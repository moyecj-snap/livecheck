import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { VERIFY_DESCRIPTION } from "../src/config.js";
import { verifyBazaarExtensions } from "../src/bazaar.js";

describe("bazaar discovery metadata", () => {
  it("declares POST JSON body { url } and the verify output schema", () => {
    const extensions = verifyBazaarExtensions() as {
      bazaar?: {
        info?: { input?: { bodyType?: string; body?: { url?: string } } };
        schema?: { properties?: { input?: { properties?: { body?: { required?: string[] } } } } };
      };
    };
    assert.ok(extensions.bazaar, "expected extensions.bazaar");
    assert.equal("discoverable" in (extensions.bazaar as object), false);
    assert.equal(extensions.bazaar?.info?.input?.bodyType, "json");
    assert.equal(typeof extensions.bazaar?.info?.input?.body?.url, "string");
    const bodySchema = (extensions.bazaar as {
      schema?: { properties?: { input?: { properties?: { body?: { required?: string[] } } } } };
    }).schema?.properties?.input?.properties?.body;
    assert.deepEqual(bodySchema?.required, ["url"]);
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
    assert.match(decoded.resource.description, /Not a search engine/);
    assert.equal(decoded.resource.description, VERIFY_DESCRIPTION);
    assert.ok(decoded.extensions?.bazaar);
    assert.equal(decoded.extensions.bazaar.info.input.bodyType, "json");
    assert.ok(decoded.extensions.bazaar.info.input.body.url);
    assert.equal(decoded.x402Version, 2);
  });
});
