import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { CONFIRM_PRICE_USD } from "../src/config.js";
import { classifyListingPublished } from "../src/listing-published.js";
import { confirmUrl } from "../src/confirm.js";
import { classify } from "../src/classify.js";
import { FIXTURES } from "../src/fixtures.js";
import type { FetchedPage, VerifyVerdict } from "../src/types.js";

function page(partial: Partial<FetchedPage> & Pick<FetchedPage, "requestedUrl" | "html" | "httpStatus">): FetchedPage {
  const html = partial.html;
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return {
    canonicalUrl: partial.canonicalUrl ?? partial.requestedUrl,
    text: html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    title: titleMatch?.[1]?.trim() ?? null,
    redirected: Boolean(partial.redirected),
    redirectChain: partial.redirectChain ?? [],
    ...partial,
  };
}

function fromFixture(url: string, fixtureId: keyof typeof FIXTURES, extra: Partial<FetchedPage> = {}): FetchedPage {
  return page({
    requestedUrl: url,
    httpStatus: FIXTURES[fixtureId].status === 302 ? 200 : FIXTURES[fixtureId].status,
    html: FIXTURES[fixtureId].body ?? "",
    ...extra,
  });
}

describe("classifyListingPublished", () => {
  it("confirms a live specific job with apply form (L2, confidence ≥ 0.90)", () => {
    const fetched = fromFixture(
      "https://boards.greenhouse.io/northwind/jobs/1842",
      "live-apply-now",
    );
    const verify = classify(fetched);
    const result = classifyListingPublished(verify, { page: fetched, evidenceId: "ev_lp_live" });
    assert.equal(verify.status, "live");
    assert.equal(result.verdict, "confirmed");
    assert.equal(result.effect.type, "listing_published");
    assert.equal(result.effect.id, "1842");
    assert.equal(result.evidence_level, 2);
    assert.ok(result.confidence >= 0.9);
    assert.equal(result.independent_evidence, true);
    assert.equal(result.price_usd, CONFIRM_PRICE_USD);
    assert.ok(result.signals.includes("verify_live"));
    assert.ok(result.signals.includes("listing_id"));
  });

  it("fails a closed / sold-out listing", () => {
    const fetched = fromFixture("https://shop.example.com/products/groove-ring", "products/groove-ring");
    const verify = classify(fetched);
    const result = classifyListingPublished(verify, { page: fetched });
    assert.equal(verify.status, "closed");
    assert.equal(result.verdict, "failed");
    assert.equal(result.effect.type, "listing_published");
    assert.equal(result.effect.id, "groove-ring");
    assert.ok(result.signals.includes("verify_closed"));
    assert.ok(result.signals.includes("sold-out"));
  });

  it("returns unknown for ambiguous HTML and points at /v1/judge", () => {
    const fetched = page({
      requestedUrl: "https://example.com/page",
      httpStatus: 200,
      html: "<html><head><title>Hello</title></head><body><p>Hello</p></body></html>",
    });
    const verify = classify(fetched);
    const result = classifyListingPublished(verify, { page: fetched });
    assert.equal(result.verdict, "unknown");
    assert.equal(result.next_step?.endpoint, "/v1/judge");
    assert.equal(result.next_step?.action, "human_review");
    assert.ok(result.confidence < 0.9);
  });

  it("never confirms thank-you fluff even if add-to-cart text is present", () => {
    const fetched = page({
      requestedUrl: "https://shop.example.com/thank-you",
      httpStatus: 200,
      html: `<html><head><title>Thank you</title></head><body>
        <h1>Thank you</h1><p>We've received your request.</p><button>Add to cart</button>
        </body></html>`,
    });
    const verify: VerifyVerdict = {
      url: fetched.requestedUrl,
      canonical_url: fetched.canonicalUrl,
      status: "live",
      http_status: 200,
      checked_at: "2026-09-09T00:00:00Z",
      signals: ["in-stock"],
      confidence: 0.8,
      price_usd: 0.01,
      title: "Thank you",
    };
    const result = classifyListingPublished(verify, { page: fetched });
    assert.equal(result.verdict, "unknown");
    assert.ok(result.signals.includes("thank_you_copy"));
    assert.equal(result.effect.id, undefined);
  });

  it("does not invent a listing id when the URL has none", () => {
    const verify: VerifyVerdict = {
      url: "https://example.com/",
      canonical_url: "https://example.com/",
      status: "live",
      http_status: 200,
      checked_at: "2026-09-09T00:00:00Z",
      signals: ["in-stock"],
      confidence: 0.74,
      price_usd: 0.01,
    };
    const result = classifyListingPublished(verify);
    assert.equal(result.verdict, "unknown");
    assert.equal(result.effect.id, undefined);
  });

  it("maps eBay in-stock Verify onto confirmed without inventing a different id", () => {
    const verify: VerifyVerdict = {
      url: "https://www.ebay.com/itm/123456789012",
      canonical_url: "https://www.ebay.com/itm/123456789012",
      status: "live",
      http_status: 200,
      checked_at: "2026-09-09T00:00:00Z",
      signals: ["ebay-in-stock"],
      confidence: 0.86,
      price_usd: 0.01,
      title: "Vintage Camera",
    };
    const result = classifyListingPublished(verify);
    assert.equal(result.verdict, "confirmed");
    assert.equal(result.effect.id, "123456789012");
    assert.equal(result.evidence_level, 2);
  });
});

describe("listing_published HTTP", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => close());

  it("happy path: live product → confirmed with Phase A fields and receipt", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/products/ridge-wallet`,
        intent: "listing_published",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      verdict: string;
      effect: { type: string; id?: string };
      evidence_level: number;
      confidence: number;
      id?: string;
      receipt?: { hash?: string; verify_url?: string };
      price_usd: number;
      independent_evidence: boolean;
    };
    assert.equal(body.verdict, "confirmed");
    assert.equal(body.effect.type, "listing_published");
    assert.equal(body.effect.id, "ridge-wallet");
    assert.equal(body.evidence_level, 2);
    assert.ok(body.confidence >= 0.9);
    assert.match(body.id ?? "", /^cfm_/);
    assert.ok(body.receipt?.hash);
    assert.ok(body.receipt?.verify_url?.includes("/v1/receipt/"));
    assert.equal(body.price_usd, 0.1);
    assert.equal(body.independent_evidence, true);

    const receipt = await fetch(body.receipt!.verify_url!);
    assert.equal(receipt.status, 200);
    const receiptBody = (await receipt.json()) as { id?: string; intent?: string };
    assert.equal(receiptBody.id, body.id);
    assert.equal(receiptBody.intent, "listing_published");
  });

  it("closed sold-out → failed", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/products/groove-ring`,
        intent: "listing_published",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; evidence_level: number };
    assert.equal(body.verdict, "failed");
    assert.ok(body.evidence_level >= 1);
  });

  it("ambiguous collection → unknown with next_step stub", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/collections/rings`,
        intent: "listing_published",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      verdict: string;
      next_step?: { action?: string; endpoint?: string };
    };
    assert.equal(body.verdict, "unknown");
    assert.equal(body.next_step?.action, "human_review");
    assert.equal(body.next_step?.endpoint, "/v1/judge");
  });

  it("lead_submit regression: thank-you + id still confirmed", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/thank-you-id`,
        intent: "lead_submit",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; effect: { type: string; id?: string } };
    assert.equal(body.verdict, "confirmed");
    assert.equal(body.effect.type, "lead_submit");
    assert.equal(body.effect.id, "ABC123");
  });

  it("listing_published on a thank-you page is unknown, not confirmed", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/thank-you-id`,
        intent: "listing_published",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; effect: { type: string; id?: string } };
    assert.equal(body.verdict, "unknown");
    assert.equal(body.effect.type, "listing_published");
  });

  it("confirmUrl listing_published maps verify live apply fixture", async () => {
    const verdict = await confirmUrl(`${origin}/fixtures/jobs/1842`, fetch, new Date(), {
      intent: "listing_published",
    });
    assert.equal(verdict.verdict, "confirmed");
    assert.equal(verdict.effect.type, "listing_published");
    assert.equal(verdict.effect.id, "1842");
  });
});
