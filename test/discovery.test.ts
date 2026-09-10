import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.js";
import {
  CONFIRM_DESCRIPTION,
  MOCK_PAY_TO,
  NETWORK,
  OPENAPI_CONFIRM_DESCRIPTION,
  OPENAPI_CONFIRM_SUMMARY,
  PRICE_ATOMIC_USDC,
  PRICE_USD,
  VERIFY_DESCRIPTION,
} from "../src/config.js";
import { livePaymentMiddlewareFromServer, resourceServerFromFacilitator } from "../src/payments.js";

function stubFacilitator(): FacilitatorClient {
  return {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
        extensions: ["bazaar"],
        signers: {},
      };
    },
    async verify() {
      return { isValid: false, invalidReason: "test-unpaid" };
    },
    async settle() {
      return { success: false, transaction: "", network: NETWORK };
    },
  };
}

type OpenApiDoc = {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string; "x-guidance"?: string };
  paths?: {
    "/v1/verify"?: {
      post?: {
        "x-payment-info"?: {
          price?: { mode?: string; currency?: string; amount?: string };
          protocols?: Array<{ x402?: object }>;
        };
        requestBody?: {
          content?: { "application/json"?: { schema?: { properties?: { url?: object }; required?: string[] } } };
        };
        responses?: {
          "200"?: { content?: { "application/json"?: { schema?: { properties?: { status?: { enum?: string[] } } } } } };
          "402"?: object;
        };
      };
    };
    "/v1/confirm"?: {
      post?: {
        summary?: string;
        description?: string;
        "x-guidance"?: string;
        tags?: string[];
        "x-payment-info"?: {
          price?: { mode?: string; currency?: string; amount?: string };
          intent_prices?: unknown;
        };
        requestBody?: {
          content?: {
            "application/json"?: {
              schema?: {
                required?: string[];
                properties?: { intent?: { description?: string; enum?: string[] } };
              };
            };
          };
        };
        responses?: { "402"?: { description?: string } };
      };
    };
  };
};

function assertJsonDiscovery(res: Response, label: string) {
  assert.equal(res.status, 200, `${label}: expected 200`);
  assert.notEqual(res.status, 402, `${label}: discovery must not 402`);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(res.headers.get("payment-required"), null);
}

describe("discovery documents (mock gate)", () => {
  const previous = process.env.LIVECHECK_PUBLIC_URL;
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => {
    close();
    if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
    else process.env.LIVECHECK_PUBLIC_URL = previous;
  });

  it("GET /openapi.json is free 200 JSON with x-payment-info and url body", async () => {
    const res = await fetch(`${origin}/openapi.json`);
    assertJsonDiscovery(res, "openapi.json");
    const doc = (await res.json()) as OpenApiDoc;
    assert.equal(doc.openapi, "3.1.0");
    assert.equal(doc.info?.title, "Livecheck");
    assert.ok(doc.info?.version);
    assert.equal(doc.info?.description, VERIFY_DESCRIPTION);
    assert.equal(doc.info?.["x-guidance"], VERIFY_DESCRIPTION);
    assert.match(VERIFY_DESCRIPTION, /not a search engine/i);
    const op = doc.paths?.["/v1/verify"]?.post;
    assert.ok(op, "expected POST /v1/verify");
    assert.equal(op["x-payment-info"]?.price?.mode, "fixed");
    assert.equal(op["x-payment-info"]?.price?.currency, "USD");
    assert.equal(op["x-payment-info"]?.price?.amount, "0.01");
    assert.notEqual(op["x-payment-info"]?.price?.amount, PRICE_ATOMIC_USDC);
    assert.ok(op["x-payment-info"]?.protocols?.some((p) => p.x402 !== undefined));
    assert.ok(op.requestBody?.content?.["application/json"]?.schema?.properties?.url);
    assert.deepEqual(op.requestBody?.content?.["application/json"]?.schema?.required, ["url"]);
    assert.ok(op.responses?.["402"]);
    assert.deepEqual(
      op.responses?.["200"]?.content?.["application/json"]?.schema?.properties?.status?.enum,
      ["live", "closed", "unknown"],
    );
    const confirm = doc.paths?.["/v1/confirm"]?.post;
    assert.ok(confirm, "expected POST /v1/confirm");
    assert.equal(confirm.summary, OPENAPI_CONFIRM_SUMMARY);
    assert.equal(confirm.description, OPENAPI_CONFIRM_DESCRIPTION);
    assert.equal(confirm["x-guidance"], OPENAPI_CONFIRM_DESCRIPTION);
    assert.notEqual(confirm.description, CONFIRM_DESCRIPTION);
    assert.match(confirm.description ?? "", /POST \/v1\/confirm\/order \(\$0\.25\)/);
    assert.match(confirm.description ?? "", /GET \/stats/);
    assert.deepEqual(confirm.tags, ["Confirm", "lead_submit", "side-effect"]);
    assert.notEqual(confirm.description, VERIFY_DESCRIPTION);
    assert.equal(confirm["x-payment-info"]?.price?.amount, "0.10");
    assert.equal(confirm["x-payment-info"]?.intent_prices, undefined);
    assert.deepEqual(confirm.requestBody?.content?.["application/json"]?.schema?.required, ["url", "intent"]);
    assert.deepEqual(confirm.requestBody?.content?.["application/json"]?.schema?.properties?.intent?.enum, [
      "lead_submit",
      "listing_published",
    ]);
    assert.match(
      confirm.requestBody?.content?.["application/json"]?.schema?.properties?.intent?.description ?? "",
      /claim\.title\/sku\/id optional/,
    );
    assert.match(confirm.responses?.["402"]?.description ?? "", /\$0\.10/);
    const check = (doc.paths as Record<string, { post?: typeof confirm }>)?.["/v1/check"]?.post;
    assert.ok(check, "expected POST /v1/check");
    assert.equal(check["x-payment-info"]?.price?.amount, "0.02");
    assert.equal(check["x-payment-info"]?.intent_prices, undefined);
    const watch = (doc.paths as Record<string, { post?: typeof confirm }>)?.["/v1/watch"]?.post;
    assert.ok(watch, "expected POST /v1/watch");
    assert.equal(watch["x-payment-info"]?.price?.amount, "2.50");
    assert.equal(watch["x-payment-info"]?.intent_prices, undefined);
    const order = (doc.paths as Record<string, { post?: typeof confirm }>)?.["/v1/confirm/order"]?.post;
    assert.ok(order, "expected POST /v1/confirm/order");
    assert.equal(order["x-payment-info"]?.price?.amount, "0.25");
    assert.equal(order["x-payment-info"]?.intent_prices, undefined);
    assert.deepEqual(order.requestBody?.content?.["application/json"]?.schema?.properties?.intent?.enum, [
      "order_placed",
    ]);
  });

  it("GET /.well-known/x402 is free 200 JSON listing the verify URL", async () => {
    const res = await fetch(`${origin}/.well-known/x402`);
    assertJsonDiscovery(res, ".well-known/x402");
    const body = (await res.json()) as { version?: number; resources?: unknown };
    assert.equal(body.version, 1);
    assert.deepEqual(body.resources, [
      "https://livecheck.fly.dev/v1/verify",
      "https://livecheck.fly.dev/v1/check",
      "https://livecheck.fly.dev/v1/watch",
      "https://livecheck.fly.dev/v1/confirm",
      "https://livecheck.fly.dev/v1/confirm/order",
    ]);
    assert.ok(Array.isArray(body.resources));
    assert.equal(typeof body.resources[0], "string");
  });

  it("empty POST /v1/verify still reaches a parseable 402 (not 400)", async () => {
    const res = await fetch(`${origin}/v1/verify`, { method: "POST" });
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header, "expected payment-required header");
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts?: Array<{ amount?: string }>;
    };
    assert.equal(decoded.accepts?.[0]?.amount, PRICE_ATOMIC_USDC);
    assert.equal(decoded.accepts?.[0]?.amount, "10000");
    assert.equal(PRICE_USD, 0.01);
  });
});

describe("discovery documents (live @x402/hono gate)", () => {
  const previousPublic = process.env.LIVECHECK_PUBLIC_URL;
  process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
  const gate = livePaymentMiddlewareFromServer(
    resourceServerFromFacilitator(stubFacilitator()),
    MOCK_PAY_TO,
  );
  const app = createApp(gate);
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

  after(() => {
    close();
    if (previousPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
    else process.env.LIVECHECK_PUBLIC_URL = previousPublic;
  });

  it("does not 402 OpenAPI or well-known under the live payment middleware", async () => {
    const openapi = await fetch(`${origin}/openapi.json`);
    assertJsonDiscovery(openapi, "live openapi.json");
    const wellKnown = await fetch(`${origin}/.well-known/x402`);
    assertJsonDiscovery(wellKnown, "live .well-known/x402");
    const keys = await fetch(`${origin}/.well-known/livecheck-keys.json`);
    assertJsonDiscovery(keys, "live .well-known/livecheck-keys.json");
    const stats = await fetch(`${origin}/stats`);
    assert.equal(stats.status, 200, "GET /stats must not 402");
    const verify = await fetch(`${origin}/v1/verify`, { method: "POST" });
    assert.equal(verify.status, 402);
  });
});
