import type { DatabaseSync } from "node:sqlite";

/**
 * Where free /job traffic comes from: DAILY TOTALS ONLY.
 *
 * One counter per (Pacific day, event, dimension, value). No IP, no cookie,
 * no per-visit row, no full URL, no checked link. Every value is reduced
 * before it reaches SQLite:
 *   - referrer: the Referer host only, folded to its registrable domain
 *     (jobs.example.co.uk -> example.co.uk). Never a path or query.
 *     "direct" when absent, "self" for our own pages, "other" when odd.
 *   - utm: utm_source (else ref), lowercase, [a-z0-9._-] only, <= 40 chars,
 *     anything else "other"; "none" when absent. No ':' or '/', so a URL
 *     cannot be stored.
 *   - ua: browser | bot | agent.
 * Per day, each (event, dimension) keeps at most SOURCE_DISTINCT_CAP values;
 * past that, new values count as "other". The private report also folds
 * values seen fewer than SOURCE_REPORT_MIN_COUNT times in the window into
 * "other", so one-off tokens are not shown.
 */
export const SOURCE_EVENTS = ["view", "check"] as const;
export const SOURCE_DIMENSIONS = ["referrer", "utm", "ua"] as const;
export type SourceEvent = (typeof SOURCE_EVENTS)[number];
export type SourceDimension = (typeof SOURCE_DIMENSIONS)[number];
export type UaClass = "browser" | "bot" | "agent";

export const SOURCE_DISTINCT_CAP = 50;

/**
 * Craig's launch tags (utm_source / ref) and their referrer domains. These are
 * always counted under their own name: never folded into "other" in the
 * report and never pushed out by the daily distinct cap. "test" is here so a
 * single deploy check is visible.
 */
export const LAUNCH_UTM_TAGS = ["producthunt", "linkedin", "x", "email", "test"] as const;
export const LAUNCH_REFERRER_DOMAINS = ["producthunt.com", "linkedin.com", "x.com", "t.co"] as const;
const ALWAYS_SHOWN: Record<SourceDimension, ReadonlySet<string>> = {
  referrer: new Set(LAUNCH_REFERRER_DOMAINS),
  utm: new Set(LAUNCH_UTM_TAGS),
  ua: new Set(["browser", "bot", "agent"]),
};
export const SOURCE_REPORT_MIN_COUNT = 2;
export const UTM_MAX_LENGTH = 40;
const DOMAIN_MAX_LENGTH = 60;

export const SOURCES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS free_page_sources (
  day TEXT NOT NULL CHECK (length(day) = 10),
  event TEXT NOT NULL CHECK (event IN (${SOURCE_EVENTS.map((e) => `'${e}'`).join(", ")})),
  dimension TEXT NOT NULL CHECK (dimension IN (${SOURCE_DIMENSIONS.map((d) => `'${d}'`).join(", ")})),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND ${DOMAIN_MAX_LENGTH}),
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, event, dimension, value)
);
`;

const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.in", "net.in", "org.in",
  "com.br", "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.cn", "com.tw",
  "co.za", "co.kr", "co.il", "com.my", "com.ph", "com.vn", "co.id",
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Registrable domain (approximate eTLD+1) of a hostname, or undefined if odd. */
export function registrableDomain(hostname: string): string | undefined {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return undefined;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return undefined; // IP literal
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;
  if (!/^[a-z]{2,24}$/.test(labels.at(-1)!) && !labels.at(-1)!.startsWith("xn--")) return undefined;
  const lastTwo = labels.slice(-2).join(".");
  const domain = TWO_PART_SUFFIXES.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join(".") : lastTwo;
  return domain.length <= DOMAIN_MAX_LENGTH ? domain : undefined;
}

/** Referer header -> "direct" | "self" | registrable domain | "other". Host only. */
export function referrerSource(referer: string | null | undefined, selfHosts: readonly string[] = []): string {
  const raw = (referer ?? "").trim();
  if (!raw) return "direct";
  let host: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "other";
    host = url.hostname;
  } catch {
    return "other";
  }
  const domain = registrableDomain(host);
  if (!domain) return "other";
  const self = selfHosts.map((h) => registrableDomain(h.replace(/:\d+$/, "")) ?? h.toLowerCase());
  if (self.includes(domain) || selfHosts.some((h) => h.replace(/:\d+$/, "").toLowerCase() === host.toLowerCase())) {
    return "self";
  }
  return domain;
}

const UTM_OK = new RegExp(`^[a-z0-9][a-z0-9._-]{0,${UTM_MAX_LENGTH - 1}}$`);
const RESERVED_VALUES = new Set(["none", "direct", "self", "other"]);

/** utm_source / ref value -> sanitized token, "none" when absent, "other" when odd. */
export function utmSource(value: string | null | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "none";
  if (raw.length > UTM_MAX_LENGTH || !UTM_OK.test(raw)) return "other";
  // Domain-looking values are allowed (e.g. "news.ycombinator.com") but must
  // not look like a link or carry an address.
  if (raw.includes("..") || raw.startsWith("www.") || /\d{6,}/.test(raw)) return "other";
  return RESERVED_VALUES.has(raw) ? "other" : raw;
}

/** Software acting for a person or a script: AI assistants fetching on request, automation, HTTP libraries. */
const AGENT_UA =
  /(chatgpt-user|claude-user|claude-web|perplexity-user|mistralai-user|gemini-user|copilot|\bagent\b|\bmcp\b|headless|playwright|puppeteer|selenium|phantomjs|curl\/|wget\/|python|httpx|aiohttp|node-fetch|undici|axios|okhttp|go-http-client|java\/|libwww|ruby|deno\/|bun\/)/i;
/** Crawlers, link unfurlers, monitors. */
const BOT_UA =
  /(bot\b|bot\/|bot;|crawler|spider|slurp|facebookexternalhit|embedly|preview|unfurl|monitor|uptime|pingdom|validator|scanner|feedfetcher|whatsapp|telegram|discord)/i;

/** Rough class only: the UA string itself is never stored. Agent markers win over bot, bot over browser. */
export function uaClass(userAgent: string | null | undefined): UaClass {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "agent";
  if (AGENT_UA.test(ua)) return "agent";
  if (BOT_UA.test(ua)) return "bot";
  if (/^mozilla\/5\.0 \(/i.test(ua) && /(applewebkit|gecko|trident)/i.test(ua)) return "browser";
  return "agent";
}

export type SourceValues = { referrer: string; utm: string; ua: UaClass };

/**
 * Add one to each dimension. New values past the per-day distinct cap are
 * counted as "other". Synchronous transaction: no interleaving.
 */
export function bumpSourcesIn(db: DatabaseSync, day: string, event: SourceEvent, values: SourceValues): void {
  const countDistinct = db.prepare(
    `SELECT COUNT(*) AS n FROM free_page_sources WHERE day = ? AND event = ? AND dimension = ? AND value != 'other'
       AND value NOT IN (${[...LAUNCH_UTM_TAGS, ...LAUNCH_REFERRER_DOMAINS].map((v) => `'${v}'`).join(", ")})`,
  );
  const exists = db.prepare(
    `SELECT 1 AS hit FROM free_page_sources WHERE day = ? AND event = ? AND dimension = ? AND value = ?`,
  );
  const bump = db.prepare(
    `INSERT INTO free_page_sources (day, event, dimension, value, n) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(day, event, dimension, value) DO UPDATE SET n = n + 1`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const dimension of SOURCE_DIMENSIONS) {
      let value: string = values[dimension];
      if (!value || value.length > DOMAIN_MAX_LENGTH) value = "other";
      if (value !== "other" && !ALWAYS_SHOWN[dimension].has(value) && !exists.get(day, event, dimension, value)) {
        const distinct = Number((countDistinct.get(day, event, dimension) as { n: number | bigint }).n);
        if (distinct >= SOURCE_DISTINCT_CAP) value = "other";
      }
      bump.run(day, event, dimension, value);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw error;
  }
}

export type SourceTotals = Record<SourceEvent, Record<SourceDimension, Record<string, number>>>;

function emptyTotals(): SourceTotals {
  const out = {} as SourceTotals;
  for (const event of SOURCE_EVENTS) {
    out[event] = { referrer: {}, utm: {}, ua: {} };
  }
  return out;
}

/** Totals since `sinceDay` (inclusive), rare values folded into "other", sorted by count. */
export function readSourceTotalsFrom(db: DatabaseSync, sinceDay: string | null): SourceTotals {
  const rows = (
    sinceDay
      ? db
          .prepare(`SELECT event, dimension, value, SUM(n) AS n FROM free_page_sources WHERE day >= ? GROUP BY event, dimension, value`)
          .all(sinceDay)
      : db.prepare(`SELECT event, dimension, value, SUM(n) AS n FROM free_page_sources GROUP BY event, dimension, value`).all()
  ) as Array<{ event: string; dimension: string; value: string; n: number | bigint }>;
  const out = emptyTotals();
  for (const row of rows) {
    if (!(SOURCE_EVENTS as readonly string[]).includes(row.event)) continue;
    if (!(SOURCE_DIMENSIONS as readonly string[]).includes(row.dimension)) continue;
    const bucket = out[row.event as SourceEvent][row.dimension as SourceDimension];
    const n = Number(row.n);
    const keep =
      ALWAYS_SHOWN[row.dimension as SourceDimension].has(row.value) ||
      RESERVED_VALUES.has(row.value) ||
      n >= SOURCE_REPORT_MIN_COUNT;
    const key = keep ? row.value : "other";
    bucket[key] = (bucket[key] ?? 0) + n;
  }
  for (const event of SOURCE_EVENTS) {
    for (const dimension of SOURCE_DIMENSIONS) {
      const sorted = Object.entries(out[event][dimension]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      out[event][dimension] = Object.fromEntries(sorted);
    }
  }
  return out;
}

/** "producthunt: 412 views, 1030 checks": one line per utm_source/ref value, from the folded totals. */
export function sourceSummary(totals: SourceTotals): Record<string, { views: number; checks: number }> {
  const out: Record<string, { views: number; checks: number }> = {};
  for (const [value, n] of Object.entries(totals.view.utm)) (out[value] ??= { views: 0, checks: 0 }).views += n;
  for (const [value, n] of Object.entries(totals.check.utm)) (out[value] ??= { views: 0, checks: 0 }).checks += n;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].views + b[1].checks - (a[1].views + a[1].checks) || a[0].localeCompare(b[0])));
}
