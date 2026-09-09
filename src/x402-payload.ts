import { confirmBazaarExtensions, verifyBazaarExtensions } from "./bazaar.js";
import {
  CONFIRM_DESCRIPTION,
  CONFIRM_PRICE_ATOMIC_USDC,
  NETWORK,
  PRICE_ATOMIC_USDC,
  USDC_BASE,
  USDC_EIP712,
  VERIFY_DESCRIPTION,
  payToAddress,
} from "./config.js";
import { isConfirmRequestPath, publicConfirmUrl, publicVerifyUrl } from "./public-url.js";

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

function accept(amount: string): PaymentRequiredBody["accepts"][number] {
  return {
    scheme: "exact",
    network: NETWORK,
    amount,
    asset: USDC_BASE,
    payTo: payToAddress(),
    maxTimeoutSeconds: 60,
    extra: { name: USDC_EIP712.name, version: USDC_EIP712.version },
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
      description: CONFIRM_DESCRIPTION,
      mimeType: "application/json",
    },
    // Hotfix 2026-09-09: single $0.10 accept only. Dual accepts broke CDP
    // facilitator verify (paymentPayload invalid) with purl 0.2.8.
    accepts: [accept(CONFIRM_PRICE_ATOMIC_USDC)],
    extensions: confirmBazaarExtensions(),
  };
}

export function encodePaymentRequired(body: PaymentRequiredBody | Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

export function decodePaymentRequired(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
}

/**
 * Force the fields CDP/wallets actually read off a 402.
 * @x402/hono builds resource.url from routeConfig.resource or c.req.url.
 * Fly's proxy presents http://livecheck.fly.dev to the app, so the library
 * 402 is http unless we overwrite it after the middleware runs.
 */
export function advertisePaymentRequired(
  payload: Record<string, unknown>,
  requestUrl: string,
  host?: string,
): Record<string, unknown> {
  const confirm = isConfirmRequestPath(requestUrl);
  const existingResource =
    payload.resource && typeof payload.resource === "object"
      ? (payload.resource as Record<string, unknown>)
      : {};
  const libraryExtensions =
    payload.extensions && typeof payload.extensions === "object"
      ? (payload.extensions as Record<string, unknown>)
      : {};
  const routeBazaar = confirm ? confirmBazaarExtensions() : verifyBazaarExtensions();
  const extensions: Record<string, unknown> = {
    ...routeBazaar,
    ...libraryExtensions,
  };
  if (!extensions.bazaar) {
    Object.assign(extensions, routeBazaar);
  }
  return {
    ...payload,
    resource: confirm
      ? {
          ...existingResource,
          url: publicConfirmUrl(requestUrl, host),
          description: CONFIRM_DESCRIPTION,
          mimeType: "application/json",
        }
      : {
          ...existingResource,
          url: publicVerifyUrl(requestUrl, host),
          description: VERIFY_DESCRIPTION,
          mimeType: "application/json",
        },
    extensions,
  };
}
