import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import {
  CHECK_PRICE_ATOMIC_USDC,
  CONFIRM_PRICE_ATOMIC_USDC,
  ORDER_PLACED_PRICE_ATOMIC_USDC,
  PRICE_ATOMIC_USDC,
  PRICE_USD,
  WATCH_PRICE_ATOMIC_USDC,
} from "../src/config.js";
import { encodePaymentRequired, paymentRequiredBody } from "../src/x402-payload.js";
import {
  DEFAULT_LIVECHECK_ORIGIN,
  DEFAULT_LIVECHECK_URL,
  checkListing,
  confirmListing,
  confirmRoutePath,
  decodePaymentRequiredHeader,
  livecheckOrigin,
  livecheckPathUrl,
  livecheckVerifyUrl,
  paymentRequiredResult,
  resolvePaymentSignature,
  verifyListing,
  watchChainTopup,
  watchGet,
  watchListing,
  watchRenew,
} from "../src/mcp-client.js";

describe("mcp client mapping", () => {
  it("defaults LIVECHECK_URL to the local verify endpoint", () => {
    assert.equal(livecheckVerifyUrl({}), DEFAULT_LIVECHECK_URL);
    assert.equal(livecheckVerifyUrl({ LIVECHECK_URL: " http://example.test/v1/verify " }), "http://example.test/v1/verify");
  });

  it("derives origin from an existing verify LIVECHECK_URL so mcp.json keeps working", () => {
    assert.equal(livecheckOrigin({}), DEFAULT_LIVECHECK_ORIGIN);
    assert.equal(livecheckOrigin({ LIVECHECK_URL: "https://livecheck.fly.dev/v1/verify" }), "https://livecheck.fly.dev");
    assert.equal(livecheckOrigin({ LIVECHECK_URL: "https://livecheck.fly.dev" }), "https://livecheck.fly.dev");
    assert.equal(livecheckPathUrl("/v1/check", { LIVECHECK_URL: "https://livecheck.fly.dev/v1/verify" }), "https://livecheck.fly.dev/v1/check");
    assert.equal(livecheckPathUrl("/v1/watch", { LIVECHECK_URL: "http://127.0.0.1:43127/v1/verify" }), "http://127.0.0.1:43127/v1/watch");
  });

  it("keeps confirm prices on distinct Fly routes", () => {
    assert.equal(confirmRoutePath("lead_submit"), "/v1/confirm");
    assert.equal(confirmRoutePath("listing_published"), "/v1/confirm");
    assert.equal(confirmRoutePath("order_placed"), "/v1/confirm/order");
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

  it("resolves an optional caller payment signature and never invents one", () => {
    assert.equal(resolvePaymentSignature(undefined, {}), undefined);
    assert.equal(resolvePaymentSignature("  ", {}), undefined);
    assert.equal(resolvePaymentSignature("sig_from_arg", { LIVECHECK_PAYMENT_SIGNATURE: "sig_from_env" }), "sig_from_arg");
    assert.equal(resolvePaymentSignature(undefined, { LIVECHECK_PAYMENT_SIGNATURE: " sig_from_env " }), "sig_from_env");
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

  it("forwards a caller-supplied PAYMENT-SIGNATURE and still does not invent a wallet", async () => {
    let captured: Headers | undefined;
    await verifyListing("https://example.com/jobs/1", {
      endpoint: "http://livecheck.test/v1/verify",
      paymentSignature: "envelope-from-caller",
      fetchImpl: async (_input, init) => {
        captured = new Headers(init?.headers);
        return new Response(JSON.stringify({ paid: false, http: 402 }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.ok(captured);
    assert.equal(captured.get("payment-signature"), "envelope-from-caller");
    assert.equal(captured.get("x-payment"), "envelope-from-caller");
    assert.equal(captured.get("x-livecheck-mock"), null);
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

  const envFor = () => ({ LIVECHECK_URL: `${origin}/v1/verify` });

  function assertUnpaid402(
    result: { paid: boolean; http: number; x402Version?: number; accepts?: Array<{ amount: string; scheme: string }> },
    amount: string,
  ) {
    assert.equal(result.paid, false);
    assert.equal(result.http, 402);
    assert.equal(result.x402Version, 2);
    assert.equal(result.accepts?.[0]?.scheme, "exact");
    assert.equal(result.accepts?.[0]?.amount, amount);
    assert.equal("wallet" in result, false);
  }

  it("surfaces unpaid verify as structured 402", async () => {
    const result = (await verifyListing("https://boards.greenhouse.io/example/jobs/1", {
      endpoint: `${origin}/v1/verify`,
    })) as { paid: boolean; http: number; x402Version: number; accepts: Array<{ amount: string; scheme: string }> };
    assertUnpaid402(result, PRICE_ATOMIC_USDC);
  });

  it("surfaces unpaid check as structured 402 without pretending settle succeeded", async () => {
    const result = (await checkListing(
      {
        target: { type: "url", url: "https://boards.greenhouse.io/example/jobs/1", render: "never" },
        condition: { detector: "status_change", params: {} },
      },
      { env: envFor() },
    )) as { paid: boolean; http: number; x402Version: number; accepts: Array<{ amount: string; scheme: string }> };
    assertUnpaid402(result, CHECK_PRICE_ATOMIC_USDC);
  });

  it("surfaces unpaid confirm ($0.10) as structured 402", async () => {
    const result = (await confirmListing(
      { url: "https://example.com/thank-you", intent: "lead_submit" },
      { env: envFor() },
    )) as { paid: boolean; http: number; x402Version: number; accepts: Array<{ amount: string; scheme: string }> };
    assertUnpaid402(result, CONFIRM_PRICE_ATOMIC_USDC);
  });

  it("surfaces unpaid confirm/order ($0.25) as structured 402 on the order route", async () => {
    let capturedUrl = "";
    const result = (await confirmListing(
      { url: "https://shop.example.com/thank-you", intent: "order_placed" },
      {
        env: envFor(),
        fetchImpl: async (input, init) => {
          capturedUrl = String(input);
          return fetch(input, init);
        },
      },
    )) as { paid: boolean; http: number; x402Version: number; accepts: Array<{ amount: string; scheme: string }> };
    assert.match(capturedUrl, /\/v1\/confirm\/order$/);
    assertUnpaid402(result, ORDER_PLACED_PRICE_ATOMIC_USDC);
  });

  it("surfaces unpaid watch as structured 402", async () => {
    const result = (await watchListing(
      {
        target: { type: "url", url: "https://boards.greenhouse.io/example/jobs/1", render: "never" },
        condition: { detector: "status_change", params: {} },
        callback: { url: "https://example.com/hooks/livecheck", secret: "whsec_example", deliver: "on_change" },
        interval_s: 900,
      },
      { env: envFor() },
    )) as { paid: boolean; http: number; x402Version: number; accepts: Array<{ amount: string; scheme: string }> };
    assertUnpaid402(result, WATCH_PRICE_ATOMIC_USDC);
  });

  it("sends owner token on watch follow-ups and still 402s unpaid chain top-up", async () => {
    let getHeaders: Headers | undefined;
    await watchGet("wtc_01MISSING", "owt_01TOKEN", {
      env: envFor(),
      fetchImpl: async (input, init) => {
        getHeaders = new Headers(init?.headers);
        return fetch(input, init);
      },
    }).catch((error: Error & { http?: number }) => {
      assert.equal(error.http, 404);
    });
    assert.equal(getHeaders?.get("x-livecheck-owner-token"), "owt_01TOKEN");

    const topup = (await watchChainTopup("wtc_01MISSING", "owt_01TOKEN", { env: envFor() })) as {
      paid: boolean;
      http: number;
    };
    assert.equal(topup.paid, false);
    assert.equal(topup.http, 402);

    let renewHeaders: Headers | undefined;
    let renewUrl = "";
    const renew = (await watchRenew("wtc_01MISSING", "owt_01TOKEN", {
      env: envFor(),
      fetchImpl: async (input, init) => {
        renewUrl = String(input);
        renewHeaders = new Headers(init?.headers);
        return fetch(input, init);
      },
    })) as { paid: boolean; http: number };
    assert.match(renewUrl, /\/v1\/watch\/renew$/);
    assert.equal(renewHeaders?.get("x-livecheck-owner-token"), "owt_01TOKEN");
    assert.equal(renew.paid, false);
    assert.equal(renew.http, 402);
  });
});
