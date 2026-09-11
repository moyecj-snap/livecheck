/**
 * Ops: compare confirm paid_calls vs receipts on this volume, and optionally
 * copy intent/verdict from livecheck.paid_call logs onto unscoped paid_calls.
 *
 * Cannot reconstruct signed receipts. See RECEIPT_RECONSTRUCTION_IMPOSSIBLE.
 *
 *   npm run receipt:backfill
 *   npm run receipt:backfill -- --json
 *   fly logs -a livecheck | npm run receipt:backfill -- --from-logs
 *
 * Dual-volume — run on each machine:
 *   fly machines list -a livecheck
 *   fly ssh console -a livecheck --machine <id> -C "npm run receipt:backfill -- --json"
 */
import { readFileSync } from "node:fs";
import { runReceiptBackfill } from "../src/receipt-backfill.js";
import { defaultPaidCallDbPath } from "../src/paid-call-store.js";
import { defaultReceiptDbPath } from "../src/receipt-store.js";
import { dualMachineCosHelp } from "../src/receipt-rescue.js";

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  if (argFlag("--machines-help")) {
    console.log(dualMachineCosHelp());
    return;
  }

  const fromLogs = argFlag("--from-logs");
  const logFile = argValue("--log-file");
  let logText: string | undefined;
  if (logFile) logText = readFileSync(logFile, "utf8");
  else if (fromLogs) logText = await readStdin();

  const report = runReceiptBackfill({
    paidCallDbPath: argValue("--db") ?? defaultPaidCallDbPath(),
    receiptDbPath: argValue("--receipts") ?? defaultReceiptDbPath(),
    logText,
  });

  if (argFlag("--json")) {
    console.log(JSON.stringify(report));
    return;
  }

  const lines = [
    `as_of=${report.as_of}`,
    `machine=${report.fly_machine_id ?? "(not on Fly)"}`,
    `paid_calls=${report.source.paid_calls ?? ""}`,
    `receipts=${report.source.receipts ?? "(missing)"}`,
    `intent_rows_updated=${report.intent_rows_updated}`,
    "",
    "Confirm paid_calls by stored intent (not lead_submit-attributed unscoped rows):",
    `  L7d   lead_submit=${report.windows.l7d.lead_submit} listing_published=${report.windows.l7d.listing_published} order_placed=${report.windows.l7d.order_placed} unscoped=${report.windows.l7d.unscoped}`,
    `  L30d  lead_submit=${report.windows.l30d.lead_submit} listing_published=${report.windows.l30d.listing_published} order_placed=${report.windows.l30d.order_placed} unscoped=${report.windows.l30d.unscoped}`,
    "",
    "Receipts (intent-filtered confirm_receipts):",
    `  L7d   lead_submit=${report.receipts.l7d.lead_submit} listing_published=${report.receipts.l7d.listing_published} order_placed=${report.receipts.l7d.order_placed}`,
    `  L30d  lead_submit=${report.receipts.l30d.lead_submit} listing_published=${report.receipts.l30d.listing_published} order_placed=${report.receipts.l30d.order_placed}`,
    "",
    report.receipt_reconstruction.reason,
    "",
    ...report.notes,
  ];
  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
