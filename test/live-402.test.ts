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
import { setFacilitatorFetchForTests, wrapFacilitatorForCatalog } from "../src/facilitator-catalog.js";
import {
  livePaymentMiddlewareFromServer,
  resourceServerFromFacilitator,
  shouldMirrorChallengeIntoBody,
} from "../src/payments.js";
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
    assert.ok((resource.description ?? "").length <= 300);
    const accepts = decoded.accepts as Array<{ amount?: string; extra?: { name?: string; version?: string } }>;
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0]?.amount, "2500000");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
    const extensions = decoded.extensions as {
      bazaar?: {
        info?: {
          input?: { method?: string; bodyType?: string; body?: { target?: unknown; callback?: unknown } };
          output?: { example?: { price_usd?: number } };
        };
      };
    };
    assert.ok(extensions?.bazaar, "expected extensions.bazaar in decoded payment-required");
    assert.equal(extensions.bazaar.info?.input?.method, "POST");
    assert.equal(extensions.bazaar.info?.input?.bodyType, "json");
    assert.ok(extensions.bazaar.info?.input?.body?.target);
    assert.ok(extensions.bazaar.info?.input?.body?.callback);
    assert.equal(extensions.bazaar.info?.output?.example?.price_usd, 2.5);
    assertInfoInputMatchesSchema(extensions.bazaar, "live watch 402");
    const header = res.headers.get("payment-required");
    assert.ok(header);
    assert.ok((resource.description ?? "").length <= 300);
  });

  it("logs a paid watch attempt before facilitator handling and the reject reason", async () => {
    const secret = "super-secret-sig";
    const envelope = {
      x402Version: 2,
      resource: {
        url: "https://livecheck.fly.dev/v1/watch",
        description: "d".repeat(743),
        mimeType: "application/json",
      },
      extensions: {},
      accepted: { amount: "2500000", scheme: "exact" },
      payload: { signature: secret },
    };
    const header = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((part) => String(part)).join(" "));
    };
    try {
      const res = await fetch(`${origin}/v1/watch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": header,
        },
        body: JSON.stringify({
          target: { type: "url", url: "https://example.com", render: "never" },
          condition: { detector: "status_change", params: {} },
          callback: { url: "https://example.com/hook", secret: "whsec_x" },
        }),
      });
      assert.equal(res.status, 402);
      const inbound = lines.find((line) => line.startsWith("[livecheck] paid watch inbound"));
      const rejected = lines.find((line) => line.startsWith("[livecheck] paid watch rejected"));
      assert.ok(inbound, `missing inbound log\n${lines.join("\n")}`);
      assert.ok(rejected, `missing rejected log\n${lines.join("\n")}`);
      assert.ok(lines.indexOf(inbound) < lines.indexOf(rejected));
      const summary = JSON.parse(inbound.slice("[livecheck] paid watch inbound ".length)) as {
        header?: string;
        desc_len?: number;
        amount?: string;
        has_bazaar?: boolean;
      };
      assert.equal(summary.header, "payment-signature");
      assert.equal(summary.desc_len, 743);
      assert.equal(summary.amount, "2500000");
      assert.equal(summary.has_bazaar, false);
      assert.doesNotMatch(inbound, /super-secret-sig/);
      const reject = JSON.parse(rejected.slice("[livecheck] paid watch rejected ".length)) as {
        status?: number;
        reason?: string;
      };
      assert.equal(reject.status, 402);
      assert.equal(typeof reject.reason, "string");
      assert.ok((reject.reason ?? "").length > 0);
      assert.doesNotMatch(rejected, /super-secret-sig/);
    } finally {
      console.log = original;
    }
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
  it("mirrors the decoded payment-required challenge into the body on every paid route", async () => {
    const watchBody = {
      target: { type: "url", url: "https://example.com", render: "never" },
      condition: { detector: "status_change", params: {} },
      callback: { url: "https://example.com/hook", secret: "whsec_x" },
    };
    const cases: Array<{ path: string; body?: unknown; amount: string }> = [
      { path: "/v1/verify", body: { url: "https://example.com" }, amount: "10000" },
      { path: "/v1/verify/job", body: { url: "https://boards.greenhouse.io/example/jobs/1842" }, amount: "10000" },
      { path: "/v1/verify/listing", body: { url: "https://example.com/listing/1" }, amount: "10000" },
      { path: "/v1/confirm", body: { url: "https://example.com/thank-you", intent: "lead_submit" }, amount: "100000" },
      {
        path: "/v1/confirm/order",
        body: { url: "https://shop.example.com/thank-you", intent: "order_placed" },
        amount: "250000",
      },
      {
        path: "/v1/check",
        body: { target: watchBody.target, condition: watchBody.condition },
        amount: "20000",
      },
      { path: "/v1/watch", body: watchBody, amount: "2500000" },
      { path: "/v1/watch/renew", body: { id: "wtc_01M26F7JFYRFCCBSQVNW1B0E3M" }, amount: "2500000" },
      { path: "/v1/watch/wtc_01M26F7JFYRFCCBSQVNW1B0E3M/chain/topup", amount: "500000" },
    ];
    for (const entry of cases) {
      const res = await fetch(`${origin}${entry.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(entry.body === undefined ? {} : { body: JSON.stringify(entry.body) }),
      });
      assert.equal(res.status, 402, entry.path);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/, entry.path);
      const fromHeader = decode402(res);
      const text = await res.text();
      assert.notEqual(text.trim(), "{}", `${entry.path} body is no longer {}`);
      const fromBody = JSON.parse(text) as Record<string, unknown>;
      assert.deepEqual(fromBody, fromHeader, `${entry.path}: body equals decoded header`);
      assert.equal(fromBody.x402Version, 2, entry.path);
      const accepts = fromBody.accepts as Array<{ amount?: string }>;
      assert.equal(accepts[0]?.amount, entry.amount, entry.path);
      const resource = fromBody.resource as { url?: string };
      assert.equal(resource.url, `https://livecheck.fly.dev${entry.path}`, entry.path);
    }
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
          extensions: { bazaar: { info: { input: { bodyType: "json" } }, schema: { properties: {} } } },
        },
        "https://livecheck.fly.dev/v1/watch",
        "livecheck.fly.dev",
      );
      assert.deepEqual(decoded.accepts, accepts);
      const resource = decoded.resource as { url: string; description: string };
      assert.equal(resource.url, "https://livecheck.fly.dev/v1/watch");
      assert.equal(resource.description, WATCH_PAYMENT_DESCRIPTION);
      assert.ok((decoded.extensions as { bazaar?: unknown }).bazaar);
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

describe("paid watch 402 carries the full CDP errorMessage", () => {
  const previousPublic = process.env.LIVECHECK_PUBLIC_URL;
  process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
  const tail = "UNIQUE_402_TAIL_x402V2PaymentPayload_full_errorMessage";
  const secret = `0x${"cd".repeat(40)}`;
  const errorMessage = `'paymentPayload' is invalid: must match one of [x402V2PaymentPayload, x402V1PaymentPayload]. ${secret} ${tail}`;
  const cdpBody = JSON.stringify({
    correlationId: "a4057b459beecf2e-IAD",
    errorLink: "https://docs.cdp.coinbase.com/api-reference/v2/errors#invalid-request",
    errorType: "invalid_request",
    errorMessage,
    signature: secret,
  });
  const facilitator: FacilitatorClient = wrapFacilitatorForCatalog({
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
        extensions: [],
        signers: {},
      };
    },
    async verify() {
      const res = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/verify", { method: "POST" });
      const text = await res.text();
      const cut = text.length <= 200 ? text : `${text.slice(0, 197)}...`;
      throw new Error(`Facilitator verify failed (400): ${cut}`);
    },
    async settle() {
      return { success: false, transaction: "", network: NETWORK };
    },
  });
  const app = createApp(
    livePaymentMiddlewareFromServer(resourceServerFromFacilitator(facilitator), MOCK_PAY_TO),
  );
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    setFacilitatorFetchForTests(
      async () => new Response(cdpBody, { status: 400, headers: { "content-type": "application/json" } }),
    );
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
    setFacilitatorFetchForTests(null);
    if (previousPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
    else process.env.LIVECHECK_PUBLIC_URL = previousPublic;
  });

  it("writes the full CDP errorMessage into payment-required.error", async () => {
    const libraryExcerpt = cdpBody.length <= 200 ? cdpBody : `${cdpBody.slice(0, 197)}...`;
    assert.equal(libraryExcerpt.includes(tail), false);
    const unpaid = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { type: "url", url: "https://example.com", render: "never" },
        condition: { detector: "status_change", params: {} },
        callback: { url: "https://example.com/hook", secret: "whsec_x" },
      }),
    });
    assert.equal(unpaid.status, 402);
    const challenge = decodePaymentRequired(unpaid.headers.get("payment-required") ?? "");
    const accepts = challenge.accepts as unknown[];
    assert.equal(accepts.length, 1);
    const envelope = {
      x402Version: 2,
      resource: {
        url: "https://livecheck.fly.dev/v1/watch",
        description: "d".repeat(743),
        mimeType: "application/json",
      },
      accepted: accepts[0],
      payload: { signature: "super-secret-sig", authorization: { from: "0x0561", value: "2500000" } },
    };
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((part) => String(part)).join(" "));
    };
    try {
      const res = await fetch(`${origin}/v1/watch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
        },
        body: JSON.stringify({
          target: { type: "url", url: "https://example.com", render: "never" },
          condition: { detector: "status_change", params: {} },
          callback: { url: "https://example.com/hook", secret: "whsec_x" },
        }),
      });
      assert.equal(res.status, 402);
      const decoded = decodePaymentRequired(res.headers.get("payment-required") ?? "");
      const error = String(decoded.error ?? "");
      assert.match(error, /UNIQUE_402_TAIL_x402V2PaymentPayload_full_errorMessage/);
      assert.match(error, /correlationId=a4057b459beecf2e-IAD/);
      assert.doesNotMatch(error, new RegExp(secret));
      assert.doesNotMatch(error, /super-secret-sig/);
      const rejected = lines.find((line) => line.startsWith("[livecheck] paid watch rejected"));
      assert.ok(rejected);
      assert.match(rejected, /UNIQUE_402_TAIL_x402V2PaymentPayload_full_errorMessage/);
      assert.doesNotMatch(rejected, new RegExp(secret));
      const facilitator = lines.find((line) => line.startsWith("[livecheck] facilitator verify"));
      assert.ok(facilitator);
      assert.match(facilitator, /UNIQUE_402_TAIL_x402V2PaymentPayload_full_errorMessage/);
      assert.match(facilitator, /"description_clamped":true/);
    } finally {
      console.log = original;
    }
  });
});

describe("shouldMirrorChallengeIntoBody", () => {
  it("replaces only an empty or {} JSON body, never HTML or a body that says something", () => {
    assert.equal(shouldMirrorChallengeIntoBody("application/json", "{}"), true);
    assert.equal(shouldMirrorChallengeIntoBody("application/json; charset=UTF-8", " { } "), true);
    assert.equal(shouldMirrorChallengeIntoBody(null, ""), true);
    assert.equal(shouldMirrorChallengeIntoBody("text/html; charset=UTF-8", "{}"), false);
    assert.equal(shouldMirrorChallengeIntoBody("text/html", "<html>paywall</html>"), false);
    assert.equal(shouldMirrorChallengeIntoBody("application/json", '{"error":"payment_amount_insufficient"}'), false);
    assert.equal(shouldMirrorChallengeIntoBody("application/json", "[]"), false);
    assert.equal(shouldMirrorChallengeIntoBody("application/json", "not json"), false);
  });
});
