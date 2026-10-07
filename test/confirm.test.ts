import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import {
  CONFIRM_DESCRIPTION,
  CONFIRM_PAYMENT_DESCRIPTION,
  CONFIRM_PRICE_ATOMIC_USDC,
  CONFIRM_PRICE_USD,
  PRICE_ATOMIC_USDC,
  PRICE_USD,
  VERIFY_DESCRIPTION,
} from "../src/config.js";
import {
  classifyLeadSubmit,
  confirmUrl,
  parseConfirmRequest,
  parseConfirmRouteRequest,
  parseOrderConfirmRequest,
  UnsupportedIntentError,
} from "../src/confirm.js";
import { CONFIRM_EXAMPLE } from "../src/bazaar.js";
import { CONFIRM_DEMO_URL } from "../src/docs-example-url.js";
import { DEMO_REF_MAX_LENGTH } from "../src/demo-thank-you.js";
import { FIXTURES } from "../src/fixtures.js";
import type { FetchedPage } from "../src/types.js";

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

describe("classifyLeadSubmit", () => {
  it("confirms thank-you + confirmation id at strength 2", () => {
    const verdict = classifyLeadSubmit(
      page({
        requestedUrl: "https://example.com/thank-you?ref=ABC123",
        httpStatus: 200,
        html: FIXTURES["confirm/thank-you-id"].body!,
      }),
      { evidenceId: "ev_test_confirmed" },
    );
    assert.equal(verdict.verdict, "confirmed");
    assert.equal(verdict.evidence_strength, 2);
    assert.equal(verdict.evidence_level, 2);
    assert.ok(verdict.confidence >= 0.9);
    assert.equal(verdict.effect.type, "lead_submit");
    assert.equal(verdict.effect.id, "ABC123");
    assert.equal(verdict.independent_evidence, true);
    assert.equal(verdict.independent_signals, 1);
    assert.ok(verdict.signals.includes("confirmation_id"));
    assert.ok(verdict.evidence_id.startsWith("ev_"));
    assert.equal(verdict.price_usd, CONFIRM_PRICE_USD);
    assert.equal(verdict.price_usd, 0.1);
  });

  it("does not confirm the bazaar example.com 404 just because ref=ABC123 is in the URL", () => {
    const verdict = classifyLeadSubmit(
      page({
        requestedUrl: "https://example.com/thank-you?ref=ABC123",
        canonicalUrl: "https://example.com/thank-you?ref=ABC123",
        httpStatus: 404,
        html: `<!doctype html><html lang="en"><head><title>Example Domain</title></head><body><p>This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.</p></body></html>`,
      }),
    );
    assert.notEqual(verdict.verdict, "confirmed");
    assert.equal(verdict.verdict, "unknown");
    assert.equal(verdict.http_status, 404);
    assert.equal(verdict.effect.id, undefined);
    assert.ok(verdict.signals.includes("confirmation_url_token"));
    assert.ok(verdict.signals.includes("url_token_not_sufficient"));
    assert.ok(verdict.signals.includes("non_2xx"));
  });

  it("does not confirm a 200 page whose only token is a ref query param", () => {
    const verdict = classifyLeadSubmit(
      page({
        requestedUrl: "https://forms.example.com/thanks?ref=ABC123",
        httpStatus: 200,
        html: `<!doctype html><html><head><title>Contact</title></head><body><h1>Contact</h1><p>Fill out the form below.</p></body></html>`,
      }),
    );
    assert.equal(verdict.verdict, "unknown");
    assert.equal(verdict.effect.id, undefined);
    assert.ok(verdict.signals.includes("url_token_not_sufficient"));
  });

  it("does not confirm a 404 page even when the body prints a confirmation id", () => {
    const verdict = classifyLeadSubmit(
      page({
        requestedUrl: "https://forms.example.com/thank-you",
        httpStatus: 404,
        html: `<!doctype html><html><head><title>Not Found</title></head><body><h1>Not Found</h1><p>Confirmation number: ABC123</p></body></html>`,
      }),
    );
    assert.notEqual(verdict.verdict, "confirmed");
    assert.equal(verdict.verdict, "unknown");
    assert.ok(verdict.signals.includes("non_2xx"));
    assert.ok(verdict.signals.includes("confirmation_id_ignored_non_2xx"));
  });

  it("returns unknown for thank-you copy only", () => {
    const verdict = classifyLeadSubmit(
      page({
        requestedUrl: "https://example.com/thank-you",
        httpStatus: 200,
        html: FIXTURES["confirm/thank-you-only"].body!,
      }),
    );
    assert.equal(verdict.verdict, "unknown");
    assert.equal(verdict.evidence_strength, 1);
    assert.equal(verdict.evidence_level, 1);
    assert.ok(verdict.confidence < 0.9);
    assert.equal(verdict.next_step?.action, "human_review");
    assert.equal(verdict.next_step?.endpoint, "/v1/judge");
    assert.equal("id" in verdict.effect, false);
    assert.ok(verdict.signals.includes("thank_you_copy"));
    assert.equal(verdict.independent_evidence, true);
  });

  it("returns failed for an error banner", () => {
    const verdict = classifyLeadSubmit(
      page({
        requestedUrl: "https://example.com/submit",
        httpStatus: 200,
        html: FIXTURES["confirm/error-banner"].body!,
      }),
    );
    assert.equal(verdict.verdict, "failed");
    assert.equal(verdict.evidence_strength, 1);
    assert.equal("id" in verdict.effect, false);
    assert.ok(verdict.signals.some((s) => s.startsWith("failure_banner:")));
  });

  it("does not confirm when cookies were used even if an id is present", () => {
    const verdict = classifyLeadSubmit(
      page({
        requestedUrl: "https://example.com/thank-you?ref=ABC123",
        httpStatus: 200,
        html: FIXTURES["confirm/thank-you-id"].body!,
      }),
      { cookiesUsed: true },
    );
    assert.equal(verdict.verdict, "unknown");
    assert.notEqual(verdict.evidence_strength, 2);
    assert.equal(verdict.independent_evidence, false);
  });
});

describe("parseConfirmRequest", () => {
  it("rejects intent other than payable Confirm intents as unsupported_intent", () => {
    assert.throws(
      () => parseConfirmRequest({ url: "https://example.com/thanks", intent: "booking" }),
      (error: unknown) =>
        error instanceof UnsupportedIntentError &&
        error.status === 400 &&
        error.code === "unsupported_intent",
    );
  });

  it("accepts order_placed", () => {
    const parsed = parseConfirmRequest({ url: "https://example.com/order/1", intent: "order_placed" });
    assert.equal(parsed.intent, "order_placed");
  });

  it("parseConfirmRouteRequest rejects order_placed with /v1/confirm/order hint", () => {
    assert.throws(
      () => parseConfirmRouteRequest({ url: "https://example.com/order/1", intent: "order_placed" }),
      (error: unknown) =>
        error instanceof UnsupportedIntentError &&
        error.intent === "order_placed" &&
        error.use === "/v1/confirm/order ($0.25)",
    );
  });

  it("parseOrderConfirmRequest rejects lead_submit with /v1/confirm hint", () => {
    assert.throws(
      () => parseOrderConfirmRequest({ url: "https://example.com/thanks", intent: "lead_submit" }),
      (error: unknown) =>
        error instanceof UnsupportedIntentError &&
        error.intent === "lead_submit" &&
        error.use === "/v1/confirm ($0.10)",
    );
  });

  it("accepts listing_published without a claim", () => {
    const parsed = parseConfirmRequest({
      url: "https://shop.example.com/products/ridge-wallet",
      intent: "listing_published",
    });
    assert.equal(parsed.intent, "listing_published");
    assert.equal(parsed.claim, undefined);
  });

  it("does not require claim for lead_submit", () => {
    const parsed = parseConfirmRequest({ url: "https://example.com/thanks", intent: "lead_submit" });
    assert.equal(parsed.intent, "lead_submit");
    assert.equal(parsed.claim, undefined);
  });

  it("accepts an optional claim object", () => {
    const parsed = parseConfirmRequest({
      url: "https://example.com/thanks",
      intent: "lead_submit",
      claim: { ref: "ABC123" },
    });
    assert.equal(parsed.claim?.ref, "ABC123");
  });
});

describe("confirmUrl + HTTP", () => {
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

  it("confirmUrl on thank-you + id is confirmed with independent_evidence", async () => {
    const verdict = await confirmUrl(`${origin}/fixtures/confirm/thank-you-id`);
    assert.equal(verdict.verdict, "confirmed");
    assert.equal(verdict.evidence_strength, 2);
    assert.equal(verdict.effect.id, "ABC123");
    assert.equal(verdict.independent_evidence, true);
    assert.ok(verdict.signals.includes("cookieless_fetch"));
  });

  it("POST /v1/confirm thank-you + id after mock pay", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/thank-you-id`,
        intent: "lead_submit",
        claim: {},
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      verdict: string;
      evidence_strength: number;
      evidence_level?: number;
      confidence?: number;
      id?: string;
      effect: { type: string; id?: string };
      independent_evidence: boolean;
      price_usd: number;
      receipt?: { hash?: string; verify_url?: string; signature?: string };
      watch?: { suggest?: string; detector?: string; price_usd?: number };
    };
    assert.equal(body.verdict, "confirmed");
    assert.equal((body as { route?: string }).route, "confirm");
    assert.equal(body.evidence_strength, 2);
    assert.equal(body.evidence_level, 2);
    assert.ok((body.confidence ?? 0) >= 0.9);
    assert.equal(body.effect.id, "ABC123");
    assert.equal(body.independent_evidence, true);
    assert.equal(body.price_usd, 0.1);
    assert.match(body.id ?? "", /^cfm_/);
    assert.ok(body.receipt?.hash);
    assert.ok(body.receipt?.verify_url?.includes("/v1/receipt/"));
    assert.deepEqual(body.watch, { suggest: "/v1/watch", detector: "status_change", price_usd: 2.5 });
  });

  it("POST /v1/confirm of the vet402 example.com URL is not confirmed", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-livecheck-mock": "1",
        "user-agent": "vet402-observatory-l1/1.0 (+https://vet402.com/observatory/methodology)",
      },
      body: JSON.stringify({
        url: "https://example.com/thank-you?ref=ABC123",
        intent: "lead_submit",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      verdict: string;
      confidence?: number;
      evidence_level?: number;
      http_status?: number;
      effect?: { id?: string };
      example?: boolean;
    };
    assert.notEqual(body.verdict, "confirmed");
    assert.equal(body.verdict, "unknown");
    assert.equal(body.http_status, 404);
    assert.equal(body.effect?.id, undefined);
    assert.ok((body.confidence ?? 1) < 0.9);
    assert.notEqual(body.evidence_level, 2);
    assert.notEqual(body.example, true);
  });

  it("GET /demo/thank-you is a 200 page that prints the ref and escapes it", async () => {
    const ok = await fetch(`${origin}/demo/thank-you?ref=ABC123`);
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /Confirmation number: ABC123/);
    assert.match(html, /We've received your request/);

    const evil = await fetch(`${origin}/demo/thank-you?ref=${encodeURIComponent("<script>alert(1)</script>")}`);
    assert.equal(evil.status, 200);
    const escaped = await evil.text();
    assert.equal(escaped.includes("<script>alert"), false);
    assert.match(escaped, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

    const extra = "EXTRA";
    const ref = `${"X".repeat(DEMO_REF_MAX_LENGTH - 1)}9${extra}`;
    const capped = await fetch(`${origin}/demo/thank-you?ref=${ref}`);
    const cappedHtml = await capped.text();
    assert.equal(cappedHtml.includes(extra), false);
    assert.match(cappedHtml, new RegExp(`Confirmation number: ${"X".repeat(DEMO_REF_MAX_LENGTH - 1)}9`));
  });

  it("docs example input confirms when the page prints ABC123", async () => {
    assert.equal(CONFIRM_EXAMPLE.url, CONFIRM_DEMO_URL);
    assert.equal(CONFIRM_EXAMPLE.url, "https://livecheck.fly.dev/demo/thank-you?ref=ABC123");
    assert.equal(CONFIRM_EXAMPLE.verdict, "confirmed");
    assert.equal(CONFIRM_EXAMPLE.effect.id, "ABC123");
    const demo = new URL(CONFIRM_DEMO_URL);
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}${demo.pathname}${demo.search}`,
        intent: "lead_submit",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      verdict: string;
      http_status?: number;
      evidence_level?: number;
      effect?: { id?: string };
    };
    assert.equal(body.verdict, "confirmed");
    assert.equal(body.http_status, 200);
    assert.equal(body.evidence_level, 2);
    assert.equal(body.effect?.id, "ABC123");
  });

  it("POST /v1/confirm thank-you copy only is unknown", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/confirm/thank-you-only`, intent: "lead_submit" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      verdict: string;
      evidence_strength: number;
      effect: { id?: string };
      next_step?: { action?: string; endpoint?: string; est_price_usd?: number };
    };
    assert.equal(body.verdict, "unknown");
    assert.equal(body.evidence_strength, 1);
    assert.equal(body.effect.id, undefined);
    assert.equal(body.next_step?.action, "human_review");
    assert.equal(body.next_step?.endpoint, "/v1/judge");
    assert.equal(body.next_step?.est_price_usd, 1);
  });

  it("POST /v1/confirm error banner is failed", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/confirm/error-banner`, intent: "lead_submit" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string };
    assert.equal(body.verdict, "failed");
  });

  it("POST /v1/confirm with intent !== lead_submit is 400 after mock pay", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/confirm/thank-you-id`, intent: "booking" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; intent?: unknown };
    assert.equal(body.error, "unsupported_intent");
    assert.equal(body.intent, "booking");
  });

  it("POST /v1/confirm order_placed is 400 unsupported_intent with confirm/order hint", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/confirm/order-thank-you-id`, intent: "order_placed" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; intent?: unknown; use?: string };
    assert.equal(body.error, "unsupported_intent");
    assert.equal(body.intent, "order_placed");
    assert.equal(body.use, "/v1/confirm/order ($0.25)");
  });

  it("unpaid POST /v1/confirm is 402 at $0.10 and does not use verify copy", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/thank-you", intent: "lead_submit" }),
    });
    assert.equal(res.status, 402);
    const decoded = JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8")) as {
      accepts?: Array<{ amount?: string; extra?: { name?: string; version?: string } }>;
      resource?: { description?: string; url?: string; serviceName?: string; tags?: string[] };
    };
    assert.equal(decoded.accepts?.[0]?.amount, CONFIRM_PRICE_ATOMIC_USDC);
    assert.equal(decoded.accepts?.[0]?.amount, "100000");
    assert.equal(decoded.accepts?.length, 1);
    assert.deepEqual(decoded.accepts?.[0]?.extra, { name: "USD Coin", version: "2" });
    assert.equal(decoded.resource?.description, CONFIRM_PAYMENT_DESCRIPTION);
    assert.match(decoded.resource?.description ?? "", /Livecheck/);
    assert.notEqual(decoded.resource?.description, VERIFY_DESCRIPTION);
    assert.match(decoded.resource?.url ?? "", /\/v1\/confirm$/);
    assert.equal("watch" in decoded, false);
  });

  it("unpaid POST /v1/confirm/order is 402 at $0.25 with one accept", async () => {
    const res = await fetch(`${origin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://shop.example.com/thank-you", intent: "order_placed" }),
    });
    assert.equal(res.status, 402);
    const decoded = JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8")) as {
      accepts?: Array<{ amount?: string; extra?: { name?: string; version?: string } }>;
      resource?: { description?: string; url?: string };
    };
    assert.equal(decoded.accepts?.length, 1);
    assert.equal(decoded.accepts?.[0]?.amount, "250000");
    assert.deepEqual(decoded.accepts?.[0]?.extra, { name: "USD Coin", version: "2" });
    assert.match(decoded.resource?.url ?? "", /\/v1\/confirm\/order$/);
    assert.match(decoded.resource?.description ?? "", /order_placed/);
  });

  it("POST /v1/verify is still $0.01", async () => {
    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(res.status, 402);
    const decoded = JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8")) as {
      accepts?: Array<{ amount?: string }>;
      resource?: { description?: string; tags?: string[]; serviceName?: string };
    };
    assert.equal(decoded.accepts?.[0]?.amount, PRICE_ATOMIC_USDC);
    assert.equal(decoded.accepts?.[0]?.amount, "10000");
    assert.equal(PRICE_USD, 0.01);
    assert.equal(decoded.resource?.description, VERIFY_DESCRIPTION);
    assert.equal(decoded.resource?.tags, undefined);
    assert.equal(decoded.resource?.serviceName, undefined);
  });
});
