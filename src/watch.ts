import { createHash, timingSafeEqual } from "node:crypto";
import {
  CheckError,
  parseCheckCondition,
  parseCheckTarget,
  runCheck,
} from "./check.js";
import {
  CHAIN_TOPUP_PRICE_ATOMIC,
  CHAIN_TOPUP_PRICE_USD,
  WATCH_BASELINE_TIMEOUT_MS,
  WATCH_DEFAULT_INTERVAL_S,
  WATCH_EVENTS_DEFAULT_LIMIT,
  WATCH_EVENTS_MAX_LIMIT,
  WATCH_EVENTS_RETENTION_DAYS,
  WATCH_MAX_ACTIVE_PER_WALLET,
  WATCH_MAX_CHECKS_PER_TERM,
  WATCH_MIN_INTERVAL_S,
  WATCH_PRICE_USD,
  WATCH_TERM_DAYS,
  WATCH_TERM_SECONDS,
  usdFromAtomic,
} from "./config.js";
import { isWatchId, newOwnerToken, newWatchId } from "./confirm-id.js";
import { hostnameOnly, isoTs } from "./paid-call.js";
import { sha256Hex, stableJson } from "./receipt.js";
import type {
  CheckCondition,
  CheckObservation,
  CheckTarget,
  WatchBaseline,
  WatchCallbackDeliver,
  WatchCallbackPayload,
  WatchCreateResult,
  WatchEventType,
  WatchPublicView,
  WatchRenewResult,
  WatchRun,
} from "./types.js";
import { parseTargetUrl, VerifyError } from "./verify.js";
import {
  countActiveStandardWatchers,
  findActiveDuplicate,
  creditChainBalance,
  getWatchEvent,
  getWatcher,
  insertWatcher,
  listWatchEventsPage,
  renewWatcher,
  stopWatcher,
  type WatcherRow,
} from "./watch-store.js";

export type WatchErrorCode =
  | "invalid_target"
  | "invalid_condition"
  | "invalid_callback"
  | "invalid_interval"
  | "render_not_available"
  | "duplicate_watch"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_id"
  | "not_renewable";

export class WatchError extends Error {
  readonly code: WatchErrorCode;
  readonly status: number;
  readonly existing_id?: string;
  readonly use?: string;
  readonly limit?: number;

  constructor(
    code: WatchErrorCode,
    message: string,
    status: 400 | 401 | 403 | 404 | 409 | 429,
    extra?: { existing_id?: string; use?: string; limit?: number },
  ) {
    super(message);
    this.name = "WatchError";
    this.code = code;
    this.status = status;
    this.existing_id = extra?.existing_id;
    this.use = extra?.use;
    this.limit = extra?.limit;
  }
}

export type ParsedWatchRequest = {
  target: CheckTarget;
  condition: CheckCondition;
  callback: { url: string; secret: string; deliver: WatchCallbackDeliver };
  interval_s: number;
  label: string | null;
  context: Record<string, unknown> | null;
  chain_budget_usd: number | null;
  run: WatchRun;
};

function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function conditionKey(condition: CheckCondition): string {
  return sha256Hex(stableJson({ detector: condition.detector, params: condition.params }));
}

export function hashOwnerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function ownerTokenMatches(presented: string, storedHash: string): boolean {
  const presentedHash = hashOwnerToken(presented.trim());
  try {
    const a = Buffer.from(presentedHash, "hex");
    const b = Buffer.from(storedHash, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function checksRemainingForInterval(intervalS: number): number {
  return Math.min(WATCH_MAX_CHECKS_PER_TERM, Math.max(1, Math.floor(WATCH_TERM_SECONDS / intervalS)));
}

export function jitteredDelayMs(intervalS: number, random: () => number = Math.random): number {
  const factor = 1 + (random() * 0.2 - 0.1);
  return Math.max(1_000, Math.round(intervalS * 1000 * factor));
}

export function parseWatchTarget(raw: unknown): CheckTarget {
  if (isRecord(raw) && (raw as { render?: unknown }).render === "always") {
    throw new WatchError(
      "render_not_available",
      'target.render "always" is not available on POST /v1/watch. Use POST /v1/watch/fast when that route ships.',
      400,
      { use: "/v1/watch/fast" },
    );
  }
  try {
    return parseCheckTarget(raw);
  } catch (error) {
    if (error instanceof CheckError) {
      throw new WatchError(
        error.code === "invalid_condition" ? "invalid_condition" : "invalid_target",
        error.message,
        400,
      );
    }
    throw error;
  }
}

export function parseWatchCondition(raw: unknown): CheckCondition {
  try {
    return parseCheckCondition(raw);
  } catch (error) {
    if (error instanceof CheckError) {
      throw new WatchError("invalid_condition", error.message, 400);
    }
    throw error;
  }
}

function parseCallback(raw: unknown): ParsedWatchRequest["callback"] {
  if (!isRecord(raw)) {
    throw new WatchError("invalid_callback", "callback must be { url, secret, deliver? }.", 400);
  }
  const record = raw as Record<string, unknown>;
  let url: string;
  try {
    url = parseTargetUrl(record.url);
  } catch (error) {
    const message = error instanceof VerifyError ? error.message : "callback.url must be an absolute http(s) URL.";
    throw new WatchError("invalid_callback", message, 400);
  }
  if (typeof record.secret !== "string" || !record.secret.trim()) {
    throw new WatchError("invalid_callback", "callback.secret is required.", 400);
  }
  const deliver = record.deliver === undefined ? "on_change" : record.deliver;
  if (deliver !== "on_change" && deliver !== "every_check") {
    throw new WatchError("invalid_callback", 'callback.deliver must be "on_change" or "every_check".', 400);
  }
  return { url, secret: record.secret.trim(), deliver };
}

function parseInterval(raw: unknown): number {
  if (raw === undefined || raw === null) return WATCH_DEFAULT_INTERVAL_S;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new WatchError("invalid_interval", "interval_s must be an integer number of seconds.", 400);
  }
  if (raw < WATCH_MIN_INTERVAL_S) {
    throw new WatchError(
      "invalid_interval",
      `interval_s must be at least ${WATCH_MIN_INTERVAL_S}.`,
      400,
    );
  }
  if (raw > WATCH_TERM_SECONDS) {
    throw new WatchError("invalid_interval", `interval_s must be at most ${WATCH_TERM_SECONDS}.`, 400);
  }
  return raw;
}

export function parseWatchRequest(body: unknown): ParsedWatchRequest {
  if (!isRecord(body)) {
    throw new WatchError("invalid_target", "JSON body must be an object.", 400);
  }
  const record = body as Record<string, unknown>;
  const target = parseWatchTarget(record.target);
  const condition = parseWatchCondition(record.condition);
  const callback = parseCallback(record.callback);
  const interval_s = parseInterval(record.interval_s);
  let label: string | null = null;
  if (record.label !== undefined && record.label !== null) {
    if (typeof record.label !== "string") {
      throw new WatchError("invalid_target", "label must be a string.", 400);
    }
    label = record.label.trim().slice(0, 200) || null;
  }
  let context: Record<string, unknown> | null = null;
  if (record.context !== undefined && record.context !== null) {
    if (!isRecord(record.context)) {
      throw new WatchError("invalid_target", "context must be an object.", 400);
    }
    context = record.context as Record<string, unknown>;
  }
  let chain_budget_usd: number | null = null;
  if (record.chain_budget_usd !== undefined && record.chain_budget_usd !== null) {
    if (typeof record.chain_budget_usd !== "number" || !Number.isFinite(record.chain_budget_usd)) {
      throw new WatchError("invalid_target", "chain_budget_usd must be a number.", 400);
    }
    if (record.chain_budget_usd < 0) {
      throw new WatchError("invalid_target", "chain_budget_usd must be >= 0.", 400);
    }
    chain_budget_usd = record.chain_budget_usd;
  }
  const run = parseOnChangeRun(record.on_change);
  return { target, condition, callback, interval_s, label, context, chain_budget_usd, run };
}

export function parseOnChangeRun(raw: unknown): WatchRun {
  if (raw === undefined || raw === null) return "none";
  if (!isRecord(raw)) {
    throw new WatchError("invalid_target", 'on_change must be { run: "none" | "verify" }.', 400);
  }
  const run = (raw as { run?: unknown }).run;
  if (run === undefined || run === null || run === "none") return "none";
  if (run === "verify") return "verify";
  throw new WatchError(
    "invalid_target",
    'on_change.run must be "none" or "verify". Confirm chain is not available on this route.',
    400,
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("baseline_timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function captureBaseline(
  parsed: ParsedWatchRequest,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<{
  baseline: WatchBaseline;
  observation: CheckObservation | null;
  content?: string;
  fired: boolean | null;
}> {
  try {
    const result = await withTimeout(
      runCheck({ target: parsed.target, condition: parsed.condition, baseline_hash: null }, fetcher, now),
      WATCH_BASELINE_TIMEOUT_MS,
    );
    return {
      baseline: {
        captured: true,
        hash: result.observation.hash,
        summary: result.observation.summary,
      },
      observation: result.observation,
      content: result.content,
      fired: result.fired,
    };
  } catch {
    return { baseline: { captured: false }, observation: null, fired: null };
  }
}

export function watchTermExpiresAt(from: Date): string {
  return isoTs(new Date(from.getTime() + WATCH_TERM_DAYS * 86_400_000));
}

function expiresAt(now: Date): string {
  return watchTermExpiresAt(now);
}

export function parseWatchRenewRequest(body: unknown): { id: string } {
  if (!isRecord(body)) {
    throw new WatchError("invalid_id", "JSON body must be { id }.", 400);
  }
  const id = (body as { id?: unknown }).id;
  if (typeof id !== "string" || !id.trim()) {
    throw new WatchError("invalid_id", "id is required.", 400);
  }
  const trimmed = id.trim();
  if (!isWatchId(trimmed)) {
    throw new WatchError("invalid_id", "id must be a watcher id (wtc_ + ULID).", 400);
  }
  return { id: trimmed };
}

export function publicWatcherView(row: WatcherRow): WatchPublicView {
  const view: WatchPublicView = {
    id: row.id,
    tier: "standard",
    status: row.status,
    expires_at: row.expires_at,
    checks_remaining: row.checks_remaining,
    interval_s: row.interval_s,
    first_check_at: row.first_check_at,
    next_check_at: row.next_check_at,
    baseline: row.baseline,
    last_observation: row.last_observation,
    target: row.target,
    condition: row.condition,
    price_usd: WATCH_PRICE_USD,
    run: row.run,
    on_change: { run: row.run },
    chain_budget_usd: row.chain_budget_usd,
    chain_balance_usd: usdFromAtomic(row.chain_balance_atomic),
    callback: { url: row.callback_url, deliver: row.callback_deliver },
  };
  if (row.label) view.label = row.label;
  return view;
}

export function requireOwnerToken(headerValue: string | undefined, row: WatcherRow | undefined): WatcherRow {
  if (!headerValue?.trim()) {
    throw new WatchError("unauthorized", "X-Livecheck-Owner-Token is required.", 401);
  }
  if (!row) {
    throw new WatchError("not_found", "Watcher not found.", 404);
  }
  if (!ownerTokenMatches(headerValue, row.owner_token_hash)) {
    throw new WatchError("forbidden", "owner_token does not match this watcher.", 403);
  }
  return row;
}

export async function createWatch(
  body: unknown,
  ctx: {
    payer: string;
    now?: Date;
    fetcher?: typeof fetch;
  },
): Promise<{ result: Omit<WatchCreateResult, "receipt">; ownerToken: string; observation: CheckObservation | null }> {
  const parsed = parseWatchRequest(body);
  const now = ctx.now ?? new Date();
  const payer = ctx.payer.toLowerCase();

  const active = countActiveStandardWatchers(payer);
  if (active >= WATCH_MAX_ACTIVE_PER_WALLET) {
    throw new WatchError(
      "rate_limited",
      `At most ${WATCH_MAX_ACTIVE_PER_WALLET} active standard watchers per wallet.`,
      429,
      { limit: WATCH_MAX_ACTIVE_PER_WALLET },
    );
  }

  const key = conditionKey(parsed.condition);
  const existing = findActiveDuplicate(payer, parsed.target.url, key);
  if (existing) {
    throw new WatchError("duplicate_watch", "An active watcher already exists for this wallet, URL, and condition.", 409, {
      existing_id: existing,
    });
  }

  const { baseline, observation, content, fired } = await captureBaseline(parsed, ctx.fetcher, now);
  const id = newWatchId(now.getTime());
  const ownerToken = newOwnerToken(now.getTime());
  const createdAt = isoTs(now);
  const firstCheckAt = createdAt;
  const nextCheckAt = baseline.captured
    ? isoTs(new Date(now.getTime() + jitteredDelayMs(parsed.interval_s)))
    : createdAt;

  const row: WatcherRow = {
    id,
    payer,
    owner_token_hash: hashOwnerToken(ownerToken),
    status: "active",
    tier: "standard",
    target_url: parsed.target.url,
    target: parsed.target,
    condition: parsed.condition,
    condition_key: key,
    interval_s: parsed.interval_s,
    checks_remaining: checksRemainingForInterval(parsed.interval_s),
    expires_at: expiresAt(now),
    first_check_at: firstCheckAt,
    next_check_at: nextCheckAt,
    baseline,
    last_observation: observation,
    callback_url: parsed.callback.url,
    callback_secret: parsed.callback.secret,
    callback_deliver: parsed.callback.deliver,
    run: parsed.run,
    chain_budget_usd: parsed.chain_budget_usd,
    chain_balance_atomic: 0,
    chain_spent_atomic: 0,
    label: parsed.label,
    context_json: parsed.context ? JSON.stringify(parsed.context) : null,
    created_at: createdAt,
    claimed_until: null,
    consecutive_failures: 0,
    unreachable: false,
    expiring_emitted: false,
    detector_state: {
      ...(content ? { last_content: content } : {}),
      last_fired: fired,
    },
  };

  try {
    insertWatcher(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique/i.test(message)) {
      const raced = findActiveDuplicate(payer, parsed.target.url, key);
      throw new WatchError("duplicate_watch", "An active watcher already exists for this wallet, URL, and condition.", 409, {
        existing_id: raced,
      });
    }
    throw error;
  }

  const result: Omit<WatchCreateResult, "receipt"> = {
    id,
    tier: "standard",
    status: "active",
    owner_token: ownerToken,
    expires_at: row.expires_at,
    checks_remaining: row.checks_remaining,
    interval_s: row.interval_s,
    first_check_at: row.first_check_at,
    next_check_at: row.next_check_at,
    baseline: row.baseline,
    target: row.target,
    condition: row.condition,
    price_usd: WATCH_PRICE_USD,
    run: parsed.run,
    on_change: { run: parsed.run },
    chain_budget_usd: parsed.chain_budget_usd,
    chain_balance_usd: 0,
  };
  if (parsed.label) result.label = parsed.label;
  return { result, ownerToken, observation };
}

/** Prepaid-window only (Confirm continuity). No new detectors or event kinds. */
export function renewWatch(
  body: unknown,
  ownerToken: string | undefined,
  now = new Date(),
): Omit<WatchRenewResult, "receipt"> {
  const { id } = parseWatchRenewRequest(body);
  const row = requireOwnerToken(ownerToken, getWatcher(id));
  if (row.status !== "active") {
    throw new WatchError("not_renewable", "Only an active watcher can be renewed.", 409);
  }
  const currentExpiry = Date.parse(row.expires_at);
  const baseMs = Number.isFinite(currentExpiry) ? Math.max(now.getTime(), currentExpiry) : now.getTime();
  const expires_at = watchTermExpiresAt(new Date(baseMs));
  const checks_remaining = row.checks_remaining + checksRemainingForInterval(row.interval_s);
  if (!renewWatcher(row.id, { expires_at, checks_remaining })) {
    throw new WatchError("not_renewable", "Only an active watcher can be renewed.", 409);
  }
  const updated = getWatcher(row.id) ?? { ...row, expires_at, checks_remaining, expiring_emitted: false };
  const result: Omit<WatchRenewResult, "receipt"> = {
    id: updated.id,
    tier: "standard",
    status: updated.status,
    expires_at: updated.expires_at,
    checks_remaining: updated.checks_remaining,
    interval_s: updated.interval_s,
    first_check_at: updated.first_check_at,
    next_check_at: updated.next_check_at,
    baseline: updated.baseline,
    target: updated.target,
    condition: updated.condition,
    price_usd: WATCH_PRICE_USD,
    run: updated.run,
    on_change: { run: updated.run },
    chain_budget_usd: updated.chain_budget_usd,
    chain_balance_usd: usdFromAtomic(updated.chain_balance_atomic),
  };
  if (updated.label) result.label = updated.label;
  return result;
}

export function topupWatchChain(
  watcherId: string,
  ownerToken: string | undefined,
): {
  id: string;
  added_usd: number;
  chain_balance_usd: number;
  chain_budget_usd: number | null;
  price_usd: number;
  run: WatchRun;
} {
  const row = requireOwnerToken(ownerToken, getWatcher(watcherId));
  const nextAtomic = creditChainBalance(row.id, CHAIN_TOPUP_PRICE_ATOMIC);
  const updated = getWatcher(row.id);
  return {
    id: row.id,
    added_usd: CHAIN_TOPUP_PRICE_USD,
    chain_balance_usd: usdFromAtomic(updated?.chain_balance_atomic ?? nextAtomic),
    chain_budget_usd: updated?.chain_budget_usd ?? row.chain_budget_usd,
    price_usd: CHAIN_TOPUP_PRICE_USD,
    run: updated?.run ?? row.run,
  };
}

export function readWatch(id: string, ownerToken: string | undefined): WatchPublicView {
  const row = requireOwnerToken(ownerToken, getWatcher(id));
  return publicWatcherView(row);
}

export function deleteWatch(id: string, ownerToken: string | undefined): { id: string; status: "stopped"; refund: false } {
  const row = requireOwnerToken(ownerToken, getWatcher(id));
  stopWatcher(row.id);
  return { id: row.id, status: "stopped", refund: false };
}

export function watchErrorBody(error: WatchError): Record<string, unknown> {
  const body: Record<string, unknown> = { error: error.code, message: error.message };
  if (error.existing_id) body.id = error.existing_id;
  if (error.use) body.use = error.use;
  if (error.limit != null) body.limit = error.limit;
  return body;
}

export type WatchEventsPage = {
  id: string;
  events: Array<WatchCallbackPayload & { delivered_at: string | null; delivery_attempts: number }>;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
};

export function listWatchEventsForOwner(
  watcherId: string,
  ownerToken: string | undefined,
  query: { limit?: string; cursor?: string },
  now = new Date(),
): WatchEventsPage {
  const row = requireOwnerToken(ownerToken, getWatcher(watcherId));
  const limitRaw = query.limit ? Number(query.limit) : WATCH_EVENTS_DEFAULT_LIMIT;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(WATCH_EVENTS_MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : WATCH_EVENTS_DEFAULT_LIMIT;

  let cursor: { created_at: string; id: string } | undefined;
  if (query.cursor?.trim()) {
    const cursorRow = getWatchEvent(query.cursor.trim());
    if (!cursorRow || cursorRow.watcher_id !== row.id) {
      throw new WatchError("not_found", "Unknown events cursor.", 404);
    }
    cursor = { created_at: cursorRow.created_at, id: cursorRow.id };
  }

  const since = isoTs(new Date(now.getTime() - WATCH_EVENTS_RETENTION_DAYS * 86_400_000));
  const rows = listWatchEventsPage({
    watcherId: row.id,
    sinceIso: since,
    limit: limit + 1,
    cursor,
  });
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;
  const events = page.map((event) => {
    let payload: WatchCallbackPayload;
    try {
      payload = JSON.parse(event.payload_json) as WatchCallbackPayload;
    } catch {
      payload = {
        id: event.id,
        type: event.kind as WatchEventType,
        watcher_id: event.watcher_id,
        created_at: event.created_at,
        previous: null,
        current: null,
        diff: { fired: null, changed: [] },
        confidence: 0,
        checks_remaining: row.checks_remaining,
        expires_at: row.expires_at,
        receipt: { hash: "", verify_url: "" },
        context: null,
        chain: { run: "none" },
      };
    }
    return {
      ...payload,
      id: event.id,
      type: (payload.type ?? event.kind) as WatchEventType,
      delivered_at: event.delivered_at,
      delivery_attempts: event.delivery_attempts,
    };
  });
  return {
    id: row.id,
    events,
    limit,
    has_more,
    next_cursor: has_more ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export function watcherHost(row: WatcherRow): string {
  return hostnameOnly(row.target_url);
}
