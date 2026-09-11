import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { CheckError, parseCheckRequest, runCheck } from "./check.js";
import {
  CHAIN_TOPUP_DESCRIPTION,
  CHAIN_TOPUP_PRICE_USD,
  CHECK_DESCRIPTION,
  CHECK_PRICE_USD,
  CONFIRM_DESCRIPTION,
  CONFIRM_PRICE_USD,
  NETWORK,
  ORDER_PLACED_PRICE_USD,
  PRICE_USD,
  USER_AGENT,
  VERIFY_DESCRIPTION,
  WATCH_DESCRIPTION,
  WATCH_OWNER_TOKEN_HEADER,
  WATCH_PRICE_USD,
  isLiveSettlement,
  missingLiveKeyNames,
} from "./config.js";
import { withConfirmPaymentContext } from "./confirm-payment.js";
import {
  confirmUrl,
  parseConfirmRouteRequest,
  parseOrderConfirmRequest,
  UnsupportedIntentError,
} from "./confirm.js";
import { isEbayAdapterEnabled } from "./ebay.js";
import { demoHtml } from "./demo-page.js";
import { discoveryHeaders, openApiDocument, wellKnownX402 } from "./discovery.js";
import { FIXTURES } from "./fixtures.js";
import { recordSuccessfulPaidCheck, withPaidCallContext } from "./paid-call.js";
import { applyPaymentGate, settlementMode } from "./payments.js";
import { publicCheckUrl, publicConfirmOrderUrl, publicConfirmUrl, publicVerifyUrl, publicWatchChainTopupUrl, publicWatchUrl } from "./public-url.js";
import { isReceiptId } from "./confirm-id.js";
import {
  livecheckKeysDocument,
  lookupReceiptResponse,
  receiptSigningEnabled,
  sealCheckResult,
  sealConfirmResultDetailed,
  sealWatchResult,
} from "./receipt.js";
import { buildStatsDocument, statsHtml } from "./stats.js";
import { VerifyError, parseTargetUrl, verifyUrl } from "./verify.js";
import { WatchError, createWatch, deleteWatch, listWatchEventsForOwner, readWatch, topupWatchChain, watchErrorBody } from "./watch.js";
import { withWatchHint } from "./watch-hint.js";
import { resolveWatchPayer, withWatchPayerContext } from "./watch-payer.js";

export function createApp(paymentGate: MiddlewareHandler = applyPaymentGate()): Hono {
  const app = new Hono();

  app.use(withPaidCallContext());
  app.use(withConfirmPaymentContext());
  app.use(withWatchPayerContext());
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
    if (!id || !isReceiptId(id)) {
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
      check_price_usd: CHECK_PRICE_USD,
      watch_price_usd: WATCH_PRICE_USD,
      chain_topup_price_usd: CHAIN_TOPUP_PRICE_USD,
      public_verify_url: publicVerifyUrl(c.req.url),
      public_confirm_url: publicConfirmUrl(c.req.url),
      public_confirm_order_url: publicConfirmOrderUrl(c.req.url),
      public_check_url: publicCheckUrl(c.req.url),
      public_watch_url: publicWatchUrl(c.req.url),
      public_chain_topup_url: publicWatchChainTopupUrl(c.req.url),
      bazaar: true,
      ebay: isEbayAdapterEnabled(),
      confirm: true,
      check: true,
      watch: true,
      chain_topup: true,
      receipt_signing: receiptSigningEnabled(),
      description: VERIFY_DESCRIPTION,
      confirm_description: CONFIRM_DESCRIPTION,
      check_description: CHECK_DESCRIPTION,
      watch_description: WATCH_DESCRIPTION,
      chain_topup_description: CHAIN_TOPUP_DESCRIPTION,
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
      return c.json(withWatchHint(verdict));
    } catch (error) {
      if (error instanceof VerifyError) {
        return c.json({ error: error.message }, error.status as 400 | 502 | 504);
      }
      throw error;
    }
  });

  app.post("/v1/confirm", (c) => handlePaidConfirm(c, parseConfirmRouteRequest));
  app.post("/v1/confirm/order", (c) => handlePaidConfirm(c, parseOrderConfirmRequest));
  app.post("/v1/check", handlePaidCheck);
  app.post("/v1/watch", handlePaidWatch);
  app.post("/v1/watch/:id/chain/topup", handleChainTopup);
  app.get("/v1/watch/:id/events", handleListWatchEvents);
  app.get("/v1/watch/:id", handleGetWatch);
  app.delete("/v1/watch/:id", handleDeleteWatch);

  return app;
}

async function handlePaidCheck(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_target", message: "Request body must be JSON." }, 400);
  }
  try {
    const parsed = parseCheckRequest(body);
    const classified = await runCheck(parsed);
    const { content: _content, ...publicCheck } = classified;
    const result = sealCheckResult(publicCheck, {
      url: parsed.target.url,
      requestUrl: c.req.url,
      host: c.req.header("host"),
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof CheckError) {
      return c.json({ error: error.code, message: error.message }, error.status as 400 | 422);
    }
    if (error instanceof VerifyError) {
      return c.json({ error: "invalid_target", message: error.message }, error.status as 400 | 502 | 504);
    }
    throw error;
  }
}

async function handlePaidWatch(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_target", message: "Request body must be JSON." }, 400);
  }
  try {
    const created = await createWatch(body, {
      payer: resolveWatchPayer({ get: (name) => c.req.header(name) }),
    });
    const result = sealWatchResult(created.result, {
      url: created.result.target.url,
      requestUrl: c.req.url,
      host: c.req.header("host"),
      observation: created.observation,
    });
    return c.json(result, 201);
  } catch (error) {
    if (error instanceof WatchError) {
      return c.json(watchErrorBody(error), error.status as 400 | 401 | 403 | 404 | 409 | 429);
    }
    if (error instanceof VerifyError) {
      return c.json({ error: "invalid_target", message: error.message }, error.status as 400 | 502 | 504);
    }
    throw error;
  }
}

function ownerTokenFrom(c: Context): string | undefined {
  return c.req.header(WATCH_OWNER_TOKEN_HEADER) ?? c.req.header("X-Livecheck-Owner-Token") ?? undefined;
}

async function handleChainTopup(c: Context) {
  try {
    const body = topupWatchChain(c.req.param("id") ?? "", ownerTokenFrom(c));
    return c.json(body);
  } catch (error) {
    if (error instanceof WatchError) {
      return c.json(watchErrorBody(error), error.status as 400 | 401 | 403 | 404 | 409 | 429);
    }
    throw error;
  }
}

async function handleGetWatch(c: Context) {
  try {
    const view = readWatch(c.req.param("id") ?? "", ownerTokenFrom(c));
    return c.json(view);
  } catch (error) {
    if (error instanceof WatchError) {
      return c.json(watchErrorBody(error), error.status as 400 | 401 | 403 | 404 | 409 | 429);
    }
    throw error;
  }
}

async function handleListWatchEvents(c: Context) {
  try {
    const body = listWatchEventsForOwner(c.req.param("id") ?? "", ownerTokenFrom(c), {
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    return c.json(body);
  } catch (error) {
    if (error instanceof WatchError) {
      return c.json(watchErrorBody(error), error.status as 400 | 401 | 403 | 404 | 409 | 429);
    }
    throw error;
  }
}

async function handleDeleteWatch(c: Context) {
  try {
    const result = deleteWatch(c.req.param("id") ?? "", ownerTokenFrom(c));
    return c.json(result);
  } catch (error) {
    if (error instanceof WatchError) {
      return c.json(watchErrorBody(error), error.status as 400 | 401 | 403 | 404 | 409 | 429);
    }
    throw error;
  }
}

async function handlePaidConfirm(c: Context, parse: typeof parseConfirmRouteRequest) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON." }, 400);
  }
  try {
    const { url, intent, claim } = parse(body);
    const classified = await confirmUrl(url, fetch, new Date(), { intent, claim });
    const { result, durable } = sealConfirmResultDetailed(classified, {
      intent,
      url,
      claim,
      requestUrl: c.req.url,
      host: c.req.header("host"),
    });
    // @x402/hono settles only when the handler returns <400. A live 200
    // without a durable receipt would charge and leave /stats paid_calls
    // with receipts=0. Mock/dev still 200 from process memory.
    if (isLiveSettlement() && !durable) {
      return c.json(
        {
          error: "receipt_persist_failed",
          message:
            "Confirm result was computed but receipts.sqlite did not persist. Settlement was not completed. Retry; if this repeats, check RECEIPT_DB_PATH / the livecheck_data volume.",
        },
        503,
      );
    }
    recordSuccessfulPaidCheck({
      route: "confirm",
      url,
      intent,
      verdict: result.verdict,
    });
    return c.json(withWatchHint(result));
  } catch (error) {
    if (error instanceof UnsupportedIntentError) {
      const payload: Record<string, unknown> = {
        error: "unsupported_intent",
        intent: error.intent ?? null,
      };
      if (error.use) payload.use = error.use;
      return c.json(payload, 400);
    }
    if (error instanceof VerifyError) {
      return c.json({ error: error.message }, error.status as 400 | 502 | 504);
    }
    throw error;
  }
}
