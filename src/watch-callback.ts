import { createHmac, timingSafeEqual } from "node:crypto";
import {
  SENTINEL_SIGNATURE_HEADER,
  USER_AGENT,
  WATCH_CALLBACK_MAX_ATTEMPTS,
  WATCH_CALLBACK_RETRY_DELAYS_MS,
  WATCH_CALLBACK_TIMEOUT_MS,
} from "./config.js";
import { hostnameOnly, isoTs } from "./paid-call.js";
import {
  getWatcher,
  insertDeliveryAttempt,
  listDueCallbackEvents,
  updateWatchEventDelivery,
  type WatchEventRow,
} from "./watch-store.js";

export { SENTINEL_SIGNATURE_HEADER };

/**
 * HMAC-SHA256 over the raw UTF-8 body. Hex is lowercase.
 *
 * Header: `X-Sentinel-Signature: t=<unix>,v1=<hex>`
 * v1 = hex(HMAC-SHA256(callback.secret, raw_body))
 *
 * `t` is the unix time of this delivery attempt (not part of the MAC).
 * Receivers should reject stale `t` (e.g. older than 5 minutes) to limit replay.
 */
export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export function formatSentinelSignature(unixSeconds: number, v1Hex: string): string {
  return `t=${unixSeconds},v1=${v1Hex}`;
}

export function signCallbackBody(secret: string, body: string, unixSeconds: number): string {
  return formatSentinelSignature(unixSeconds, hmacSha256Hex(secret, body));
}

export function parseSentinelSignature(header: string): { t: number; v1: string } | undefined {
  const parts = header.split(",").map((part) => part.trim());
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n) && Number.isInteger(n)) t = n;
    } else if (key === "v1") {
      if (/^[0-9a-f]+$/i.test(value)) v1 = value.toLowerCase();
    }
  }
  if (t === undefined || !v1) return undefined;
  return { t, v1 };
}

export function verifyCallbackSignature(secret: string, body: string, header: string): boolean {
  const parsed = parseSentinelSignature(header);
  if (!parsed) return false;
  const expected = hmacSha256Hex(secret, body);
  try {
    const a = Buffer.from(parsed.v1, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** After `attemptsMade` failed POSTs, when to try again. Null once exhausted. */
export function nextCallbackRetryAt(attemptsMade: number, now: Date): Date | null {
  if (attemptsMade >= WATCH_CALLBACK_MAX_ATTEMPTS) return null;
  const delay = WATCH_CALLBACK_RETRY_DELAYS_MS[attemptsMade - 1];
  if (delay == null) return null;
  return new Date(now.getTime() + delay);
}

export type CallbackDeliveryResult = {
  ok: boolean;
  http_status: number | null;
  error: string | null;
};

export async function postSignedCallback(
  input: {
    url: string;
    secret: string;
    body: string;
    now?: Date;
  },
  fetcher: typeof fetch = fetch,
): Promise<CallbackDeliveryResult> {
  const now = input.now ?? new Date();
  const unix = Math.floor(now.getTime() / 1000);
  const signature = signCallbackBody(input.secret, input.body, unix);
  try {
    const res = await fetcher(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SENTINEL_SIGNATURE_HEADER]: signature,
        "user-agent": USER_AGENT,
      },
      body: input.body,
      signal: AbortSignal.timeout(WATCH_CALLBACK_TIMEOUT_MS),
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, http_status: res.status, error: null };
    }
    return { ok: false, http_status: res.status, error: `http_${res.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timeout|aborted|AbortError/i.test(message);
    return { ok: false, http_status: null, error: timedOut ? "timeout" : message.slice(0, 200) };
  }
}

export async function deliverWatchEvent(
  event: WatchEventRow,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<CallbackDeliveryResult> {
  const watcher = getWatcher(event.watcher_id);
  if (!watcher) {
    const attempt = event.delivery_attempts + 1;
    insertDeliveryAttempt({
      event_id: event.id,
      attempt,
      at: isoTs(now),
      ok: false,
      http_status: null,
      error: "watcher_missing",
    });
    updateWatchEventDelivery({
      id: event.id,
      delivery_attempts: attempt,
      delivered_at: null,
      next_attempt_at: nextCallbackRetryAt(attempt, now)?.toISOString().replace(/\.\d{3}Z$/, "Z") ?? null,
      last_error: "watcher_missing",
    });
    return { ok: false, http_status: null, error: "watcher_missing" };
  }

  const result = await postSignedCallback(
    {
      url: watcher.callback_url,
      secret: watcher.callback_secret,
      body: event.payload_json,
      now,
    },
    fetcher,
  );
  const attempt = event.delivery_attempts + 1;
  const at = isoTs(now);
  insertDeliveryAttempt({
    event_id: event.id,
    attempt,
    at,
    ok: result.ok,
    http_status: result.http_status,
    error: result.error,
  });

  const next = result.ok ? null : nextCallbackRetryAt(attempt, now);
  updateWatchEventDelivery({
    id: event.id,
    delivery_attempts: attempt,
    delivered_at: result.ok ? at : null,
    next_attempt_at: next ? isoTs(next) : null,
    last_error: result.ok ? null : result.error,
  });

  console.log(
    JSON.stringify({
      event: "livecheck.watch_callback",
      watcher_id: watcher.id,
      event_id: event.id,
      type: event.kind,
      attempt,
      ok: result.ok,
      http_status: result.http_status,
      host: hostnameOnly(watcher.callback_url),
    }),
  );
  return result;
}

export async function deliverDueCallbacks(
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<{ delivered: number; failed: number }> {
  const due = listDueCallbackEvents(isoTs(now), WATCH_CALLBACK_MAX_ATTEMPTS);
  let delivered = 0;
  let failed = 0;
  for (const event of due) {
    const result = await deliverWatchEvent(event, now, fetcher);
    if (result.ok) delivered += 1;
    else failed += 1;
  }
  return { delivered, failed };
}
