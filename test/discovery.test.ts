import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  OPENAPI_INFO_DESCRIPTION,
  OPENAPI_INFO_GUIDANCE,
  OPENAPI_INFO_TAGS,
  OPENAPI_INFO_TITLE,
  OPENAPI_VERIFY_DESCRIPTION,
  OPENAPI_VERIFY_JOB_DESCRIPTION,
  OPENAPI_VERIFY_JOB_SUMMARY,
  OPENAPI_VERIFY_JOB_TAGS,
  OPENAPI_VERIFY_LISTING_DESCRIPTION,
  OPENAPI_VERIFY_LISTING_SUMMARY,
  OPENAPI_VERIFY_LISTING_TAGS,
  OPENAPI_VERIFY_SUMMARY,
  OPENAPI_VERIFY_TAGS,
  VERIFY_DESCRIPTION,
} from "../src/config.js";
import { PAID_DISCOVERY_ROUTES, WELL_KNOWN_X402_ROUTES } from "../src/discovery.js";
import { LLMS_TXT } from "../src/llms.js";
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
  info?: {
    title?: string;
    version?: string;
    description?: string;
    "x-guidance"?: string;
    "x-tags"?: string[];
  };
  paths?: {
    "/v1/verify"?: {
      post?: {
        summary?: string;
        description?: string;
        "x-guidance"?: string;
        tags?: string[];
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

function assertLlmsTxt(res: Response, body: string) {
  assert.equal(res.status, 200, "GET /llms.txt must be 200");
  assert.notEqual(res.status, 402, "GET /llms.txt must not 402");
  assert.equal(res.headers.get("payment-required"), null);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match(res.headers.get("content-type") ?? "", /charset=utf-8/i);
  const file = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.equal(body, file);
  assert.equal(body, LLMS_TXT);
  assert.match(body, /Live status of a specific product page/);
  assert.match(body, /Livecheck is not a search engine/);
  const endpointLines = body
    .split("## Endpoints\n")[1]
    ?.split("## How to act on Verify")[0]
    ?.split("\n")
    .filter((line) => line.startsWith("- "));
  assert.ok(endpointLines && endpointLines.length >= 3, "expected endpoint lines");
  assert.equal(
    endpointLines[0],
    '- POST /v1/verify/job ($0.01) — is this specific job posting still open? body {"url"} → {status: live|closed|unknown, title, signals[], confidence}',
  );
  assert.equal(
    endpointLines[1],
    '- POST /v1/verify/listing ($0.01) — is this product listing still available or sold out? body {"url"} → same response',
  );
  assert.match(endpointLines[2] ?? "", /^- POST \/v1\/verify \(\$0\.01\)/);
  assert.match(body, /POST \/v1\/verify \(\$0\.01\)/);
  assert.doesNotMatch(body, /\/v1\/judge/);
  assert.match(body, /POST \/v1\/check \(\$0\.02\)/);
  assert.match(body, /POST \/v1\/watch \(\$2\.50\)/);
  assert.match(body, /POST \/v1\/watch\/renew \(\$2\.50\)/);
  assert.match(body, /HTTPS callback optional/);
  assert.match(body, /headline counts include internal test traffic/);
  assert.doesNotMatch(body, /<org>/);
  assert.match(body, /GET \/v1\/watch\/\{id\}\/events/);
  assert.match(body, /POST \/v1\/confirm \(\$0\.10\)/);
  assert.match(body, /POST \/v1\/confirm\/order \(\$0\.25\)/);
  assert.match(body, /GET \/v1\/receipt\/\{id\}/);
  assert.match(body, /https:\/\/github\.com\/moyecj-snap\/livecheck-skills/);
  assert.match(body, /npx agentcash@latest add https:\/\/livecheck\.fly\.dev/);
  assert.match(body, /does not run JavaScript/);
  assert.doesNotMatch(body, /in_stock/);
  assert.doesNotMatch(body, /invalid_url/);
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
    assert.equal(doc.info?.title, OPENAPI_INFO_TITLE);
    assert.equal(doc.info?.title, "Livecheck: Live Listing Status");
    assert.ok((doc.info?.title ?? "").length <= 32);
    assert.ok(doc.info?.version);
    assert.equal(doc.info?.description, OPENAPI_INFO_DESCRIPTION);
    assert.equal(doc.info?.["x-guidance"], OPENAPI_INFO_GUIDANCE);
    const infoGuidance = doc.info?.["x-guidance"] ?? "";
    assert.equal(infoGuidance.startsWith("Is this job posting still open?"), true);
    const jobIdx = infoGuidance.indexOf("/v1/verify/job");
    const listingIdx = infoGuidance.indexOf("/v1/verify/listing");
    const genericIdx = infoGuidance.search(/\/v1\/verify(?!\/)/);
    assert.ok(jobIdx >= 0, "guidance must name /v1/verify/job");
    assert.ok(listingIdx > jobIdx, "guidance must name /v1/verify/listing after /v1/verify/job");
    assert.ok(genericIdx > listingIdx, "generic /v1/verify must follow job and listing");
    assert.deepEqual(doc.info?.["x-tags"], [...OPENAPI_INFO_TAGS]);
    assert.equal((doc.info as { iconUrl?: string } | undefined)?.iconUrl, undefined);
    assert.notEqual(doc.info?.description, VERIFY_DESCRIPTION);
    assert.match(VERIFY_DESCRIPTION, /not a search engine/i);
    const op = doc.paths?.["/v1/verify"]?.post;
    assert.ok(op, "expected POST /v1/verify");
    assert.equal(op.summary, OPENAPI_VERIFY_SUMMARY);
    assert.equal(op.description, OPENAPI_VERIFY_DESCRIPTION);
    assert.equal(op["x-guidance"], OPENAPI_VERIFY_DESCRIPTION);
    assert.deepEqual(op.tags, [...OPENAPI_VERIFY_TAGS]);
    assert.notEqual(op.description, VERIFY_DESCRIPTION);
    assert.ok((op.description ?? "").length > 500, "route copy is catalog text, not the 402 description");
    const paths = doc.paths as Record<string, { post?: typeof op; get?: unknown }>;
    assert.equal(paths["/v1/judge"], undefined, "GET /v1/judge stays a code stub and is not in OpenAPI");
    const job = paths["/v1/verify/job"]?.post;
    assert.ok(job, "expected POST /v1/verify/job");
    assert.equal((job as { operationId?: string }).operationId, "verifyJob");
    assert.equal(job.summary, OPENAPI_VERIFY_JOB_SUMMARY);
    assert.equal(job.description, OPENAPI_VERIFY_JOB_DESCRIPTION);
    assert.equal(job["x-guidance"], OPENAPI_VERIFY_JOB_DESCRIPTION);
    assert.deepEqual(job.tags, [...OPENAPI_VERIFY_JOB_TAGS]);
    assert.equal(job["x-payment-info"]?.price?.amount, "0.01");
    const listing = paths["/v1/verify/listing"]?.post;
    assert.ok(listing, "expected POST /v1/verify/listing");
    assert.equal((listing as { operationId?: string }).operationId, "verifyProductListing");
    assert.equal(listing.summary, OPENAPI_VERIFY_LISTING_SUMMARY);
    assert.equal(listing.description, OPENAPI_VERIFY_LISTING_DESCRIPTION);
    assert.equal(listing["x-guidance"], OPENAPI_VERIFY_LISTING_DESCRIPTION);
    assert.deepEqual(listing.tags, [...OPENAPI_VERIFY_LISTING_TAGS]);
    assert.equal(listing["x-payment-info"]?.price?.amount, "0.01");
    const routeOf = (operation: typeof op) =>
      (
        operation?.responses as {
          "200"?: {
            content?: {
              "application/json"?: {
                example?: { route?: string };
                schema?: { properties?: { route?: { enum?: string[] } }; required?: string[] };
              };
            };
          };
        }
      )?.["200"]?.content?.["application/json"];
    assert.equal(routeOf(op)?.example?.route, "verify");
    assert.equal(routeOf(job)?.example?.route, "verify/job");
    assert.equal(routeOf(listing)?.example?.route, "verify/listing");
    assert.ok(routeOf(op)?.schema?.required?.includes("route"));
    assert.deepEqual(routeOf(job)?.schema?.properties?.route?.enum, ["verify", "verify/job", "verify/listing"]);
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
    assert.deepEqual(watch.requestBody?.content?.["application/json"]?.schema?.required, ["target", "condition"]);
    const renew = (doc.paths as Record<string, { post?: typeof confirm }>)?.["/v1/watch/renew"]?.post;
    assert.ok(renew, "expected POST /v1/watch/renew");
    assert.equal(renew["x-payment-info"]?.price?.amount, "2.50");
    assert.equal(renew["x-payment-info"]?.intent_prices, undefined);
    const topup = (doc.paths as Record<string, { post?: typeof confirm }>)?.["/v1/watch/{id}/chain/topup"]?.post;
    assert.ok(topup, "expected POST /v1/watch/{id}/chain/topup");
    assert.equal(topup["x-payment-info"]?.price?.amount, "0.50");
    assert.equal(topup["x-payment-info"]?.intent_prices, undefined);
    const order = (doc.paths as Record<string, { post?: typeof confirm }>)?.["/v1/confirm/order"]?.post;
    assert.ok(order, "expected POST /v1/confirm/order");
    assert.equal(order["x-payment-info"]?.price?.amount, "0.25");
    assert.equal(order["x-payment-info"]?.intent_prices, undefined);
    assert.deepEqual(order.requestBody?.content?.["application/json"]?.schema?.properties?.intent?.enum, [
      "order_placed",
    ]);
    assert.equal(
      WELL_KNOWN_X402_ROUTES.some((r) => r.path.includes("{id}")),
      false,
      "well-known routes must be concrete",
    );
    assert.ok(PAID_DISCOVERY_ROUTES.some((r) => r.path === "/v1/watch/{id}/chain/topup"));
    const paid = PAID_DISCOVERY_ROUTES;
    for (const route of paid) {
      const routeOp = paths[route.path]?.post as
        | {
            "x-payment-info"?: {
              price?: { mode?: string; currency?: string; amount?: string };
              intent_prices?: unknown;
            };
          }
        | undefined;
      assert.ok(routeOp, `expected POST ${route.path}`);
      assert.equal(routeOp["x-payment-info"]?.price?.mode, "fixed", `${route.path} must be fixed`);
      assert.equal(routeOp["x-payment-info"]?.price?.currency, "USD");
      assert.equal(routeOp["x-payment-info"]?.price?.amount, route.amount);
      assert.equal(routeOp["x-payment-info"]?.intent_prices, undefined, `${route.path} must have one price, no intent_prices`);
    }
    const stats = paths["/stats"] as { get?: { description?: string; tags?: string[] } } | undefined;
    assert.match(stats?.get?.description ?? "", /Sentinel/);
    assert.match(doc.info?.["x-guidance"] ?? "", /\/v1\/watch\/renew/);
    assert.match(doc.info?.description ?? "", /watcher renew/);
    assert.ok(stats?.get?.tags?.includes("Sentinel"));
  });

  it("GET /.well-known/x402 is free 200 JSON listing concrete paid URLs only", async () => {
    const res = await fetch(`${origin}/.well-known/x402`);
    assertJsonDiscovery(res, ".well-known/x402");
    const body = (await res.json()) as { version?: number; resources?: unknown };
    assert.equal(body.version, 1);
    assert.deepEqual(body.resources, [
      "https://livecheck.fly.dev/v1/verify",
      "https://livecheck.fly.dev/v1/verify/job",
      "https://livecheck.fly.dev/v1/verify/listing",
      "https://livecheck.fly.dev/v1/check",
      "https://livecheck.fly.dev/v1/watch",
      "https://livecheck.fly.dev/v1/watch/renew",
      "https://livecheck.fly.dev/v1/confirm",
      "https://livecheck.fly.dev/v1/confirm/order",
    ]);
    assert.ok(Array.isArray(body.resources));
    assert.equal(typeof body.resources[0], "string");
    assert.deepEqual(
      WELL_KNOWN_X402_ROUTES.map((r) => r.path),
      [
        "/v1/verify",
        "/v1/verify/job",
        "/v1/verify/listing",
        "/v1/check",
        "/v1/watch",
        "/v1/watch/renew",
        "/v1/confirm",
        "/v1/confirm/order",
      ],
    );
    for (const url of body.resources as string[]) {
      assert.equal(url.includes("{"), false, `crawler resource must not be templated: ${url}`);
      assert.equal(
        url.includes("/v1/watch/") && url.includes("/chain/topup"),
        false,
        `well-known must not list path-param topup: ${url}`,
      );
    }
    assert.equal(
      (body.resources as string[]).includes("https://livecheck.fly.dev/v1/watch/{id}/chain/topup"),
      false,
    );
  });

  it("GET /llms.txt is free 200 text/plain from public/llms.txt", async () => {
    const res = await fetch(`${origin}/llms.txt`);
    assertLlmsTxt(res, await res.text());
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

  it("does not 402 OpenAPI, well-known, or llms.txt under the live payment middleware", async () => {
    const openapi = await fetch(`${origin}/openapi.json`);
    assertJsonDiscovery(openapi, "live openapi.json");
    const wellKnown = await fetch(`${origin}/.well-known/x402`);
    assertJsonDiscovery(wellKnown, "live .well-known/x402");
    const keys = await fetch(`${origin}/.well-known/livecheck-keys.json`);
    assertJsonDiscovery(keys, "live .well-known/livecheck-keys.json");
    const stats = await fetch(`${origin}/stats`);
    assert.equal(stats.status, 200, "GET /stats must not 402");
    const llms = await fetch(`${origin}/llms.txt`);
    assertLlmsTxt(llms, await llms.text());
    const verify = await fetch(`${origin}/v1/verify`, { method: "POST" });
    assert.equal(verify.status, 402);
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    for (const path of ["/v1/verify/job", "/v1/verify/listing"] as const) {
      const unpaid = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      assert.equal(unpaid.status, 402, `${path} must 402 before body validation`);
      const header = unpaid.headers.get("payment-required");
      assert.ok(header, `${path} payment-required`);
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        accepts?: Array<{ amount?: string }>;
        resource?: { url?: string; description?: string };
      };
      assert.equal(decoded.accepts?.length, 1);
      assert.equal(decoded.accepts?.[0]?.amount, "10000");
      assert.equal(decoded.resource?.url, `https://livecheck.fly.dev${path}`);
      assert.equal(decoded.resource?.description, VERIFY_DESCRIPTION);
    }
  });
});
