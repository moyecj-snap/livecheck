import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.js";
import {
  CONFIRM_DESCRIPTION,
  MOCK_PAY_TO,
  NETWORK,
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
        description?: string;
        "x-guidance"?: string;
        tags?: string[];
        "x-payment-info"?: {
          price?: { mode?: string; currency?: string; amount?: string };
        };
        requestBody?: {
          content?: { "application/json"?: { schema?: { required?: string[] } } };
        };
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
    assert.equal(confirm.description, CONFIRM_DESCRIPTION);
    assert.equal(confirm["x-guidance"], CONFIRM_DESCRIPTION);
    assert.match(confirm.description ?? "", /Livecheck/);
    assert.ok(confirm.tags?.includes("Livecheck"));
    assert.notEqual(confirm.description, VERIFY_DESCRIPTION);
    assert.equal(confirm["x-payment-info"]?.price?.amount, "0.10");
    assert.deepEqual(confirm.requestBody?.content?.["application/json"]?.schema?.required, ["url", "intent"]);
  });

  it("GET /.well-known/x402 is free 200 JSON listing the verify URL", async () => {
    const res = await fetch(`${origin}/.well-known/x402`);
    assertJsonDiscovery(res, ".well-known/x402");
    const body = (await res.json()) as { version?: number; resources?: unknown };
    assert.equal(body.version, 1);
    assert.deepEqual(body.resources, [
      "https://livecheck.fly.dev/v1/verify",
      "https://livecheck.fly.dev/v1/confirm",
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
    const verify = await fetch(`${origin}/v1/verify`, { method: "POST" });
    assert.equal(verify.status, 402);
  });
});
