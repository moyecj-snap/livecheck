import {
  checkBazaarExtensions,
  confirmBazaarExtensions,
  orderConfirmBazaarExtensions,
  verifyBazaarExtensions,
} from "./bazaar.js";
import {
  CHECK_PAYMENT_DESCRIPTION,
  CHECK_PRICE_ATOMIC_USDC,
  CONFIRM_PAYMENT_DESCRIPTION,
  CONFIRM_PRICE_ATOMIC_USDC,
  NETWORK,
  ORDER_PAYMENT_DESCRIPTION,
  ORDER_PLACED_PRICE_ATOMIC_USDC,
  PRICE_ATOMIC_USDC,
  USDC_BASE,
  USDC_EIP712,
  VERIFY_DESCRIPTION,
  payToAddress,
} from "./config.js";
import {
  paidResourceKind,
  publicCheckUrl,
  publicConfirmOrderUrl,
  publicConfirmUrl,
  publicVerifyUrl,
} from "./public-url.js";

export type PaymentRequiredBody = {
  x402Version: 2;
  error: string;
  resource: {
    url: string;
    description: string;
    mimeType: string;
    serviceName?: string;
    tags?: string[];
  };
  accepts: Array<{
    scheme: "exact";
    network: typeof NETWORK;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: { name: string; version: string };
  }>;
  extensions: Record<string, unknown>;
};

/** EIP-712 USDC domain — must match Verify. Matching field; never rewrite. */
export const USDC_PAYMENT_EXTRA = { name: USDC_EIP712.name, version: USDC_EIP712.version } as const;

function accept(amount: string): PaymentRequiredBody["accepts"][number] {
  return {
    scheme: "exact",
    network: NETWORK,
    amount,
    asset: USDC_BASE,
    payTo: payToAddress(),
    maxTimeoutSeconds: 60,
    extra: { ...USDC_PAYMENT_EXTRA },
  };
}

export function paymentRequiredBody(resourceUrl: string): PaymentRequiredBody {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: VERIFY_DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [accept(PRICE_ATOMIC_USDC)],
    extensions: verifyBazaarExtensions(),
  };
}

export function confirmPaymentRequiredBody(resourceUrl: string): PaymentRequiredBody {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: CONFIRM_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [accept(CONFIRM_PRICE_ATOMIC_USDC)],
    extensions: confirmBazaarExtensions(),
  };
}

export function orderConfirmPaymentRequiredBody(resourceUrl: string): PaymentRequiredBody {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: ORDER_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [accept(ORDER_PLACED_PRICE_ATOMIC_USDC)],
    extensions: orderConfirmBazaarExtensions(),
  };
}

export function checkPaymentRequiredBody(resourceUrl: string): PaymentRequiredBody {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: CHECK_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [accept(CHECK_PRICE_ATOMIC_USDC)],
    extensions: checkBazaarExtensions(),
  };
}

export function encodePaymentRequired(body: PaymentRequiredBody | Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

export function decodePaymentRequired(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
}

function advertisedResource(kind: ReturnType<typeof paidResourceKind>, requestUrl: string, host?: string) {
  if (kind === "confirm_order") {
    return {
      url: publicConfirmOrderUrl(requestUrl, host),
      description: ORDER_PAYMENT_DESCRIPTION,
    };
  }
  if (kind === "confirm") {
    return {
      url: publicConfirmUrl(requestUrl, host),
      description: CONFIRM_PAYMENT_DESCRIPTION,
    };
  }
  if (kind === "check") {
    return {
      url: publicCheckUrl(requestUrl, host),
      description: CHECK_PAYMENT_DESCRIPTION,
    };
  }
  return {
    url: publicVerifyUrl(requestUrl, host),
    description: VERIFY_DESCRIPTION,
  };
}

function routeBazaar(kind: ReturnType<typeof paidResourceKind>): Record<string, unknown> {
  if (kind === "confirm_order") return orderConfirmBazaarExtensions();
  if (kind === "confirm") return confirmBazaarExtensions();
  if (kind === "check") return checkBazaarExtensions();
  return verifyBazaarExtensions();
}

/**
 * Force the fields CDP/wallets actually read off a 402.
 * @x402/hono builds resource.url from routeConfig.resource or c.req.url.
 * Fly's proxy presents http://livecheck.fly.dev to the app, so the library
 * 402 is http unless we overwrite it after the middleware runs.
 *
 * Must not change payment-requirements matching fields: amount, asset, payTo,
 * network, scheme, extra, maxTimeoutSeconds. extra stays Verify's USDC domain
 * {name, version}. resource.url/description are pinned in route config to the
 * same public values, so this rewrite is a no-op for signing fields.
 */
export function advertisePaymentRequired(
  payload: Record<string, unknown>,
  requestUrl: string,
  host?: string,
): Record<string, unknown> {
  const kind = paidResourceKind(requestUrl);
  const existingResource =
    payload.resource && typeof payload.resource === "object"
      ? (payload.resource as Record<string, unknown>)
      : {};
  const libraryExtensions =
    payload.extensions && typeof payload.extensions === "object"
      ? (payload.extensions as Record<string, unknown>)
      : {};
  const advertised = advertisedResource(kind, requestUrl, host);
  const bazaar = routeBazaar(kind);
  const extensions: Record<string, unknown> = { ...bazaar, ...libraryExtensions };
  if (!extensions.bazaar) {
    Object.assign(extensions, bazaar);
  }
  return {
    ...payload,
    resource: {
      ...existingResource,
      url: advertised.url,
      description: advertised.description,
      mimeType: "application/json",
    },
    extensions,
  };
}
