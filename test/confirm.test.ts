import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import {
  CONFIRM_DESCRIPTION,
  CONFIRM_PRICE_ATOMIC_USDC,
  CONFIRM_PRICE_USD,
  PRICE_ATOMIC_USDC,
  PRICE_USD,
  VERIFY_DESCRIPTION,
} from "../src/config.js";
import { classifyLeadSubmit, confirmUrl, parseConfirmRequest } from "../src/confirm.js";
import { FIXTURES } from "../src/fixtures.js";
import { VerifyError } from "../src/verify.js";
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
    assert.equal(verdict.effect.type, "lead_submit");
    assert.equal(verdict.effect.id, "ABC123");
    assert.equal(verdict.independent_evidence, true);
    assert.equal(verdict.independent_signals, 1);
    assert.ok(verdict.signals.includes("confirmation_id"));
    assert.ok(verdict.evidence_id.startsWith("ev_"));
    assert.equal(verdict.price_usd, CONFIRM_PRICE_USD);
    assert.equal(verdict.price_usd, 0.1);
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
  it("rejects intent other than lead_submit", () => {
    assert.throws(
      () => parseConfirmRequest({ url: "https://example.com/thanks", intent: "booking" }),
      (error: unknown) => error instanceof VerifyError && error.status === 400,
    );
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
      effect: { type: string; id?: string };
      independent_evidence: boolean;
      price_usd: number;
    };
    assert.equal(body.verdict, "confirmed");
    assert.equal(body.evidence_strength, 2);
    assert.equal(body.effect.id, "ABC123");
    assert.equal(body.independent_evidence, true);
    assert.equal(body.price_usd, 0.1);
  });

  it("POST /v1/confirm thank-you copy only is unknown", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/confirm/thank-you-only`, intent: "lead_submit" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; evidence_strength: number; effect: { id?: string } };
    assert.equal(body.verdict, "unknown");
    assert.equal(body.evidence_strength, 1);
    assert.equal(body.effect.id, undefined);
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
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /lead_submit/);
  });

  it("unpaid POST /v1/confirm is 402 at $0.10 and does not use verify copy", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/thank-you", intent: "lead_submit" }),
    });
    assert.equal(res.status, 402);
    const decoded = JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8")) as {
      accepts?: Array<{ amount?: string }>;
      resource?: { description?: string; url?: string };
    };
    assert.equal(decoded.accepts?.[0]?.amount, CONFIRM_PRICE_ATOMIC_USDC);
    assert.equal(decoded.accepts?.[0]?.amount, "100000");
    assert.equal(decoded.resource?.description, CONFIRM_DESCRIPTION);
    assert.notEqual(decoded.resource?.description, VERIFY_DESCRIPTION);
    assert.match(decoded.resource?.url ?? "", /\/v1\/confirm$/);
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
      resource?: { description?: string };
    };
    assert.equal(decoded.accepts?.[0]?.amount, PRICE_ATOMIC_USDC);
    assert.equal(decoded.accepts?.[0]?.amount, "10000");
    assert.equal(PRICE_USD, 0.01);
    assert.equal(decoded.resource?.description, VERIFY_DESCRIPTION);
  });
});
