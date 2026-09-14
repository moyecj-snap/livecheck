import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.js";
import {
  CHAIN_TOPUP_PAYMENT_DESCRIPTION,
  CHECK_PAYMENT_DESCRIPTION,
  CONFIRM_PAYMENT_DESCRIPTION,
  WATCH_PAYMENT_DESCRIPTION,
  WATCH_RENEW_PAYMENT_DESCRIPTION,
  MOCK_PAY_TO,
  NETWORK,
  ORDER_PAYMENT_DESCRIPTION,
  VERIFY_DESCRIPTION,
} from "../src/config.js";
import { livePaymentMiddlewareFromServer, resourceServerFromFacilitator } from "../src/payments.js";
import { advertisePaymentRequired, decodePaymentRequired } from "../src/x402-payload.js";
import { assertInfoInputMatchesSchema } from "./bazaar-schema.js";

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

function decode402(res: Response): Record<string, unknown> {
  const header = res.headers.get("payment-required");
  assert.ok(header, "expected payment-required header");
  return decodePaymentRequired(header);
}

describe("live @x402/hono 402 (decoded payment-required)", () => {
  const previousPublic = process.env.LIVECHECK_PUBLIC_URL;
  const previousFly = process.env.FLY_APP_NAME;
  process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
  delete process.env.FLY_APP_NAME;

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
    if (previousFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = previousFly;
  });

  it("decodes https resource URL and bazaar from the library payment-required header", async () => {
    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(res.status, 402);
    const decoded = decode402(res);
    const resource = decoded.resource as { url?: string; description?: string };
    assert.equal(resource.url, "https://livecheck.fly.dev/v1/verify");
    assert.equal(resource.description, VERIFY_DESCRIPTION);
    assert.match(resource.description ?? "", /not a search engine/i);
    const extensions = decoded.extensions as {
      bazaar?: { info?: { input?: { bodyType?: string; body?: { url?: string }; method?: string } } };
    };
    assert.ok(extensions?.bazaar, "expected extensions.bazaar in decoded payment-required");
    assert.equal(extensions.bazaar?.info?.input?.bodyType, "json");
    assert.equal(extensions.bazaar?.info?.input?.method, "POST");
    assert.equal(typeof extensions.bazaar?.info?.input?.body?.url, "string");
    assert.equal(decoded.x402Version, 2);
    const accepts = decoded.accepts as Array<{ amount?: string; scheme?: string }>;
    assert.equal(accepts[0]?.scheme, "exact");
    assert.equal(accepts[0]?.amount, "10000");
    assertInfoInputMatchesSchema(extensions.bazaar, "live @x402/hono 402");
  });

  it("confirm 402 uses Livecheck Confirm copy (verify-shaped resource fields)", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/thank-you", intent: "lead_submit" }),
    });
    assert.equal(res.status, 402);
    const decoded = decode402(res);
    const resource = decoded.resource as {
      url?: string;
      description?: string;
      serviceName?: string;
      tags?: string[];
    };
    assert.equal(resource.url, "https://livecheck.fly.dev/v1/confirm");
    assert.equal(resource.description, CONFIRM_PAYMENT_DESCRIPTION);
    assert.match(resource.description ?? "", /Livecheck/);
    assert.notEqual(resource.description, VERIFY_DESCRIPTION);
    const accepts = decoded.accepts as Array<{ amount?: string; extra?: { name?: string; version?: string } }>;
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0]?.amount, "100000");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
  });

  it("check 402 is one $0.02 accept with verify-shaped extra", async () => {
    const res = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { type: "url", url: "https://example.com", render: "never" },
        condition: { detector: "status_change", params: {} },
      }),
    });
    assert.equal(res.status, 402);
    const decoded = decode402(res);
    const resource = decoded.resource as { url?: string; description?: string };
    assert.equal(resource.url, "https://livecheck.fly.dev/v1/check");
    assert.equal(resource.description, CHECK_PAYMENT_DESCRIPTION);
    const accepts = decoded.accepts as Array<{ amount?: string; extra?: { name?: string; version?: string } }>;
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0]?.amount, "20000");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
  });

  it("watch 402 is one $2.50 accept with verify-shaped extra", async () => {
    const res = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { type: "url", url: "https://example.com", render: "never" },
        condition: { detector: "status_change", params: {} },
        callback: { url: "https://example.com/hook", secret: "whsec_x" },
      }),
    });
    assert.equal(res.status, 402);
    const decoded = decode402(res);
    const resource = decoded.resource as { url?: string; description?: string };
    assert.equal(resource.url, "https://livecheck.fly.dev/v1/watch");
    assert.equal(resource.description, WATCH_PAYMENT_DESCRIPTION);
    const accepts = decoded.accepts as Array<{ amount?: string; extra?: { name?: string; version?: string } }>;
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0]?.amount, "2500000");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
  });

  it("watch renew 402 is one $2.50 accept with the concrete renew URL", async () => {
    const res = await fetch(`${origin}/v1/watch/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "wtc_01M26F7JFYRFCCBSQVNW1B0E3M" }),
    });
    assert.equal(res.status, 402);
    const decoded = decode402(res);
    const resource = decoded.resource as { url?: string; description?: string };
    assert.equal(resource.url, "https://livecheck.fly.dev/v1/watch/renew");
    assert.equal(resource.description, WATCH_RENEW_PAYMENT_DESCRIPTION);
    const accepts = decoded.accepts as Array<{ amount?: string; extra?: { name?: string; version?: string } }>;
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0]?.amount, "2500000");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
  });

  it("chain topup 402 is one $0.50 accept with the watcher URL pinned", async () => {
    const res = await fetch(`${origin}/v1/watch/wtc_01M26F7JFYRFCCBSQVNW1B0E3M/chain/topup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 402);
    const decoded = decode402(res);
    const resource = decoded.resource as { url?: string; description?: string };
    assert.equal(resource.url, "https://livecheck.fly.dev/v1/watch/wtc_01M26F7JFYRFCCBSQVNW1B0E3M/chain/topup");
    assert.equal(resource.description, CHAIN_TOPUP_PAYMENT_DESCRIPTION);
    const accepts = decoded.accepts as Array<{ amount?: string; extra?: { name?: string; version?: string } }>;
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0]?.amount, "500000");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
  });

  it("confirm/order 402 is one $0.25 accept with verify-shaped extra", async () => {
    const res = await fetch(`${origin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://shop.example.com/thank-you", intent: "order_placed" }),
    });
    assert.equal(res.status, 402);
    const decoded = decode402(res);
    const resource = decoded.resource as { url?: string; description?: string };
    assert.equal(resource.url, "https://livecheck.fly.dev/v1/confirm/order");
    assert.equal(resource.description, ORDER_PAYMENT_DESCRIPTION);
    const accepts = decoded.accepts as Array<{ amount?: string; extra?: { name?: string; version?: string } }>;
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0]?.amount, "250000");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
  });
});

describe("live 402 with FLY_APP_NAME and an http request URL", () => {
  const previousPublic = process.env.LIVECHECK_PUBLIC_URL;
  const previousFly = process.env.FLY_APP_NAME;
  delete process.env.LIVECHECK_PUBLIC_URL;
  process.env.FLY_APP_NAME = "livecheck";

  const gate = livePaymentMiddlewareFromServer(
    resourceServerFromFacilitator(stubFacilitator()),
    MOCK_PAY_TO,
  );
  const app = createApp(gate);

  after(() => {
    if (previousPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
    else process.env.LIVECHECK_PUBLIC_URL = previousPublic;
    if (previousFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = previousFly;
  });

  it("pins https://livecheck.fly.dev/v1/verify from FLY_APP_NAME (decoded header)", async () => {
    const res = await app.request("http://livecheck.fly.dev/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(res.status, 402);
    const decoded = decode402(res);
    const resource = decoded.resource as { url?: string; description?: string };
    assert.equal(resource.url, "https://livecheck.fly.dev/v1/verify");
    assert.notEqual(resource.url, "http://livecheck.fly.dev/v1/verify");
    assert.equal(resource.description, VERIFY_DESCRIPTION);
    const extensions = decoded.extensions as { bazaar?: unknown };
    assert.ok(extensions?.bazaar, "expected extensions.bazaar in decoded payment-required");
  });
});

describe("advertisePaymentRequired on a production-shaped 402", () => {
  it("does not change payment-requirements matching fields on accepts[]", () => {
    const accepts = [
      {
        scheme: "exact",
        network: NETWORK,
        amount: "100000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: MOCK_PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ];
    const previousPublic = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      const decoded = advertisePaymentRequired(
        {
          x402Version: 2,
          error: "Payment required",
          resource: {
            url: "https://livecheck.fly.dev/v1/confirm",
            description: CONFIRM_PAYMENT_DESCRIPTION,
            mimeType: "application/json",
          },
          accepts: structuredClone(accepts),
        },
        "https://livecheck.fly.dev/v1/confirm",
        "livecheck.fly.dev",
      );
      assert.deepEqual(decoded.accepts, accepts);
      const resource = decoded.resource as { url: string; description: string };
      assert.equal(resource.url, "https://livecheck.fly.dev/v1/confirm");
      assert.equal(resource.description, CONFIRM_PAYMENT_DESCRIPTION);
    } finally {
      if (previousPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previousPublic;
    }
  });

  it("does not change check 402 matching fields (amount 20000)", () => {
    const accepts = [
      {
        scheme: "exact",
        network: NETWORK,
        amount: "20000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: MOCK_PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ];
    const previousPublic = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      const decoded = advertisePaymentRequired(
        {
          x402Version: 2,
          error: "Payment required",
          resource: {
            url: "https://livecheck.fly.dev/v1/check",
            description: CHECK_PAYMENT_DESCRIPTION,
            mimeType: "application/json",
          },
          accepts: structuredClone(accepts),
        },
        "https://livecheck.fly.dev/v1/check",
        "livecheck.fly.dev",
      );
      assert.deepEqual(decoded.accepts, accepts);
      const resource = decoded.resource as { url: string; description: string };
      assert.equal(resource.url, "https://livecheck.fly.dev/v1/check");
      assert.equal(resource.description, CHECK_PAYMENT_DESCRIPTION);
    } finally {
      if (previousPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previousPublic;
    }
  });

  it("does not change watch 402 matching fields (amount 2500000)", () => {
    const accepts = [
      {
        scheme: "exact",
        network: NETWORK,
        amount: "2500000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: MOCK_PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ];
    const previousPublic = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      const decoded = advertisePaymentRequired(
        {
          x402Version: 2,
          error: "Payment required",
          resource: {
            url: "https://livecheck.fly.dev/v1/watch",
            description: WATCH_PAYMENT_DESCRIPTION,
            mimeType: "application/json",
          },
          accepts: structuredClone(accepts),
        },
        "https://livecheck.fly.dev/v1/watch",
        "livecheck.fly.dev",
      );
      assert.deepEqual(decoded.accepts, accepts);
      const resource = decoded.resource as { url: string; description: string };
      assert.equal(resource.url, "https://livecheck.fly.dev/v1/watch");
      assert.equal(resource.description, WATCH_PAYMENT_DESCRIPTION);
    } finally {
      if (previousPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previousPublic;
    }
  });

  it("upgrades the decoded http Fly 402 to https + bazaar + agent description", () => {
    const previousPublic = process.env.LIVECHECK_PUBLIC_URL;
    const previousFly = process.env.FLY_APP_NAME;
    delete process.env.LIVECHECK_PUBLIC_URL;
    delete process.env.FLY_APP_NAME;
    try {
      const decoded = advertisePaymentRequired(
        {
          x402Version: 2,
          error: "Payment required",
          resource: {
            url: "http://livecheck.fly.dev/v1/verify",
            description: "Primary-source live check",
            mimeType: "application/json",
          },
          accepts: [],
        },
        "http://livecheck.fly.dev/v1/verify",
        "livecheck.fly.dev",
      );
      const resource = decoded.resource as { url: string; description: string };
      assert.equal(resource.url, "https://livecheck.fly.dev/v1/verify");
      assert.equal(resource.description, VERIFY_DESCRIPTION);
      assert.ok((decoded.extensions as { bazaar?: unknown }).bazaar);
    } finally {
      if (previousPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previousPublic;
      if (previousFly === undefined) delete process.env.FLY_APP_NAME;
      else process.env.FLY_APP_NAME = previousFly;
    }
  });
});
