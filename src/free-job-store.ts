import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SOURCES_TABLE_SQL,
  bumpSourcesIn,
  readSourceTotalsFrom,
  sourceSummary,
  type SourceEvent,
  type SourceTotals,
  type SourceValues,
} from "./free-job-sources.js";

/**
 * Launch tracking for the free /job page: daily COUNTS only.
 *
 * One row per (Pacific day, metric) with an integer. There is no column for
 * a URL, host, IP, cookie, or user agent, so the page cannot store the links
 * people check even by accident. This is its own file
 * (`/data/free-page.sqlite` on Fly), never `paid-calls.sqlite`: free checks
 * are not paid calls and never touch /stats revenue buckets.
 */
export const FREE_PAGE_METRICS = [
  "views",
  "checks",
  "verdict_open",
  "verdict_closed",
  "verdict_cant_tell",
  "cta_docs",
  "cta_skill",
  "limited",
  "busy",
  "invalid_url",
  "example_open",
  "example_filled",
] as const;

export type FreePageMetric = (typeof FREE_PAGE_METRICS)[number];

const dailyTableSql = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  day TEXT NOT NULL CHECK (length(day) = 10),
  metric TEXT NOT NULL CHECK (metric IN (${FREE_PAGE_METRICS.map((m) => `'${m}'`).join(", ")})),
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, metric)
);
`;
const TABLE_SQL = dailyTableSql("free_page_daily");

/**
 * SQLite can't ALTER a CHECK. When a new metric is added, an existing
 * free_page_daily (created with the older list) is rebuilt in one
 * transaction: copy counts into a table with the current CHECK, drop, rename.
 */
export function migrateFreePageDaily(db: DatabaseSync): void {
  db.exec(TABLE_SQL);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'free_page_daily'").get() as
    | { sql?: string }
    | undefined;
  const sql = row?.sql ?? "";
  if (FREE_PAGE_METRICS.every((metric) => sql.includes(`'${metric}'`))) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TABLE IF EXISTS free_page_daily_v2");
    db.exec(dailyTableSql("free_page_daily_v2"));
    db.exec("INSERT INTO free_page_daily_v2 (day, metric, n) SELECT day, metric, n FROM free_page_daily");
    db.exec("DROP TABLE free_page_daily");
    db.exec("ALTER TABLE free_page_daily_v2 RENAME TO free_page_daily");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Live knobs for the free page, editable with no deploy and no restart:
 *   fly ssh console -a livecheck -C "npm run --silent free:set -- hourly_cap 1000"
 * The page reads this table on every request. A key that is not set falls
 * back to its env var, then the built-in default.
 */
export const FREE_PAGE_SETTINGS = {
  hourly_cap: { min: 0, max: 100_000 },
  concurrency: { min: 1, max: 16 },
  per_visitor_daily: { min: 1, max: 1000 },
  per_ip_daily: { min: 1, max: 10_000 },
  enabled: { min: 0, max: 1 },
} as const;

export type FreePageSettingKey = keyof typeof FREE_PAGE_SETTINGS;
export type FreePageSettings = Partial<Record<FreePageSettingKey, number>>;

export const SETTINGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS free_page_settings (
  key TEXT PRIMARY KEY CHECK (key IN (${Object.keys(FREE_PAGE_SETTINGS).map((k) => `'${k}'`).join(", ")})),
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function isFreePageSettingKey(value: unknown): value is FreePageSettingKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FREE_PAGE_SETTINGS, value);
}

/** Validate a key/value pair. Throws with a plain message on anything out of range. */
export function parseFreePageSetting(key: unknown, raw: unknown): { key: FreePageSettingKey; value: number } {
  if (!isFreePageSettingKey(key)) {
    throw new Error(`unknown setting ${String(key)}; use one of: ${Object.keys(FREE_PAGE_SETTINGS).join(", ")}`);
  }
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim().toLowerCase();
  const value = key === "enabled" && (text === "on" || text === "true") ? 1 : key === "enabled" && (text === "off" || text === "false") ? 0 : Number(text);
  const { min, max } = FREE_PAGE_SETTINGS[key];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be a whole number from ${min} to ${max}, got ${String(raw)}`);
  }
  return { key, value };
}

export function migrateFreePageSettings(db: DatabaseSync): void {
  db.exec(SETTINGS_TABLE_SQL);
}

export function readFreePageSettingsFrom(db: DatabaseSync): FreePageSettings {
  const out: FreePageSettings = {};
  const rows = db.prepare(`SELECT key, value FROM free_page_settings`).all() as Array<{ key: string; value: number }>;
  for (const row of rows) {
    if (!isFreePageSettingKey(row.key)) continue;
    const { min, max } = FREE_PAGE_SETTINGS[row.key];
    const value = Number(row.value);
    if (Number.isInteger(value) && value >= min && value <= max) out[row.key] = value;
  }
  return out;
}

export function setFreePageSettingIn(db: DatabaseSync, key: unknown, raw: unknown, now = new Date()): { key: FreePageSettingKey; value: number } {
  const parsed = parseFreePageSetting(key, raw);
  db.prepare(
    `INSERT INTO free_page_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(parsed.key, parsed.value, now.toISOString().replace(/\.\d{3}Z$/, "Z"));
  return parsed;
}

export function unsetFreePageSettingIn(db: DatabaseSync, key: unknown): boolean {
  if (!isFreePageSettingKey(key)) throw new Error(`unknown setting ${String(key)}`);
  return Number(db.prepare(`DELETE FROM free_page_settings WHERE key = ?`).run(key).changes) === 1;
}

type StoreState = { db: DatabaseSync; path: string; persisted: boolean };
let state: StoreState | undefined;

export function defaultFreePageDbPath(): string {
  const fromEnv = process.env.FREE_PAGE_DB_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.FLY_APP_NAME?.trim() && existsSync("/data")) return "/data/free-page.sqlite";
  return resolve(process.cwd(), "data/free-page.sqlite");
}

function open(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  migrateFreePageDaily(db);
  migrateFreePageSettings(db);
  db.exec(SOURCES_TABLE_SQL);
  return db;
}

/** Open an existing counts file for the admin script (never creates one). */
export function openFreePageDbForAdmin(path: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`no free-page database at ${path} (the app creates it on boot)`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  migrateFreePageDaily(db);
  migrateFreePageSettings(db);
  db.exec(SOURCES_TABLE_SQL);
  return db;
}

/** Live settings for this request. Empty when the read fails (defaults apply). */
export function readFreePageSettings(): FreePageSettings {
  try {
    return readFreePageSettingsFrom(db().db);
  } catch {
    return {};
  }
}

export function setFreePageSetting(key: unknown, raw: unknown, now = new Date()): { key: FreePageSettingKey; value: number } {
  return setFreePageSettingIn(db().db, key, raw, now);
}

/** Open the counts file. On failure, counts live in memory for this process. */
export function initFreePageStore(path = defaultFreePageDbPath()): { ok: boolean; path: string; reason?: string } {
  closeFreePageStore();
  try {
    state = { db: open(path), path, persisted: path !== ":memory:" };
    return { ok: true, path };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    state = { db: open(":memory:"), path: ":memory:", persisted: false };
    return { ok: false, path, reason };
  }
}

export function closeFreePageStore(): void {
  if (state) {
    try {
      state.db.close();
    } catch {
      // ignore
    }
  }
  state = undefined;
}

function db(): StoreState {
  if (!state) state = { db: open(":memory:"), path: ":memory:", persisted: false };
  return state;
}

/** Test / audit seam: the raw handle (read-only use). */
export function freePageDbForTests(): DatabaseSync {
  return db().db;
}

const PT_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Pacific calendar day, YYYY-MM-DD. Free limits and counts roll over at midnight PT. */
export function pacificDay(now: Date): string {
  return PT_DAY.format(now);
}

export function bumpFreePageMetric(metric: FreePageMetric, now = new Date()): void {
  try {
    db()
      .db.prepare(
        `INSERT INTO free_page_daily (day, metric, n) VALUES (?, ?, 1)
         ON CONFLICT(day, metric) DO UPDATE SET n = n + 1`,
      )
      .run(pacificDay(now), metric);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[free_page] count failed: ${reason}`);
  }
}

/** Daily source counters (referrer domain, utm/ref, UA class). See free-job-sources.ts. */
export function bumpFreePageSources(event: SourceEvent, values: SourceValues, now = new Date()): void {
  try {
    bumpSourcesIn(db().db, pacificDay(now), event, values);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[free_page] source count failed: ${reason}`);
  }
}

export type FreePageCounts = Record<FreePageMetric, number>;

function emptyCounts(): FreePageCounts {
  const out = {} as FreePageCounts;
  for (const metric of FREE_PAGE_METRICS) out[metric] = 0;
  return out;
}

function sumSince(sinceDay: string | null): FreePageCounts {
  const out = emptyCounts();
  const rows = (
    sinceDay
      ? db().db.prepare(`SELECT metric, SUM(n) AS n FROM free_page_daily WHERE day >= ? GROUP BY metric`).all(sinceDay)
      : db().db.prepare(`SELECT metric, SUM(n) AS n FROM free_page_daily GROUP BY metric`).all()
  ) as Array<{ metric: string; n: number }>;
  for (const row of rows) {
    if ((FREE_PAGE_METRICS as readonly string[]).includes(row.metric)) out[row.metric as FreePageMetric] = Number(row.n);
  }
  return out;
}

export type FreePageStats = {
  ok: true;
  service: "livecheck";
  page: "/job";
  note: string;
  generated_at: string;
  persisted: boolean;
  day_timezone: "America/Los_Angeles";
  today: FreePageCounts;
  l7d: FreePageCounts;
  l30d: FreePageCounts;
  all_time: FreePageCounts;
  by_day: Array<{ day: string } & FreePageCounts>;
  /** Where views and checks came from. Totals only; private view only. */
  sources: {
    note: string;
    /** Per utm_source/ref value: views and checks, e.g. producthunt {views: 412, checks: 1030}. */
    by_source: { today: Record<string, { views: number; checks: number }>; l7d: Record<string, { views: number; checks: number }>; l30d: Record<string, { views: number; checks: number }> };
    today: SourceTotals;
    l7d: SourceTotals;
    l30d: SourceTotals;
  };
};

export function readFreePageStats(now = new Date()): FreePageStats {
  const day = (offset: number) => pacificDay(new Date(now.getTime() - offset * 86_400_000));
  const byDayRows = db()
    .db.prepare(`SELECT day, metric, n FROM free_page_daily WHERE day >= ? ORDER BY day`)
    .all(day(29)) as Array<{ day: string; metric: string; n: number }>;
  const byDay = new Map<string, { day: string } & FreePageCounts>();
  for (const row of byDayRows) {
    let entry = byDay.get(row.day);
    if (!entry) {
      entry = { day: row.day, ...emptyCounts() };
      byDay.set(row.day, entry);
    }
    if ((FREE_PAGE_METRICS as readonly string[]).includes(row.metric)) entry[row.metric as FreePageMetric] = Number(row.n);
  }
  return {
    ok: true,
    service: "livecheck",
    page: "/job",
    note:
      "Free /job page counts only (no wallet, no payment). Not paid calls; not in /stats revenue or buckets. No URLs, IPs, or cookies are stored.",
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    persisted: db().persisted,
    day_timezone: "America/Los_Angeles",
    today: sumSince(day(0)),
    l7d: sumSince(day(6)),
    l30d: sumSince(day(29)),
    all_time: sumSince(null),
    by_day: [...byDay.values()],
    sources: (() => {
      const today = readSourceTotalsFrom(db().db, day(0));
      const l7d = readSourceTotalsFrom(db().db, day(6));
      const l30d = readSourceTotalsFrom(db().db, day(29));
      return {
        note:
          "Daily totals only. referrer = Referer registrable domain (direct/self/other); utm = utm_source or ref, sanitized; ua = browser/bot/agent. Values seen fewer than 2 times in the window show as other, except launch tags (producthunt, linkedin, x, email, test) and their domains. No IPs, URLs, cookies, or per-visit rows.",
        by_source: { today: sourceSummary(today), l7d: sourceSummary(l7d), l30d: sourceSummary(l30d) },
        today,
        l7d,
        l30d,
      };
    })(),
  };
}
