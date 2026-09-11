import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultPaidCallDbPath, openPaidCallDb } from "./paid-call-store.js";
import {
  confirmReceiptsTableExists,
  defaultReceiptDbPath,
  insertConfirmReceiptRow,
  listConfirmReceiptRows,
  migrateReceiptStore,
  receiptPathConflictsWithPaidCalls,
} from "./receipt-store.js";

/** Live Fly machines — each has its own livecheck_data volume. */
export const FLY_MACHINES = [
  {
    id: "839744b76061e8",
    name: "summer-voice",
    holds: "Confirm paid_calls (3 confirm + 1 verify) and the misplaced confirm_receipts rows",
  },
  {
    id: "860792be4622e8",
    name: "sparkling-violet",
    holds: "mostly verify/check; stray wtc_ receipt in paid-calls.sqlite confirm_receipts",
  },
] as const;

export const SEP8_ORPHAN_NOTE =
  "Refund candidate (unreconstructable): machine 839744b76061e8 (summer-voice) paid_calls id 2 at 2026-09-08T18:56:30Z, route=confirm, payment_intent=pi_3UDUC1QOrQ8LEBMA1ZXJlcqF, tx=0xd932eeba… — no confirm_receipts row in paid-calls.sqlite or receipts.sqlite. Do not invent a cfm_ stub. Manual Stripe refund is an ops decision; this process does not refund.";

export function dualMachineCosHelp(): string {
  return [
    "Each Fly machine has its own livecheck_data volume. One /stats or one ssh is one volume.",
    "",
    `  839744b76061e8  summer-voice       ${FLY_MACHINES[0].holds}`,
    `  860792be4622e8  sparkling-violet   ${FLY_MACHINES[1].holds}`,
    "",
    "  fly machines list -a livecheck",
    "  fly ssh console -a livecheck --machine 839744b76061e8 -C \"npm run receipt:rescue -- --json\"",
    "  fly ssh console -a livecheck --machine 860792be4622e8 -C \"npm run receipt:rescue -- --json\"",
    "  fly ssh console -a livecheck --machine 839744b76061e8 -C \"npm run paid-call:cos -- --json\"",
    "  fly ssh console -a livecheck --machine 860792be4622e8 -C \"npm run paid-call:cos -- --json\"",
    "",
    "Do not add the two JSON reports into a new KPI. Do not Fly deploy from this tree.",
    SEP8_ORPHAN_NOTE,
  ].join("\n");
}

export type ReceiptRescueReport = {
  as_of: string;
  paid_calls_path: string;
  receipts_path: string;
  fly_machine_id: string | null;
  found: number;
  copied: number;
  ids: string[];
  dropped_source_table: boolean;
  same_path_refused: boolean;
  notes: string[];
};

function openReceiptsForWrite(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  migrateReceiptStore(db);
  return db;
}

/**
 * Copy confirm_receipts rows that were written into paid-calls.sqlite
 * (pre-26c702e bindReceiptSqlite) into receipts.sqlite, then drop the
 * misplaced table so receipts are never written there again.
 */
export function rescueMisplacedReceipts(input: {
  paidCallPath?: string;
  receiptPath?: string;
  paidCallDb?: DatabaseSync;
  receiptDb?: DatabaseSync;
  dropSource?: boolean;
  now?: Date;
}): ReceiptRescueReport {
  const paidPath = input.paidCallPath ?? defaultPaidCallDbPath();
  const receiptPath = input.receiptPath ?? defaultReceiptDbPath();
  const dropSource = input.dropSource !== false;
  const notes: string[] = [
    "Copies confirm_receipts out of paid-calls.sqlite into receipts.sqlite (INSERT OR REPLACE by id).",
    "Does not invent receipts. The Sep 8 confirm paid_call with no row in either table stays a refund candidate.",
    SEP8_ORPHAN_NOTE,
  ];
  const report: ReceiptRescueReport = {
    as_of: (input.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    paid_calls_path: paidPath,
    receipts_path: receiptPath,
    fly_machine_id: process.env.FLY_MACHINE_ID?.trim() || process.env.FLY_ALLOC_ID?.trim() || null,
    found: 0,
    copied: 0,
    ids: [],
    dropped_source_table: false,
    same_path_refused: false,
    notes,
  };

  if (receiptPathConflictsWithPaidCalls(receiptPath, paidPath)) {
    report.same_path_refused = true;
    notes.push("Refused: RECEIPT_DB_PATH equals PAID_CALL_DB_PATH. Fix env; do not write receipts into paid-calls.sqlite.");
    return report;
  }

  const ownsPaid = !input.paidCallDb;
  const ownsReceipt = !input.receiptDb;
  let paidDb = input.paidCallDb;
  let receiptDb = input.receiptDb;

  try {
    if (!paidDb) {
      if (paidPath !== ":memory:" && !existsSync(paidPath)) {
        notes.push(`paid-calls sqlite not found at ${paidPath}; nothing to rescue.`);
        return report;
      }
      paidDb = openPaidCallDb(paidPath);
    }
    if (!confirmReceiptsTableExists(paidDb)) {
      notes.push("No confirm_receipts table on the paid-calls DB. Nothing to copy.");
      return report;
    }

    if (!receiptDb) {
      receiptDb = openReceiptsForWrite(receiptPath);
    } else {
      migrateReceiptStore(receiptDb);
    }

    const rows = listConfirmReceiptRows(paidDb);
    report.found = rows.length;
    for (const row of rows) {
      insertConfirmReceiptRow(receiptDb, row);
      report.copied += 1;
      report.ids.push(row.id);
    }

    if (dropSource && report.copied === report.found) {
      paidDb.exec("DROP TABLE IF EXISTS confirm_receipts");
      report.dropped_source_table = !confirmReceiptsTableExists(paidDb);
      notes.push(
        report.dropped_source_table
          ? "Dropped misplaced confirm_receipts from paid-calls.sqlite. Receipts write only to receipts.sqlite."
          : "Copy succeeded but DROP TABLE confirm_receipts on paid-calls.sqlite failed; inspect the volume.",
      );
    } else if (report.found === 0) {
      notes.push("confirm_receipts table existed but was empty.");
    }
    return report;
  } finally {
    if (ownsPaid) {
      try {
        paidDb?.close();
      } catch {
        // ignore
      }
    }
    if (ownsReceipt) {
      try {
        receiptDb?.close();
      } catch {
        // ignore
      }
    }
  }
}
