import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { CONFIRM_DESCRIPTION, PRICE_ATOMIC_USDC, PRICE_USD, VERIFY_DESCRIPTION } from "../src/config.js";

describe("HTTP surface", () => {
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

  it("GET /health is free and reports mock settlement", async () => {
    const res = await fetch(`${origin}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      settlement: string;
      price_usd: number;
      confirm_price_usd?: number;
      check_price_usd?: number;
      watch_price_usd?: number;
      bazaar?: boolean;
      ebay?: boolean;
                      confirm?: boolean;
                      check?: boolean;
                      watch?: boolean;
                      receipt_signing?: boolean;
      public_verify_url?: string;
      public_confirm_url?: string;
      public_confirm_order_url?: string;
      public_check_url?: string;
      public_watch_url?: string;
      description?: string;
      confirm_description?: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.settlement, "disabled");
    assert.equal(body.price_usd, PRICE_USD);
    assert.equal(body.confirm_price_usd, 0.1);
    assert.equal(body.check_price_usd, 0.02);
    assert.equal(body.watch_price_usd, 2.5);
    assert.equal(body.watch, true);
    assert.equal(body.description, VERIFY_DESCRIPTION);
    assert.equal(body.confirm_description, CONFIRM_DESCRIPTION);
    assert.equal(body.bazaar, true);
    assert.equal(body.ebay, false);
    assert.equal(body.confirm, true);
    assert.equal(body.check, true);
    assert.equal(typeof body.receipt_signing, "boolean");
    assert.ok(body.public_verify_url?.endsWith("/v1/verify"));
    assert.ok(body.public_confirm_url?.endsWith("/v1/confirm"));
    assert.ok(body.public_confirm_order_url?.endsWith("/v1/confirm/order"));
    assert.ok(body.public_check_url?.endsWith("/v1/check"));
    assert.ok(body.public_watch_url?.endsWith("/v1/watch"));
  });

  it("GET / is a human demo page", async () => {
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Livecheck/);
    assert.match(html, /payment-required/);
    assert.match(html, /Before you scrape a job posting, Shopify or HTML product page, or eBay item/);
    assert.match(html, /\$0\.01 USDC/);
  });

  it("POST /v1/verify without payment returns HTTP 402 and payment-required", async () => {
    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://boards.greenhouse.io/example/jobs/1" }),
    });
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header, "expected payment-required header");
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(decoded.x402Version, 2);
    assert.equal(decoded.accepts[0].scheme, "exact");
    assert.equal(decoded.accepts[0].network, "eip155:8453");
    assert.equal(decoded.accepts[0].amount, PRICE_ATOMIC_USDC);
    assert.equal(decoded.accepts[0].amount, "10000");
    assert.equal(decoded.resource.description, VERIFY_DESCRIPTION);
    assert.ok(decoded.extensions?.bazaar);
    assert.equal(decoded.extensions.bazaar.info.output.example.price_usd, PRICE_USD);
  });

  it("mock-paid closed fixture returns status closed", async () => {
    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-livecheck-mock": "1",
      },
      body: JSON.stringify({ url: `${origin}/fixtures/closed-to-new-applications` }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "closed");
  });

  it("mock-paid live fixture returns status live", async () => {
    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": "livecheck-dev",
      },
      body: JSON.stringify({ url: `${origin}/fixtures/live-apply-now` }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; price_usd: number };
    assert.equal(body.status, "live");
    assert.equal(body.price_usd, PRICE_USD);
  });
});
