import type { FacilitatorClient } from "@x402/core/server";
import { FacilitatorResponseError } from "@x402/core/server";
import type { Context, MiddlewareHandler } from "hono";
import { CHECK_CAPACITY_RETRY_AFTER_SECONDS, FACILITATOR_TIMEOUT_MS } from "./config.js";

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
 * Bound verify and settle. A client payment rejection (facilitator 4xx
 * VerifyError / SettleError) is rethrown so x402 still answers 402 and does
 * not settle. Anything else — timeout, network, HTTP 5xx — becomes
 * ProcessorUnavailableError. The caller is not charged.
 */
export function wrapFacilitatorProcessorGuard(inner: FacilitatorClient): FacilitatorClient {
  return {
    getSupported: () => inner.getSupported(),
    verify: (paymentPayload, paymentRequirements) =>
      withProcessorDeadline(() => inner.verify(paymentPayload, paymentRequirements)),
    settle: (paymentPayload, paymentRequirements) =>
      withProcessorDeadline(() => inner.settle(paymentPayload, paymentRequirements)),
  };
}

async function withProcessorDeadline<T>(work: () => Promise<T>): Promise<T> {
  const timeoutMs = resolveFacilitatorTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new ProcessorUnavailableError(`Facilitator request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      work().then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  } catch (error) {
    if (isClientPaymentFailure(error)) throw error;
    throw asProcessorError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function processorUnavailableBody(): { error: string; message: string } {
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
    if (!(await isProcessorUnavailableResponse(current))) return result;
    // Assign c.res. Hono ignores a returned Response once the payment
    // middleware has already finalized a settle-failure 502.
    return processor503(c);
  };
}

async function isProcessorUnavailableResponse(response: Response): Promise<boolean> {
  try {
    const payload = JSON.parse(await response.clone().text()) as { error?: unknown };
    return typeof payload.error === "string" && payload.error.startsWith("processor_unavailable");
  } catch {
    return false;
  }
}

function processor503(c: Context): Response {
  const response = new Response(JSON.stringify(processorUnavailableBody()), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "retry-after": String(CHECK_CAPACITY_RETRY_AFTER_SECONDS),
      "cache-control": "no-store",
    },
  });
  c.res = response;
  return response;
}
