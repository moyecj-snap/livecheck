import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { isLiveSettlement } from "./config.js";

export const PAID_CALL_EVENT = "livecheck.paid_call" as const;

export type PaidCallRoute = "verify" | "confirm";

export type PaidCallSettlement = {
  payer?: string;
  tx?: string;
  payment_intent?: string;
};

export type PaidCallRemembered = {
  route: PaidCallRoute;
  intent?: string;
  status?: string;
  verdict?: string;
  host: string;
  url_hash: string;
};

export type PaidCallEvent = {
  event: typeof PAID_CALL_EVENT;
  route: PaidCallRoute;
  intent?: string;
  status?: string;
  verdict?: string;
  host: string;
  url_hash: string;
  payer?: string;
  tx?: string;
  payment_intent?: string;
  ts: string;
};

type PaidCallStore = {
  remembered?: PaidCallRemembered;
  emitted: boolean;
};

const paidCallAls = new AsyncLocalStorage<PaidCallStore>();

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** SHA-256 hex of the full URL. The raw URL is never returned. */
export function hashUrl(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

/** Hostname only — no userinfo, path, query, or fragment. */
export function hostnameOnly(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function looksLikeEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function isTxHash(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value.trim());
}

function isPaymentIntentId(value: string): boolean {
  return /^pi_[A-Za-z0-9]+$/.test(value.trim());
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Accept a wallet address only. Drop emails and anything that is not an 0x address.
 */
export function sanitizePayer(value: unknown): string | undefined {
  const raw = pickString(value);
  if (!raw || looksLikeEmail(raw)) return undefined;
  if (isHexAddress(raw)) return raw.toLowerCase();
  return undefined;
}

export function sanitizeTx(value: unknown): string | undefined {
  const raw = pickString(value);
  if (!raw || looksLikeEmail(raw)) return undefined;
  if (isTxHash(raw)) return raw.toLowerCase();
  return undefined;
}

export function sanitizePaymentIntent(value: unknown): string | undefined {
  const raw = pickString(value);
  if (!raw || looksLikeEmail(raw)) return undefined;
  if (isPaymentIntentId(raw)) return raw;
  return undefined;
}

function walkForString(value: unknown, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Payer from settle result or payment payload. Never an email. */
export function extractPayer(result: unknown, paymentPayload?: unknown): string | undefined {
  const fromResult = sanitizePayer(
    result && typeof result === "object" ? (result as { payer?: unknown }).payer : undefined,
  );
  if (fromResult) return fromResult;

  const candidates = [
    walkForString(paymentPayload, ["payload", "authorization", "from"]),
    walkForString(paymentPayload, ["payload", "from"]),
    walkForString(paymentPayload, ["accepted", "from"]),
  ];
  for (const candidate of candidates) {
    const payer = sanitizePayer(candidate);
    if (payer) return payer;
  }
  return undefined;
}

export function urlHostAndHash(url: string): { host: string; url_hash: string } {
  return { host: hostnameOnly(url), url_hash: hashUrl(url) };
}

export function isoTs(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildPaidCallEvent(
  remembered: PaidCallRemembered,
  settlement: PaidCallSettlement = {},
  now = new Date(),
): PaidCallEvent {
  const event: PaidCallEvent = {
    event: PAID_CALL_EVENT,
    route: remembered.route,
    host: remembered.host,
    url_hash: remembered.url_hash,
    ts: isoTs(now),
  };
  if (remembered.route === "confirm" && remembered.intent) {
    event.intent = remembered.intent;
  }
  if (remembered.route === "verify" && remembered.status) {
    event.status = remembered.status;
  }
  if (remembered.route === "confirm" && remembered.verdict) {
    event.verdict = remembered.verdict;
  }
  const payer = sanitizePayer(settlement.payer);
  const tx = sanitizeTx(settlement.tx);
  const paymentIntent = sanitizePaymentIntent(settlement.payment_intent);
  if (payer) event.payer = payer;
  if (tx) event.tx = tx;
  if (paymentIntent) event.payment_intent = paymentIntent;
  return event;
}

/** Serialized event plus the raw URL used to build it — for leak tests. */
export function serializePaidCall(event: PaidCallEvent): string {
  return JSON.stringify(event);
}

export function paidCallLineContainsSensitive(line: string, rawUrl: string): string[] {
  const leaks: string[] = [];
  if (line.includes(rawUrl)) leaks.push("full_url");
  let parsed: URL | undefined;
  try {
    parsed = new URL(rawUrl);
  } catch {
    parsed = undefined;
  }
  if (parsed) {
    if (parsed.search && line.includes(parsed.search)) leaks.push("query_string");
    if (parsed.searchParams.toString() && line.includes(parsed.searchParams.toString())) {
      leaks.push("query_params");
    }
    for (const value of parsed.searchParams.values()) {
      if (value && looksLikeEmail(value) && line.includes(value)) leaks.push("email");
    }
    if (parsed.username && line.includes(parsed.username)) leaks.push("userinfo");
    if (parsed.password && line.includes(parsed.password)) leaks.push("password");
    if (parsed.pathname.length > 1 && line.includes(parsed.pathname)) leaks.push("path");
  }
  const emails = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  if (emails.length) leaks.push("email");
  return [...new Set(leaks)];
}

export function withPaidCallContext(): MiddlewareHandler {
  return async (_c, next) => {
    await paidCallAls.run({ emitted: false }, next);
  };
}

export function rememberPaidCall(input: {
  route: PaidCallRoute;
  url: string;
  intent?: string;
  status?: string;
  verdict?: string;
}): PaidCallRemembered {
  const remembered: PaidCallRemembered = {
    route: input.route,
    host: hostnameOnly(input.url),
    url_hash: hashUrl(input.url),
  };
  if (input.route === "confirm" && input.intent) remembered.intent = input.intent;
  if (input.route === "verify" && input.status) remembered.status = input.status;
  if (input.route === "confirm" && input.verdict) remembered.verdict = input.verdict;
  const store = paidCallAls.getStore();
  if (store) store.remembered = remembered;
  return remembered;
}

export function emitPaidCall(
  settlement: PaidCallSettlement = {},
  writer: (line: string) => void = (line) => console.log(line),
  now = new Date(),
): PaidCallEvent | undefined {
  const store = paidCallAls.getStore();
  const remembered = store?.remembered;
  if (!remembered) return undefined;
  if (store?.emitted) return undefined;
  const event = buildPaidCallEvent(remembered, settlement, now);
  if (store) store.emitted = true;
  writer(serializePaidCall(event));
  return event;
}

/**
 * After a 200 verify/confirm: remember host+hash+verdict.
 * Mock/dev emits immediately (no settle hook). Live waits for onAfterSettle
 * so the same line can include payer / tx / payment_intent.
 */
export function recordSuccessfulPaidCheck(input: {
  route: PaidCallRoute;
  url: string;
  intent?: string;
  status?: string;
  verdict?: string;
}): void {
  rememberPaidCall(input);
  if (!isLiveSettlement()) {
    emitPaidCall();
  }
}

/** Live settle hook: Stripe already recorded; attach payment fields and emit. */
export function emitPaidCallAfterSettle(settlement: PaidCallSettlement): void {
  emitPaidCall(settlement);
}
