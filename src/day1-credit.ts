import type { DatabaseSync } from "node:sqlite";

/**
 * Day-1 Sentinel watcher that burned checks on fetch failures (LIVE↔530 flaps).
 * Craig, Sep 29 2026: credit ~690 checks back if the row still exists.
 * The measured run was 693 consecutive failures; the applied credit is 690.
 */
export const DAY1_WATCHER_ID = "wtc_01M3AW4EX4JXJCQG8PTB7GE7W1";
export const DAY1_FAILED_CHECK_CREDIT = 690;
export const DAY1_CREDIT_KEY = "day1-failed-checks:wtc_01M3AW4EX4JXJCQG8PTB7GE7W1";

export type Day1CreditResult = {
  watcher_id: string;
  credit: number;
  applied: boolean;
  reason: "applied" | "already_applied" | "watcher_missing";
  checks_remaining: number | null;
  previous_checks_remaining: number | null;
};

function result(
  partial: Pick<Day1CreditResult, "applied" | "reason" | "checks_remaining" | "previous_checks_remaining">,
): Day1CreditResult {
  return {
    watcher_id: DAY1_WATCHER_ID,
    credit: DAY1_FAILED_CHECK_CREDIT,
    ...partial,
  };
}

/**
 * Idempotent one-shot. Adds {@link DAY1_FAILED_CHECK_CREDIT} to checks_remaining
 * when the Day-1 watcher row is present and this key has not been applied.
 * A missing row is not marked applied, so a later restore of the volume still credits.
 * Does not invent a watcher, change status, or move expires_at.
 */
export function applyDay1FailedCheckCredit(db: DatabaseSync, nowIso?: string): Day1CreditResult {
  db.exec(`CREATE TABLE IF NOT EXISTS watch_ops_applied (
    key TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    detail TEXT
  )`);

  const existing = db.prepare(`SELECT key FROM watch_ops_applied WHERE key = ?`).get(DAY1_CREDIT_KEY) as
    | { key?: string }
    | undefined;
  const row = db.prepare(`SELECT checks_remaining FROM watchers WHERE id = ?`).get(DAY1_WATCHER_ID) as
    | { checks_remaining?: number | bigint }
    | undefined;
  const current = row?.checks_remaining == null ? null : Number(row.checks_remaining);

  if (existing?.key) {
    return result({
      applied: false,
      reason: "already_applied",
      checks_remaining: current,
      previous_checks_remaining: null,
    });
  }
  if (current == null) {
    return result({
      applied: false,
      reason: "watcher_missing",
      checks_remaining: null,
      previous_checks_remaining: null,
    });
  }

  const next = current + DAY1_FAILED_CHECK_CREDIT;
  const appliedAt = nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE watchers SET checks_remaining = ? WHERE id = ?`).run(next, DAY1_WATCHER_ID);
    db.prepare(`INSERT INTO watch_ops_applied (key, applied_at, detail) VALUES (?, ?, ?)`).run(
      DAY1_CREDIT_KEY,
      appliedAt,
      `credited ${DAY1_FAILED_CHECK_CREDIT} failed checks; previous=${current}; next=${next}`,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(`[watch] day-1 credit: ${DAY1_WATCHER_ID} checks_remaining ${current} -> ${next}`);
  return result({
    applied: true,
    reason: "applied",
    checks_remaining: next,
    previous_checks_remaining: current,
  });
}
