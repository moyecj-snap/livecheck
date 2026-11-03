/**
 * Posting age for job checks (Nov 3, 2026 scope, approved by Craig).
 *
 * Age is context, not evidence. HARD RULE: nothing in this module may change
 * a verdict's `status` or `confidence`. `attachAge` only adds the `age`
 * object (and an `age_conflict` signal when two sources disagree).
 *
 * - Never use a "last updated" date as the posted date (Greenhouse
 *   `updated_at` moves on every edit; Bitwarden showed Nov 3 for a job first
 *   published Sep 25). If that is the only date, `posted_at` is null,
 *   `age_source` is "none", and the date goes in `last_updated_at`.
 * - Unknown is reported as unknown. Never infer an age, never default to fresh.
 * - Age counts from the date the ATS reports. A job closed and reposted
 *   under a new id looks new, so true age is >= age_days.
 */

export const DEFAULT_STALE_AFTER_DAYS = 60;
export const MIN_STALE_AFTER_DAYS = 7;
export const MAX_STALE_AFTER_DAYS = 365;

/** Signal added when the ATS date and the page's JSON-LD datePosted differ by more than 2 days. The ATS date wins. */
export const AGE_CONFLICT_SIGNAL = "age_conflict";

const DAY_MS = 86_400_000;
const CONFLICT_DAYS = 2;
const MAX_FUTURE_SKEW_MS = DAY_MS;
const MIN_YEAR = 2000;

export type AgeSource =
  | "greenhouse.first_published"
  | "greenhouse.published_at"
  | "ashby.publishedAt"
  | "lever.createdAt"
  | "workday.startDate"
  | "jsonld.datePosted"
  | "workday.postedOn_text"
  | "none";

/** exact: a timestamp. day: a calendar date (or Workday's "Posted N Days Ago"). at_least: a lower bound only ("30+"). */
export type AgePrecision = "exact" | "day" | "at_least" | "unknown";

export type AgeBucket = "0-7" | "8-30" | "31-60" | "61-90" | "90+" | "30+" | "unknown";

/** Neutral note for a live posting 30 to 59 days old. */
export function noteForAge30to59(days: number | string): string {
  return `Posted ${days} days ago. Still open on the employer's site. Most applications come in during a posting's first few days.`;
}

/** Neutral note for a live posting 60 days old and up (Craig, Nov 3, 2026: "60 and up"). */
export const AGE_NOTE_OVER_60 =
  "Posted over 60 days ago and still listed. Roles this old may already be in final interviews or quietly filled. If you apply, also reach out to the team directly.";

export type PostingAge = {
  posted_at: string | null;
  age_days: number | null;
  /** Only with age_precision "at_least" (Workday "Posted 30+ Days Ago"). */
  age_days_min?: number;
  age_source: AgeSource;
  age_precision: AgePrecision;
  age_bucket: AgeBucket;
  /** age_days >= stale_after_days ("60 and up" at the default). null when the age is unknown or only a lower bound that does not decide it. */
  stale_age: boolean | null;
  stale_after_days: number;
  /** A "last updated" date from the ATS. Never used as the posted date. */
  last_updated_at?: string;
  /** Plain-words note on a live posting 30+ days old. */
  note?: string;
};

/**
 * Date evidence read from one ATS response. `postedAt` here is a true
 * first-posted date (never updated_at). Text-only Workday ages carry days.
 */
export type AgeEvidence = {
  source: AgeSource;
  postedAt?: string;
  precision: AgePrecision;
  /** Workday postedOn text: days ago (exact day count) or a lower bound. */
  daysAgo?: number;
  atLeastDays?: number;
  lastUpdatedAt?: string;
};

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Parse a date for age. Accepts ISO date (YYYY-MM-DD → day precision),
 * ISO date-time (exact), or epoch seconds/ms (exact). Drops dates before
 * 2000, and (when `now` is given) dates more than one day in the future.
 */
export function parseAgeDate(
  value: unknown,
  now?: Date,
): { iso: string; precision: "exact" | "day" } | undefined {
  let date: Date;
  let precision: "exact" | "day" = "exact";
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value > 0 && value < 1e12 ? value * 1000 : value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly) {
      precision = "day";
      date = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
      // Reject 2026-02-31 style dates that Date.UTC rolls over.
      if (date.getUTCDate() !== Number(dateOnly[3])) return undefined;
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
      date = new Date(trimmed);
    } else {
      return undefined;
    }
  } else {
    return undefined;
  }
  const ms = date.getTime();
  if (Number.isNaN(ms)) return undefined;
  if (date.getUTCFullYear() < MIN_YEAR) return undefined;
  if (now && ms - now.getTime() > MAX_FUTURE_SKEW_MS) return undefined;
  return { iso: precision === "day" ? isoSeconds(date).slice(0, 10) : isoSeconds(date), precision };
}

/**
 * Workday CXS `postedOn` is text: "Posted Today", "Posted Yesterday",
 * "Posted 5 Days Ago", "Posted 30+ Days Ago".
 */
export function parseWorkdayPostedOn(text: unknown): { daysAgo?: number; atLeastDays?: number } | undefined {
  if (typeof text !== "string") return undefined;
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(posted )?today$/.test(t)) return { daysAgo: 0 };
  if (/^(posted )?yesterday$/.test(t)) return { daysAgo: 1 };
  const plus = /^(posted )?(\d{1,3})\+ days? ago$/.exec(t);
  if (plus) return { atLeastDays: Number(plus[2]) };
  const days = /^(posted )?(\d{1,3}) days? ago$/.exec(t);
  if (days) return { daysAgo: Number(days[2]) };
  return undefined;
}

/** Greenhouse: first_published, then published_at. updated_at is kept apart and never used as posted. */
export function greenhouseAgeEvidence(row: Record<string, unknown>, now?: Date): AgeEvidence {
  const updated = parseAgeDate(row.updated_at, now);
  const lastUpdatedAt = updated ? { lastUpdatedAt: updated.iso } : {};
  for (const [field, source] of [
    ["first_published", "greenhouse.first_published"],
    ["published_at", "greenhouse.published_at"],
  ] as const) {
    const parsed = parseAgeDate(row[field], now);
    if (parsed) return { source, postedAt: parsed.iso, precision: parsed.precision, ...lastUpdatedAt };
  }
  return { source: "none", precision: "unknown", ...lastUpdatedAt };
}

export function simpleAgeEvidence(source: Exclude<AgeSource, "none" | "workday.postedOn_text">, value: unknown, now?: Date): AgeEvidence {
  const parsed = parseAgeDate(value, now);
  if (!parsed) return { source: "none", precision: "unknown" };
  return { source, postedAt: parsed.iso, precision: parsed.precision };
}

/** Workday: startDate (ISO), else postedOn text. */
export function workdayAgeEvidence(info: Record<string, unknown>, now?: Date): AgeEvidence {
  const start = parseAgeDate(info.startDate, now) ?? parseAgeDate(info.postedDate, now);
  if (start) return { source: "workday.startDate", postedAt: start.iso, precision: start.precision };
  const text = parseWorkdayPostedOn(info.postedOn);
  if (text?.daysAgo !== undefined) return { source: "workday.postedOn_text", precision: "day", daysAgo: text.daysAgo };
  if (text?.atLeastDays !== undefined) {
    return { source: "workday.postedOn_text", precision: "at_least", atLeastDays: text.atLeastDays };
  }
  return { source: "none", precision: "unknown" };
}

type JsonLdNode = Record<string, unknown>;

function jsonLdNodes(value: unknown, out: JsonLdNode[], depth = 0): void {
  if (depth > 6 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) jsonLdNodes(item, out, depth + 1);
    return;
  }
  const node = value as JsonLdNode;
  out.push(node);
  if (node["@graph"]) jsonLdNodes(node["@graph"], out, depth + 1);
}

function isJobPosting(node: JsonLdNode): boolean {
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => typeof item === "string" && item.toLowerCase() === "jobposting");
}

/** First schema.org JobPosting in the page's JSON-LD, or undefined. Age only; never a verdict input. */
export function jsonLdJobPosting(html: string): { datePosted?: unknown } | undefined {
  const scripts = html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const nodes: JsonLdNode[] = [];
    jsonLdNodes(parsed, nodes);
    const posting = nodes.find(isJobPosting);
    if (posting) return { datePosted: posting.datePosted };
  }
  return undefined;
}

export function clampStaleAfterDays(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_STALE_AFTER_DAYS;
  return Math.min(MAX_STALE_AFTER_DAYS, Math.max(MIN_STALE_AFTER_DAYS, Math.round(n)));
}

export function ageBucket(days: number): Exclude<AgeBucket, "30+" | "unknown"> {
  if (days <= 7) return "0-7";
  if (days <= 30) return "8-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

function daysSince(posted: string, precision: "exact" | "day", now: Date): number {
  const nowMs = now.getTime();
  if (precision === "day") return Math.max(0, utcDay(nowMs) - utcDay(Date.parse(`${posted}T00:00:00Z`)));
  return Math.max(0, Math.floor((nowMs - Date.parse(posted)) / DAY_MS));
}

export function unknownAge(staleAfterDays = DEFAULT_STALE_AFTER_DAYS, lastUpdatedAt?: string): PostingAge {
  return {
    posted_at: null,
    age_days: null,
    age_source: "none",
    age_precision: "unknown",
    age_bucket: "unknown",
    stale_age: null,
    stale_after_days: staleAfterDays,
    ...(lastUpdatedAt ? { last_updated_at: lastUpdatedAt } : {}),
  };
}

function noteFor(status: string, days: number | undefined, atLeast: number | undefined): string | undefined {
  if (status !== "live") return undefined;
  if (days !== undefined) {
    if (days >= 60) return AGE_NOTE_OVER_60;
    if (days >= 30) return noteForAge30to59(days);
    return undefined;
  }
  if (atLeast !== undefined) {
    if (atLeast >= 60) return AGE_NOTE_OVER_60;
    if (atLeast >= 30) return noteForAge30to59(`${atLeast}+`);
  }
  return undefined;
}

/** Build the `age` object from one piece of evidence. */
export function buildPostingAge(
  evidence: AgeEvidence | undefined,
  now: Date,
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
  status = "unknown",
): PostingAge {
  if (!evidence || evidence.source === "none") return unknownAge(staleAfterDays, evidence?.lastUpdatedAt);
  const extra = evidence.lastUpdatedAt ? { last_updated_at: evidence.lastUpdatedAt } : {};
  if (evidence.precision === "at_least" && evidence.atLeastDays !== undefined) {
    const min = evidence.atLeastDays;
    const note = noteFor(status, undefined, min);
    return {
      posted_at: null,
      age_days: null,
      age_days_min: min,
      age_source: evidence.source,
      age_precision: "at_least",
      age_bucket: min > 90 ? "90+" : min === 30 ? "30+" : ageBucket(min),
      stale_age: min >= staleAfterDays ? true : null,
      stale_after_days: staleAfterDays,
      ...extra,
      ...(note ? { note } : {}),
    };
  }
  let days: number;
  let postedAt: string;
  if (evidence.daysAgo !== undefined) {
    days = evidence.daysAgo;
    postedAt = new Date((utcDay(now.getTime()) - days) * DAY_MS).toISOString().slice(0, 10);
  } else if (evidence.postedAt && (evidence.precision === "exact" || evidence.precision === "day")) {
    // Sanity at answer time: a date more than a day ahead of now is dropped.
    if (!parseAgeDate(evidence.postedAt, now)) return unknownAge(staleAfterDays, evidence.lastUpdatedAt);
    postedAt = evidence.postedAt;
    days = daysSince(postedAt, evidence.precision, now);
  } else {
    return unknownAge(staleAfterDays, evidence.lastUpdatedAt);
  }
  const note = noteFor(status, days, undefined);
  return {
    posted_at: postedAt,
    age_days: days,
    age_source: evidence.source,
    age_precision: evidence.daysAgo !== undefined ? "day" : (evidence.precision as "exact" | "day"),
    age_bucket: ageBucket(days),
    stale_age: days >= staleAfterDays,
    stale_after_days: staleAfterDays,
    ...extra,
    ...(note ? { note } : {}),
  };
}

/**
 * Pick the age from ATS evidence and the page's JSON-LD datePosted.
 * The ATS wins. JSON-LD is used only when the ATS gave no posted date.
 * Returns the age and whether the two disagreed by more than 2 days.
 */
export function resolvePostingAge(input: {
  ats?: AgeEvidence;
  jsonLdDatePosted?: unknown;
  now: Date;
  staleAfterDays?: number;
  status: string;
}): { age: PostingAge; conflict: boolean } {
  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const jsonLd =
    input.jsonLdDatePosted === undefined ? undefined : simpleAgeEvidence("jsonld.datePosted", input.jsonLdDatePosted, input.now);
  const atsAge = input.ats && input.ats.source !== "none" ? buildPostingAge(input.ats, input.now, staleAfterDays, input.status) : undefined;
  if (atsAge && atsAge.age_source !== "none") {
    const age = atsAge;
    let conflict = false;
    if (jsonLd && jsonLd.source !== "none" && age.age_days !== null) {
      const ldDays = buildPostingAge(jsonLd, input.now, staleAfterDays, input.status).age_days;
      if (ldDays !== null && Math.abs(ldDays - age.age_days) > CONFLICT_DAYS) conflict = true;
    }
    return { age, conflict };
  }
  if (jsonLd && jsonLd.source !== "none") {
    const age = buildPostingAge({ ...jsonLd, ...(input.ats?.lastUpdatedAt ? { lastUpdatedAt: input.ats.lastUpdatedAt } : {}) }, input.now, staleAfterDays, input.status);
    return { age, conflict: false };
  }
  return { age: unknownAge(staleAfterDays, input.ats?.lastUpdatedAt), conflict: false };
}
