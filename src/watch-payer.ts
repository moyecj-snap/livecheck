import { AsyncLocalStorage } from "node:async_hooks";
import type { FacilitatorClient } from "@x402/core/server";
import type { MiddlewareHandler } from "hono";
import { MOCK_PAY_TO, isLiveSettlement } from "./config.js";
import { extractPayer, sanitizePayer } from "./paid-call.js";

type WatchPayerStore = {
  payer?: string;
};

const watchPayerAls = new AsyncLocalStorage<WatchPayerStore>();

function pickFromPaymentHeader(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  try {
    const text = raw.trim();
    const decoded = text.startsWith("{")
      ? (JSON.parse(text) as unknown)
      : (JSON.parse(Buffer.from(text, "base64").toString("utf8")) as unknown);
    return extractPayer(undefined, decoded);
  } catch {
    return undefined;
  }
}

export function rememberWatchPayer(payer: string): void {
  const store = watchPayerAls.getStore();
  const sanitized = sanitizePayer(payer);
  if (store && sanitized) store.payer = sanitized;
}

export function currentWatchPayer(): string | undefined {
  return watchPayerAls.getStore()?.payer;
}

/**
 * Paying wallet for duplicate/rate-limit. Live: facilitator payload, then
 * PAYMENT-SIGNATURE. Mock: X-Livecheck-Payer, else MOCK_PAY_TO.
 */
export function resolveWatchPayer(headers: {
  get(name: string): string | undefined | null;
}): string {
  const stored = currentWatchPayer();
  if (stored) return stored;
  const fromHeader = sanitizePayer(headers.get("x-livecheck-payer"));
  if (fromHeader) return fromHeader;
  const fromPayment = pickFromPaymentHeader(
    headers.get("payment-signature") ?? headers.get("PAYMENT-SIGNATURE") ?? headers.get("x-payment"),
  );
  if (fromPayment) return fromPayment;
  if (!isLiveSettlement()) return MOCK_PAY_TO.toLowerCase();
  return MOCK_PAY_TO.toLowerCase();
}

export function withWatchPayerContext(): MiddlewareHandler {
  return async (c, next) => {
    const initial =
      sanitizePayer(c.req.header("x-livecheck-payer")) ??
      pickFromPaymentHeader(
        c.req.header("payment-signature") ?? c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("x-payment"),
      ) ??
      (!isLiveSettlement() ? MOCK_PAY_TO.toLowerCase() : undefined);
    await watchPayerAls.run({ payer: initial }, next);
  };
}

/** Remember payer from the verified x402 envelope (live settle path). */
export function wrapFacilitatorForWatchPayer(inner: FacilitatorClient): FacilitatorClient {
  const remember = (payload: unknown) => {
    const payer = extractPayer(undefined, payload);
    if (payer) rememberWatchPayer(payer);
  };
  return {
    getSupported: () => inner.getSupported(),
    verify: (paymentPayload, paymentRequirements) => {
      remember(paymentPayload);
      return inner.verify(paymentPayload, paymentRequirements);
    },
    settle: (paymentPayload, paymentRequirements) => {
      remember(paymentPayload);
      return inner.settle(paymentPayload, paymentRequirements);
    },
  };
}
