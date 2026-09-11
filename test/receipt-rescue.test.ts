import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { closePaidCallStore, migratePaidCallStore, openPaidCallDb } from "../src/paid-call-store.js";
import {
  closeReceiptStore,
  confirmReceiptsTableExists,
  getConfirmReceipt,
  initReceiptStore,
  insertConfirmReceiptRow,
  listConfirmReceiptRows,
} from "../src/receipt-store.js";
import { rescueMisplacedReceipts, SEP8_ORPHAN_NOTE } from "../src/receipt-rescue.js";
import type { ConfirmReceiptRow } from "../src/receipt-store.js";

const execFileAsync = promisify(execFile);

function stubRow(overrides: Partial<ConfirmReceiptRow> = {}): ConfirmReceiptRow {
  return {
    id: overrides.id ?? "cfm_01M23ZJJGNHQ15N4DGQ7QS50KP",
    intent: overrides.intent ?? "lead_submit",
    verdict: overrides.verdict ?? "confirmed",
    confidence: 0.92,
    evidence_level: 2,
    canonical_json: '{"id":"cfm_01M23ZJJGNHQ15N4DGQ7QS50KP"}',
    payload_hash: "ab".repeat(32),
    signature: "c2ln",
    signer: "livecheck-confirm-v1",
    observed_at: "2026-09-10T18:00:00Z",
    url_hash: "cd".repeat(32),
    claim_hash: "ef".repeat(32),
    created_at: overrides.created_at ?? "2026-09-10T18:00:00Z",
  };
}

function writeMisplacedReceipts(path: string, rows: ConfirmReceiptRow[]): void {
  const db = openPaidCallDb(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS confirm_receipts (
      id TEXT PRIMARY KEY,
      intent TEXT NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_level INTEGER NOT NULL,
      canonical_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      signature TEXT,
      signer TEXT,
      observed_at TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      claim_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  for (const row of rows) insertConfirmReceiptRow(db, row);
  db.close();
}

describe("receipt rescue from paid-calls.sqlite", () => {
  afterEach(() => {
    closePaidCallStore();
    closeReceiptStore();
  });

  it("copies confirm_receipts out of paid-calls.sqlite and drops the stray table", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-rescue-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    const lead = stubRow();
    const order = stubRow({
      id: "cfm_01M240J5SCC7XYY1S865XW0FDR",
      intent: "order_placed",
      verdict: "unknown",
      created_at: "2026-09-10T19:00:00Z",
    });
    writeMisplacedReceipts(paidPath, [lead, order]);

    const report = rescueMisplacedReceipts({
      paidCallPath: paidPath,
      receiptPath,
      now: new Date("2026-09-11T20:00:00.000Z"),
    });
    assert.equal(report.found, 2);
    assert.equal(report.copied, 2);
    assert.equal(report.dropped_source_table, true);
    assert.equal(report.same_path_refused, false);
    assert.ok(report.ids.includes(lead.id));
    assert.ok(report.ids.includes(order.id));
    assert.match(report.notes.join(" "), /pi_3UDUC1QOrQ8LEBMA1ZXJlcqF/);

    const paid = new DatabaseSync(paidPath);
    assert.equal(confirmReceiptsTableExists(paid), false);
    paid.close();

    const opened = initReceiptStore(receiptPath);
    if (!opened.ok) throw new Error("receipt store failed");
    const copiedLead = getConfirmReceipt(lead.id);
    const copiedOrder = getConfirmReceipt(order.id);
    assert.ok(copiedLead);
    assert.equal(copiedLead.intent, "lead_submit");
    assert.equal(copiedLead.verdict, "confirmed");
    assert.equal(copiedLead.signature, "c2ln");
    assert.ok(copiedOrder);
    assert.equal(copiedOrder.intent, "order_placed");
    assert.equal(copiedOrder.verdict, "unknown");
  });

  it("is idempotent and does not invent the Sep 8 orphan", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-rescue-again-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    writeMisplacedReceipts(paidPath, [stubRow()]);
    const first = rescueMisplacedReceipts({ paidCallPath: paidPath, receiptPath });
    assert.equal(first.copied, 1);
    const second = rescueMisplacedReceipts({ paidCallPath: paidPath, receiptPath });
    assert.equal(second.found, 0);
    assert.equal(second.copied, 0);
    assert.equal(second.dropped_source_table, false);
    assert.match(SEP8_ORPHAN_NOTE, /2026-09-08T18:56:30Z/);
    assert.match(SEP8_ORPHAN_NOTE, /unreconstructable/i);
  });

  it("refuses when receipt path is the paid-calls file", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-rescue-same-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    writeMisplacedReceipts(paidPath, [stubRow()]);
    const report = rescueMisplacedReceipts({ paidCallPath: paidPath, receiptPath: paidPath });
    assert.equal(report.same_path_refused, true);
    assert.equal(report.copied, 0);
    const paid = new DatabaseSync(paidPath);
    assert.equal(confirmReceiptsTableExists(paid), true);
    assert.equal(listConfirmReceiptRows(paid).length, 1);
    paid.close();
  });

  it("initReceiptStore refuses a paid-calls.sqlite path", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-refuse-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    writeMisplacedReceipts(paidPath, [stubRow()]);
    const opened = initReceiptStore(paidPath);
    assert.equal(opened.ok, false);
    if (opened.ok) throw new Error("expected refuse");
    assert.match(opened.reason, /must not be paid-calls/);
  });

  it("migratePaidCallStore never creates confirm_receipts", () => {
    const dir = mkdtempSync(join(tmpdir(), "paid-no-receipts-"));
    const path = join(dir, "paid-calls.sqlite");
    const db = new DatabaseSync(path);
    migratePaidCallStore(db);
    assert.equal(confirmReceiptsTableExists(db), false);
    db.close();
  });

  it("CLI --json and --machines-help", async () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-rescue-cli-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    writeMisplacedReceipts(paidPath, [stubRow({ id: "wtc_01STRAYWATCHER00000000001", intent: "watch" })]);
    const { stdout } = await execFileAsync(
      "npx",
      ["tsx", "scripts/receipt-rescue.ts", "--db", paidPath, "--receipts", receiptPath, "--json"],
      { cwd: process.cwd() },
    );
    const report = JSON.parse(stdout) as { copied: number; ids: string[]; dropped_source_table: boolean };
    assert.equal(report.copied, 1);
    assert.deepEqual(report.ids, ["wtc_01STRAYWATCHER00000000001"]);
    assert.equal(report.dropped_source_table, true);

    const help = await execFileAsync("npx", ["tsx", "scripts/receipt-rescue.ts", "--machines-help"], {
      cwd: process.cwd(),
    });
    assert.match(help.stdout, /839744b76061e8/);
    assert.match(help.stdout, /860792be4622e8/);
    assert.match(help.stdout, /summer-voice/);
    assert.match(help.stdout, /Patty v5/);
    assert.match(help.stdout, /pi_3UDUC1QOrQ8LEBMA1ZXJlcqF/);
  });
});
