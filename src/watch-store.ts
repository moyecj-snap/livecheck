import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CheckCondition, CheckObservation, CheckTarget, WatchBaseline, WatchStatus } from "./types.js";

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
  callback_deliver: "on_change";
  run: "none";
  chain_budget_usd: number | null;
  label: string | null;
  context_json: string | null;
  created_at: string;
  claimed_until: string | null;
};

export type WatchEventRow = {
  id: string;
  watcher_id: string;
  kind: string;
  payload_json: string;
  created_at: string;
  delivered_at: string | null;
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
  claimed_until TEXT
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
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_watch_events_watcher ON watch_events(watcher_id, created_at);
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
  return db;
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
    callback_deliver: "on_change",
    run: "none",
    chain_budget_usd: item.chain_budget_usd == null ? null : Number(item.chain_budget_usd),
    label: item.label == null ? null : String(item.label),
    context_json: item.context_json == null ? null : String(item.context_json),
    created_at: String(item.created_at),
    claimed_until: item.claimed_until == null ? null : String(item.claimed_until),
  };
}

const SELECT_COLS = `id, payer, owner_token_hash, status, tier, target_url, target_json, condition_json,
  condition_key, interval_s, checks_remaining, expires_at, first_check_at, next_check_at,
  baseline_json, last_observation_json, callback_url, callback_secret, callback_deliver,
  run, chain_budget_usd, label, context_json, created_at, claimed_until`;

export function insertWatcher(row: WatcherRow): void {
  const db = requireDb();
  db.prepare(
    `INSERT INTO watchers (
      id, payer, owner_token_hash, status, tier, target_url, target_json, condition_json,
      condition_key, interval_s, checks_remaining, expires_at, first_check_at, next_check_at,
      baseline_json, last_observation_json, callback_url, callback_secret, callback_deliver,
      run, chain_budget_usd, label, context_json, created_at, claimed_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
}): void {
  const db = requireDb();
  db.prepare(
    `UPDATE watchers
     SET last_observation_json = ?,
         baseline_json = COALESCE(?, baseline_json),
         checks_remaining = ?,
         next_check_at = ?,
         status = ?,
         claimed_until = NULL
     WHERE id = ?`,
  ).run(
    input.last_observation ? JSON.stringify(input.last_observation) : null,
    input.baseline ? JSON.stringify(input.baseline) : null,
    input.checks_remaining,
    input.next_check_at,
    input.status,
    input.id,
  );
}

export function stopWatcher(id: string): boolean {
  const db = requireDb();
  const result = db
    .prepare(`UPDATE watchers SET status = 'stopped', claimed_until = NULL WHERE id = ? AND status = 'active'`)
    .run(id);
  return Number(result.changes) > 0;
}

export function insertWatchEvent(row: WatchEventRow): void {
  const db = requireDb();
  db.prepare(
    `INSERT INTO watch_events (id, watcher_id, kind, payload_json, created_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.watcher_id, row.kind, row.payload_json, row.created_at, row.delivered_at);
}

export function listWatchEvents(watcherId: string): WatchEventRow[] {
  const db = requireDb();
  return db
    .prepare(
      `SELECT id, watcher_id, kind, payload_json, created_at, delivered_at
       FROM watch_events WHERE watcher_id = ? ORDER BY created_at ASC`,
    )
    .all(watcherId) as WatchEventRow[];
}

export function expireOverdueWatchers(nowIso: string): number {
  const db = requireDb();
  const result = db
    .prepare(
      `UPDATE watchers SET status = 'expired'
       WHERE status = 'active' AND (expires_at <= ? OR checks_remaining <= 0)`,
    )
    .run(nowIso);
  return Number(result.changes);
}
