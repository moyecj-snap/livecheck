#!/usr/bin/env npx tsx
/**
 * One-shot Day-1 credit for wtc_01M3AW4EX4JXJCQG8PTB7GE7W1 (+690 checks).
 *
 * The watcher burned ~690 checks on fetch failures (measured: 693 consecutive
 * failures, median gap ~301s, no back-off). Craig, Sep 29 2026.
 *
 * Opening the watch store applies the same credit idempotently. Run this
 * against the Fly volume when you need the outcome in hand:
 *
 *   WATCH_DB_PATH=/data/watchers.sqlite npm run watch:credit-day1
 *
 * If the row is already gone, this prints watcher_missing / database_missing
 * and does not invent a watcher. A later restore of the volume still credits
 * on the next store open, because a missing row is not marked applied.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DAY1_FAILED_CHECK_CREDIT, DAY1_WATCHER_ID } from "../src/day1-credit.js";
import { defaultWatchDbPath, migrateWatchStore } from "../src/watch-store.js";

const path = process.argv[2]?.trim() || process.env.WATCH_DB_PATH?.trim() || defaultWatchDbPath();

if (!existsSync(path)) {
  process.stdout.write(
    `${JSON.stringify({
      path,
      watcher_id: DAY1_WATCHER_ID,
      credit: DAY1_FAILED_CHECK_CREDIT,
      applied: false,
      reason: "database_missing",
      note: "No watchers.sqlite at this path. If the Day-1 watcher was deleted, there is nothing to credit.",
    })}\n`,
  );
  process.exit(0);
}

const db = new DatabaseSync(path);
try {
  const result = migrateWatchStore(db);
  process.stdout.write(`${JSON.stringify({ path, ...result })}\n`);
} finally {
  db.close();
}
