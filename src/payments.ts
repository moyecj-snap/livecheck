import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import { verifyBazaarExtensions } from "./bazaar.js";
import {
  MOCK_PAYMENT_HEADER,
  NETWORK,
  PRICE_LABEL,
  VERIFY_DESCRIPTION,
  isLiveSettlement,
  missingLiveKeyNames,
  readLiveKeys,
} from "./config.js";
import { configuredPublicOrigin, publicVerifyUrl } from "./public-url.js";
import { encodePaymentRequired, paymentRequiredBody } from "./x402-payload.js";
import { createStripeClient, recordSettledPayment } from "./stripe-record.js";

export function settlementMode(): "live" | "mock" {
  return isLiveSettlement() ? "live" : "mock";
}

export function applyPaymentGate(): MiddlewareHandler {
  if (isLiveSettlement()) {
    return livePaymentMiddleware();
  }
  return mockPaymentMiddleware();
}

function livePaymentMiddleware(): MiddlewareHandler {
  const keys = readLiveKeys();
  if (!keys) {
    throw new Error(`Live settlement requested but missing: ${missingLiveKeyNames().join(", ")}`);
  }

  const facilitatorClient = new HTTPFacilitatorClient(
    createFacilitatorConfig(keys.cdpApiKeyId, keys.cdpApiKeySecret),
  );

  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  const stripe = createStripeClient(keys.stripeSecretKey);
  resourceServer.onAfterSettle(async ({ result, requirements }) => {
    await recordSettledPayment(stripe, result, requirements);
  });

  const publicResource = configuredPublicOrigin() ? publicVerifyUrl() : undefined;

  return paymentMiddleware(
    {
      "POST /v1/verify": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE_LABEL,
            network: NETWORK,
            payTo: keys.depositAddress,
          },
        ],
        description: VERIFY_DESCRIPTION,
        mimeType: "application/json",
        ...(publicResource ? { resource: publicResource } : {}),
        extensions: verifyBazaarExtensions(),
      },
    },
    resourceServer,
  );
}

function mockPaymentMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST" || c.req.path !== "/v1/verify") {
      return next();
    }

    const mock =
      c.req.header("x-livecheck-mock") === "1" ||
      c.req.header("payment-signature") === MOCK_PAYMENT_HEADER ||
      c.req.header("x-payment") === MOCK_PAYMENT_HEADER;

    if (mock) {
      c.header("x-livecheck-settlement", "disabled");
      return next();
    }

    const body = paymentRequiredBody(publicVerifyUrl(c.req.url));
    const encoded = encodePaymentRequired(body);
    c.header("payment-required", encoded);
    c.header("cache-control", "no-store");
    c.header("x-livecheck-settlement", "disabled");
    return c.json(body, 402);
  };
}
