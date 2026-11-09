import { DatabaseSync } from "node:sqlite";
import { bucketLaunchSource } from "./free-job-sources.js";
import { currentLaunchUtmTags } from "./free-job-store.js";
import {
  EMERGENCY_STOP_MESSAGE,
  OUT_OF_CHECKS_MESSAGE,
  STARTER_KEY_RETENTION_MS,
  STARTER_KEY_SETTINGS,
  STARTER_KEY_TTL_MS,
  STARTER_SOURCE_ON_KEY_ROW,
  STARTER_SOURCE_STATS_PUBLIC,
  WIND_DOWN_MESSAGE,
  githubAccountTooYoung,
  hashStarterKey,
  isStarterSettingKey,
  isoStamp,
  newStarterKeyId,
  newStarterKeySecret,
  resolveStarterKeyLimits,
  type StarterKeyLimits,
  type StarterKeySettings,
  type StarterSettingKey,
} from "./starter-key.js";

/**
 * Starter keys live in the paid-calls SQLite file (the Fly volume) so they
 * survive restarts. Rows hold the GitHub id and username, the hashed key,
 * an opt-in bit, and counts. No email, no URL, no raw IP, no access token.
 *
 * `paid_left` is the phase 2 card-credit hook. Phase 1 never increments it.
 */

const GLOBAL = "global";
const ABUSE_REASON = ">50% blocked targets in an hour";

const KEYS_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_sha256 TEXT NOT NULL UNIQUE,
  github_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  contact_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (contact_opt_in IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  free_allowance INTEGER NOT NULL CHECK (free_allowance >= 1),
  free_used INTEGER NOT NULL DEFAULT 0 CHECK (free_used >= 0),
  paid_left INTEGER NOT NULL DEFAULT 0 CHECK (paid_left >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  suspended_reason TEXT,
  followup_drafted_at TEXT,
  internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0, 1)),
  source TEXT
);
`;

const DAILY_SQL = `
CREATE TABLE IF NOT EXISTS api_key_daily (
  day TEXT NOT NULL CHECK (length(day) = 10),
  key_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, key_id, metric)
);
`;

const MINUTE_SQL = `
CREATE TABLE IF NOT EXISTS api_key_minute (
  minute TEXT NOT NULL,
  key_id TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (minute, key_id)
);
`;

const HOUR_SQL = `
CREATE TABLE IF NOT EXISTS api_key_hour (
  hour TEXT NOT NULL,
  key_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (hour, key_id, metric)
);
`;

const SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS api_key_settings (
  key TEXT PRIMARY KEY CHECK (key IN (${Object.keys(STARTER_KEY_SETTINGS).map((key) => `'${key}'`).join(", ")})),
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const CAP_HITS_SQL = `
CREATE TABLE IF NOT EXISTS api_key_cap_hits (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  cap INTEGER NOT NULL,
  used INTEGER NOT NULL,
  hit_at TEXT NOT NULL
);
`;

/**
 * Issued starter keys by source. Counts only: no key id, login, IP, or URL.
 *
 * One row per (issue second, source). The second is the key's created_at, so
 * a rolling 7-day or 30-day window matches starter_keys.issued exactly. `day`
 * is that second's UTC date, for a per-day reading. Rows stay after the key
 * is deleted at expiry, which is what "keys per post" needs.
 *
 * v112 does not read this table. Creating it does not change api_keys.
 */
const SOURCE_DAILY_SQL = `
CREATE TABLE IF NOT EXISTS api_key_source_daily (
  day TEXT NOT NULL CHECK (length(day) = 10),
  created_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 40),
  issued INTEGER NOT NULL CHECK (issued >= 0),
  PRIMARY KEY (created_at, source)
);
`;

export type ApiKeyStatus = "active" | "suspended" | "revoked";

export type ApiKeyRow = {
  id: string;
  key_sha256: string;
  github_id: string;
  github_login: string;
  contact_opt_in: number;
  created_at: string;
  expires_at: string;
  free_allowance: number;
  free_used: number;
  paid_left: number;
  status: ApiKeyStatus;
  suspended_reason: string | null;
  followup_drafted_at: string | null;
  /** 1 = our own dry-run/test key (keys:mark-internal). Left out of every starter-key stat and follow-up. */
  internal: number;
  /**
   * Sanitized launch tag (or none / other). Null only before backfill of a
   * row inserted without the column. Not a URL, login, or IP.
   */
  source: string | null;
};

export type IssueInput = {
  githubId: string;
  githubLogin: string;
  /** Checked and then discarded. Not stored. */
  accountCreatedAt: string;
  contactOptIn: boolean;
  /** Already an HMAC (`ip:…`). The raw IP never reaches this function. */
  ipSubject: string;
  /**
   * utm_source or ref, raw or already bucketed. Sanitized again here.
   * Omitted, or a cookie from before this deploy, counts as "none".
   */
  source?: string;
};

export type IssueResult =
  | { ok: true; plaintext: string; id: string; expiresAt: string; login: string }
  | { ok: false; error: string; message: string };

export type ReserveResult =
  | { ok: true; key: ApiKeyRow }
  | {
      ok: false;
      status: 401 | 402 | 403 | 429 | 503;
      error: string;
      message: string;
      retryAfter?: number;
      freeUsed?: number;
      freeAllowance?: number;
    };

export type StarterKeyWindow = {
  issued: number;
  activated: number;
  reached_20: number;
  free_checks: number;
  out_of_credit: number;
};

export type StarterKeyStats = {
  /** Internal/test keys on file (keys:mark-internal). Not in l7d/l30d. */
  internal_keys_excluded: number;
  available: boolean;
  emergency_stop: boolean;
  wind_down: boolean;
  daily_cap: number;
  daily_cap_used: number;
  daily_cap_hit: boolean;
  note: string;
  l7d: StarterKeyWindow;
  l30d: StarterKeyWindow;
};

const STATS_NOTE =
  "Free starter-key checks are not paid calls and are not in the traffic buckets. This block is this machine's paid-calls volume, not a fleet sum. A future card-funded call would be a paid call with payer key:<id> (external). The daily cap is never raised automatically. Our own test keys (keys:mark-internal) are left out of issued, activated, 20+, free checks, and out of credit. The daily cap meter counts every free check, ours included, because it guards load.";

let bound: DatabaseSync | undefined;

export function bindApiKeyDb(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000;");
  migrateApiKeyStore(db);
  bound = db;
}

export function unbindApiKeyDb(): void {
  bound = undefined;
}

export function apiKeyDb(): DatabaseSync | undefined {
  return bound;
}

export function migrateApiKeyStore(db: DatabaseSync): void {
  db.exec(KEYS_SQL);
  migrateInternalColumn(db);
  db.exec(DAILY_SQL);
  db.exec(MINUTE_SQL);
  db.exec(HOUR_SQL);
  migrateApiKeySettings(db);
  db.exec(CAP_HITS_SQL);
  // Additive. v112 ignores the aggregate table. The source column is nullable,
  // so v112's INSERT (which does not name it) still works.
  db.exec(SOURCE_DAILY_SQL);
  migrateSourceColumn(db);
  retireIssueSourceTable(db);
  backfillNullSources(db);
}

/** Files made before keys:mark-internal existed get the column, default 0. */
function migrateInternalColumn(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>;
  if (cols.some((col) => col.name === "internal")) return;
  db.exec(`ALTER TABLE api_keys ADD COLUMN internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0, 1))`);
}

/** Nullable tag. Existing rows stay null until backfillNullSources sets them to none. */
function migrateSourceColumn(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>;
  if (cols.some((col) => col.name === "source")) return;
  db.exec(`ALTER TABLE api_keys ADD COLUMN source TEXT`);
}

/**
 * The settings CHECK lists the live keys. Rebuild when it still has the
 * old single `enabled` switch so `emergency_stop` and `wind_down` can be set
 * without a deploy. An `enabled` 0 row becomes emergency_stop 1.
 */
function migrateApiKeySettings(db: DatabaseSync): void {
  db.exec(SETTINGS_SQL);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_key_settings'").get() as
    | { sql?: string }
    | undefined;
  const sql = row?.sql ?? "";
  if (sql.includes("'emergency_stop'") && sql.includes("'wind_down'")) return;
  const old = db.prepare(`SELECT key, value, updated_at FROM api_key_settings`).all() as Array<{
    key: string;
    value: number | bigint;
    updated_at: string;
  }>;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TABLE api_key_settings");
    db.exec(SETTINGS_SQL);
    const insert = db.prepare(`INSERT INTO api_key_settings (key, value, updated_at) VALUES (?, ?, ?)`);
    let emergency = false;
    for (const item of old) {
      if (item.key === "enabled") {
        if (num(item.value) === 0) emergency = true;
        continue;
      }
      if (!isStarterSettingKey(item.key)) continue;
      insert.run(item.key, num(item.value), item.updated_at);
    }
    if (emergency) insert.run("emergency_stop", 1, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed
    }
    throw error;
  }
}

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed
    }
    throw error;
  }
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcMinute(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function utcHour(date: Date): string {
  return date.toISOString().slice(0, 13);
}

function readDaily(db: DatabaseSync, day: string, keyId: string, metric: string): number {
  const row = db.prepare(`SELECT n FROM api_key_daily WHERE day = ? AND key_id = ? AND metric = ?`).get(day, keyId, metric) as
    | { n: number | bigint }
    | undefined;
  return row ? num(row.n) : 0;
}

function bumpDaily(db: DatabaseSync, day: string, keyId: string, metric: string, delta: number): number {
  if (delta > 0) {
    db.prepare(
      `INSERT INTO api_key_daily (day, key_id, metric, n) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, key_id, metric) DO UPDATE SET n = n + excluded.n`,
    ).run(day, keyId, metric, delta);
  } else if (delta < 0) {
    db.prepare(
      `UPDATE api_key_daily SET n = n + ? WHERE day = ? AND key_id = ? AND metric = ? AND n + ? >= 0`,
    ).run(delta, day, keyId, metric, delta);
  }
  return readDaily(db, day, keyId, metric);
}

function readMinute(db: DatabaseSync, minute: string, keyId: string): number {
  const row = db.prepare(`SELECT n FROM api_key_minute WHERE minute = ? AND key_id = ?`).get(minute, keyId) as
    | { n: number | bigint }
    | undefined;
  return row ? num(row.n) : 0;
}

function bumpMinute(db: DatabaseSync, minute: string, keyId: string): number {
  db.prepare(
    `INSERT INTO api_key_minute (minute, key_id, n) VALUES (?, ?, 1)
     ON CONFLICT(minute, key_id) DO UPDATE SET n = n + 1`,
  ).run(minute, keyId);
  return readMinute(db, minute, keyId);
}

function readHour(db: DatabaseSync, hour: string, keyId: string, metric: string): number {
  const row = db.prepare(`SELECT n FROM api_key_hour WHERE hour = ? AND key_id = ? AND metric = ?`).get(hour, keyId, metric) as
    | { n: number | bigint }
    | undefined;
  return row ? num(row.n) : 0;
}

function bumpHour(db: DatabaseSync, hour: string, keyId: string, metric: string): number {
  db.prepare(
    `INSERT INTO api_key_hour (hour, key_id, metric, n) VALUES (?, ?, ?, 1)
     ON CONFLICT(hour, key_id, metric) DO UPDATE SET n = n + 1`,
  ).run(hour, keyId, metric);
  return readHour(db, hour, keyId, metric);
}

function rowFrom(raw: Record<string, unknown> | undefined): ApiKeyRow | undefined {
  if (!raw) return undefined;
  const status = raw.status;
  if (status !== "active" && status !== "suspended" && status !== "revoked") return undefined;
  return {
    id: String(raw.id),
    key_sha256: String(raw.key_sha256),
    github_id: String(raw.github_id),
    github_login: String(raw.github_login),
    contact_opt_in: num(raw.contact_opt_in),
    created_at: String(raw.created_at),
    expires_at: String(raw.expires_at),
    free_allowance: num(raw.free_allowance),
    free_used: num(raw.free_used),
    paid_left: num(raw.paid_left),
    status,
    suspended_reason: raw.suspended_reason == null ? null : String(raw.suspended_reason),
    followup_drafted_at: raw.followup_drafted_at == null ? null : String(raw.followup_drafted_at),
    internal: num(raw.internal ?? 0),
    source: raw.source == null || raw.source === "" ? null : String(raw.source),
  };
}

const KEY_COLUMNS =
  "id, key_sha256, github_id, github_login, contact_opt_in, created_at, expires_at, free_allowance, free_used, paid_left, status, suspended_reason, followup_drafted_at, internal, source";

export function readStarterKeySettings(db: DatabaseSync): StarterKeySettings {
  const out: StarterKeySettings = {};
  const rows = db.prepare(`SELECT key, value FROM api_key_settings`).all() as Array<{ key: string; value: number | bigint }>;
  for (const row of rows) {
    if (!Object.prototype.hasOwnProperty.call(STARTER_KEY_SETTINGS, row.key)) continue;
    const key = row.key as StarterSettingKey;
    const value = num(row.value);
    const { min, max } = STARTER_KEY_SETTINGS[key];
    if (Number.isInteger(value) && value >= min && value <= max) out[key] = value;
  }
  return out;
}

export function starterKeyLimits(db: DatabaseSync): StarterKeyLimits {
  return resolveStarterKeyLimits(readStarterKeySettings(db));
}

export function setStarterKeySetting(
  db: DatabaseSync,
  key: StarterSettingKey,
  value: number,
  now = new Date(),
): { key: StarterSettingKey; value: number; previous: number | undefined } {
  const spec = STARTER_KEY_SETTINGS[key];
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw new Error(`${key} must be a whole number from ${spec.min} to ${spec.max}`);
  }
  const previous = readStarterKeySettings(db)[key];
  db.prepare(
    `INSERT INTO api_key_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, isoStamp(now));
  return { key, value, previous };
}

function flagCapHit(db: DatabaseSync, day: string, cap: number, used: number, now: Date): void {
  const result = db
    .prepare(`INSERT INTO api_key_cap_hits (day, cap, used, hit_at) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO NOTHING`)
    .run(day, cap, used, isoStamp(now));
  if (num(result.changes) === 1) {
    console.warn(
      `starter_keys: DAILY CAP HIT day=${day} used=${used} cap=${cap} (not raised; change it with keys:set daily_check_cap)`,
    );
  }
}

export function capHitOn(db: DatabaseSync, day: string): boolean {
  const row = db.prepare(`SELECT day FROM api_key_cap_hits WHERE day = ?`).get(day) as { day: string } | undefined;
  return Boolean(row);
}

function existingMessage(row: ApiKeyRow, nowIso: string): IssueResult {
  if (row.status === "revoked") {
    return { ok: false, error: "revoked", message: "This GitHub account's starter key was revoked." };
  }
  if (row.status === "suspended") {
    return { ok: false, error: "suspended", message: "This GitHub account's starter key is suspended." };
  }
  if (row.expires_at <= nowIso) {
    return {
      ok: false,
      error: "already_issued",
      message: "This GitHub account already had a starter key. A new one is not issued while that record is kept.",
    };
  }
  return {
    ok: false,
    error: "already_issued",
    message: "This GitHub account already has a starter key. It was shown once and cannot be shown again.",
  };
}

function sourceDay(createdAt: string): string {
  return createdAt.slice(0, 10);
}

/** +1 on a new issue. -1 when that issue leaves the issued total. Never below 0. */
function bumpSourceIssued(db: DatabaseSync, createdAt: string, source: string, delta: number): void {
  const day = sourceDay(createdAt);
  if (delta > 0) {
    db.prepare(
      `INSERT INTO api_key_source_daily (day, created_at, source, issued) VALUES (?, ?, ?, ?)
       ON CONFLICT(created_at, source) DO UPDATE SET issued = issued + excluded.issued`,
    ).run(day, createdAt, source, delta);
    return;
  }
  if (delta < 0) {
    db.prepare(
      `UPDATE api_key_source_daily SET issued = issued + ? WHERE created_at = ? AND source = ? AND issued + ? >= 0`,
    ).run(delta, createdAt, source, delta);
    db.prepare(`DELETE FROM api_key_source_daily WHERE created_at = ? AND source = ? AND issued = 0`).run(createdAt, source);
  }
}

function storedSource(source: string | null | undefined): string {
  return source && source.length > 0 ? source : "none";
}

/**
 * The previous commit of this branch kept key id → tag in api_key_issue_source.
 * Copy that tag onto the column, subtract any internal key that was still
 * counted, then drop the table. v112 never creates it. Fresh databases skip this.
 */
function retireIssueSourceTable(db: DatabaseSync): void {
  const exists = db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'api_key_issue_source'`).get() as
    | { hit: number }
    | undefined;
  if (!exists) return;
  const rows = db
    .prepare(
      `SELECT s.key_id AS key_id, s.created_at AS created_at, s.source AS source, s.counted AS counted, k.internal AS internal
       FROM api_key_issue_source s
       JOIN api_keys k ON k.id = s.key_id`,
    )
    .all() as Array<{ key_id: string; created_at: string; source: string; counted: number | bigint; internal: number | bigint }>;
  db.exec("BEGIN IMMEDIATE");
  try {
    const setSource = db.prepare(`UPDATE api_keys SET source = ? WHERE id = ? AND source IS NULL`);
    for (const row of rows) {
      setSource.run(row.source, row.key_id);
      if (num(row.counted) === 1 && num(row.internal) === 1) bumpSourceIssued(db, String(row.created_at), storedSource(row.source), -1);
    }
    db.exec(`DROP TABLE api_key_issue_source`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed
    }
    throw error;
  }
}

/**
 * Rows inserted before the column existed (or by v112, which does not set it)
 * have no tag. Record them as none, once. Internal keys are not added to the
 * issued aggregate; they are already out of the issued total.
 */
function backfillNullSources(db: DatabaseSync): void {
  const missing = db.prepare(`SELECT id, created_at, internal FROM api_keys WHERE source IS NULL`).all() as Array<{
    id: string;
    created_at: string;
    internal: number | bigint;
  }>;
  if (missing.length === 0) return;
  const setSource = db.prepare(`UPDATE api_keys SET source = 'none' WHERE id = ? AND source IS NULL`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of missing) {
      const updated = setSource.run(row.id);
      if (num(updated.changes) === 1 && num(row.internal) !== 1) bumpSourceIssued(db, String(row.created_at), "none", 1);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed
    }
    throw error;
  }
}

export function issueStarterKey(db: DatabaseSync, input: IssueInput, now = new Date()): IssueResult {
  if (!/^[0-9]{1,20}$/.test(input.githubId)) {
    return { ok: false, error: "invalid_account", message: "GitHub did not return a usable account id." };
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(input.githubLogin)) {
    return { ok: false, error: "invalid_account", message: "GitHub did not return a usable username." };
  }
  return withTx(db, () => {
    const limits = starterKeyLimits(db);
    if (limits.emergencyStop) {
      return { ok: false, error: "emergency_stop", message: EMERGENCY_STOP_MESSAGE };
    }
    const nowIso = isoStamp(now);
    const existing = rowFrom(
      db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE github_id = ?`).get(input.githubId) as Record<string, unknown> | undefined,
    );
    if (existing) {
      if (existing.github_login !== input.githubLogin) {
        db.prepare(`UPDATE api_keys SET github_login = ? WHERE id = ?`).run(input.githubLogin, existing.id);
      }
      if (input.contactOptIn && existing.contact_opt_in !== 1) {
        db.prepare(`UPDATE api_keys SET contact_opt_in = 1 WHERE id = ?`).run(existing.id);
      }
      return existingMessage(existing, nowIso);
    }
    if (limits.windDown) {
      return { ok: false, error: "wind_down", message: WIND_DOWN_MESSAGE };
    }
    if (githubAccountTooYoung(input.accountCreatedAt, now)) {
      return {
        ok: false,
        error: "account_too_young",
        message: githubTooYoungMessage(input.accountCreatedAt),
      };
    }
    const day = utcDay(now);
    const ipCount = readDaily(db, day, input.ipSubject, "issued");
    if (ipCount >= limits.issuancePerIp) {
      return { ok: false, error: "ip_limited", message: "Too many new keys from this network today. Try again tomorrow." };
    }
    const globalCount = readDaily(db, day, GLOBAL, "issued");
    if (globalCount >= limits.issuancePerDay) {
      return { ok: false, error: "global_limited", message: "Starter keys are paused for today. Try again tomorrow." };
    }
    const plaintext = newStarterKeySecret();
    const id = newStarterKeyId();
    const expiresAt = isoStamp(new Date(now.getTime() + STARTER_KEY_TTL_MS));
    const source = bucketLaunchSource(input.source, currentLaunchUtmTags());
    try {
      db.prepare(
        `INSERT INTO api_keys (
           id, key_sha256, github_id, github_login, contact_opt_in, created_at, expires_at,
           free_allowance, free_used, paid_left, status, source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'active', ?)`,
      ).run(
        id,
        hashStarterKey(plaintext),
        input.githubId,
        input.githubLogin,
        input.contactOptIn ? 1 : 0,
        nowIso,
        expiresAt,
        limits.freeAllowance,
        source,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE")) {
        return {
          ok: false,
          error: "already_issued",
          message: "This GitHub account already has a starter key. It was shown once and cannot be shown again.",
        };
      }
      throw error;
    }
    bumpDaily(db, day, input.ipSubject, "issued", 1);
    bumpDaily(db, day, GLOBAL, "issued", 1);
    bumpSourceIssued(db, nowIso, source, 1);
    console.log(`starter_keys: issued id=${id}`);
    return { ok: true, plaintext, id, expiresAt, login: input.githubLogin };
  });
}

function lookupByHash(db: DatabaseSync, token: string): ApiKeyRow | undefined {
  return rowFrom(
    db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE key_sha256 = ?`).get(hashStarterKey(token)) as
      | Record<string, unknown>
      | undefined,
  );
}

/** Key status only. Does not count a call or reserve a credit. */
function denyStarterKey(row: ApiKeyRow | undefined, limits: StarterKeyLimits, now: Date): ReserveResult | undefined {
  if (!row) return { ok: false, status: 401, error: "invalid_api_key", message: "Unknown starter key." };
  if (row.status === "revoked") {
    return { ok: false, status: 401, error: "starter_key_revoked", message: "This starter key was revoked." };
  }
  if (limits.emergencyStop) {
    return { ok: false, status: 403, error: "starter_keys_emergency_stop", message: EMERGENCY_STOP_MESSAGE };
  }
  if (row.status === "suspended") {
    return { ok: false, status: 403, error: "starter_key_suspended", message: "This starter key is suspended." };
  }
  if (row.expires_at <= isoStamp(now)) {
    return { ok: false, status: 403, error: "starter_key_expired", message: "This starter key has expired." };
  }
  return undefined;
}

/** Whether this key may be used right now. Does not spend a credit or a rate-limit slot. */
export function authorizeStarterKey(db: DatabaseSync, token: string, now = new Date()): ReserveResult | { ok: true; key: ApiKeyRow } {
  const limits = starterKeyLimits(db);
  const row = lookupByHash(db, token);
  return denyStarterKey(row, limits, now) ?? { ok: true, key: row as ApiKeyRow };
}

export function reserveStarterCall(db: DatabaseSync, token: string, now = new Date()): ReserveResult {
  return withTx(db, () => {
    const limits = starterKeyLimits(db);
    const row = lookupByHash(db, token);
    const denied = denyStarterKey(row, limits, now);
    if (denied || !row) return denied ?? { ok: false, status: 401, error: "invalid_api_key", message: "Unknown starter key." };
    const minute = utcMinute(now);
    const calls = bumpMinute(db, minute, row.id);
    if (calls > limits.perKeyPerMinute) {
      return {
        ok: false,
        status: 429 as const,
        error: "rate_limited",
        message: `This starter key is limited to ${limits.perKeyPerMinute} calls a minute.`,
        retryAfter: 60,
      };
    }
    const day = utcDay(now);
    const reserved = readDaily(db, day, row.id, "free_reserved");
    if (row.free_used + reserved >= row.free_allowance) {
      return {
        ok: false,
        status: 402 as const,
        error: "out_of_checks",
        message: OUT_OF_CHECKS_MESSAGE,
        freeUsed: row.free_used,
        freeAllowance: row.free_allowance,
      };
    }
    const chargedToday = readDaily(db, day, row.id, "free_charged");
    if (chargedToday + reserved >= limits.perKeyDailyChecks) {
      return {
        ok: false,
        status: 429 as const,
        error: "daily_check_limit",
        message: `This starter key is limited to ${limits.perKeyDailyChecks} checks a day.`,
        retryAfter: 3600,
      };
    }
    const globalCharged = readDaily(db, day, GLOBAL, "free_charged");
    const globalReserved = readDaily(db, day, GLOBAL, "free_reserved");
    if (globalCharged + globalReserved >= limits.dailyCheckCap) {
      flagCapHit(db, day, limits.dailyCheckCap, globalCharged + globalReserved, now);
      return {
        ok: false,
        status: 429 as const,
        error: "starter_keys_daily_cap",
        message: `Free starter keys are limited to ${limits.dailyCheckCap} checks a day across all keys. Try again tomorrow.`,
        retryAfter: 3600,
      };
    }
    bumpDaily(db, day, row.id, "free_reserved", 1);
    bumpDaily(db, day, GLOBAL, "free_reserved", 1);
    return { ok: true, key: row };
  });
}

export function finishStarterCall(
  db: DatabaseSync,
  keyId: string,
  outcome: { charge: boolean; blocked: boolean },
  now = new Date(),
): { freeUsed: number; freeAllowance: number; suspended: boolean } {
  return withTx(db, () => {
    const day = utcDay(now);
    const limits = starterKeyLimits(db);
    bumpDaily(db, day, keyId, "free_reserved", -1);
    bumpDaily(db, day, GLOBAL, "free_reserved", -1);
    if (outcome.charge) {
      db.prepare(`UPDATE api_keys SET free_used = free_used + 1 WHERE id = ?`).run(keyId);
      bumpDaily(db, day, keyId, "free_charged", 1);
      const charged = bumpDaily(db, day, GLOBAL, "free_charged", 1);
      if (charged >= limits.dailyCheckCap) flagCapHit(db, day, limits.dailyCheckCap, charged, now);
    }
    let suspended = false;
    if (outcome.charge || outcome.blocked) {
      const hour = utcHour(now);
      const attempts = bumpHour(db, hour, keyId, "attempts");
      const blocked = outcome.blocked ? bumpHour(db, hour, keyId, "blocked") : readHour(db, hour, keyId, "blocked");
      if (attempts >= limits.abuseMinSamples && blocked * 2 > attempts) {
        const result = db
          .prepare(`UPDATE api_keys SET status = 'suspended', suspended_reason = ? WHERE id = ? AND status = 'active'`)
          .run(ABUSE_REASON, keyId);
        suspended = num(result.changes) === 1;
        if (suspended) console.warn(`starter_keys: suspended id=${keyId} reason=${ABUSE_REASON}`);
      }
    }
    const row = rowFrom(db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`).get(keyId) as Record<string, unknown> | undefined);
    return {
      freeUsed: row?.free_used ?? 0,
      freeAllowance: row?.free_allowance ?? 0,
      suspended,
    };
  });
}

/**
 * Find one key by key id (k_…), GitHub numeric id, or GitHub login (with or
 * without @; GitHub logins are case-insensitive).
 */
export function findStarterKey(db: DatabaseSync, idOrLogin: string): ApiKeyRow | undefined {
  const needle = idOrLogin.trim().replace(/^@/, "");
  if (!needle) return undefined;
  return rowFrom(
    db
      .prepare(
        `SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ? OR github_id = ? OR lower(github_login) = lower(?) ORDER BY created_at ASC LIMIT 1`,
      )
      .get(needle, needle, needle) as Record<string, unknown> | undefined,
  );
}

export function revokeStarterKey(db: DatabaseSync, idOrLogin: string, now = new Date()): ApiKeyRow | undefined {
  const row = findStarterKey(db, idOrLogin);
  if (!row) return undefined;
  if (row.status !== "revoked") {
    db.prepare(`UPDATE api_keys SET status = 'revoked', suspended_reason = COALESCE(suspended_reason, 'revoked') WHERE id = ?`).run(row.id);
    console.log(`starter_keys: revoked id=${row.id} at=${isoStamp(now)}`);
  }
  return rowFrom(db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`).get(row.id) as Record<string, unknown>);
}

/**
 * Flag our own dry-run/test key as internal. Its key, checks, and 20+ status
 * leave every starter-key stat (issued, activated, reached_20, free_checks,
 * out_of_credit) and the 7-day follow-up list. The same transaction subtracts
 * one from that key's issued-by-source bucket. The key itself keeps working
 * until revoked. Like testers:add for wallets.
 */
export function markStarterKeyInternal(db: DatabaseSync, idOrLogin: string, now = new Date()): ApiKeyRow | undefined {
  return withTx(db, () => {
    const row = findStarterKey(db, idOrLogin);
    if (!row) return undefined;
    if (row.internal !== 1) {
      db.prepare(`UPDATE api_keys SET internal = 1 WHERE id = ?`).run(row.id);
      bumpSourceIssued(db, row.created_at, storedSource(row.source), -1);
      console.log(`starter_keys: marked internal id=${row.id} login=@${row.github_login} at=${isoStamp(now)}`);
    }
    return rowFrom(db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`).get(row.id) as Record<string, unknown>);
  });
}

/**
 * Admin delete: remove one account's key record and its per-key count rows
 * now, so the same GitHub account can get a fresh key. Overrides the
 * 90-day retention for this record only. Logs the key id and login, never
 * the key or its hash. The day's global cap meter is left as it was.
 */
export function deleteStarterKeyRecord(
  db: DatabaseSync,
  idOrLogin: string,
  now = new Date(),
): { id: string; github_login: string; github_id: string } | undefined {
  return withTx(db, () => {
    const row = findStarterKey(db, idOrLogin);
    if (!row) return undefined;
    if (row.internal !== 1) bumpSourceIssued(db, row.created_at, storedSource(row.source), -1);
    db.prepare(`DELETE FROM api_key_daily WHERE key_id = ?`).run(row.id);
    db.prepare(`DELETE FROM api_key_minute WHERE key_id = ?`).run(row.id);
    db.prepare(`DELETE FROM api_key_hour WHERE key_id = ?`).run(row.id);
    db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(row.id);
    console.log(
      `starter_keys: admin deleted id=${row.id} login=@${row.github_login} github:${row.github_id} status=${row.status} at=${isoStamp(now)} (overrides 90-day retention; the account can get a new key)`,
    );
    return { id: row.id, github_login: row.github_login, github_id: row.github_id };
  });
}

export function listStarterKeys(db: DatabaseSync): ApiKeyRow[] {
  const rows = db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const parsed = rowFrom(row);
    return parsed ? [parsed] : [];
  });
}

export type FollowupCandidate = {
  id: string;
  github_login: string;
  created_at: string;
  free_used: number;
  status: ApiKeyStatus;
};

/** Opted-in keys that are 7 days old, still inside their 30-day life, and not yet drafted. */
export function listFollowups(db: DatabaseSync, now = new Date()): FollowupCandidate[] {
  const due = isoStamp(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const nowIso = isoStamp(now);
  const rows = db
    .prepare(
      `SELECT id, github_login, created_at, free_used, status FROM api_keys
       WHERE contact_opt_in = 1 AND followup_drafted_at IS NULL AND status != 'revoked' AND internal = 0
         AND created_at <= ? AND expires_at > ?
       ORDER BY created_at ASC`,
    )
    .all(due, nowIso) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    github_login: String(row.github_login),
    created_at: String(row.created_at),
    free_used: num(row.free_used),
    status: row.status === "suspended" ? "suspended" : "active",
  }));
}

export function markFollowupDrafted(db: DatabaseSync, id: string, now = new Date()): boolean {
  const result = db
    .prepare(`UPDATE api_keys SET followup_drafted_at = ? WHERE id = ? AND contact_opt_in = 1 AND followup_drafted_at IS NULL`)
    .run(isoStamp(now), id);
  return num(result.changes) === 1;
}

/** Delete key rows whose expiry is at least 90 days ago, plus their count rows. */
export function deleteExpiredStarterKeys(db: DatabaseSync, now = new Date()): number {
  const cutoff = isoStamp(new Date(now.getTime() - STARTER_KEY_RETENTION_MS));
  const pruneBefore = isoStamp(new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000));
  return withTx(db, () => {
    const ids = db.prepare(`SELECT id FROM api_keys WHERE expires_at <= ?`).all(cutoff) as Array<{ id: string }>;
    for (const { id } of ids) {
      // Issued-by-source stays in api_key_source_daily. The key row, including its tag, does not.
      db.prepare(`DELETE FROM api_key_daily WHERE key_id = ?`).run(id);
      db.prepare(`DELETE FROM api_key_minute WHERE key_id = ?`).run(id);
      db.prepare(`DELETE FROM api_key_hour WHERE key_id = ?`).run(id);
      db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
    }
    db.prepare(`DELETE FROM api_key_minute WHERE minute < ?`).run(pruneBefore.slice(0, 16));
    db.prepare(`DELETE FROM api_key_hour WHERE hour < ?`).run(pruneBefore.slice(0, 13));
    db.prepare(`DELETE FROM api_key_daily WHERE day < ? AND (key_id = ? OR key_id LIKE 'ip:%')`).run(pruneBefore.slice(0, 10), GLOBAL);
    db.prepare(`DELETE FROM api_key_cap_hits WHERE day < ?`).run(pruneBefore.slice(0, 10));
    return ids.length;
  });
}

export function sweepStarterKeys(now = new Date()): number {
  const db = bound;
  if (!db) return 0;
  return deleteExpiredStarterKeys(db, now);
}

function emptyWindow(): StarterKeyWindow {
  return { issued: 0, activated: 0, reached_20: 0, free_checks: 0, out_of_credit: 0 };
}

function rollingCutoff(now: Date, days: number): { iso: string; day: string } {
  const at = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { iso: isoStamp(at), day: utcDay(at) };
}

function windowStats(db: DatabaseSync, sinceIso: string, sinceDay: string): StarterKeyWindow {
  // Outside keys only: internal = 0. Our own test keys never count.
  const count = (where: string) =>
    num(
      (db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE created_at >= ? AND internal = 0${where}`).get(sinceIso) as {
        n: number | bigint;
      }).n,
    );
  return {
    issued: count(""),
    activated: count(" AND free_used >= 1"),
    reached_20: count(" AND free_used >= 20"),
    out_of_credit: count(" AND free_used >= free_allowance"),
    free_checks: num(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(n), 0) AS n FROM api_key_daily
             WHERE metric = 'free_charged' AND day >= ? AND key_id != ? AND key_id NOT LIKE 'ip:%'
               AND key_id NOT IN (SELECT id FROM api_keys WHERE internal = 1)`,
          )
          .get(sinceDay, GLOBAL) as { n: number | bigint }
      ).n,
    ),
  };
}

export function queryStarterKeyStats(db: DatabaseSync, now = new Date()): StarterKeyStats {
  const limits = starterKeyLimits(db);
  const day = utcDay(now);
  const used = readDaily(db, day, GLOBAL, "free_charged") + readDaily(db, day, GLOBAL, "free_reserved");
  const l7 = rollingCutoff(now, 7);
  const l30 = rollingCutoff(now, 30);
  const internal = num((db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE internal = 1`).get() as { n: number | bigint }).n);
  return {
    available: true,
    internal_keys_excluded: internal,
    emergency_stop: limits.emergencyStop,
    wind_down: limits.windDown,
    daily_cap: limits.dailyCheckCap,
    daily_cap_used: used,
    daily_cap_hit: capHitOn(db, day),
    note: STATS_NOTE,
    l7d: windowStats(db, l7.iso, l7.day),
    l30d: windowStats(db, l30.iso, l30.day),
  };
}

export type StarterSourceBucket = { issued: number; activated: number; reached_20: number };
export type StarterSourceBuckets = Record<string, StarterSourceBucket>;

export type StarterKeySourceReport = {
  available: boolean;
  note: string;
  /** The two storage/visibility defaults. Flip the constants in starter-key.ts. */
  decisions: { public_stats: boolean; source_on_key_row: boolean };
  /** Same rolling windows as starter_keys.l7d.issued and l30d.issued. */
  issued: { l7d: number; l30d: number };
  by_source: { l7d: StarterSourceBuckets; l30d: StarterSourceBuckets };
};

const SOURCE_STATS_NOTE =
  "Starter keys by the link that started sign-in (utm_source or ref) after the launch-tag allowlist. The tag is the sanitized value on the key (none = no tag, including a sign-in already in flight at deploy; other = not on the allowlist). issued is the daily aggregate and survives key expiry. activated (free_used >= 1) and reached_20 (free_used >= 20) are counted from the key row and drop when the key is deleted. Internal test keys (keys:mark-internal) are left out. Each bucket's issued adds up to starter_keys issued for the same rolling window, and the same for activated and reached_20. Public /stats does not include this block.";

function sourceDecisions(): StarterKeySourceReport["decisions"] {
  return { public_stats: STARTER_SOURCE_STATS_PUBLIC, source_on_key_row: STARTER_SOURCE_ON_KEY_ROW };
}

function sourceBuckets(db: DatabaseSync, sinceIso: string): StarterSourceBuckets {
  const issuedRows = db
    .prepare(`SELECT source, SUM(issued) AS n FROM api_key_source_daily WHERE created_at >= ? GROUP BY source`)
    .all(sinceIso) as Array<{ source: string; n: number | bigint }>;
  const useRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(source, ''), 'none') AS source,
              SUM(CASE WHEN free_used >= 1 THEN 1 ELSE 0 END) AS activated,
              SUM(CASE WHEN free_used >= 20 THEN 1 ELSE 0 END) AS reached_20
       FROM api_keys
       WHERE internal = 0 AND created_at >= ?
       GROUP BY COALESCE(NULLIF(source, ''), 'none')`,
    )
    .all(sinceIso) as Array<{ source: string; activated: number | bigint; reached_20: number | bigint }>;
  const buckets = new Map<string, StarterSourceBucket>();
  const bucket = (source: string): StarterSourceBucket => {
    const existing = buckets.get(source);
    if (existing) return existing;
    const created = { issued: 0, activated: 0, reached_20: 0 };
    buckets.set(source, created);
    return created;
  };
  for (const row of issuedRows) {
    const issued = num(row.n);
    if (issued > 0) bucket(row.source).issued = issued;
  }
  for (const row of useRows) {
    const activated = num(row.activated);
    const reached = num(row.reached_20);
    if (activated > 0 || reached > 0) {
      const item = bucket(row.source);
      item.activated = activated;
      item.reached_20 = reached;
    }
  }
  const entries = [...buckets.entries()].filter(([, item]) => item.issued > 0 || item.activated > 0 || item.reached_20 > 0);
  entries.sort((a, b) => b[1].issued - a[1].issued || b[1].activated - a[1].activated || a[0].localeCompare(b[0]));
  return Object.fromEntries(entries);
}

export function queryStarterKeySourceBuckets(db: DatabaseSync, now = new Date()): { l7d: StarterSourceBuckets; l30d: StarterSourceBuckets } {
  return {
    l7d: sourceBuckets(db, rollingCutoff(now, 7).iso),
    l30d: sourceBuckets(db, rollingCutoff(now, 30).iso),
  };
}

export function starterKeySourceReport(now = new Date()): StarterKeySourceReport {
  const decisions = sourceDecisions();
  const empty = { l7d: {}, l30d: {} };
  if (!bound) {
    return {
      available: false,
      note: `${SOURCE_STATS_NOTE} The store is not open on this process.`,
      decisions,
      issued: { l7d: 0, l30d: 0 },
      by_source: empty,
    };
  }
  try {
    const stats = queryStarterKeyStats(bound, now);
    return {
      available: true,
      note: SOURCE_STATS_NOTE,
      decisions,
      issued: { l7d: stats.l7d.issued, l30d: stats.l30d.issued },
      by_source: queryStarterKeySourceBuckets(bound, now),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[starter_keys] source stats read failed: ${reason}`);
    return {
      available: false,
      note: `${SOURCE_STATS_NOTE} The store read failed.`,
      decisions,
      issued: { l7d: 0, l30d: 0 },
      by_source: empty,
    };
  }
}

export function starterKeyStats(now = new Date()): StarterKeyStats {
  if (!bound) {
    return {
      available: false,
      internal_keys_excluded: 0,
      emergency_stop: false,
      wind_down: false,
      daily_cap: STARTER_KEY_SETTINGS.daily_check_cap.fallback,
      daily_cap_used: 0,
      daily_cap_hit: false,
      note: `${STATS_NOTE} The store is not open on this process.`,
      l7d: emptyWindow(),
      l30d: emptyWindow(),
    };
  }
  try {
    return queryStarterKeyStats(bound, now);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[starter_keys] stats read failed: ${reason}`);
    return {
      available: false,
      internal_keys_excluded: 0,
      emergency_stop: false,
      wind_down: false,
      daily_cap: STARTER_KEY_SETTINGS.daily_check_cap.fallback,
      daily_cap_used: 0,
      daily_cap_hit: false,
      note: `${STATS_NOTE} The store read failed.`,
      l7d: emptyWindow(),
      l30d: emptyWindow(),
    };
  }
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** Rejection copy for a GitHub account under 7 days old. Date is account created_at + 7 days, in UTC. */
export function githubTooYoungMessage(accountCreatedAt: string): string {
  const created = Date.parse(accountCreatedAt);
  if (!Number.isFinite(created)) return "Your GitHub account must be at least 7 days old.";
  const d = new Date(created + 7 * 24 * 60 * 60 * 1000);
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  return `Your GitHub account must be at least 7 days old. Try again after ${date}.`;
}
