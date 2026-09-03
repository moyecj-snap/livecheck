import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { NETWORK, PRICE_USD, USER_AGENT, VERIFY_DESCRIPTION, isLiveSettlement, missingLiveKeyNames } from "./config.js";
import { isEbayAdapterEnabled } from "./ebay.js";
import { demoHtml } from "./demo-page.js";
import { discoveryHeaders, openApiDocument, wellKnownX402 } from "./discovery.js";
import { FIXTURES } from "./fixtures.js";
import { applyPaymentGate, settlementMode } from "./payments.js";
import { publicVerifyUrl } from "./public-url.js";
import { VerifyError, parseTargetUrl, verifyUrl } from "./verify.js";

export function createApp(paymentGate: MiddlewareHandler = applyPaymentGate()): Hono {
  const app = new Hono();

  app.use(paymentGate);

  app.get("/openapi.json", (c) => {
    return c.json(openApiDocument(c.req.url, c.req.header("host")), 200, discoveryHeaders());
  });

  app.get("/.well-known/x402", (c) => {
    return c.json(wellKnownX402(c.req.url, c.req.header("host")), 200, discoveryHeaders());
  });

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "livecheck",
      settlement: settlementMode() === "live" ? "stripe-x402" : "disabled",
      missing_keys: isLiveSettlement() ? [] : missingLiveKeyNames(),
      network: NETWORK,
      price_usd: PRICE_USD,
      public_verify_url: publicVerifyUrl(c.req.url),
      bazaar: true,
      ebay: isEbayAdapterEnabled(),
      description: VERIFY_DESCRIPTION,
      user_agent: USER_AGENT,
    });
  });

  app.get("/", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.html(demoHtml(origin));
  });

  app.get("/fixtures/*", (c) => {
    const id = c.req.path.replace(/^\/fixtures\//, "");
    const fixture = FIXTURES[id];
    if (!fixture) return c.text("Unknown fixture", 404);
    if (fixture.location) {
      return c.redirect(fixture.location, fixture.status as 302);
    }
    return c.html(fixture.body ?? "", fixture.status as 200 | 404);
  });

  app.post("/v1/verify", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be JSON." }, 400);
    }
    const url = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
    try {
      const target = parseTargetUrl(url);
      const verdict = await verifyUrl(target);
      return c.json(verdict);
    } catch (error) {
      if (error instanceof VerifyError) {
        return c.json({ error: error.message }, error.status as 400 | 502 | 504);
      }
      throw error;
    }
  });

  return app;
}
