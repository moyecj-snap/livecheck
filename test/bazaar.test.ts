import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { declareDiscoveryExtension, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { createApp } from "../src/app.js";
import { VERIFY_DESCRIPTION } from "../src/config.js";
import { VERIFY_EXAMPLE, VERIFY_INPUT_SCHEMA, verifyBazaarExtensions } from "../src/bazaar.js";
import { fillCatalogPaymentPayload } from "../src/catalog-payload.js";
import {
  assertInfoInputMatchesSchema,
  validateInfoInput,
  type BazaarExt,
} from "./bazaar-schema.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const live402 = JSON.parse(
  readFileSync(join(fixtureDir, "fixtures/live-402-payment-required.json"), "utf8"),
) as { extensions?: { bazaar?: BazaarExt } };

describe("bazaar discovery metadata", () => {
  it("declares POST JSON body { url } and the verify output schema", () => {
    const extensions = verifyBazaarExtensions() as { bazaar?: BazaarExt };
    assert.ok(extensions.bazaar, "expected extensions.bazaar");
    assert.equal("discoverable" in (extensions.bazaar as object), false);
    assert.deepEqual(Object.keys(extensions.bazaar as object).sort(), ["info", "schema"]);
    assert.equal(extensions.bazaar?.info?.input?.bodyType, "json");
    assert.equal(extensions.bazaar?.info?.input?.method, "POST");
    assert.equal(extensions.bazaar?.info?.input?.type, "http");
    assert.equal(typeof (extensions.bazaar?.info?.input?.body as { url?: string })?.url, "string");
    const inputSchema = (
      extensions.bazaar as {
        schema?: {
          properties?: {
            input?: {
              required?: string[];
              properties?: { method?: { enum?: string[] }; body?: { required?: string[]; type?: string } };
            };
          };
        };
      }
    ).schema?.properties?.input;
    assert.deepEqual(inputSchema?.required, ["type", "method", "bodyType", "body"]);
    assert.deepEqual(inputSchema?.properties?.method?.enum, ["POST"]);
    assert.equal(inputSchema?.properties?.body?.type, undefined);
    assert.deepEqual(inputSchema?.properties?.body?.required, ["url"]);
    const example = extensions.bazaar?.info as {
      output?: { example?: Record<string, unknown> };
    };
    for (const key of [
      "url",
      "canonical_url",
      "status",
      "http_status",
      "checked_at",
      "title",
      "signals",
      "confidence",
      "price_usd",
    ]) {
      assert.ok(key in (example.output?.example ?? {}), `expected output example.${key}`);
    }
    assert.equal(example.output?.example?.price_usd, 0.01);
  });

  it("info.input validates against schema.properties.input (CDP settle check)", () => {
    const bazaar = verifyBazaarExtensions().bazaar as BazaarExt;
    assertInfoInputMatchesSchema(bazaar, "settle-injected declaration");
    const spec = validateDiscoveryExtension(bazaar as never);
    assert.equal(spec.valid, true, spec.errors?.join("; ") ?? "invalid discovery extension");
  });

  it("raw declareDiscoveryExtension omits method — the exact settle rejection", () => {
    const raw = declareDiscoveryExtension({
      bodyType: "json",
      input: { url: VERIFY_EXAMPLE.url },
      inputSchema: VERIFY_INPUT_SCHEMA,
    }).bazaar as BazaarExt;
    assert.equal(raw.info?.input?.method, undefined);
    assert.deepEqual(
      (raw.schema as { properties?: { input?: { required?: string[] } } })?.properties?.input
        ?.required,
      ["type", "method", "bodyType", "body"],
    );
    const ajv = validateInfoInput(raw);
    assert.equal(ajv.valid, false);
    assert.match(ajv.errors, /must have required property 'method'/);
    const spec = validateDiscoveryExtension(raw as never);
    assert.equal(spec.valid, false);
    assert.ok(
      spec.errors?.some((err) => err.includes("must have required property 'method'")),
      spec.errors?.join("; ") ?? "expected /input: must have required property 'method'",
    );
  });

  it("live Fly 402 extensions.bazaar (2026-09-01 snapshot) info.input matches schema.properties.input", () => {
    const bazaar = live402.extensions?.bazaar;
    assert.ok(bazaar, "expected fixture extensions.bazaar");
    assert.equal(bazaar.info?.input?.method, "POST");
    assertInfoInputMatchesSchema(bazaar, "live 402 payment-required");
    const spec = validateDiscoveryExtension(bazaar as never);
    assert.equal(spec.valid, true, spec.errors?.join("; ") ?? "invalid live 402 bazaar");
  });

  it("settle backfill (resource present, bazaar missing) injects a schema-valid bazaar", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      const { payload, resourceFilled, bazaarFilled } = fillCatalogPaymentPayload({
        x402Version: 2,
        resource: {
          url: "https://livecheck.fly.dev/v1/verify",
          description: VERIFY_DESCRIPTION,
          mimeType: "application/json",
        },
      });
      assert.equal(resourceFilled, false);
      assert.equal(bazaarFilled, true);
      const bazaar = payload.extensions?.bazaar as BazaarExt;
      assert.equal(bazaar.info?.input?.method, "POST");
      assertInfoInputMatchesSchema(bazaar, "settle-filled bazaar");
      const spec = validateDiscoveryExtension(bazaar as never);
      assert.equal(spec.valid, true, spec.errors?.join("; ") ?? "invalid settle-filled bazaar");
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
    }
  });
});

describe("402 bazaar + public URL", () => {
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

  it("advertises https://livecheck.fly.dev/v1/verify and bazaar extensions on unpaid 402", async () => {
    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://boards.greenhouse.io/example/jobs/1" }),
    });
    assert.equal(res.status, 402);
    const decoded = JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8"));
    assert.equal(decoded.resource.url, "https://livecheck.fly.dev/v1/verify");
    assert.match(decoded.resource.description, /not a search engine/i);
    assert.equal(decoded.resource.description, VERIFY_DESCRIPTION);
    assert.ok(decoded.extensions?.bazaar);
    assert.equal(decoded.extensions.bazaar.info.input.bodyType, "json");
    assert.equal(decoded.extensions.bazaar.info.input.method, "POST");
    assert.ok(decoded.extensions.bazaar.info.input.body.url);
    assert.equal(decoded.extensions.bazaar.info.output.example.price_usd, 0.01);
    assert.equal(decoded.accepts[0].amount, "10000");
    assert.equal(decoded.x402Version, 2);
    assertInfoInputMatchesSchema(decoded.extensions.bazaar, "live 402 payment-required");
  });
});
