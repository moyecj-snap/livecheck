import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { ORDER_PLACED_PRICE_USD } from "../src/config.js";
import { confirmUrl, parseConfirmRequest } from "../src/confirm.js";
import { classifyOrderPlaced } from "../src/order-placed.js";
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

describe("classifyOrderPlaced", () => {
  it("confirms an independent order id at L2 and $0.25", () => {
    const verdict = classifyOrderPlaced(
      page({
        requestedUrl: "https://shop.example.com/thank-you",
        httpStatus: 200,
        html: FIXTURES["confirm/order-thank-you-id"].body!,
      }),
      { evidenceId: "ev_order_confirmed" },
    );
    assert.equal(verdict.verdict, "confirmed");
    assert.equal(verdict.evidence_strength, 2);
    assert.equal(verdict.evidence_level, 2);
    assert.ok(verdict.confidence >= 0.9);
    assert.equal(verdict.effect.type, "order_placed");
    assert.equal(verdict.effect.id, "ORD-18421");
    assert.equal(verdict.independent_evidence, true);
    assert.ok(verdict.signals.includes("order_id"));
    assert.equal(verdict.price_usd, ORDER_PLACED_PRICE_USD);
    assert.equal(verdict.price_usd, 0.25);
  });

  it("returns unknown for thank-you fluff only", () => {
    const verdict = classifyOrderPlaced(
      page({
        requestedUrl: "https://shop.example.com/thank-you",
        httpStatus: 200,
        html: FIXTURES["confirm/order-thank-you-only"].body!,
      }),
    );
    assert.equal(verdict.verdict, "unknown");
    assert.equal(verdict.evidence_level, 1);
    assert.ok(verdict.confidence < 0.9);
    assert.equal("id" in verdict.effect, false);
    assert.equal(verdict.next_step?.endpoint, "/v1/judge");
    assert.ok(verdict.signals.includes("thank_you_copy"));
  });

  it("returns failed for payment declined / cancelled banners", () => {
    const declined = classifyOrderPlaced(
      page({
        requestedUrl: "https://shop.example.com/checkout",
        httpStatus: 200,
        html: FIXTURES["confirm/order-payment-failed"].body!,
      }),
    );
    assert.equal(declined.verdict, "failed");
    assert.ok(declined.signals.some((s) => s.startsWith("failure_banner:")));

    const cancelled = classifyOrderPlaced(
      page({
        requestedUrl: "https://shop.example.com/orders/1",
        httpStatus: 200,
        html: FIXTURES["confirm/order-cancelled"].body!,
      }),
    );
    assert.equal(cancelled.verdict, "failed");
  });

  it("does not invent an order id from claim alone", () => {
    const verdict = classifyOrderPlaced(
      page({
        requestedUrl: "https://shop.example.com/thank-you",
        httpStatus: 200,
        html: FIXTURES["confirm/order-thank-you-only"].body!,
      }),
      { claim: { order_id: "INV-FAKE-0001" } },
    );
    assert.equal(verdict.verdict, "unknown");
    assert.equal(verdict.effect.id, undefined);
  });

  it("does not confirm login walls or cookie fetches even with an id in the URL", () => {
    const login = classifyOrderPlaced(
      page({
        requestedUrl: "https://shop.example.com/orders/ORD-18421",
        httpStatus: 200,
        html: FIXTURES["confirm/order-loginwall"].body!,
      }),
    );
    assert.equal(login.verdict, "unknown");
    assert.ok(login.signals.includes("loginwalled"));

    const cookies = classifyOrderPlaced(
      page({
        requestedUrl: "https://shop.example.com/thank-you?order_id=ORD-18421",
        httpStatus: 200,
        html: FIXTURES["confirm/order-thank-you-id"].body!,
      }),
      { cookiesUsed: true },
    );
    assert.equal(cookies.verdict, "unknown");
    assert.equal(cookies.independent_evidence, false);
  });
});

describe("parseConfirmRequest order_placed", () => {
  it("accepts order_placed with optional claim fields", () => {
    const parsed = parseConfirmRequest({
      url: "https://shop.example.com/thank-you",
      intent: "order_placed",
      claim: { order_id: "ORD-18421", total: "42.00", email_domain: "acme.com" },
    });
    assert.equal(parsed.intent, "order_placed");
    assert.equal(parsed.claim?.order_id, "ORD-18421");
  });
});

describe("order_placed HTTP + regressions", () => {
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

  it("POST /v1/confirm/order order_placed happy path after mock pay", async () => {
    const res = await fetch(`${origin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/order-thank-you-id`,
        intent: "order_placed",
        claim: { order_id: "ORD-18421" },
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
    };
    assert.equal(body.verdict, "confirmed");
    assert.equal(body.effect.type, "order_placed");
    assert.equal(body.effect.id, "ORD-18421");
    assert.equal(body.evidence_level, 2);
    assert.ok(body.confidence >= 0.9);
    assert.equal(body.price_usd, 0.25);
    assert.match(body.id ?? "", /^cfm_/);
    assert.ok(body.receipt?.hash);

    const receipt = await fetch(body.receipt!.verify_url!);
    assert.equal(receipt.status, 200);
    const receiptBody = (await receipt.json()) as { intent?: string };
    assert.equal(receiptBody.intent, "order_placed");
  });

  it("POST /v1/confirm/order order_placed failed / unknown / trap", async () => {
    const failed = await fetch(`${origin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/order-payment-failed`,
        intent: "order_placed",
      }),
    });
    assert.equal(failed.status, 200);
    assert.equal(((await failed.json()) as { verdict: string }).verdict, "failed");

    const unknown = await fetch(`${origin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/order-thank-you-only`,
        intent: "order_placed",
      }),
    });
    assert.equal(unknown.status, 200);
    const unknownBody = (await unknown.json()) as {
      verdict: string;
      next_step?: { endpoint?: string };
      effect: { id?: string };
    };
    assert.equal(unknownBody.verdict, "unknown");
    assert.equal(unknownBody.effect.id, undefined);
    assert.equal(unknownBody.next_step?.endpoint, "/v1/judge");
  });

  it("unpaid POST /v1/confirm/order is 402 with one $0.25 accept", async () => {
    const res = await fetch(`${origin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://shop.example.com/thank-you", intent: "order_placed" }),
    });
    assert.equal(res.status, 402);
    const decoded = JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8")) as {
      accepts?: Array<{ amount?: string; extra?: unknown }>;
    };
    assert.equal(decoded.accepts?.[0]?.amount, "250000");
    assert.equal(decoded.accepts?.length, 1);
    assert.deepEqual(decoded.accepts?.[0]?.extra, { name: "USD Coin", version: "2" });
  });

  it("POST /v1/confirm rejects order_placed after mock pay", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/confirm/order-thank-you-id`, intent: "order_placed" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; intent?: unknown; use?: string };
    assert.equal(body.error, "unsupported_intent");
    assert.equal(body.intent, "order_placed");
    assert.equal(body.use, "/v1/confirm/order");
  });

  it("POST /v1/confirm/order rejects lead_submit after mock pay", async () => {
    const res = await fetch(`${origin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/confirm/thank-you-id`, intent: "lead_submit" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; intent?: unknown; use?: string };
    assert.equal(body.error, "unsupported_intent");
    assert.equal(body.intent, "lead_submit");
    assert.equal(body.use, "/v1/confirm");
  });

  it("lead_submit regression: thank-you + id still confirmed at $0.10", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/thank-you-id`,
        intent: "lead_submit",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; effect: { type: string; id?: string }; price_usd: number };
    assert.equal(body.verdict, "confirmed");
    assert.equal(body.effect.type, "lead_submit");
    assert.equal(body.effect.id, "ABC123");
    assert.equal(body.price_usd, 0.1);
  });

  it("listing_published regression: live product still confirmed at $0.10", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/products/ridge-wallet`,
        intent: "listing_published",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; effect: { type: string }; price_usd: number };
    assert.equal(body.verdict, "confirmed");
    assert.equal(body.effect.type, "listing_published");
    assert.equal(body.price_usd, 0.1);
  });

  it("unsupported intent is still 400 after mock pay", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/confirm/order-thank-you-id`, intent: "booking" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; intent?: unknown };
    assert.equal(body.error, "unsupported_intent");
    assert.equal(body.intent, "booking");
  });

  it("confirmUrl order_placed maps the order-id fixture", async () => {
    const verdict = await confirmUrl(`${origin}/fixtures/confirm/order-thank-you-id`, fetch, new Date(), {
      intent: "order_placed",
    });
    assert.equal(verdict.verdict, "confirmed");
    assert.equal(verdict.effect.type, "order_placed");
    assert.equal(verdict.effect.id, "ORD-18421");
  });
});
