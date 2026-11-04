import { AsyncLocalStorage } from "node:async_hooks";
import type { FacilitatorClient } from "@x402/core/server";
import type { MiddlewareHandler } from "hono";
import { isoTs, responseRouteFromPath, type PaidCallRoute, type PaymentProtocol } from "./paid-call.js";
import { logRefundCandidate } from "./refund-candidate-log.js";

/**
 * Request signal captured around the x402 gate.
 *
 * @x402/hono 2.24.0 (exact / authorization) verifies, runs the handler, then
 * calls facilitator.settle only when the handler status is below 400. That
 * settle is still before @hono/node-server writes the response. If the client
 * or proxy closes the socket while fetch/classify is in progress, node-server
 * aborts this signal ("Client connection prematurely closed") and the handler
 * can still return 200. Skipping settle in that case keeps a timeout or
 * disconnect from charging the caller.
 *
 * If the caller leaves *during* settle (or during an MPP-paid handler), the
 * payment is collected and the answer is never delivered. node-server aborts
 * the signal only when the response closed before it finished writing, so a
 * payment noted with noteSettledPayment plus an aborted signal is listed as a
 * refund candidate (`settled_no_response_delivered`). Listing only.
 */
export type SettledPayment = {
  protocol: PaymentProtocol;
  /** On-chain tx hash when known. */
  payment_id?: string;
  payer?: string;
  amount_usd?: string;
  settled_at: string;
  /** Defaults to the route from the request path. */
  route?: PaidCallRoute;
};

type SettleAbortStore = {
  signal: AbortSignal;
  route?: PaidCallRoute;
  settled?: SettledPayment;
  listed?: boolean;
};

const settleAbortAls = new AsyncLocalStorage<SettleAbortStore>();

export const SETTLED_NO_RESPONSE_REASON = "settled_no_response_delivered";

/** Refund-candidate route for a paid path. Watch top-ups (/v1/watch/{id}/chain/topup) count as watch. */
export function refundRouteForPath(path: string): PaidCallRoute | undefined {
  const route = responseRouteFromPath(path);
  if (route) return route;
  return /^\/v1\/watch\/[^/]+\/chain\/topup\/?$/.test(path.split("?")[0] ?? path) ? "watch" : undefined;
}

export function withSettleAbortContext(): MiddlewareHandler {
  return async (c, next) => {
    const route = refundRouteForPath(c.req.path);
    await settleAbortAls.run({ signal: c.req.raw.signal, ...(route ? { route } : {}) }, next);
  };
}

export function callerDisconnectedBeforeSettle(): boolean {
  return settleAbortAls.getStore()?.signal.aborted === true;
}

/** Paid route of the current request, when known (used by the x402 settle guard). */
export function currentPaidRoute(): PaidCallRoute | undefined {
  return settleAbortAls.getStore()?.route;
}

function listUndelivered(store: SettleAbortStore): void {
  const settled = store.settled;
  if (!settled || store.listed) return;
  const route = settled.route ?? store.route;
  if (!route) return;
  store.listed = true;
  logRefundCandidate({
    ts: isoTs(),
    protocol: settled.protocol,
    ...(settled.payment_id ? { payment_id: settled.payment_id } : {}),
    route,
    reason: SETTLED_NO_RESPONSE_REASON,
    ...(settled.payer ? { payer: settled.payer } : {}),
    ...(settled.amount_usd ? { amount_usd: settled.amount_usd } : {}),
    settled_at: settled.settled_at,
  });
}

/**
 * Record that this request's payment settled. If the caller is already gone,
 * or leaves before the response finishes writing, it becomes a refund
 * candidate. A normal, fully written response never aborts the signal.
 */
export function noteSettledPayment(payment: SettledPayment): void {
  const store = settleAbortAls.getStore();
  if (!store) return;
  store.settled = payment;
  if (store.signal.aborted) {
    listUndelivered(store);
    return;
  }
  store.signal.addEventListener("abort", () => listUndelivered(store), { once: true });
}

/**
 * Do not call the facilitator when the caller is already gone.
 * A failed SettleResponse is not retried (only settlement_pending is) and
 * does not run onAfterSettle, so Stripe and paid_call stay unrecorded.
 */
export function wrapFacilitatorSkipSettleIfDisconnected(inner: FacilitatorClient): FacilitatorClient {
  return {
    getSupported: () => inner.getSupported(),
    verify: (paymentPayload, paymentRequirements) => inner.verify(paymentPayload, paymentRequirements),
    settle: (paymentPayload, paymentRequirements) => {
      if (callerDisconnectedBeforeSettle()) {
        return Promise.resolve({
          success: false,
          errorReason: "request_aborted",
          errorMessage: "Caller disconnected before settlement; payment was not collected.",
          transaction: "",
          network: paymentRequirements.network,
        });
      }
      return inner.settle(paymentPayload, paymentRequirements);
    },
  };
}
