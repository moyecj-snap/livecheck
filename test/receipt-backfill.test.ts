import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPaidCallEvent, hashUrl } from "../src/paid-call.js";
import { insertPaidCallRow, listPaidCallRows, openPaidCallDb } from "../src/paid-call-store.js";
import {
  RECEIPT_RECONSTRUCTION_IMPOSSIBLE,
  runReceiptBackfill,
} from "../src/receipt-backfill.js";
import { closeReceiptStore, initReceiptStore, rememberConfirmReceipt } from "../src/receipt-store.js";

const execFileAsync = promisify(execFile);

describe("receipt backfill", () => {
  it("copies intent from logs onto unscoped paid_calls and reports reconstruction impossible", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-backfill-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    const db = openPaidCallDb(paidPath);
    const url_hash = hashUrl("https://example.com/thanks");
    insertPaidCallRow(db, {
      ts: "2026-09-10T18:00:00Z",
      route: "confirm",
      host: "example.com",
      url_sha256: url_hash,
    });
    insertPaidCallRow(db, {
      ts: "2026-09-10T18:01:00Z",
      route: "confirm",
      host: "example.com",
      url_sha256: hashUrl("https://example.com/other"),
    });
    db.close();

    const event = buildPaidCallEvent(
      { route: "confirm", host: "example.com", url_hash, intent: "lead_submit", verdict: "unknown" },
      {},
      new Date("2026-09-10T18:00:00.000Z"),
    );
    const report = runReceiptBackfill({
      paidCallDbPath: paidPath,
      receiptDbPath: receiptPath,
      logText: JSON.stringify(event),
      now: new Date("2026-09-11T19:00:00.000Z"),
    });
    assert.equal(report.intent_rows_updated, 1);
    assert.equal(report.windows.l7d.lead_submit, 1);
    assert.equal(report.windows.l7d.unscoped, 1);
    assert.equal(report.receipt_reconstruction.possible, false);
    assert.equal(report.receipt_reconstruction.reason, RECEIPT_RECONSTRUCTION_IMPOSSIBLE);
    assert.equal(report.receipts.l7d.lead_submit, 0);
    assert.match(report.notes.join(" "), /cannot be reconstructed/i);
  });

  it("counts existing receipts without inventing new ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-backfill-have-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    const db = openPaidCallDb(paidPath);
    insertPaidCallRow(db, {
      ts: "2026-09-10T18:00:00Z",
      route: "confirm",
      host: "example.com",
      url_sha256: hashUrl("https://example.com/lead"),
      intent: "lead_submit",
      verdict: "confirmed",
    });
    db.close();
    const receipts = initReceiptStore(receiptPath);
    assert.equal(receipts.ok, true);
    rememberConfirmReceipt({
      id: "cfm_01BACKFILL000000000000001",
      intent: "lead_submit",
      verdict: "confirmed",
      confidence: 0.92,
      evidence_level: 2,
      canonical_json: "{}",
      payload_hash: "ab".repeat(32),
      signature: null,
      signer: null,
      observed_at: "2026-09-10T18:00:00Z",
      url_hash: hashUrl("https://example.com/lead"),
      claim_hash: "ef".repeat(32),
      created_at: "2026-09-10T18:00:00Z",
    });
    closeReceiptStore();
    const report = runReceiptBackfill({
      paidCallDbPath: paidPath,
      receiptDbPath: receiptPath,
      now: new Date("2026-09-11T19:00:00.000Z"),
    });
    assert.equal(report.windows.l7d.lead_submit, 1);
    assert.equal(report.receipts.l7d.lead_submit, 1);
    assert.equal(report.receipt_reconstruction.possible, false);
    closeReceiptStore();
  });

  it("copies a check receipt into paid_calls once", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-backfill-check-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    openPaidCallDb(paidPath).close();
    const url_hash = hashUrl("https://boards.greenhouse.io/example/jobs/1842");
    const receipts = initReceiptStore(receiptPath);
    assert.equal(receipts.ok, true);
    rememberConfirmReceipt({
      id: "chk_01BACKFILLCHECK0000000001",
      intent: "check",
      verdict: "observed",
      confidence: 0.5,
      evidence_level: 0,
      canonical_json: "{}",
      payload_hash: "ab".repeat(32),
      signature: null,
      signer: null,
      observed_at: "2026-09-10T18:00:00Z",
      url_hash,
      claim_hash: "ef".repeat(32),
      created_at: "2026-09-10T18:00:00Z",
    });
    closeReceiptStore();
    const now = new Date("2026-09-11T19:00:00.000Z");
    const first = runReceiptBackfill({ paidCallDbPath: paidPath, receiptDbPath: receiptPath, now });
    assert.equal(first.sentinel_rows_inserted, 1);
    const second = runReceiptBackfill({ paidCallDbPath: paidPath, receiptDbPath: receiptPath, now });
    assert.equal(second.sentinel_rows_inserted, 0);
    const db = openPaidCallDb(paidPath);
    const rows = listPaidCallRows(db);
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].route, "check");
    assert.equal(rows[0].host, "");
    assert.equal(rows[0].url_sha256, url_hash);
    assert.equal(rows[0].verdict, "observed");
    assert.equal(rows[0].payer, undefined);
    assert.equal(rows[0].user_agent, undefined);
    closeReceiptStore();
  });

  it("CLI --json reports reconstruction.possible=false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-backfill-cli-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const db = openPaidCallDb(paidPath);
    insertPaidCallRow(db, {
      // CLI uses the wall clock for L7d. Keep the row inside that window.
      ts: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      route: "confirm",
      host: "example.com",
      url_sha256: hashUrl("https://example.com/thanks"),
    });
    db.close();
    const logPath = join(dir, "logs.txt");
    writeFileSync(logPath, "");
    const { stdout } = await execFileAsync(
      "npx",
      [
        "tsx",
        "scripts/receipt-backfill.ts",
        "--db",
        paidPath,
        "--receipts",
        join(dir, "missing-receipts.sqlite"),
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const report = JSON.parse(stdout) as {
      receipt_reconstruction: { possible: boolean };
      windows: { l7d: { unscoped: number } };
    };
    assert.equal(report.receipt_reconstruction.possible, false);
    assert.equal(report.windows.l7d.unscoped, 1);
  });
});
