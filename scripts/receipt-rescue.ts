/**
 * Ops: copy leftover confirm_receipts out of paid-calls.sqlite into receipts.sqlite.
 * node:sqlite DatabaseSync only (Fly image has no better-sqlite3).
 *
 * Live volumes already got Patty's one-shot:
 *   node /data/migrate-receipts-v5.mjs
 * 839744…: 2 cfm_ now in receipts.sqlite (GET /v1/receipt/cfm_01M23ZJJ… 200).
 * 860792…: stray wtc_ now in receipts.sqlite.
 * If this prints found=0, the volume is already migrated — stop.
 *
 *   npm run receipt:rescue
 *   npm run receipt:rescue -- --json
 *   npm run receipt:rescue -- --machines-help
 *
 * Dual-volume leftover check (do not treat as a second invent-and-copy):
 *   fly ssh console -a livecheck --machine 839744b76061e8 -C "npm run receipt:rescue -- --json"
 *   fly ssh console -a livecheck --machine 860792be4622e8 -C "npm run receipt:rescue -- --json"
 *
 * Does not Fly deploy. Does not invent the Sep 8 orphan (pi_3UDUC1QOrQ8LEBMA1ZXJlcqF).
 */
import { defaultPaidCallDbPath } from "../src/paid-call-store.js";
import { defaultReceiptDbPath } from "../src/receipt-store.js";
import { dualMachineCosHelp, rescueMisplacedReceipts } from "../src/receipt-rescue.js";

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function main(): void {
  if (argFlag("--machines-help")) {
    console.log(dualMachineCosHelp());
    return;
  }

  const report = rescueMisplacedReceipts({
    paidCallPath: argValue("--db") ?? defaultPaidCallDbPath(),
    receiptPath: argValue("--receipts") ?? defaultReceiptDbPath(),
    dropSource: !argFlag("--keep-source"),
  });

  if (argFlag("--json")) {
    console.log(JSON.stringify(report));
    return;
  }

  console.log(
    [
      `as_of=${report.as_of}`,
      `machine=${report.fly_machine_id ?? "(not on Fly)"}`,
      `paid_calls=${report.paid_calls_path}`,
      `receipts=${report.receipts_path}`,
      `found=${report.found} copied=${report.copied} dropped_source=${report.dropped_source_table}`,
      `ids=${report.ids.join(",") || "(none)"}`,
      `same_path_refused=${report.same_path_refused}`,
      "",
      ...report.notes,
    ].join("\n"),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
