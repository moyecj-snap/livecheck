/**
 * Ops: the refund-candidates list (read-only). Listing only: this never pays,
 * refunds, or changes anything. Craig approves each refund by hand.
 *
 *   npm run --silent refunds:list
 *   npm run --silent refunds:list -- --since 2026-11-04
 *   npm run --silent refunds:list -- --since 2026-11-04T00:00:00Z --json
 *
 * On Fly:
 *   fly ssh console -a livecheck -C "npm run --silent refunds:list -- --since 2026-11-04 --json"
 *
 * Each row: ts, protocol, payment_id (tx), route, reason, payer, amount_usd,
 * http_status, responded_at, settled_at. No URLs are stored.
 * Reasons: settled_after_status_unknown, settle_timeout_unresolved,
 * settle_error_unresolved, settled_no_response_delivered, and the MPP ones
 * (charge_outcome_unknown, handler_status_<n>, handler_threw).
 *
 * Options: --db <path> (default PAID_CALL_DB_PATH, else /data/paid-calls.sqlite
 * on Fly), --since <YYYY-MM-DD | ISO>, --json. Opens the DB read-only and
 * never creates one. Run as root (fly ssh default), it switches to the DB
 * file's owner first.
 */
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { defaultPaidCallDbPath, listRefundCandidates, paidCallStoreTableColumns } from "../src/paid-call-store.js";

const USAGE = `usage:
  refunds:list [-- --since <YYYY-MM-DD | ISO>] [--json] [--db <path>]`;

function fail(message: string): never {
  console.error(`refunds: ${message}\n${USAGE}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
let json = false;
let dbPath: string | undefined;
let since: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "list") continue;
  if (arg === "--json") {
    json = true;
    continue;
  }
  if (arg === "--db") {
    dbPath = argv[++i];
    if (!dbPath) fail("--db needs a path");
    continue;
  }
  if (arg === "--since") {
    const value = argv[++i];
    if (!value) fail("--since needs a date");
    if (/^\d{4}-\d\d-\d\d$/.test(value)) since = `${value}T00:00:00Z`;
    else if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) since = value;
    else fail("--since must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ");
    continue;
  }
  fail(`unknown argument: ${arg}`);
}

const path = dbPath ?? defaultPaidCallDbPath();
if (!existsSync(path)) fail(`no paid-calls database at ${path} (pass --db)`);

if (typeof process.getuid === "function" && process.getuid() === 0) {
  const owner = statSync(path);
  if (owner.uid !== 0 && process.setgid && process.setuid) {
    process.setgid(owner.gid);
    process.setuid(owner.uid);
  }
}

const db = new DatabaseSync(path, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout = 5000;");
  const columns = paidCallStoreTableColumns(db, "refund_candidates");
  if (columns.size > 0 && !columns.has("settled_at")) {
    fail("refund_candidates is missing the new columns; the app adds them on boot after deploy");
  }
  const rows = columns.size === 0 ? [] : listRefundCandidates(db, since);
  if (json) {
    console.log(JSON.stringify({ since: since ?? null, count: rows.length, candidates: rows }, null, 2));
  } else if (rows.length === 0) {
    console.log(`refund_candidates: none${since ? ` since ${since}` : ""}`);
  } else {
    console.log(`refund_candidates: ${rows.length}${since ? ` since ${since}` : ""}`);
    for (const row of rows) {
      console.log(
        [
          row.ts,
          row.protocol,
          row.route,
          row.reason,
          `payer=${row.payer ?? "-"}`,
          `amount_usd=${row.amount_usd ?? "-"}`,
          `tx=${row.payment_id ?? "-"}`,
          `responded_at=${row.responded_at ?? "-"}`,
          `settled_at=${row.settled_at ?? "-"}`,
        ].join("  "),
      );
    }
  }
} finally {
  db.close();
}
