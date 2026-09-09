import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { RoutesConfig } from "@x402/core/server";
import type { MiddlewareHandler } from "hono";
import { confirmBazaarExtensions, verifyBazaarExtensions } from "./bazaar.js";
import {
  CONFIRM_PAYMENT_DESCRIPTION,
  CONFIRM_PRICE_LABEL,
  MOCK_PAYMENT_HEADER,
  NETWORK,
  PRICE_LABEL,
  VERIFY_DESCRIPTION,
  isLiveSettlement,
  missingLiveKeyNames,
  readLiveKeys,
} from "./config.js";
import { publicConfirmUrl, publicVerifyUrl } from "./public-url.js";
import {
  advertisePaymentRequired,
  confirmPaymentRequiredBody,
  decodePaymentRequired,
  encodePaymentRequired,
  paymentRequiredBody,
} from "./x402-payload.js";
import { rememberMockConfirmPayment, wrapFacilitatorForVerifiedAmount } from "./confirm-payment.js";
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
        // Hotfix 2026-09-09: dual accepts ($0.10 + $0.25) break CDP facilitator
        // verify (paymentPayload invalid) with purl 0.2.8. Single $0.10 until
        // order_placed has its own route / fixed multi-price accepts.
        {
          scheme: "exact" as const,
          price: CONFIRM_PRICE_LABEL,
          network: NETWORK as `${string}:${string}`,
          payTo,
        },
      ],
      description: CONFIRM_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
      // Hotfix: omit serviceName/tags — verify settles; confirm with these
      // fields still got CDP facilitator paymentPayload 400 with purl 0.2.8.
      resource: publicConfirmUrl(),
      // Hotfix: omit confirm bazaar on 402 — fat schema suspected in CDP paymentPayload 400.
      // extensions: confirmBazaarExtensions(),
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
    const current = c.res ?? (result instanceof Response ? result : undefined);
    if (!current || current.status !== 402) {
      return result;
    }
    const raw = current.headers.get("payment-required") ?? current.headers.get("PAYMENT-REQUIRED");
    if (!raw) return result;
    let decoded: Record<string, unknown>;
    try {
      decoded = decodePaymentRequired(raw);
    } catch {
      return result;
    }
    const advertised = advertisePaymentRequired(decoded, c.req.url, c.req.header("host"));
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
  return withAdvertised402(
    paymentMiddleware(verifyPaymentRoutes(payTo), resourceServer, undefined, undefined, syncFacilitatorOnStart),
  );
}

export function resourceServerFromFacilitator(facilitatorClient: FacilitatorClient): x402ResourceServer {
  return new x402ResourceServer(wrapFacilitatorForVerifiedAmount(facilitatorClient))
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
    const paidPath = c.req.path === "/v1/verify" || c.req.path === "/v1/confirm";
    if (c.req.method !== "POST" || !paidPath) {
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
      c.req.path === "/v1/confirm"
        ? confirmPaymentRequiredBody(publicConfirmUrl(c.req.url))
        : paymentRequiredBody(publicVerifyUrl(c.req.url));
    const encoded = encodePaymentRequired(body);
    c.header("payment-required", encoded);
    c.header("cache-control", "no-store");
    c.header("x-livecheck-settlement", "disabled");
    return c.json(body, 402);
  };
}
