/**
 * Read-only re-check of stored Confirm verdicts that were `confirmed`.
 * Does not update receipts or paid_calls.
 *
 *   npm run recheck:confirm-receipts
 *   npm run recheck:confirm-receipts -- --json
 *   npm run recheck:confirm-receipts -- --db /data/paid-calls.sqlite --receipts /data/receipts.sqlite
 *
 * Run on each Fly machine:
 *   fly ssh console -a livecheck --machine <id> -C "npm run recheck:confirm-receipts"
 */
import { defaultPaidCallDbPath } from "../src/paid-call-store.js";
import { defaultReceiptDbPath } from "../src/receipt-store.js";
import { formatRecheckTable, recheckConfirmReceipts } from "../src/recheck-confirm-receipts.js";

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const report = await recheckConfirmReceipts({
  paidCallDbPath: argValue("--db") ?? defaultPaidCallDbPath(),
  receiptDbPath: argValue("--receipts") ?? defaultReceiptDbPath(),
});

if (argFlag("--json")) {
  console.log(JSON.stringify(report));
} else {
  console.log(formatRecheckTable(report));
}
