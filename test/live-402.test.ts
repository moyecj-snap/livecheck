import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.js";
import { MOCK_PAY_TO, NETWORK, VERIFY_DESCRIPTION } from "../src/config.js";
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
    assert.match(resource.description ?? "", /Not a search engine/);
    const extensions = decoded.extensions as {
      bazaar?: { info?: { input?: { bodyType?: string; body?: { url?: string }; method?: string } } };
    };
    assert.ok(extensions?.bazaar, "expected extensions.bazaar in decoded payment-required");
    assert.equal(extensions.bazaar?.info?.input?.bodyType, "json");
    assert.equal(extensions.bazaar?.info?.input?.method, "POST");
    assert.equal(typeof extensions.bazaar?.info?.input?.body?.url, "string");
    assert.equal(decoded.x402Version, 2);
    assertInfoInputMatchesSchema(extensions.bazaar, "live @x402/hono 402");
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
