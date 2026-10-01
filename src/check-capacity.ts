import { timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";
import {
  CHECK_CAPACITY_RETRY_AFTER_SECONDS,
  CHECK_CONCURRENCY,
  CHECK_QUEUE_MAX,
  CHECK_QUEUE_WAIT_MS,
  TEST_MODE_HEADER,
  TEST_MODE_SECRET_ENV,
} from "./config.js";

/**
 * Slots cover the expensive verify pipeline only:
 * POST /v1/verify, POST /v1/verify/job, POST /v1/verify/listing.
 * Confirm and Sentinel stay outside this cap.
 *
 * Unpaid probes do not take a slot. Under capacity they still 402.
 * When every slot is taken they 503 before the payment middleware runs,
 * so a full machine never reaches facilitator verify or settle.
 *
 * A request that will run the check (payment header, mock pay, or test mode)
 * takes a slot before that middleware. If every slot is taken it waits in a
 * short queue (default 30, each at most ~10s). 503 + Retry-After happens
 * only when the queue is full or the wait expires, and still before charging.
 */

const testModeAls = new AsyncLocalStorage<{ enabled: true }>();

type AdmitResult = "ok" | "full" | "timeout" | "aborted";

type Waiter = {
  done: boolean;
  resolve: (result: Exclude<AdmitResult, "full">) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal: AbortSignal;
  onAbort: () => void;
};

let inFlight = 0;
let concurrencyOverride: number | null = null;
let queueMaxOverride: number | null = null;
let queueWaitMsOverride: number | null = null;
const waiters: Waiter[] = [];

export function setCheckConcurrencyForTests(value: number | null): void {
  concurrencyOverride = value;
}

export function setCheckQueueMaxForTests(value: number | null): void {
  queueMaxOverride = value;
}

export function setCheckQueueWaitMsForTests(value: number | null): void {
  queueWaitMsOverride = value;
}

export function checkQueueDepthForTests(): number {
  return waiters.length;
}

export function resetCheckSlotsForTests(): void {
  inFlight = 0;
  for (const waiter of waiters.splice(0)) {
    if (waiter.done) continue;
    waiter.done = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve("timeout");
  }
}

export function resolveCheckConcurrency(): number {
  if (concurrencyOverride != null) return concurrencyOverride;
  const raw = process.env.LIVECHECK_CHECK_CONCURRENCY?.trim();
  if (!raw) return CHECK_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 64) return CHECK_CONCURRENCY;
  return n;
}

export function resolveCheckQueueMax(): number {
  if (queueMaxOverride != null) return queueMaxOverride;
  const raw = process.env.LIVECHECK_CHECK_QUEUE_MAX?.trim();
  if (!raw) return CHECK_QUEUE_MAX;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 256) return CHECK_QUEUE_MAX;
  return n;
}

export function resolveCheckQueueWaitMs(): number {
  if (queueWaitMsOverride != null) return queueWaitMsOverride;
  const raw = process.env.LIVECHECK_CHECK_QUEUE_WAIT_MS?.trim();
  if (!raw) return CHECK_QUEUE_WAIT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 120_000) return CHECK_QUEUE_WAIT_MS;
  return n;
}

export function isBurstCheckPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "") || "/";
  return normalized === "/v1/verify" || normalized === "/v1/verify/job" || normalized === "/v1/verify/listing";
}

/** True only inside a verify request whose test-mode secret matched. */
export function isInternalTestMode(): boolean {
  return testModeAls.getStore()?.enabled === true;
}

export function testModeAuthorized(headerValue: string | undefined): boolean {
  const secret = process.env[TEST_MODE_SECRET_ENV]?.trim() ?? "";
  if (!secret || headerValue == null) return false;
  const provided = headerValue.trim();
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(secret);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hasPaymentAttempt(c: Context): boolean {
  return Boolean(c.req.header("payment-signature") || c.req.header("x-payment") || c.req.header("x-livecheck-mock"));
}

function slotsFull(): boolean {
  return inFlight >= resolveCheckConcurrency();
}

function tryAcquire(): boolean {
  if (slotsFull()) return false;
  inFlight += 1;
  return true;
}

function finish(waiter: Waiter, result: Exclude<AdmitResult, "full">): boolean {
  if (waiter.done) return false;
  waiter.done = true;
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.signal.removeEventListener("abort", waiter.onAbort);
  const index = waiters.indexOf(waiter);
  if (index >= 0) waiters.splice(index, 1);
  waiter.resolve(result);
  return true;
}

function release(): void {
  while (waiters.length > 0) {
    const next = waiters[0];
    if (!next) break;
    if (next.done) {
      waiters.shift();
      continue;
    }
    if (finish(next, "ok")) return;
  }
  inFlight = Math.max(0, inFlight - 1);
}

function enqueue(signal: AbortSignal): Promise<Exclude<AdmitResult, "full">> {
  return new Promise((resolve) => {
    const waiter: Waiter = {
      done: false,
      resolve,
      signal,
      timer: null,
      onAbort: () => undefined,
    };
    waiter.onAbort = () => {
      finish(waiter, "aborted");
    };
    waiter.timer = setTimeout(() => finish(waiter, "timeout"), resolveCheckQueueWaitMs());
    waiters.push(waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal.aborted) finish(waiter, "aborted");
  });
}

async function admit(signal: AbortSignal): Promise<AdmitResult> {
  if (signal.aborted) return "aborted";
  if (tryAcquire()) return "ok";
  if (waiters.length >= resolveCheckQueueMax()) return "full";
  return enqueue(signal);
}

function capacity503(c: Context) {
  c.header("retry-after", String(CHECK_CAPACITY_RETRY_AFTER_SECONDS));
  c.header("cache-control", "no-store");
  return c.json(
    {
      error: "over_capacity",
      message: "Too many checks are in progress. Retry after the Retry-After delay. You were not charged.",
    },
    503,
  );
}

async function runAdmitted(c: Context, run: () => Promise<Response | void>): Promise<Response | void> {
  const outcome = await admit(c.req.raw.signal);
  if (outcome !== "ok") {
    // A closed connection must not fall through into the verify handler.
    if (outcome === "aborted" || c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    return capacity503(c);
  }
  try {
    return await run();
  } finally {
    release();
  }
}

/**
 * Runs in place of the bare payment gate. Non-verify routes (Confirm,
 * Sentinel, discovery) call the gate unchanged.
 */
export function withBurstProtection(paymentGate: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST" || !isBurstCheckPath(c.req.path)) {
      return paymentGate(c, next);
    }

    if (testModeAuthorized(c.req.header(TEST_MODE_HEADER))) {
      return runAdmitted(c, () => testModeAls.run({ enabled: true }, () => next()));
    }

    if (!hasPaymentAttempt(c)) {
      if (slotsFull()) return capacity503(c);
      return paymentGate(c, next);
    }

    return runAdmitted(c, () => paymentGate(c, next));
  };
}
