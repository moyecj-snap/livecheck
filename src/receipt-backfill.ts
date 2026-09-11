import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  backfillPaidCallIntentFromEvent,
  defaultPaidCallDbPath,
  isoCutoff,
  openPaidCallDb,
  parsePaidCallLogLine,
  queryConfirmIntentWindows,
  type ConfirmIntentWindows,
} from "./paid-call-store.js";
import { PAID_CALL_EVENT } from "./paid-call.js";
import { defaultReceiptDbPath, queryReceiptsSince } from "./receipt-store.js";

export const RECEIPT_RECONSTRUCTION_IMPOSSIBLE =
  "Signed Confirm receipts cannot be reconstructed from paid_calls (or from livecheck.paid_call logs). Those rows have host + url_sha256 + ts (+ intent/verdict once backfilled) but no cfm_ id, evidence, canonical payload, or Ed25519 signature. Do not invent stub receipts — that would fabricate honesty verdicts. Historical in-memory receipts from before 26c702e are gone unless the paying client still has the 200 body.";

export type ReceiptBackfillReport = {
  as_of: string;
  source: {
    paid_calls?: string;
    receipts?: string;
    logs?: string;
  };
  fly_machine_id: string | null;
  windows: ConfirmIntentWindows;
  receipts: {
    l7d: { lead_submit: number; listing_published: number; order_placed: number };
    l30d: { lead_submit: number; listing_published: number; order_placed: number };
  };
  intent_rows_updated: number;
  unscoped_remaining: { l7d: number; l30d: number };
  receipt_reconstruction: { possible: false; reason: string };
  notes: string[];
};

export function parsePaidCallEventsFromLogText(text: string) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(PAID_CALL_EVENT)) continue;
    const event = parsePaidCallLogLine(line);
    if (event) events.push(event);
  }
  return events;
}

function receiptCounts(db: DatabaseSync | undefined, now: Date) {
  const intents = ["lead_submit", "listing_published", "order_placed"] as const;
  const one = (days: number) => {
    const out = { lead_submit: 0, listing_published: 0, order_placed: 0 };
    if (!db) return out;
    const since = isoCutoff(now, days);
    for (const intent of intents) {
      try {
        out[intent] = queryReceiptsSince(db, since, intent).receipts;
      } catch {
        out[intent] = 0;
      }
    }
    return out;
  };
  return { l7d: one(7), l30d: one(30) };
}

function openReceiptsIfPresent(path: string): DatabaseSync | undefined {
  if (path === ":memory:" || !existsSync(path)) return undefined;
  const db = new DatabaseSync(path);
  return db;
}

export function runReceiptBackfill(input: {
  paidCallDbPath?: string;
  receiptDbPath?: string;
  logText?: string;
  now?: Date;
}): ReceiptBackfillReport {
  const now = input.now ?? new Date();
  const paidPath = input.paidCallDbPath ?? defaultPaidCallDbPath();
  const receiptPath = input.receiptDbPath ?? defaultReceiptDbPath();
  const notes: string[] = [
    "Row/intent counts only. No revenue or false-confirmed KPIs.",
    RECEIPT_RECONSTRUCTION_IMPOSSIBLE,
    "Dual-volume: run this on each Fly machine (fly ssh console -a livecheck --machine <id>).",
  ];

  if (paidPath !== ":memory:" && !existsSync(paidPath)) {
    throw new Error(`paid_calls sqlite not found at ${paidPath}`);
  }

  const paidDb = openPaidCallDb(paidPath);
  let intent_rows_updated = 0;
  try {
    if (input.logText) {
      for (const event of parsePaidCallEventsFromLogText(input.logText)) {
        intent_rows_updated += backfillPaidCallIntentFromEvent(paidDb, event);
      }
    }
    const windows = queryConfirmIntentWindows(paidDb, now);
    const receiptDb = openReceiptsIfPresent(receiptPath);
    try {
      const receipts = receiptCounts(receiptDb, now);
      const report: ReceiptBackfillReport = {
        as_of: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        source: {
          paid_calls: paidPath,
          receipts: receiptDb ? receiptPath : undefined,
          logs: input.logText !== undefined ? "provided" : undefined,
        },
        fly_machine_id: process.env.FLY_MACHINE_ID?.trim() || process.env.FLY_ALLOC_ID?.trim() || null,
        windows,
        receipts,
        intent_rows_updated,
        unscoped_remaining: { l7d: windows.l7d.unscoped, l30d: windows.l30d.unscoped },
        receipt_reconstruction: { possible: false, reason: RECEIPT_RECONSTRUCTION_IMPOSSIBLE },
        notes,
      };
      if (!receiptDb) {
        notes.push(`receipts.sqlite not found at ${receiptPath}; receipt counts are 0.`);
      }
      if (intent_rows_updated === 0 && input.logText) {
        notes.push(
          "No paid_calls rows were updated from logs. Match requires identical ts + url_sha256 on a confirm row that still has NULL intent.",
        );
      }
      return report;
    } finally {
      receiptDb?.close();
    }
  } finally {
    paidDb.close();
  }
}
