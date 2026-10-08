import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
] as const;

export type FreePageMetric = (typeof FREE_PAGE_METRICS)[number];

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS free_page_daily (
  day TEXT NOT NULL CHECK (length(day) = 10),
  metric TEXT NOT NULL CHECK (metric IN (${FREE_PAGE_METRICS.map((m) => `'${m}'`).join(", ")})),
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, metric)
);
`;

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
  db.exec(TABLE_SQL);
  return db;
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
  };
}
