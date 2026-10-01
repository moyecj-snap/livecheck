import { AsyncLocalStorage } from "node:async_hooks";
import type { FacilitatorClient } from "@x402/core/server";
import type { MiddlewareHandler } from "hono";

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
 */
type SettleAbortStore = {
  signal: AbortSignal;
};

const settleAbortAls = new AsyncLocalStorage<SettleAbortStore>();

export function withSettleAbortContext(): MiddlewareHandler {
  return async (c, next) => {
    await settleAbortAls.run({ signal: c.req.raw.signal }, next);
  };
}

export function callerDisconnectedBeforeSettle(): boolean {
  return settleAbortAls.getStore()?.signal.aborted === true;
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
