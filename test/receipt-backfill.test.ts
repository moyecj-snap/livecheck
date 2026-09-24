import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPaidCallEvent, hashUrl } from "../src/paid-call.js";
import { insertPaidCallRow, openPaidCallDb } from "../src/paid-call-store.js";
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
