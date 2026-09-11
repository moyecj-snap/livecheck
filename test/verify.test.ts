import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { verifyUrl } from "../src/verify.js";

describe("verifyUrl against local fixtures", () => {
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

  it("follows the closed Greenhouse redirect and reports closed", async () => {
    const verdict = await verifyUrl(`${origin}/fixtures/jobs/9901`);
    assert.equal(verdict.status, "closed");
    assert.match(verdict.canonical_url, /\/fixtures\/careers$/);
    assert.ok(
      verdict.signals.includes("redirected_to_board") ||
        verdict.signals.some((s) => s.includes("no longer available")),
    );
  });

  it("classifies TWO closed-to-new-applications fixtures as closed", async () => {
    const a = await verifyUrl(`${origin}/fixtures/closed-to-new-applications`);
    const b = await verifyUrl(`${origin}/fixtures/closed-to-new-applications-lever`);
    assert.equal(a.status, "closed");
    assert.equal(b.status, "closed");
  });

  it("classifies 200 + Apply Now as live", async () => {
    const verdict = await verifyUrl(`${origin}/fixtures/live-apply-now`);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("apply form present"));
  });

  it("classifies a 404 fixture as closed", async () => {
    const verdict = await verifyUrl(`${origin}/fixtures/gone-404`);
    assert.equal(verdict.status, "closed");
    assert.equal(verdict.http_status, 404);
  });

  it("classifies a recaptcha-tagged open job as live", async () => {
    const verdict = await verifyUrl(`${origin}/fixtures/live-apply-recaptcha`);
    assert.equal(verdict.status, "live");
    assert.equal(verdict.signals.includes("challenge_page"), false);
  });

  it("classifies a Cloudflare challenge fixture as unknown", async () => {
    const verdict = await verifyUrl(`${origin}/fixtures/cloudflare-challenge`);
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("challenge_page"));
  });

  it("mock-paid HTTP 200 includes Confirm-style watch hint; unpaid 402 does not", async () => {
    const unpaid = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${origin}/fixtures/live-apply-now` }),
    });
    assert.equal(unpaid.status, 402);
    const unpaidBody = (await unpaid.json()) as Record<string, unknown>;
    assert.equal("watch" in unpaidBody, false);

    const paid = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/live-apply-now` }),
    });
    assert.equal(paid.status, 200);
    const paidBody = (await paid.json()) as {
      status: string;
      watch?: { suggest?: string; detector?: string; price_usd?: number };
    };
    assert.equal(paidBody.status, "live");
    assert.deepEqual(paidBody.watch, {
      suggest: "/v1/watch",
      detector: "status_change",
      price_usd: 2.5,
    });
  });

  it("classifies Shopify in-stock as live and sold-out as closed", async () => {
    const live = await verifyUrl(`${origin}/fixtures/products/ridge-wallet`);
    const sold = await verifyUrl(`${origin}/fixtures/products/groove-ring`);
    const collection = await verifyUrl(`${origin}/fixtures/collections/rings`);
    const missing = await verifyUrl(`${origin}/fixtures/products/missing`);
    assert.equal(live.status, "live");
    assert.ok(live.signals.includes("in-stock"));
    assert.equal(sold.status, "closed");
    assert.ok(sold.signals.includes("sold-out"));
    assert.equal(collection.status, "unknown");
    assert.equal(missing.status, "closed");
  });
});
