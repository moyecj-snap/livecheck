import { DatabaseSync } from "node:sqlite";
import {
  STARTER_KEY_RETENTION_MS,
  STARTER_KEY_SETTINGS,
  STARTER_KEY_TTL_MS,
  githubAccountTooYoung,
  hashStarterKey,
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
  followup_drafted_at TEXT
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
};

export type IssueInput = {
  githubId: string;
  githubLogin: string;
  /** Checked and then discarded. Not stored. */
  accountCreatedAt: string;
  contactOptIn: boolean;
  /** Already an HMAC (`ip:…`). The raw IP never reaches this function. */
  ipSubject: string;
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
  available: boolean;
  enabled: boolean;
  env_forced_off: boolean;
  daily_cap: number;
  daily_cap_used: number;
  daily_cap_hit: boolean;
  note: string;
  l7d: StarterKeyWindow;
  l30d: StarterKeyWindow;
};

const STATS_NOTE =
  "Free starter-key checks are not paid calls and are not in the traffic buckets. This block is this machine's paid-calls volume, not a fleet sum. A future card-funded call would be a paid call with payer key:<id> (external). The daily cap is never raised automatically.";

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
  db.exec(DAILY_SQL);
  db.exec(MINUTE_SQL);
  db.exec(HOUR_SQL);
  db.exec(SETTINGS_SQL);
  db.exec(CAP_HITS_SQL);
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
  };
}

const KEY_COLUMNS =
  "id, key_sha256, github_id, github_login, contact_opt_in, created_at, expires_at, free_allowance, free_used, paid_left, status, suspended_reason, followup_drafted_at";

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

export function starterKeyLimits(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): StarterKeyLimits {
  return resolveStarterKeyLimits(readStarterKeySettings(db), env);
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

export function issueStarterKey(db: DatabaseSync, input: IssueInput, now = new Date()): IssueResult {
  if (!/^[0-9]{1,20}$/.test(input.githubId)) {
    return { ok: false, error: "invalid_account", message: "GitHub did not return a usable account id." };
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(input.githubLogin)) {
    return { ok: false, error: "invalid_account", message: "GitHub did not return a usable username." };
  }
  return withTx(db, () => {
    const limits = starterKeyLimits(db);
    if (!limits.enabled) {
      return { ok: false, error: "disabled", message: "Starter keys are turned off." };
    }
    if (githubAccountTooYoung(input.accountCreatedAt, now)) {
      return {
        ok: false,
        error: "account_too_young",
        message: "This GitHub account is under 7 days old. A starter key is available once the account is 7 days old.",
      };
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
    try {
      db.prepare(
        `INSERT INTO api_keys (
           id, key_sha256, github_id, github_login, contact_opt_in, created_at, expires_at,
           free_allowance, free_used, paid_left, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'active')`,
      ).run(
        id,
        hashStarterKey(plaintext),
        input.githubId,
        input.githubLogin,
        input.contactOptIn ? 1 : 0,
        nowIso,
        expiresAt,
        limits.freeAllowance,
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

export function reserveStarterCall(db: DatabaseSync, token: string, now = new Date()): ReserveResult {
  return withTx(db, () => {
    const limits = starterKeyLimits(db);
    const row = lookupByHash(db, token);
    if (!row) return { ok: false, status: 401 as const, error: "invalid_api_key", message: "Unknown starter key." };
    if (row.status === "revoked") {
      return { ok: false, status: 401 as const, error: "starter_key_revoked", message: "This starter key was revoked." };
    }
    if (!limits.enabled) {
      return { ok: false, status: 403 as const, error: "starter_keys_disabled", message: "Starter keys are turned off." };
    }
    if (row.status === "suspended") {
      return { ok: false, status: 403 as const, error: "starter_key_suspended", message: "This starter key is suspended." };
    }
    const nowIso = isoStamp(now);
    if (row.expires_at <= nowIso) {
      return { ok: false, status: 403 as const, error: "starter_key_expired", message: "This starter key has expired." };
    }
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
        message:
          "This starter key has used its free checks. Pay with a wallet (x402 on Base or MPP on Tempo) by calling this route without the key, or reply to get a top-up link.",
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

export function revokeStarterKey(db: DatabaseSync, idOrLogin: string, now = new Date()): ApiKeyRow | undefined {
  const needle = idOrLogin.trim().replace(/^@/, "");
  const row = rowFrom(
    db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ? OR github_id = ? OR github_login = ?`).get(needle, needle, needle) as
      | Record<string, unknown>
      | undefined,
  );
  if (!row) return undefined;
  if (row.status !== "revoked") {
    db.prepare(`UPDATE api_keys SET status = 'revoked', suspended_reason = COALESCE(suspended_reason, 'revoked') WHERE id = ?`).run(row.id);
    console.log(`starter_keys: revoked id=${row.id} at=${isoStamp(now)}`);
  }
  return rowFrom(db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`).get(row.id) as Record<string, unknown>);
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
       WHERE contact_opt_in = 1 AND followup_drafted_at IS NULL AND status != 'revoked'
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

function windowStats(db: DatabaseSync, sinceIso: string, sinceDay: string): StarterKeyWindow {
  const count = (sql: string, arg: string) => num((db.prepare(sql).get(arg) as { n: number | bigint }).n);
  return {
    issued: count(`SELECT COUNT(*) AS n FROM api_keys WHERE created_at >= ?`, sinceIso),
    activated: count(`SELECT COUNT(*) AS n FROM api_keys WHERE created_at >= ? AND free_used >= 1`, sinceIso),
    reached_20: count(`SELECT COUNT(*) AS n FROM api_keys WHERE created_at >= ? AND free_used >= 20`, sinceIso),
    out_of_credit: count(
      `SELECT COUNT(*) AS n FROM api_keys WHERE created_at >= ? AND free_used >= free_allowance`,
      sinceIso,
    ),
    free_checks: num(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(n), 0) AS n FROM api_key_daily
             WHERE metric = 'free_charged' AND day >= ? AND key_id != ? AND key_id NOT LIKE 'ip:%'`,
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
  const l7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const l30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    available: true,
    enabled: limits.enabled,
    env_forced_off: limits.envForcedOff,
    daily_cap: limits.dailyCheckCap,
    daily_cap_used: used,
    daily_cap_hit: capHitOn(db, day),
    note: STATS_NOTE,
    l7d: windowStats(db, isoStamp(l7), utcDay(l7)),
    l30d: windowStats(db, isoStamp(l30), utcDay(l30)),
  };
}

export function starterKeyStats(now = new Date()): StarterKeyStats {
  if (!bound) {
    return {
      available: false,
      enabled: false,
      env_forced_off: false,
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
      enabled: false,
      env_forced_off: false,
      daily_cap: STARTER_KEY_SETTINGS.daily_check_cap.fallback,
      daily_cap_used: 0,
      daily_cap_hit: false,
      note: `${STATS_NOTE} The store read failed.`,
      l7d: emptyWindow(),
      l30d: emptyWindow(),
    };
  }
}
