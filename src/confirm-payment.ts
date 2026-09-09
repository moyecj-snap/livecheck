import { AsyncLocalStorage } from "node:async_hooks";
import type { FacilitatorClient } from "@x402/core/server";
import type { MiddlewareHandler } from "hono";
import {
  MOCK_PAYMENT_HEADER,
  ORDER_PLACED_PRICE_ATOMIC_USDC,
  ORDER_PLACED_PRICE_LABEL,
  ORDER_PLACED_PRICE_USD,
} from "./config.js";
import { ORDER_PLACED_INTENT } from "./order-placed.js";
import { VerifyError } from "./verify.js";

type VerifyArgs = Parameters<FacilitatorClient["verify"]>;
type PaymentPayload = VerifyArgs[0];
type PaymentRequirements = VerifyArgs[1];

export type ConfirmPayment =
  | { kind: "mock" }
  | { kind: "verified"; atomic: bigint }
  | { kind: "unknown" };

type ConfirmPaymentStore = {
  atomic?: bigint;
  mock?: boolean;
};

const confirmPaymentAls = new AsyncLocalStorage<ConfirmPaymentStore>();

export class InsufficientConfirmPaymentError extends VerifyError {
  readonly code = "payment_amount_insufficient" as const;
  readonly intent = ORDER_PLACED_INTENT;
  readonly required_atomic = ORDER_PLACED_PRICE_ATOMIC_USDC;
  readonly paid_atomic: string | null;

  constructor(paidAtomic: bigint | null) {
    const paid = paidAtomic == null ? "unknown" : paidAtomic.toString();
    super(
      `payment_amount_insufficient: order_placed requires ${ORDER_PLACED_PRICE_LABEL} (${ORDER_PLACED_PRICE_ATOMIC_USDC} atomic); paid ${paid}`,
      402,
    );
    this.name = "InsufficientConfirmPaymentError";
    this.paid_atomic = paidAtomic == null ? null : paidAtomic.toString();
  }
}

export function withConfirmPaymentContext(): MiddlewareHandler {
  return async (_c, next) => {
    await confirmPaymentAls.run({}, next);
  };
}

export function rememberMockConfirmPayment(): void {
  const store = confirmPaymentAls.getStore();
  if (store) store.mock = true;
}

export function rememberVerifiedAtomic(amount: string | number | bigint): void {
  const store = confirmPaymentAls.getStore();
  if (!store) return;
  try {
    store.atomic = BigInt(amount);
  } catch {
    // ignore non-numeric facilitator amounts
  }
}

export function peekVerifiedAtomic(): bigint | undefined {
  return confirmPaymentAls.getStore()?.atomic;
}

export function isMockPayHeaders(headers: {
  get(name: string): string | undefined | null;
}): boolean {
  return (
    headers.get("x-livecheck-mock") === "1" ||
    headers.get("payment-signature") === MOCK_PAYMENT_HEADER ||
    headers.get("x-payment") === MOCK_PAYMENT_HEADER
  );
}

function pickAmount(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const amount = (value as { amount?: unknown }).amount;
  if (typeof amount === "string" && amount.trim()) return amount.trim();
  if (typeof amount === "number" && Number.isFinite(amount)) return String(Math.trunc(amount));
  return undefined;
}

/** Decode a PAYMENT-SIGNATURE / X-PAYMENT envelope and read accepted.amount. */
export function atomicFromPaymentSignatureHeader(raw: string | undefined | null): bigint | null {
  if (!raw || raw === MOCK_PAYMENT_HEADER) return null;
  try {
    const text = raw.trim();
    const decoded = text.startsWith("{")
      ? (JSON.parse(text) as unknown)
      : (JSON.parse(Buffer.from(text, "base64").toString("utf8")) as unknown);
    const amount =
      pickAmount(decoded && typeof decoded === "object" ? (decoded as { accepted?: unknown }).accepted : undefined) ??
      pickAmount(decoded);
    if (!amount) return null;
    return BigInt(amount);
  } catch {
    return null;
  }
}

export function resolveConfirmPayment(headers: {
  get(name: string): string | undefined | null;
}): ConfirmPayment {
  if (isMockPayHeaders(headers) || confirmPaymentAls.getStore()?.mock) {
    return { kind: "mock" };
  }
  const stored = peekVerifiedAtomic();
  if (stored != null) return { kind: "verified", atomic: stored };
  const fromHeader = atomicFromPaymentSignatureHeader(
    headers.get("payment-signature") ?? headers.get("PAYMENT-SIGNATURE") ?? headers.get("x-payment"),
  );
  if (fromHeader != null) return { kind: "verified", atomic: fromHeader };
  return { kind: "unknown" };
}

/**
 * order_placed must have verified/settled ≥ $0.25 (250000 atomic).
 * lead_submit / listing_published stay $0.10 and are not re-checked here.
 * Mock pay bypasses the amount check (same as the unpaid 402 gate).
 *
 * @x402/hono 2.24.0 verifies, then runs the handler, then settles only when
 * the handler returns status below 400. Throwing 402 here cancels settle.
 */
export function assertConfirmPaymentCoversIntent(intent: string, payment: ConfirmPayment): void {
  if (intent !== ORDER_PLACED_INTENT) return;
  if (payment.kind === "mock") return;
  const paid = payment.kind === "verified" ? payment.atomic : null;
  if (paid == null || paid < BigInt(ORDER_PLACED_PRICE_ATOMIC_USDC)) {
    throw new InsufficientConfirmPaymentError(paid);
  }
}

export function underpaidOrderPlacedBody(error: InsufficientConfirmPaymentError): Record<string, unknown> {
  return {
    error: error.code,
    intent: error.intent,
    required_usd: ORDER_PLACED_PRICE_USD,
    required_atomic: error.required_atomic,
    paid_atomic: error.paid_atomic,
    message: error.message,
  };
}

/**
 * Remember the matched accept amount when the facilitator verifies/settles.
 * That amount is what @x402/hono selected from accepts[] ($0.10 or $0.25).
 */
export function wrapFacilitatorForVerifiedAmount(inner: FacilitatorClient): FacilitatorClient {
  const remember = (requirements: PaymentRequirements, payload: PaymentPayload) => {
    const amount =
      pickAmount(requirements) ??
      pickAmount(
        payload && typeof payload === "object" ? (payload as { accepted?: unknown }).accepted : undefined,
      );
    if (amount) rememberVerifiedAtomic(amount);
  };
  return {
    getSupported: () => inner.getSupported(),
    verify: (paymentPayload, paymentRequirements) => {
      remember(paymentRequirements, paymentPayload);
      return inner.verify(paymentPayload, paymentRequirements);
    },
    settle: (paymentPayload, paymentRequirements) => {
      remember(paymentRequirements, paymentPayload);
      return inner.settle(paymentPayload, paymentRequirements);
    },
  };
}

/** Test helper: treat the request as already paid at `atomic` (or mock). */
export function settledAmountGate(atomic: string | "mock"): MiddlewareHandler {
  return async (c, next) => {
    const paidPath = c.req.path === "/v1/verify" || c.req.path === "/v1/confirm";
    if (c.req.method !== "POST" || !paidPath) return next();
    if (atomic === "mock") rememberMockConfirmPayment();
    else rememberVerifiedAtomic(atomic);
    return next();
  };
}
