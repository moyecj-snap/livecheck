import { ageBucket, type PostingAge } from "./posting-age.js";

/**
 * Board-audit age table (Nov 3, 2026 scope). For a sample of a board's
 * listings: how many have a usable posted date, the age distribution, and
 * the share at 30+, 60+, and 90+ days (age_days >= N), plus how many are closed in each bucket.
 *
 * Every number goes out with the check date and sample size. Percentages of
 * the age distribution are over dated rows only, so they add up to 100%.
 * Undated rows and Workday "30+" lower-bound rows are counted on their own
 * and never folded into a bucket.
 */

export const AUDIT_BUCKETS = ["0-7", "8-30", "31-60", "61-90", "90+"] as const;
export type AuditBucket = (typeof AUDIT_BUCKETS)[number];

export type AgeAuditRow = { url?: string; status: string; age?: PostingAge | null };

export type AgeAuditSummary = {
  checked_on: string;
  sample_size: number;
  dated: number;
  dated_pct: number;
  /** Only a lower bound is known (Workday "Posted 30+ Days Ago"). */
  lower_bound_only: number;
  undated: number;
  buckets: Record<AuditBucket, { count: number; pct: number; closed: number; closed_pct: number }>;
  /** Over dated rows: age_days >= N ("60 and up"). */
  days_30_plus: { label: "30+ days"; count: number; pct: number };
  days_60_plus: { label: "60+ days"; count: number; pct: number };
  days_90_plus: { label: "90+ days"; count: number; pct: number };
  label: string;
};

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

export function summarizeAges(rows: readonly AgeAuditRow[], options: { checkedOn: string; board?: string }): AgeAuditSummary {
  const buckets = Object.fromEntries(
    AUDIT_BUCKETS.map((bucket) => [bucket, { count: 0, pct: 0, closed: 0, closed_pct: 0 }]),
  ) as AgeAuditSummary["buckets"];
  let dated = 0;
  let lowerBound = 0;
  let undated = 0;
  const over = { 30: 0, 60: 0, 90: 0 };
  for (const row of rows) {
    const age = row.age;
    if (age && age.age_days !== null && (age.age_precision === "exact" || age.age_precision === "day")) {
      dated += 1;
      const bucket = buckets[ageBucket(age.age_days)];
      bucket.count += 1;
      if (row.status === "closed") bucket.closed += 1;
      if (age.age_days >= 30) over[30] += 1;
      if (age.age_days >= 60) over[60] += 1;
      if (age.age_days >= 90) over[90] += 1;
    } else if (age && age.age_precision === "at_least") {
      lowerBound += 1;
    } else {
      undated += 1;
    }
  }
  for (const bucket of AUDIT_BUCKETS) {
    const b = buckets[bucket];
    b.pct = pct(b.count, dated);
    b.closed_pct = pct(b.closed, b.count);
  }
  const n = rows.length;
  const who = options.board ? `${options.board}, ` : "";
  return {
    checked_on: options.checkedOn,
    sample_size: n,
    dated,
    dated_pct: pct(dated, n),
    lower_bound_only: lowerBound,
    undated,
    buckets,
    days_30_plus: { label: "30+ days", count: over[30], pct: pct(over[30], dated) },
    days_60_plus: { label: "60+ days", count: over[60], pct: pct(over[60], dated) },
    days_90_plus: { label: "90+ days", count: over[90], pct: pct(over[90], dated) },
    label: `${who}${options.checkedOn}, ${n} listings checked, ${dated} with a posted date from the hiring platform or the page`,
  };
}

export const AGE_AUDIT_CSV_COLUMNS = [
  "url",
  "status",
  "posted_at",
  "age_days",
  "age_days_min",
  "age_source",
  "age_precision",
  "age_bucket",
  "stale_age",
  "stale_after_days",
  "last_updated_at",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function ageAuditCsv(rows: readonly AgeAuditRow[]): string {
  const lines = [AGE_AUDIT_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const age = row.age;
    lines.push(
      [
        row.url,
        row.status,
        age?.posted_at,
        age?.age_days,
        age?.age_days_min,
        age?.age_source ?? "none",
        age?.age_precision ?? "unknown",
        age?.age_bucket ?? "unknown",
        age?.stale_age,
        age?.stale_after_days,
        age?.last_updated_at,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
