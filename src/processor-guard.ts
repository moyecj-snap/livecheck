import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { FacilitatorResponseError } from "@x402/core/server";
import type { Context, MiddlewareHandler } from "hono";
import {
  CHECK_CAPACITY_RETRY_AFTER_SECONDS,
  FACILITATOR_TIMEOUT_MS,
  PAYMENT_STATUS_UNKNOWN_MESSAGE,
  PAYMENT_STATUS_UNKNOWN_RETRY_AFTER_SECONDS,
} from "./config.js";
import { extractPayer, isoTs, sanitizeTx } from "./paid-call.js";
import { logRefundCandidate, usdFromAtomic } from "./refund-candidate-log.js";
import { currentPaidRoute, noteSettledPayment } from "./settle-abort.js";

/**
 * Thrown when Coinbase/CDP verify or settle times out or errors.
 * Extends the x402 facilitator error so the payment middleware does not turn
 * it into a 402 (which would invite a retry of the same payment) and does not
 * settle. withProcessorUnavailable503 rewrites the resulting 502 to 503.
 */
export class ProcessorUnavailableError extends FacilitatorResponseError {
  constructor(detail: string) {
    super(`processor_unavailable: ${detail}`);
    this.name = "ProcessorUnavailableError";
  }
}

/**
 * Thrown when settle passes the 5s limit or the processor errors during
 * settle. The facilitator may still settle, so the caller is told
 * "Payment status unknown", never "not charged". Same 502 -> 503 rewrite.
 */
export class SettleStatusUnknownError extends FacilitatorResponseError {
  constructor(detail: string) {
    super(`payment_status_unknown: ${detail}`);
    this.name = "SettleStatusUnknownError";
  }
}

export const LATE_SETTLE_REASON = "settled_after_status_unknown";
export const SETTLE_TIMEOUT_UNRESOLVED_REASON = "settle_timeout_unresolved";
export const SETTLE_ERROR_UNRESOLVED_REASON = "settle_error_unresolved";

/**
 * Called once when a settle succeeds after the caller already got 503
 * payment_status_unknown. Runs in the original request's async context, so
 * the paid-call record from the handler is still available. Live wiring
 * records Stripe and writes the paid_calls row (settle_late). Errors are logged.
 */
export type LateSettleRecorder = (args: {
  result: SettleResponse;
  requirements: PaymentRequirements;
  paymentPayload: PaymentPayload;
}) => Promise<void> | void;

export type ProcessorGuardHooks = { onLateSettle?: LateSettleRecorder };

let facilitatorTimeoutOverrideMs: number | null = null;

/** Test seam. Production uses FACILITATOR_TIMEOUT_MS (5s). */
export function setFacilitatorTimeoutForTests(ms: number | null): void {
  facilitatorTimeoutOverrideMs = ms;
}

export function resolveFacilitatorTimeoutMs(): number {
  return facilitatorTimeoutOverrideMs ?? FACILITATOR_TIMEOUT_MS;
}

function httpStatusFromMessage(error: Error): number | null {
  const match = /\((\d{3})\)/.exec(error.message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

/**
 * Invalid payments stay 402 and are not settled. HTTP 4xx from the facilitator
 * (except 408/429) is a rejected payload, including CDP's invalid_request body.
 * Timeouts, network failures, and HTTP 5xx are processor outages.
 */
function isClientPaymentFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "VerifyError" || error.name === "SettleError") {
    const status = (error as { statusCode?: number }).statusCode;
    return typeof status !== "number" || status < 500;
  }
  const status = httpStatusFromMessage(error);
  if (status == null || status < 400 || status >= 500) return false;
  return status !== 408 && status !== 429;
}

function asProcessorError(error: unknown): ProcessorUnavailableError {
  if (error instanceof ProcessorUnavailableError) return error;
  const detail = error instanceof Error ? error.message : "Payment processor request failed";
  return new ProcessorUnavailableError(detail);
}

/**
 * Bound verify and settle for the caller at FACILITATOR_TIMEOUT_MS (5s).
 * A client payment rejection (facilitator 4xx VerifyError / SettleError) is
 * rethrown so x402 still answers 402.
 *
 * - verify timeout / network / HTTP 5xx: ProcessorUnavailableError. This is
 *   before any payment, so "You were not charged." is true.
 * - settle timeout / network / HTTP 5xx: SettleStatusUnknownError ("Payment
 *   status unknown"). The facilitator request keeps running in the background
 *   (FACILITATOR_SETTLE_OBSERVE_MS on the live HTTP client). A late success is
 *   listed as a refund candidate with its tx; an outcome never learned is
 *   listed without one. Listing only: nothing is refunded automatically.
 * - settle success in time: noted for the disconnect watch (settle-abort.ts).
 */
export function wrapFacilitatorProcessorGuard(inner: FacilitatorClient, hooks: ProcessorGuardHooks = {}): FacilitatorClient {
  return {
    getSupported: () => inner.getSupported(),
    verify: async (paymentPayload, paymentRequirements) => {
      const outcome = await withProcessorDeadline(() => inner.verify(paymentPayload, paymentRequirements));
      if (outcome.kind === "value") return outcome.value;
      if (isClientPaymentFailure(outcome.error)) throw outcome.error;
      throw asProcessorError(outcome.error);
    },
    settle: async (paymentPayload, paymentRequirements) => {
      const route = currentPaidRoute() ?? "verify";
      const payer = extractPayer(undefined, paymentPayload);
      const amountUsd = usdFromAtomic((paymentRequirements as { amount?: unknown }).amount);
      const base = {
        protocol: "x402" as const,
        route,
        ...(payer ? { payer } : {}),
        ...(amountUsd ? { amount_usd: amountUsd } : {}),
      };
      const outcome = await withProcessorDeadline(() => inner.settle(paymentPayload, paymentRequirements), (late, respondedAt) => {
        // The caller already has 503 payment_status_unknown.
        if (late.kind === "value") {
          const result = late.value;
          const tx = sanitizeTx(result.transaction);
          if (result.success) {
            const resultPayer = extractPayer(result, paymentPayload);
            logRefundCandidate({
              ...base,
              ts: isoTs(),
              ...(tx ? { payment_id: tx } : {}),
              ...(resultPayer ? { payer: resultPayer } : {}),
              reason: LATE_SETTLE_REASON,
              responded_at: respondedAt,
              settled_at: isoTs(),
            });
            // Count it as a paid call too (same bucket, marked settle_late), so
            // /stats matches Stripe and on-chain. The tx unique index keeps a
            // retry from counting it twice.
            const recorder = hooks.onLateSettle;
            if (recorder) {
              Promise.resolve()
                .then(() => recorder({ result, requirements: paymentRequirements, paymentPayload }))
                .catch((error: unknown) => {
                  console.warn(
                    `[x402] late settle paid-call record failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                });
            }
          } else if (result.errorReason === "settlement_pending") {
            // Broadcast but unconfirmed: may still land. Keep the tx for lookup.
            logRefundCandidate({
              ...base,
              ts: isoTs(),
              ...(tx ? { payment_id: tx } : {}),
              reason: SETTLE_TIMEOUT_UNRESOLVED_REASON,
              responded_at: respondedAt,
            });
          } else {
            console.warn(`[x402] late settle after status unknown did not collect: ${result.errorReason ?? "failed"}`);
          }
          return;
        }
        if (isClientPaymentFailure(late.error)) {
          console.warn("[x402] late settle after status unknown was rejected; not collected");
          return;
        }
        logRefundCandidate({ ...base, ts: isoTs(), reason: SETTLE_TIMEOUT_UNRESOLVED_REASON, responded_at: respondedAt });
      });
      if (outcome.kind === "value") {
        const result = outcome.value;
        if (result.success) {
          const tx = sanitizeTx(result.transaction);
          const resultPayer = extractPayer(result, paymentPayload);
          noteSettledPayment({
            ...base,
            ...(tx ? { payment_id: tx } : {}),
            ...(resultPayer ? { payer: resultPayer } : {}),
            settled_at: isoTs(),
          });
        }
        return result;
      }
      if (isClientPaymentFailure(outcome.error)) throw outcome.error;
      if (outcome.timedOut) {
        throw new SettleStatusUnknownError(`Facilitator settle did not finish within ${resolveFacilitatorTimeoutMs()}ms`);
      }
      // Network failure or HTTP 5xx during settle: the outcome is unknown and
      // will not be learned. List it so a charge can be found and refunded.
      logRefundCandidate({ ...base, ts: isoTs(), reason: SETTLE_ERROR_UNRESOLVED_REASON, responded_at: isoTs() });
      const detail = outcome.error instanceof Error ? outcome.error.message : "Payment processor request failed";
      throw new SettleStatusUnknownError(detail);
    },
  };
}

type Outcome<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown; timedOut: boolean };
type LateOutcome<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown };

/**
 * Race work against the deadline. On timeout, `onLate` (if given) receives
 * the eventual result of the same work, with the ISO time the caller was answered.
 */
async function withProcessorDeadline<T>(
  work: () => Promise<T>,
  onLate?: (late: LateOutcome<T>, respondedAt: string) => void,
): Promise<Outcome<T>> {
  const timeoutMs = resolveFacilitatorTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let respondedAt: string | undefined;
  return await new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      respondedAt = isoTs();
      resolve({
        kind: "error",
        error: new ProcessorUnavailableError(`Facilitator request timed out after ${timeoutMs}ms`),
        timedOut: true,
      });
    }, timeoutMs);
    let started: Promise<T>;
    try {
      started = work();
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(
      (value) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ kind: "value", value });
          return;
        }
        safeLate(onLate, { kind: "value", value }, respondedAt);
      },
      (error: unknown) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ kind: "error", error, timedOut: false });
          return;
        }
        safeLate(onLate, { kind: "error", error }, respondedAt);
      },
    );
  });
}

function safeLate<T>(
  onLate: ((late: LateOutcome<T>, respondedAt: string) => void) | undefined,
  late: LateOutcome<T>,
  respondedAt: string | undefined,
): void {
  if (!onLate) return;
  try {
    onLate(late, respondedAt ?? isoTs());
  } catch (error) {
    console.warn(`[x402] late settle bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Processor503Kind = "processor_unavailable" | "payment_status_unknown";

function processor503Body(kind: Processor503Kind): { error: string; message: string } {
  if (kind === "payment_status_unknown") {
    return { error: "payment_status_unknown", message: PAYMENT_STATUS_UNKNOWN_MESSAGE };
  }
  // Verify-phase only: nothing was settled.
  return {
    error: "processor_unavailable",
    message: "Payment processor did not respond. You were not charged.",
  };
}

/**
 * x402 turns FacilitatorResponseError into HTTP 502. Processor failures must
 * be 503 and must not be confused with a page-fetch 502 from the handler.
 */
export function withProcessorUnavailable503(inner: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    const result = await inner(c, next);
    const returned = result instanceof Response ? result : undefined;
    const current = returned ?? (c.res?.status === 502 ? c.res : undefined);
    if (!current || current.status !== 502) return result;
    const kind = await processor503Kind(current);
    if (!kind) return result;
    // Assign c.res. Hono ignores a returned Response once the payment
    // middleware has already finalized a settle-failure 502.
    return processor503(c, kind);
  };
}

async function processor503Kind(response: Response): Promise<Processor503Kind | undefined> {
  try {
    const payload = JSON.parse(await response.clone().text()) as { error?: unknown };
    if (typeof payload.error !== "string") return undefined;
    if (payload.error.startsWith("payment_status_unknown")) return "payment_status_unknown";
    if (payload.error.startsWith("processor_unavailable")) return "processor_unavailable";
    return undefined;
  } catch {
    return undefined;
  }
}

function processor503(c: Context, kind: Processor503Kind): Response {
  const retryAfter =
    kind === "payment_status_unknown" ? PAYMENT_STATUS_UNKNOWN_RETRY_AFTER_SECONDS : CHECK_CAPACITY_RETRY_AFTER_SECONDS;
  const response = new Response(JSON.stringify(processor503Body(kind)), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "retry-after": String(retryAfter),
      "cache-control": "no-store",
    },
  });
  c.res = response;
  return response;
}
