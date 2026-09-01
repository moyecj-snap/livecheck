import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { PRICE_ATOMIC_USDC, PRICE_USD } from "../src/config.js";
import { encodePaymentRequired, paymentRequiredBody } from "../src/x402-payload.js";
import {
  DEFAULT_LIVECHECK_URL,
  decodePaymentRequiredHeader,
  livecheckVerifyUrl,
  paymentRequiredResult,
  verifyListing,
} from "../src/mcp-client.js";

describe("mcp client mapping", () => {
  it("defaults LIVECHECK_URL to the local verify endpoint", () => {
    assert.equal(livecheckVerifyUrl({}), DEFAULT_LIVECHECK_URL);
    assert.equal(livecheckVerifyUrl({ LIVECHECK_URL: " http://example.test/v1/verify " }), "http://example.test/v1/verify");
  });

  it("builds a structured 402 from the payment-required header without inventing fields", () => {
    const payload = paymentRequiredBody("http://127.0.0.1:43127/v1/verify");
    const result = paymentRequiredResult(encodePaymentRequired(payload), "");
    assert.equal(result.paid, false);
    assert.equal(result.http, 402);
    assert.equal(result.x402Version, 2);
    assert.equal(result.error, payload.error);
    assert.deepEqual(result.resource, payload.resource);
    assert.deepEqual(result.accepts, payload.accepts);
    assert.equal("wallet" in result, false);
    assert.equal("price_usd" in result, false);
  });

  it("falls back to a JSON 402 body when the header is missing", () => {
    const payload = { x402Version: 2, error: "PAYMENT-SIGNATURE header is required" };
    const result = paymentRequiredResult(null, JSON.stringify(payload));
    assert.equal(result.paid, false);
    assert.equal(result.http, 402);
    assert.equal(result.x402Version, 2);
    assert.equal(result.error, payload.error);
  });

  it("returns only paid/http when nothing can be decoded", () => {
    const result = paymentRequiredResult("not-base64-json", "not-json");
    assert.deepEqual(result, { paid: false, http: 402 });
  });

  it("decodes a payment-required header to a plain object", () => {
    const decoded = decodePaymentRequiredHeader(
      encodePaymentRequired(paymentRequiredBody("http://127.0.0.1:43127/v1/verify")),
    );
    assert.ok(decoded);
    assert.equal(decoded.x402Version, 2);
  });

  it("returns a 200 verdict as-is and never sends a mock payment header", async () => {
    const verdict = {
      url: "https://boards.greenhouse.io/example/jobs/1",
      canonical_url: "https://boards.greenhouse.io/example/jobs/1",
      status: "live",
      http_status: 200,
      checked_at: "2026-08-30T21:00:00Z",
      signals: ["apply form present"],
      confidence: 0.8,
      price_usd: PRICE_USD,
    };
    let captured: Headers | undefined;
    const result = await verifyListing(verdict.url, {
      endpoint: "http://livecheck.test/v1/verify",
      fetchImpl: async (_input, init) => {
        captured = new Headers(init?.headers);
        return new Response(JSON.stringify(verdict), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(result, verdict);
    assert.ok(captured);
    assert.equal(captured.get("x-livecheck-mock"), null);
    assert.equal(captured.get("payment-signature"), null);
    assert.equal(captured.get("x-payment"), null);
    assert.equal(captured.get("content-type"), "application/json");
  });
});

describe("mcp client against the local HTTP app", () => {
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

  it("surfaces unpaid verify as structured 402", async () => {
    const result = (await verifyListing("https://boards.greenhouse.io/example/jobs/1", {
      endpoint: `${origin}/v1/verify`,
    })) as { paid: boolean; http: number; x402Version: number; accepts: Array<{ amount: string; scheme: string }> };
    assert.equal(result.paid, false);
    assert.equal(result.http, 402);
    assert.equal(result.x402Version, 2);
    assert.equal(result.accepts[0].scheme, "exact");
    assert.equal(result.accepts[0].amount, PRICE_ATOMIC_USDC);
  });
});
