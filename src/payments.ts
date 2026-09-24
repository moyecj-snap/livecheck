import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { RoutesConfig } from "@x402/core/server";
import type { MiddlewareHandler } from "hono";
import { chainTopupBazaarExtensions, checkBazaarExtensions, confirmBazaarExtensions, orderConfirmBazaarExtensions, verifyBazaarExtensions, watchRenewBazaarExtensions } from "./bazaar.js";
import {
  CHAIN_TOPUP_PAYMENT_DESCRIPTION,
  CHAIN_TOPUP_PRICE_LABEL,
  CHECK_PAYMENT_DESCRIPTION,
  CHECK_PRICE_LABEL,
  CONFIRM_PAYMENT_DESCRIPTION,
  CONFIRM_PRICE_LABEL,
  MOCK_PAYMENT_HEADER,
  NETWORK,
  ORDER_PAYMENT_DESCRIPTION,
  ORDER_PLACED_PRICE_LABEL,
  PRICE_LABEL,
  VERIFY_DESCRIPTION,
  WATCH_PAYMENT_DESCRIPTION,
  WATCH_PRICE_LABEL,
  WATCH_RENEW_PAYMENT_DESCRIPTION,
  isLiveSettlement,
  missingLiveKeyNames,
  readLiveKeys,
} from "./config.js";
import { isPaidPostPath, parseWatchChainTopupId, publicCheckUrl, publicConfirmOrderUrl, publicConfirmUrl, publicOrigin, publicVerifyUrl, publicWatchChainTopupUrl, publicWatchRenewUrl, publicWatchUrl } from "./public-url.js";
import {
  advertisePaymentRequired,
  chainTopupPaymentRequiredBody,
  checkPaymentRequiredBody,
  confirmPaymentRequiredBody,
  decodePaymentRequired,
  encodePaymentRequired,
  orderConfirmPaymentRequiredBody,
  paymentRequiredBody,
  watchPaymentRequiredBody,
  watchRenewPaymentRequiredBody,
} from "./x402-payload.js";
import { rememberMockConfirmPayment, wrapFacilitatorForVerifiedAmount } from "./confirm-payment.js";
import { withPaidWatchAttemptLog } from "./paid-watch-log.js";
import { wrapFacilitatorForWatchPayer } from "./watch-payer.js";
import { wrapFacilitatorForCatalog } from "./facilitator-catalog.js";
import { emitPaidCallAfterSettle, extractPayer } from "./paid-call.js";
import { createStripeClient, recordSettledPayment } from "./stripe-record.js";

export function settlementMode(): "live" | "mock" {
  return isLiveSettlement() ? "live" : "mock";
}

/** Route config the live @x402/hono middleware actually reads for the 402. */
export function verifyPaymentRoutes(payTo: string): RoutesConfig {
  return {
    "POST /v1/verify": {
      accepts: [
        {
          scheme: "exact" as const,
          price: PRICE_LABEL,
          network: NETWORK as `${string}:${string}`,
          payTo,
        },
      ],
      description: VERIFY_DESCRIPTION,
      mimeType: "application/json",
      // Pin at boot: LIVECHECK_PUBLIC_URL or FLY_APP_NAME → https://<app>.fly.dev.
      // Local mock/live without those stays localhost. withAdvertised402 still
      // upgrades a leftover http://*.fly.dev request URL after the library 402.
      resource: publicVerifyUrl(),
      extensions: verifyBazaarExtensions(),
    },
    "POST /v1/confirm": {
      accepts: [
        {
          scheme: "exact" as const,
          price: CONFIRM_PRICE_LABEL,
          network: NETWORK as `${string}:${string}`,
          payTo,
        },
      ],
      description: CONFIRM_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
      // Public URL + ASCII description pinned here so advertisePaymentRequired
      // is a no-op for signing fields (amount/asset/payTo/network/scheme/extra).
      resource: publicConfirmUrl(),
      extensions: confirmBazaarExtensions(),
    },
    "POST /v1/confirm/order": {
      accepts: [
        {
          scheme: "exact" as const,
          price: ORDER_PLACED_PRICE_LABEL,
          network: NETWORK as `${string}:${string}`,
          payTo,
        },
      ],
      description: ORDER_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
      resource: publicConfirmOrderUrl(),
      extensions: orderConfirmBazaarExtensions(),
    },
    "POST /v1/check": {
      accepts: [
        {
          scheme: "exact" as const,
          price: CHECK_PRICE_LABEL,
          network: NETWORK as `${string}:${string}`,
          payTo,
        },
      ],
      description: CHECK_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
      resource: publicCheckUrl(),
      extensions: checkBazaarExtensions(),
    },
    "POST /v1/watch": {
      accepts: [
        {
          scheme: "exact" as const,
          price: WATCH_PRICE_LABEL,
          network: NETWORK as `${string}:${string}`,
          payTo,
        },
      ],
      description: WATCH_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
      resource: publicWatchUrl(),
      // Hotfix: omit watch bazaar on the 402. The declaration is ~4450 JSON
      // (~7500 b64 payment-required vs verify ~3600) and purl/CDP reject it
      // the same way Confirm did before b7ab919. OpenAPI keeps the full schema.
    },
    "POST /v1/watch/renew": {
      accepts: [
        {
          scheme: "exact" as const,
          price: WATCH_PRICE_LABEL,
          network: NETWORK as `${string}:${string}`,
          payTo,
        },
      ],
      description: WATCH_RENEW_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
      resource: publicWatchRenewUrl(),
      extensions: watchRenewBazaarExtensions(),
    },
    "POST /v1/watch/:id/chain/topup": {
      accepts: [
        {
          scheme: "exact" as const,
          price: CHAIN_TOPUP_PRICE_LABEL,
          network: NETWORK as `${string}:${string}`,
          payTo,
        },
      ],
      description: CHAIN_TOPUP_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
      resource: publicWatchChainTopupUrl(),
      extensions: chainTopupBazaarExtensions(),
    },
  };
}

/**
 * Rewrite the library 402 so resource.url / description / bazaar are what
 * we advertise, not Fly's internal http:// request URL.
 */
export function withAdvertised402(inner: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    const result = await inner(c, next);
    const returned = result instanceof Response ? result : undefined;
    const current =
      (returned?.status === 402 ? returned : undefined) ??
      (c.res?.status === 402 ? c.res : undefined) ??
      returned ??
      c.res;
    if (!current || current.status !== 402) {
      return result;
    }
    const raw = current.headers.get("payment-required") ?? current.headers.get("PAYMENT-REQUIRED");
    if (!raw) return result ?? current;
    let decoded: Record<string, unknown>;
    try {
      decoded = decodePaymentRequired(raw);
    } catch {
      return result ?? current;
    }
    const topupId = parseWatchChainTopupId(c.req.path) ?? parseWatchChainTopupId(c.req.url);
    const requestUrl = topupId
      ? `${publicOrigin(c.req.url, c.req.header("host"))}/v1/watch/${topupId}/chain/topup`
      : c.req.url;
    const advertised = advertisePaymentRequired(decoded, requestUrl, c.req.header("host"));
    const encoded = encodePaymentRequired(advertised);
    // Re-emit via Hono so payment-required is not stuck on an immutable Fetch header map.
    return c.body(await current.text(), 402, {
      "content-type": current.headers.get("content-type") ?? "application/json",
      "cache-control": current.headers.get("cache-control") ?? "no-store",
      "payment-required": encoded,
    });
  };
}

export function applyPaymentGate(): MiddlewareHandler {
  if (isLiveSettlement()) {
    return livePaymentMiddleware();
  }
  return mockPaymentMiddleware();
}

/**
 * Live @x402/hono gate. Used in production and in tests with a stub facilitator.
 * Unpaid 402 still goes through paymentMiddleware so the test decodes the
 * library header, then we overwrite resource/extensions for Fly https.
 */
export function livePaymentMiddlewareFromServer(
  resourceServer: x402ResourceServer,
  payTo: string,
  syncFacilitatorOnStart = true,
): MiddlewareHandler {
  return withPaidWatchAttemptLog(
    withAdvertised402(
      paymentMiddleware(verifyPaymentRoutes(payTo), resourceServer, undefined, undefined, syncFacilitatorOnStart),
    ),
  );
}

export function resourceServerFromFacilitator(facilitatorClient: FacilitatorClient): x402ResourceServer {
  return new x402ResourceServer(wrapFacilitatorForVerifiedAmount(wrapFacilitatorForWatchPayer(facilitatorClient)))
    .register(NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
}

function livePaymentMiddleware(): MiddlewareHandler {
  const keys = readLiveKeys();
  if (!keys) {
    throw new Error(`Live settlement requested but missing: ${missingLiveKeyNames().join(", ")}`);
  }

  const facilitatorClient = wrapFacilitatorForCatalog(
    new HTTPFacilitatorClient(createFacilitatorConfig(keys.cdpApiKeyId, keys.cdpApiKeySecret)),
  );
  const resourceServer = resourceServerFromFacilitator(facilitatorClient);
  const stripe = createStripeClient(keys.stripeSecretKey);
  resourceServer.onAfterSettle(async ({ result, requirements, paymentPayload }) => {
    const paymentIntent = await recordSettledPayment(stripe, result, requirements);
    emitPaidCallAfterSettle({
      payer: extractPayer(result, paymentPayload),
      tx: result.transaction,
      payment_intent: paymentIntent,
    });
  });

  return livePaymentMiddlewareFromServer(resourceServer, keys.depositAddress);
}

function mockPaymentMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST" || !isPaidPostPath(c.req.path)) {
      return next();
    }

    const mock =
      c.req.header("x-livecheck-mock") === "1" ||
      c.req.header("payment-signature") === MOCK_PAYMENT_HEADER ||
      c.req.header("x-payment") === MOCK_PAYMENT_HEADER;

    if (mock) {
      rememberMockConfirmPayment();
      c.header("x-livecheck-settlement", "disabled");
      return next();
    }

    const body =
      c.req.path === "/v1/confirm/order"
        ? orderConfirmPaymentRequiredBody(publicConfirmOrderUrl(c.req.url))
        : c.req.path === "/v1/confirm"
          ? confirmPaymentRequiredBody(publicConfirmUrl(c.req.url))
          : c.req.path === "/v1/check"
            ? checkPaymentRequiredBody(publicCheckUrl(c.req.url))
            : c.req.path === "/v1/watch/renew"
              ? watchRenewPaymentRequiredBody(publicWatchRenewUrl(c.req.url))
              : c.req.path === "/v1/watch"
              ? watchPaymentRequiredBody(publicWatchUrl(c.req.url))
              : parseWatchChainTopupId(c.req.path)
                ? chainTopupPaymentRequiredBody(
                    publicWatchChainTopupUrl(c.req.url, c.req.header("host"), parseWatchChainTopupId(c.req.path)),
                  )
                : paymentRequiredBody(publicVerifyUrl(c.req.url));
    const encoded = encodePaymentRequired(body);
    c.header("payment-required", encoded);
    c.header("cache-control", "no-store");
    c.header("x-livecheck-settlement", "disabled");
    return c.json(body, 402);
  };
}
