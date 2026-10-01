import { timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";
import {
  CHECK_CAPACITY_RETRY_AFTER_SECONDS,
  CHECK_CONCURRENCY,
  TEST_MODE_HEADER,
  TEST_MODE_SECRET_ENV,
} from "./config.js";

/**
 * Slots cover the expensive verify pipeline only:
 * POST /v1/verify, POST /v1/verify/job, POST /v1/verify/listing.
 * Confirm and Sentinel stay outside this cap.
 *
 * Unpaid probes do not take a slot: under capacity they still 402.
 * Over capacity they 503 before the payment middleware runs, so a full
 * machine never reaches facilitator verify or settle.
 * A request that will run the check (payment header, mock pay, or test mode)
 * takes a slot before that middleware. Overflow is 503 + Retry-After and is
 * not billed.
 */

const testModeAls = new AsyncLocalStorage<{ enabled: true }>();

let inFlight = 0;
let concurrencyOverride: number | null = null;

export function setCheckConcurrencyForTests(value: number | null): void {
  concurrencyOverride = value;
}

export function resetCheckSlotsForTests(): void {
  inFlight = 0;
}

export function resolveCheckConcurrency(): number {
  if (concurrencyOverride != null) return concurrencyOverride;
  const raw = process.env.LIVECHECK_CHECK_CONCURRENCY?.trim();
  if (!raw) return CHECK_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 64) return CHECK_CONCURRENCY;
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

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
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
      if (!tryAcquire()) return capacity503(c);
      try {
        return await testModeAls.run({ enabled: true }, () => next());
      } finally {
        release();
      }
    }

    if (!hasPaymentAttempt(c)) {
      if (slotsFull()) return capacity503(c);
      return paymentGate(c, next);
    }

    if (!tryAcquire()) return capacity503(c);
    try {
      return await paymentGate(c, next);
    } finally {
      release();
    }
  };
}
