import { verifyBazaarExtensions } from "./bazaar.js";
import {
  NETWORK,
  PRICE_ATOMIC_USDC,
  USDC_BASE,
  USDC_EIP712,
  VERIFY_DESCRIPTION,
  payToAddress,
} from "./config.js";

export type PaymentRequiredBody = {
  x402Version: 2;
  error: string;
  resource: {
    url: string;
    description: string;
    mimeType: string;
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

export function paymentRequiredBody(resourceUrl: string): PaymentRequiredBody {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: VERIFY_DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: PRICE_ATOMIC_USDC,
        asset: USDC_BASE,
        payTo: payToAddress(),
        maxTimeoutSeconds: 60,
        extra: { name: USDC_EIP712.name, version: USDC_EIP712.version },
      },
    ],
    extensions: verifyBazaarExtensions(),
  };
}

export function encodePaymentRequired(body: PaymentRequiredBody): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}
