import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { WATCH_PRICE_USD } from "../src/config.js";
import { VERIFY_EXAMPLE } from "../src/bazaar.js";
import { openApiDocument } from "../src/discovery.js";
import { decodePaymentRequired } from "../src/x402-payload.js";
import { watchHint } from "../src/watch-hint.js";
import { closeWatchStore, initWatchStore } from "../src/watch-store.js";

type WatchField = {
  suggest?: string;
  detector?: string;
  price_usd?: number;
};

function assertPaidWatchHint(body: { watch?: WatchField }) {
  assert.deepEqual(body.watch, {
    suggest: "/v1/watch",
    detector: "status_change",
    price_usd: 2.5,
  });
  assert.equal(body.watch?.price_usd, WATCH_PRICE_USD);
}

function assertNoWatchField(value: unknown, label: string) {
  assert.equal(value !== null && typeof value === "object" && "watch" in value, false, `${label} must not include watch`);
}

function bazaarOutputExample(decoded: Record<string, unknown>): Record<string, unknown> | undefined {
  const extensions = decoded.extensions as
    | { bazaar?: { info?: { output?: { example?: Record<string, unknown> } } } }
    | undefined;
  return extensions?.bazaar?.info?.output?.example;
}

describe("watchHint helper", () => {
  it("is the fixed Sentinel cross-sell shape", () => {
    assert.deepEqual(watchHint(), {
      suggest: "/v1/watch",
      detector: "status_change",
      price_usd: 2.5,
    });
  });
});

describe("paid Verify / Confirm watch hints", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    initWatchStore(":memory:");
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
    closeWatchStore();
  });

  it("mock-paid POST /v1/verify 200 includes watch", async () => {
    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: `${origin}/fixtures/live-apply-now` }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; watch?: WatchField };
    assert.equal(body.status, "live");
    assertPaidWatchHint(body);
  });

  it("mock-paid POST /v1/confirm 200 includes watch", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/thank-you-id`,
        intent: "lead_submit",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; watch?: WatchField };
    assert.equal(body.verdict, "confirmed");
    assertPaidWatchHint(body);
  });

  it("mock-paid POST /v1/confirm/order 200 includes watch", async () => {
    const res = await fetch(`${origin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/order-thank-you-id`,
        intent: "order_placed",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; watch?: WatchField };
    assert.equal(body.verdict, "confirmed");
    assertPaidWatchHint(body);
  });

  it("unpaid verify/confirm/confirm-order 402 bodies and payment-required headers omit watch", async () => {
    for (const path of ["/v1/verify", "/v1/confirm", "/v1/confirm/order"] as const) {
      const payload =
        path === "/v1/verify"
          ? { url: "https://example.com" }
          : path === "/v1/confirm"
            ? { url: "https://example.com/thank-you", intent: "lead_submit" }
            : { url: "https://shop.example.com/thank-you", intent: "order_placed" };
      const res = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 402, `${path} unpaid`);
      const body = (await res.json()) as Record<string, unknown>;
      assertNoWatchField(body, `${path} 402 JSON`);
      const header = res.headers.get("payment-required");
      assert.ok(header, `${path} payment-required`);
      const decoded = decodePaymentRequired(header);
      assertNoWatchField(decoded, `${path} payment-required`);
      assertNoWatchField(bazaarOutputExample(decoded), `${path} bazaar output example`);
    }
  });

  it("mock-paid POST /v1/check 200 does not include watch (regression)", async () => {
    const res = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "never" },
        condition: { detector: "status_change", params: {} },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { price_usd: number; observation?: { status?: string } };
    assert.equal(body.price_usd, 0.02);
    assert.equal(body.observation?.status, "live");
    assertNoWatchField(body, "check 200");
  });

  it("mock-paid POST /v1/watch 201 does not include a watch hint field (regression)", async () => {
    const res = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "never" },
        condition: { detector: "status_change", params: {} },
        callback: { url: "https://example.com/hooks/livecheck", secret: "whsec_example", deliver: "on_change" },
        interval_s: 900,
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { price_usd: number; tier?: string };
    assert.equal(body.price_usd, 2.5);
    assert.equal(body.tier, "standard");
    assertNoWatchField(body, "watch 201");
  });
});

describe("OpenAPI + bazaar discovery stay 402-clean", () => {
  it("documents watch on verify/confirm 200 schemas", () => {
    const doc = openApiDocument("https://livecheck.fly.dev/openapi.json") as {
      paths?: Record<
        string,
        {
          post?: {
            responses?: {
              "200"?: {
                description?: string;
                content?: { "application/json"?: { schema?: { properties?: { watch?: { properties?: { suggest?: { enum?: string[] } } } } } } };
              };
            };
          };
        }
      >;
    };
    for (const path of ["/v1/verify", "/v1/confirm", "/v1/confirm/order"]) {
      const schema = doc.paths?.[path]?.post?.responses?.["200"]?.content?.["application/json"]?.schema;
      assert.deepEqual(schema?.properties?.watch?.properties?.suggest?.enum, ["/v1/watch"], path);
      assert.match(doc.paths?.[path]?.post?.responses?.["200"]?.description ?? "", /watch suggest/);
    }
    const checkWatch = (
      doc.paths?.["/v1/check"]?.post?.responses?.["200"]?.content?.["application/json"]?.schema as
        | { properties?: { watch?: unknown } }
        | undefined
    )?.properties?.watch;
    assert.equal(checkWatch, undefined);
  });

  it("bazaar verify example used on 402 does not include watch", () => {
    assert.equal("watch" in VERIFY_EXAMPLE, false);
  });
});
