import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { CONFIRM_PRICE_USD } from "../src/config.js";
import { openApiDocument } from "../src/discovery.js";

describe("GET /stats", () => {
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

  it("returns 200 JSON with lead_submit placeholders and null false-confirmed rate", async () => {
    const res = await fetch(`${origin}/stats`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok?: boolean;
      intents?: {
        lead_submit?: {
          payable?: boolean;
          price_usd?: number;
          l7d?: { paid_calls?: number; receipts?: number };
        };
        listing_published?: {
          payable?: boolean;
          price_usd?: number;
          status?: string;
          l7d?: { paid_calls?: number; receipts?: number };
        };
        order_placed?: {
          payable?: boolean;
          price_usd?: number;
          status?: string;
          l7d?: { paid_calls?: number; receipts?: number };
        };
      };
      benches?: { false_confirmed_rate?: unknown; note?: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.intents?.lead_submit?.payable, true);
    assert.equal(body.intents?.lead_submit?.price_usd, CONFIRM_PRICE_USD);
    assert.equal(typeof body.intents?.lead_submit?.l7d?.paid_calls, "number");
    assert.equal(body.intents?.listing_published?.payable, true);
    assert.equal(body.intents?.listing_published?.price_usd, CONFIRM_PRICE_USD);
    assert.equal(body.intents?.listing_published?.status, "payable");
    assert.equal(typeof body.intents?.listing_published?.l7d?.paid_calls, "number");
    assert.equal(body.intents?.order_placed?.payable, true);
    assert.equal(body.intents?.order_placed?.price_usd, 0.25);
    assert.equal(body.intents?.order_placed?.status, "payable");
    assert.equal(body.benches?.false_confirmed_rate, null);
    assert.match(body.benches?.note ?? "", /not published/i);
  });

  it("GET /v1/judge is a 501 stub and is not 402", async () => {
    const res = await fetch(`${origin}/v1/judge`);
    assert.equal(res.status, 501);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "not_implemented");
  });
});

describe("OpenAPI Confirm v1.0 spine", () => {
  it("documents additive confirm fields and does not list unsupported intents as payable", () => {
    const doc = openApiDocument("https://livecheck.fly.dev/openapi.json") as {
      paths?: {
        "/v1/confirm"?: {
          post?: {
            requestBody?: {
              content?: {
                "application/json"?: {
                  schema?: { properties?: { intent?: { enum?: string[] }; claim?: object } };
                };
              };
            };
            responses?: {
              "200"?: {
                content?: {
                  "application/json"?: {
                    schema?: { properties?: Record<string, unknown>; required?: string[] };
                  };
                };
              };
            };
          };
        };
        "/v1/receipt/{id}"?: object;
        "/stats"?: object;
      };
    };
    const intentEnum = doc.paths?.["/v1/confirm"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties
      ?.intent?.enum;
    assert.deepEqual(intentEnum, ["lead_submit", "listing_published", "order_placed"]);
    assert.ok(
      doc.paths?.["/v1/confirm"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties?.claim,
    );
    const schema = doc.paths?.["/v1/confirm"]?.post?.responses?.["200"]?.content?.["application/json"]?.schema;
    for (const key of ["id", "evidence_level", "confidence", "receipt"]) {
      assert.ok(schema?.properties?.[key], `expected 200 schema property ${key}`);
      assert.ok(schema?.required?.includes(key), `expected required ${key}`);
    }
    assert.ok(doc.paths?.["/v1/receipt/{id}"]);
    assert.ok(doc.paths?.["/stats"]);
  });
});
