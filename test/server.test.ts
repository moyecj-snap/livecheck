import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { PRICE_ATOMIC_USDC } from "../src/config.js";

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
    const body = (await res.json()) as { ok: boolean; settlement: string; price_usd: number };
    assert.equal(body.ok, true);
    assert.equal(body.settlement, "disabled");
    assert.equal(body.price_usd, 0.05);
  });

  it("GET / is a human demo page", async () => {
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Livecheck/);
    assert.match(html, /payment-required/);
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
    assert.match(decoded.resource.description, /specific product or job URL/);
    assert.ok(decoded.extensions?.bazaar);
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
    assert.equal(body.price_usd, 0.05);
  });
});
