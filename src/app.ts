import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  CONFIRM_DESCRIPTION,
  CONFIRM_PRICE_USD,
  NETWORK,
  ORDER_PLACED_PRICE_USD,
  PRICE_USD,
  USER_AGENT,
  VERIFY_DESCRIPTION,
  isLiveSettlement,
  missingLiveKeyNames,
} from "./config.js";
import {
  assertConfirmPaymentCoversIntent,
  InsufficientConfirmPaymentError,
  resolveConfirmPayment,
  underpaidOrderPlacedBody,
  withConfirmPaymentContext,
} from "./confirm-payment.js";
import { confirmUrl, parseConfirmRequest, UnsupportedIntentError } from "./confirm.js";
import { isEbayAdapterEnabled } from "./ebay.js";
import { demoHtml } from "./demo-page.js";
import { discoveryHeaders, openApiDocument, wellKnownX402 } from "./discovery.js";
import { FIXTURES } from "./fixtures.js";
import { recordSuccessfulPaidCheck, withPaidCallContext } from "./paid-call.js";
import { applyPaymentGate, settlementMode } from "./payments.js";
import { publicConfirmUrl, publicVerifyUrl } from "./public-url.js";
import { confirmPaymentRequiredBody, encodePaymentRequired } from "./x402-payload.js";
import { isConfirmId } from "./confirm-id.js";
import {
  livecheckKeysDocument,
  lookupReceiptResponse,
  receiptSigningEnabled,
  sealConfirmResult,
} from "./receipt.js";
import { buildStatsDocument, statsHtml } from "./stats.js";
import { VerifyError, parseTargetUrl, verifyUrl } from "./verify.js";

export function createApp(paymentGate: MiddlewareHandler = applyPaymentGate()): Hono {
  const app = new Hono();

  app.use(withPaidCallContext());
  app.use(withConfirmPaymentContext());
  app.use(paymentGate);

  app.get("/openapi.json", (c) => {
    return c.json(openApiDocument(c.req.url, c.req.header("host")), 200, discoveryHeaders());
  });

  app.get("/.well-known/x402", (c) => {
    return c.json(wellKnownX402(c.req.url, c.req.header("host")), 200, discoveryHeaders());
  });

  app.get("/.well-known/livecheck-keys.json", (c) => {
    return c.json(livecheckKeysDocument(), 200, discoveryHeaders());
  });

  app.get("/stats", (c) => {
    const doc = buildStatsDocument();
    const format = c.req.query("format");
    const accept = c.req.header("accept") ?? "";
    const wantsHtml =
      format === "html" || (format !== "json" && accept.includes("text/html") && !accept.includes("application/json"));
    if (wantsHtml) return c.html(statsHtml(doc));
    return c.json(doc);
  });

  app.get("/v1/receipt/:id", (c) => {
    const id = c.req.param("id");
    if (!id || !isConfirmId(id)) {
      return c.json({ error: "not_found" }, 404);
    }
    const body = lookupReceiptResponse(id, c.req.url, c.req.header("host"));
    if (!body) return c.json({ error: "not_found" }, 404);
    return c.json(body);
  });

  app.all("/v1/judge", (c) => {
    return c.json(
      {
        error: "not_implemented",
        action: "human_review",
        endpoint: "/v1/judge",
        est_price_usd: 1.0,
      },
      501,
    );
  });

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "livecheck",
      settlement: settlementMode() === "live" ? "stripe-x402" : "disabled",
      missing_keys: isLiveSettlement() ? [] : missingLiveKeyNames(),
      network: NETWORK,
      price_usd: PRICE_USD,
      confirm_price_usd: CONFIRM_PRICE_USD,
      order_placed_price_usd: ORDER_PLACED_PRICE_USD,
      public_verify_url: publicVerifyUrl(c.req.url),
      public_confirm_url: publicConfirmUrl(c.req.url),
      bazaar: true,
      ebay: isEbayAdapterEnabled(),
      confirm: true,
      receipt_signing: receiptSigningEnabled(),
      description: VERIFY_DESCRIPTION,
      confirm_description: CONFIRM_DESCRIPTION,
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
      recordSuccessfulPaidCheck({ route: "verify", url: target, status: verdict.status });
      return c.json(verdict);
    } catch (error) {
      if (error instanceof VerifyError) {
        return c.json({ error: error.message }, error.status as 400 | 502 | 504);
      }
      throw error;
    }
  });

  app.post("/v1/confirm", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be JSON." }, 400);
    }
    try {
      const { url, intent, claim } = parseConfirmRequest(body);
      assertConfirmPaymentCoversIntent(intent, resolveConfirmPayment({ get: (name) => c.req.header(name) }));
      const classified = await confirmUrl(url, fetch, new Date(), { intent, claim });
      const result = sealConfirmResult(classified, {
        intent,
        url,
        claim,
        requestUrl: c.req.url,
        host: c.req.header("host"),
      });
      recordSuccessfulPaidCheck({
        route: "confirm",
        url,
        intent,
        verdict: result.verdict,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof InsufficientConfirmPaymentError) {
        const challenge = confirmPaymentRequiredBody(publicConfirmUrl(c.req.url, c.req.header("host")));
        challenge.error = "payment_amount_insufficient";
        return c.json(underpaidOrderPlacedBody(error), 402, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "payment-required": encodePaymentRequired(challenge),
        });
      }
      if (error instanceof UnsupportedIntentError) {
        return c.json({ error: "unsupported_intent", intent: error.intent ?? null }, 400);
      }
      if (error instanceof VerifyError) {
        return c.json({ error: error.message }, error.status as 400 | 502 | 504);
      }
      throw error;
    }
  });

  return app;
}
