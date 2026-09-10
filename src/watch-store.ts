import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CheckCondition,
  CheckObservation,
  CheckTarget,
  WatchBaseline,
  WatchCallbackDeliver,
  WatchStatus,
} from "./types.js";
import { parseDetectorState, type DetectorState } from "./watch-state.js";

export type WatcherRow = {
  id: string;
  payer: string;
  owner_token_hash: string;
  status: WatchStatus;
  tier: "standard";
  target_url: string;
  target: CheckTarget;
  condition: CheckCondition;
  condition_key: string;
  interval_s: number;
  checks_remaining: number;
  expires_at: string;
  first_check_at: string;
  next_check_at: string;
  baseline: WatchBaseline;
  last_observation: CheckObservation | null;
  callback_url: string;
  callback_secret: string;
  callback_deliver: WatchCallbackDeliver;
  run: "none";
  chain_budget_usd: number | null;
  label: string | null;
  context_json: string | null;
  created_at: string;
  claimed_until: string | null;
  consecutive_failures: number;
  unreachable: boolean;
  expiring_emitted: boolean;
  detector_state: DetectorState;
};

export type WatchEventRow = {
  id: string;
  watcher_id: string;
  kind: string;
  payload_json: string;
  created_at: string;
  delivered_at: string | null;
  delivery_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
};

export type WatchDeliveryAttemptRow = {
  event_id: string;
  attempt: number;
  at: string;
  ok: boolean;
  http_status: number | null;
  error: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watchers (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL,
  owner_token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'standard',
  target_url TEXT NOT NULL,
  target_json TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  condition_key TEXT NOT NULL,
  interval_s INTEGER NOT NULL,
  checks_remaining INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  first_check_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  last_observation_json TEXT,
  callback_url TEXT NOT NULL,
  callback_secret TEXT NOT NULL,
  callback_deliver TEXT NOT NULL,
  run TEXT NOT NULL DEFAULT 'none',
  chain_budget_usd REAL,
  label TEXT,
  context_json TEXT,
  created_at TEXT NOT NULL,
  claimed_until TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  unreachable INTEGER NOT NULL DEFAULT 0,
  expiring_emitted INTEGER NOT NULL DEFAULT 0,
  detector_state_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_watchers_due ON watchers(status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_watchers_payer_status ON watchers(payer, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchers_dup
  ON watchers(payer, target_url, condition_key) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS watch_events (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_watch_events_watcher ON watch_events(watcher_id, created_at);

CREATE TABLE IF NOT EXISTS watch_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_watch_delivery_attempts_event
  ON watch_delivery_attempts(event_id, attempt);
`;

/**
 * Indexes that reference columns added in step 3. Must run AFTER ALTER TABLE.
 * Creating them in SCHEMA blows up Phase 2 Fly volumes: CREATE TABLE IF NOT EXISTS
 * is a no-op on the old watch_events shape, then CREATE INDEX on next_attempt_at
 * throws and initWatchStore never reaches migrate.
 */
const INDEXES_AFTER_MIGRATE = `
CREATE INDEX IF NOT EXISTS idx_watch_events_due
  ON watch_events(next_attempt_at) WHERE delivered_at IS NULL;
`;

type OpenStore = { ok: true; path: string; db: DatabaseSync };
type ClosedStore = { ok: false; path?: string; reason: string };
type StoreState = OpenStore | ClosedStore;

let state: StoreState | undefined;

export function defaultWatchDbPath(): string {
  const fromEnv = process.env.WATCH_DB_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.FLY_APP_NAME?.trim() && existsSync("/data")) {
    return "/data/watchers.sqlite";
  }
  return resolve(process.cwd(), "data/watchers.sqlite");
}

function prepareDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec(SCHEMA);
  migrateWatchStore(db);
  return db;
}

export function watchStoreTableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name)));
}

function ensureColumn(db: DatabaseSync, table: string, name: string, ddl: string): void {
  if (watchStoreTableColumns(db, table).has(name)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate column/i.test(message)) return;
    throw error;
  }
}

function ensureTable(db: DatabaseSync, sql: string): void {
  db.exec(sql);
}

/**
 * Idempotent step-3 upgrade. Safe on a fresh DB and on a Phase 2 Fly volume
 * whose watch_events table has only (id, watcher_id, kind, payload_json,
 * created_at, delivered_at).
 */
export function migrateWatchStore(db: DatabaseSync): void {
  ensureColumn(db, "watchers", "consecutive_failures", "consecutive_failures INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "watchers", "unreachable", "unreachable INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "watchers", "expiring_emitted", "expiring_emitted INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "watch_events", "delivery_attempts", "delivery_attempts INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "watch_events", "next_attempt_at", "next_attempt_at TEXT");
  ensureColumn(db, "watch_events", "last_error", "last_error TEXT");
  ensureColumn(db, "watchers", "detector_state_json", "detector_state_json TEXT");
  ensureTable(
    db,
    `CREATE TABLE IF NOT EXISTS watch_delivery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      at TEXT NOT NULL,
      ok INTEGER NOT NULL,
      http_status INTEGER,
      error TEXT
    );`,
  );
  ensureTable(
    db,
    `CREATE INDEX IF NOT EXISTS idx_watch_delivery_attempts_event
     ON watch_delivery_attempts(event_id, attempt);`,
  );
  db.exec(INDEXES_AFTER_MIGRATE);
}

export function initWatchStore(path = defaultWatchDbPath()): StoreState {
  closeWatchStore();
  try {
    const db = prepareDatabase(path);
    state = { ok: true, path, db };
    return state;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    state = { ok: false, path, reason };
    return state;
  }
}

export function closeWatchStore(): void {
  if (state?.ok) {
    try {
      state.db.close();
    } catch {
      // ignore close errors in tests / shutdown
    }
  }
  state = undefined;
}

export function watchStoreStatus(): { kind: "sqlite" | "memory-fallback" | "uninitialized"; path?: string; reason?: string } {
  if (!state) return { kind: "uninitialized" };
  if (state.ok) return { kind: "sqlite", path: state.path };
  return { kind: "memory-fallback", path: state.path, reason: state.reason };
}

function requireDb(): DatabaseSync {
  if (!state?.ok) {
    const opened = initWatchStore();
    if (!opened.ok) {
      throw new Error(`watch store unavailable: ${opened.reason}`);
    }
    return opened.db;
  }
  return state.db;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fromSql(item: Record<string, unknown>): WatcherRow | undefined {
  const status = item.status;
  if (status !== "active" && status !== "stopped" && status !== "expired") return undefined;
  const target = parseJson<CheckTarget>(String(item.target_json ?? "{}"), {
    type: "url",
    url: String(item.target_url ?? ""),
    render: "never",
    selector: null,
  });
  const condition = parseJson<CheckCondition>(String(item.condition_json ?? "{}"), {
    detector: "status_change",
    params: {},
  });
  const baseline = parseJson<WatchBaseline>(String(item.baseline_json ?? "{}"), { captured: false });
  const lastRaw = item.last_observation_json;
  const last_observation =
    typeof lastRaw === "string" && lastRaw
      ? parseJson<CheckObservation | null>(lastRaw, null)
      : null;
  return {
    id: String(item.id),
    payer: String(item.payer),
    owner_token_hash: String(item.owner_token_hash),
    status,
    tier: "standard",
    target_url: String(item.target_url),
    target,
    condition,
    condition_key: String(item.condition_key),
    interval_s: Number(item.interval_s),
    checks_remaining: Number(item.checks_remaining),
    expires_at: String(item.expires_at),
    first_check_at: String(item.first_check_at),
    next_check_at: String(item.next_check_at),
    baseline,
    last_observation,
    callback_url: String(item.callback_url),
    callback_secret: String(item.callback_secret),
    callback_deliver: item.callback_deliver === "every_check" ? "every_check" : "on_change",
    run: "none",
    chain_budget_usd: item.chain_budget_usd == null ? null : Number(item.chain_budget_usd),
    label: item.label == null ? null : String(item.label),
    context_json: item.context_json == null ? null : String(item.context_json),
    created_at: String(item.created_at),
    claimed_until: item.claimed_until == null ? null : String(item.claimed_until),
    consecutive_failures: Number(item.consecutive_failures ?? 0),
    unreachable: Number(item.unreachable ?? 0) === 1,
    expiring_emitted: Number(item.expiring_emitted ?? 0) === 1,
    detector_state: parseDetectorState(
      item.detector_state_json == null ? null : String(item.detector_state_json),
    ),
  };
}

const SELECT_COLS = `id, payer, owner_token_hash, status, tier, target_url, target_json, condition_json,
  condition_key, interval_s, checks_remaining, expires_at, first_check_at, next_check_at,
  baseline_json, last_observation_json, callback_url, callback_secret, callback_deliver,
  run, chain_budget_usd, label, context_json, created_at, claimed_until,
  consecutive_failures, unreachable, expiring_emitted, detector_state_json`;

export function insertWatcher(row: WatcherRow): void {
  const db = requireDb();
  db.prepare(
    `INSERT INTO watchers (
      id, payer, owner_token_hash, status, tier, target_url, target_json, condition_json,
      condition_key, interval_s, checks_remaining, expires_at, first_check_at, next_check_at,
      baseline_json, last_observation_json, callback_url, callback_secret, callback_deliver,
      run, chain_budget_usd, label, context_json, created_at, claimed_until,
      consecutive_failures, unreachable, expiring_emitted, detector_state_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.payer,
    row.owner_token_hash,
    row.status,
    row.tier,
    row.target_url,
    JSON.stringify(row.target),
    JSON.stringify(row.condition),
    row.condition_key,
    row.interval_s,
    row.checks_remaining,
    row.expires_at,
    row.first_check_at,
    row.next_check_at,
    JSON.stringify(row.baseline),
    row.last_observation ? JSON.stringify(row.last_observation) : null,
    row.callback_url,
    row.callback_secret,
    row.callback_deliver,
    row.run,
    row.chain_budget_usd,
    row.label,
    row.context_json,
    row.created_at,
    row.claimed_until,
    row.consecutive_failures ?? 0,
    row.unreachable ? 1 : 0,
    row.expiring_emitted ? 1 : 0,
    row.detector_state && Object.keys(row.detector_state).length > 0
      ? JSON.stringify(row.detector_state)
      : null,
  );
}

export function getWatcher(id: string): WatcherRow | undefined {
  const db = requireDb();
  const item = db.prepare(`SELECT ${SELECT_COLS} FROM watchers WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!item) return undefined;
  return fromSql(item);
}

export function findActiveDuplicate(payer: string, targetUrl: string, conditionKey: string): string | undefined {
  const db = requireDb();
  const item = db
    .prepare(
      `SELECT id FROM watchers
       WHERE payer = ? AND target_url = ? AND condition_key = ? AND status = 'active'
       LIMIT 1`,
    )
    .get(payer, targetUrl, conditionKey) as { id?: string } | undefined;
  return item?.id;
}

export function countActiveStandardWatchers(payer: string): number {
  const db = requireDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM watchers
       WHERE payer = ? AND status = 'active' AND tier = 'standard'`,
    )
    .get(payer) as { n: number | bigint };
  return Number(row.n);
}

export function listDueWatchers(nowIso: string, limit = 50): WatcherRow[] {
  const db = requireDb();
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM watchers
       WHERE status = 'active'
         AND checks_remaining > 0
         AND expires_at > ?
         AND next_check_at <= ?
         AND (claimed_until IS NULL OR claimed_until < ?)
       ORDER BY next_check_at ASC
       LIMIT ?`,
    )
    .all(nowIso, nowIso, nowIso, limit) as Record<string, unknown>[];
  const out: WatcherRow[] = [];
  for (const item of rows) {
    const row = fromSql(item);
    if (row) out.push(row);
  }
  return out;
}

export function claimWatcher(id: string, claimedUntilIso: string, nowIso: string): boolean {
  const db = requireDb();
  const result = db
    .prepare(
      `UPDATE watchers
       SET claimed_until = ?
       WHERE id = ? AND status = 'active'
         AND (claimed_until IS NULL OR claimed_until < ?)`,
    )
    .run(claimedUntilIso, id, nowIso);
  return Number(result.changes) > 0;
}

export function updateWatcherAfterCheck(input: {
  id: string;
  last_observation: CheckObservation | null;
  baseline?: WatchBaseline;
  checks_remaining: number;
  next_check_at: string;
  status: WatchStatus;
  consecutive_failures?: number;
  unreachable?: boolean;
  detector_state?: DetectorState;
}): void {
  const db = requireDb();
  db.prepare(
    `UPDATE watchers
     SET last_observation_json = ?,
         baseline_json = COALESCE(?, baseline_json),
         checks_remaining = ?,
         next_check_at = ?,
         status = ?,
         claimed_until = NULL,
         consecutive_failures = COALESCE(?, consecutive_failures),
         unreachable = COALESCE(?, unreachable),
         detector_state_json = COALESCE(?, detector_state_json)
     WHERE id = ?`,
  ).run(
    input.last_observation ? JSON.stringify(input.last_observation) : null,
    input.baseline ? JSON.stringify(input.baseline) : null,
    input.checks_remaining,
    input.next_check_at,
    input.status,
    input.consecutive_failures ?? null,
    input.unreachable == null ? null : input.unreachable ? 1 : 0,
    input.detector_state ? JSON.stringify(input.detector_state) : null,
    input.id,
  );
}

export function setWatcherNextCheckAt(id: string, nextCheckAt: string): void {
  const db = requireDb();
  db.prepare(`UPDATE watchers SET next_check_at = ?, claimed_until = NULL WHERE id = ?`).run(nextCheckAt, id);
}

export function markExpiringEmitted(id: string): void {
  const db = requireDb();
  db.prepare(`UPDATE watchers SET expiring_emitted = 1 WHERE id = ?`).run(id);
}

export function listExpiringWatchers(nowIso: string, horizonIso: string): WatcherRow[] {
  const db = requireDb();
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM watchers
       WHERE status = 'active'
         AND expiring_emitted = 0
         AND expires_at > ?
         AND expires_at <= ?`,
    )
    .all(nowIso, horizonIso) as Record<string, unknown>[];
  return rows.map(fromSql).filter((row): row is WatcherRow => Boolean(row));
}

export function stopWatcher(id: string): boolean {
  const db = requireDb();
  const result = db
    .prepare(`UPDATE watchers SET status = 'stopped', claimed_until = NULL WHERE id = ? AND status = 'active'`)
    .run(id);
  return Number(result.changes) > 0;
}

function eventFromSql(item: Record<string, unknown>): WatchEventRow {
  return {
    id: String(item.id),
    watcher_id: String(item.watcher_id),
    kind: String(item.kind),
    payload_json: String(item.payload_json),
    created_at: String(item.created_at),
    delivered_at: item.delivered_at == null ? null : String(item.delivered_at),
    delivery_attempts: Number(item.delivery_attempts ?? 0),
    next_attempt_at: item.next_attempt_at == null ? null : String(item.next_attempt_at),
    last_error: item.last_error == null ? null : String(item.last_error),
  };
}

const EVENT_COLS = `id, watcher_id, kind, payload_json, created_at, delivered_at,
  delivery_attempts, next_attempt_at, last_error`;

export function insertWatchEvent(row: WatchEventRow): void {
  const db = requireDb();
  db.prepare(
    `INSERT INTO watch_events (
      id, watcher_id, kind, payload_json, created_at, delivered_at,
      delivery_attempts, next_attempt_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.watcher_id,
    row.kind,
    row.payload_json,
    row.created_at,
    row.delivered_at,
    row.delivery_attempts ?? 0,
    row.next_attempt_at ?? row.created_at,
    row.last_error ?? null,
  );
}

export function getWatchEvent(id: string): WatchEventRow | undefined {
  const db = requireDb();
  const item = db.prepare(`SELECT ${EVENT_COLS} FROM watch_events WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!item) return undefined;
  return eventFromSql(item);
}

export function listWatchEvents(watcherId: string): WatchEventRow[] {
  const db = requireDb();
  return (db
    .prepare(
      `SELECT ${EVENT_COLS}
       FROM watch_events WHERE watcher_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(watcherId) as Record<string, unknown>[]).map(eventFromSql);
}

export function listWatchEventsPage(input: {
  watcherId: string;
  sinceIso: string;
  limit: number;
  cursor?: { created_at: string; id: string };
}): WatchEventRow[] {
  const db = requireDb();
  if (input.cursor) {
    return (db
      .prepare(
        `SELECT ${EVENT_COLS}
         FROM watch_events
         WHERE watcher_id = ?
           AND created_at >= ?
           AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(
        input.watcherId,
        input.sinceIso,
        input.cursor.created_at,
        input.cursor.created_at,
        input.cursor.id,
        input.limit,
      ) as Record<string, unknown>[]).map(eventFromSql);
  }
  return (db
    .prepare(
      `SELECT ${EVENT_COLS}
       FROM watch_events
       WHERE watcher_id = ? AND created_at >= ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(input.watcherId, input.sinceIso, input.limit) as Record<string, unknown>[]).map(eventFromSql);
}

export function hasWatchEventKind(watcherId: string, kind: string): boolean {
  const db = requireDb();
  const row = db
    .prepare(`SELECT 1 AS n FROM watch_events WHERE watcher_id = ? AND kind = ? LIMIT 1`)
    .get(watcherId, kind) as { n?: number } | undefined;
  return Boolean(row);
}

export function listDueCallbackEvents(nowIso: string, maxAttempts: number, limit = 25): WatchEventRow[] {
  const db = requireDb();
  return (db
    .prepare(
      `SELECT ${EVENT_COLS}
       FROM watch_events
       WHERE delivered_at IS NULL
         AND delivery_attempts < ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT ?`,
    )
    .all(maxAttempts, nowIso, limit) as Record<string, unknown>[]).map(eventFromSql);
}

export function updateWatchEventDelivery(input: {
  id: string;
  delivery_attempts: number;
  delivered_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
}): void {
  const db = requireDb();
  db.prepare(
    `UPDATE watch_events
     SET delivery_attempts = ?, delivered_at = ?, next_attempt_at = ?, last_error = ?
     WHERE id = ?`,
  ).run(input.delivery_attempts, input.delivered_at, input.next_attempt_at, input.last_error, input.id);
}

export function insertDeliveryAttempt(row: WatchDeliveryAttemptRow): void {
  const db = requireDb();
  db.prepare(
    `INSERT INTO watch_delivery_attempts (event_id, attempt, at, ok, http_status, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.event_id, row.attempt, row.at, row.ok ? 1 : 0, row.http_status, row.error);
}

export function listDeliveryAttempts(eventId: string): WatchDeliveryAttemptRow[] {
  const db = requireDb();
  return (db
    .prepare(
      `SELECT event_id, attempt, at, ok, http_status, error
       FROM watch_delivery_attempts WHERE event_id = ? ORDER BY attempt ASC`,
    )
    .all(eventId) as Record<string, unknown>[]).map((item) => ({
    event_id: String(item.event_id),
    attempt: Number(item.attempt),
    at: String(item.at),
    ok: Number(item.ok) === 1,
    http_status: item.http_status == null ? null : Number(item.http_status),
    error: item.error == null ? null : String(item.error),
  }));
}

export function expireOverdueWatchers(nowIso: string): WatcherRow[] {
  const db = requireDb();
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM watchers
       WHERE status = 'active' AND (expires_at <= ? OR checks_remaining <= 0)`,
    )
    .all(nowIso) as Record<string, unknown>[];
  const expired = rows.map(fromSql).filter((row): row is WatcherRow => Boolean(row));
  if (expired.length > 0) {
    db.prepare(
      `UPDATE watchers SET status = 'expired', claimed_until = NULL
       WHERE status = 'active' AND (expires_at <= ? OR checks_remaining <= 0)`,
    ).run(nowIso);
  }
  return expired;
}
