import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { newCheckId } from "../src/confirm-id.js";
import { buildPaidCallEvent, hashUrl } from "../src/paid-call.js";
import {
  backfillPaidCallsFromReceipts,
  closePaidCallStore,
  initPaidCallStore,
  insertPaidCallRow,
  listPaidCallRows,
  listPaidCallRowsFromStore,
  openPaidCallDb,
  queryRetentionWindows,
  queryUnattributedWindows,
  removeDuplicateReceiptBackfillRows,
  retainPaidCall,
} from "../src/paid-call-store.js";
import { ATTRIBUTION_UNATTRIBUTED, NO_TX_ATTRIBUTION_NOTE } from "../src/settlement-payer.js";
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
    assert.equal(rows.length, 1);
    assert.equal(rows[0].route, "check");
    assert.equal(rows[0].host, "");
    assert.equal(rows[0].url_sha256, url_hash);
    assert.equal(rows[0].verdict, "observed");
    assert.equal(rows[0].payer, undefined);
    assert.equal(rows[0].user_agent, undefined);
    assert.equal(rows[0].attribution, ATTRIBUTION_UNATTRIBUTED);
    assert.equal(rows[0].attribution_note, NO_TX_ATTRIBUTION_NOTE);
    assert.equal(rows[0].tx, undefined);
    const nowWindow = new Date("2026-09-11T19:00:00.000Z");
    const external = queryRetentionWindows(db, nowWindow, [], [], { external: true });
    const unattributed = queryUnattributedWindows(db, nowWindow);
    assert.equal(external.l30d.check.calls, 0);
    assert.equal(unattributed.l30d.check.calls, 1);
    const cleaned = removeDuplicateReceiptBackfillRows(db);
    assert.equal(cleaned.removed.length, 0);
    assert.equal(listPaidCallRows(db).length, 1);
    db.close();
    closeReceiptStore();
  });

  it("does not add a row when a paid check already landed within 120 seconds", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-backfill-window-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    const url_hash = hashUrl("https://example.com/purl-check");
    const directTs = "2026-10-07T23:33:05Z";
    const receiptTs = "2026-10-07T23:33:03Z";
    const payer = "0x0561f30a23cf47ba6b9acf7bc22fac1144e64fae";
    const db = openPaidCallDb(paidPath);
    insertPaidCallRow(db, {
      ts: directTs,
      route: "check",
      host: "example.com",
      url_sha256: url_hash,
      payer,
      tx: `0x${"ab".repeat(32)}`,
      verdict: "observed",
    });
    db.close();
    const receipts = initReceiptStore(receiptPath);
    assert.equal(receipts.ok, true);
    rememberConfirmReceipt({
      id: "chk_01M4CBD86KK8N4R8ATVGM5ZBX7",
      intent: "check",
      verdict: "observed",
      confidence: 0.5,
      evidence_level: 0,
      canonical_json: "{}",
      payload_hash: "ab".repeat(32),
      signature: null,
      signer: null,
      observed_at: receiptTs,
      url_hash,
      claim_hash: "ef".repeat(32),
      created_at: receiptTs,
    });
    closeReceiptStore();
    const now = new Date("2026-10-08T00:00:00Z");
    const first = runReceiptBackfill({ paidCallDbPath: paidPath, receiptDbPath: receiptPath, now });
    assert.equal(first.sentinel_rows_inserted, 0);
    const second = runReceiptBackfill({ paidCallDbPath: paidPath, receiptDbPath: receiptPath, now });
    assert.equal(second.sentinel_rows_inserted, 0);
    const paid = openPaidCallDb(paidPath);
    const rows = listPaidCallRows(paid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.payer, payer);
    assert.equal(rows[0]?.ts, directTs);
    const unattributed = queryUnattributedWindows(paid, now);
    assert.equal(unattributed.l7d.check.calls, 0);
    paid.close();
    closeReceiptStore();
  });

  it("skips a receipt when the direct row already stores that receipt id", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-backfill-id-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    const url_hash = hashUrl("https://example.com/linked-check");
    const receiptId = newCheckId(Date.parse("2026-10-07T23:00:00Z"));
    const db = openPaidCallDb(paidPath);
    insertPaidCallRow(db, {
      ts: "2026-10-07T23:33:05Z",
      route: "check",
      host: "example.com",
      url_sha256: url_hash,
      payer: "0x0561f30a23cf47ba6b9acf7bc22fac1144e64fae",
      receipt_id: receiptId,
      verdict: "observed",
    });
    db.close();
    const receipts = initReceiptStore(receiptPath);
    assert.equal(receipts.ok, true);
    rememberConfirmReceipt({
      id: receiptId,
      intent: "check",
      verdict: "observed",
      confidence: 0.5,
      evidence_level: 0,
      canonical_json: "{}",
      payload_hash: "cd".repeat(32),
      signature: null,
      signer: null,
      observed_at: "2026-10-07T23:20:00Z",
      url_hash,
      claim_hash: "ef".repeat(32),
      created_at: "2026-10-07T23:20:00Z",
    });
    closeReceiptStore();
    const report = runReceiptBackfill({
      paidCallDbPath: paidPath,
      receiptDbPath: receiptPath,
      now: new Date("2026-10-08T00:00:00Z"),
    });
    assert.equal(report.sentinel_rows_inserted, 0);
    const paid = openPaidCallDb(paidPath);
    const rows = listPaidCallRows(paid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.receipt_id, receiptId);
    paid.close();
    closeReceiptStore();
  });

  it("removes the payerless receipt copy and keeps a row that has a payer or tx", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-backfill-cleanup-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const url_hash = hashUrl("https://example.com/purl-check");
    const other = hashUrl("https://example.com/lone-check");
    const db = openPaidCallDb(paidPath);
    insertPaidCallRow(db, {
      ts: "2026-10-07T23:33:05Z",
      route: "check",
      host: "example.com",
      url_sha256: url_hash,
      payer: "0x0561f30a23cf47ba6b9acf7bc22fac1144e64fae",
      tx: `0x${"ab".repeat(32)}`,
      verdict: "observed",
    });
    insertPaidCallRow(db, {
      ts: "2026-10-07T23:33:03Z",
      route: "check",
      host: "",
      url_sha256: url_hash,
      verdict: "observed",
    });
    insertPaidCallRow(db, {
      ts: "2026-10-07T23:33:04Z",
      route: "check",
      host: "",
      url_sha256: url_hash,
      tx: `0x${"cd".repeat(32)}`,
      verdict: "observed",
    });
    insertPaidCallRow(db, {
      ts: "2026-10-07T23:33:03Z",
      route: "watch",
      host: "",
      url_sha256: other,
      verdict: "created",
    });
    const lines: string[] = [];
    const original = console.log;
    console.log = (message?: unknown) => {
      lines.push(String(message));
    };
    let cleaned: ReturnType<typeof removeDuplicateReceiptBackfillRows>;
    try {
      cleaned = removeDuplicateReceiptBackfillRows(db);
    } finally {
      console.log = original;
    }
    assert.equal(cleaned.removed.length, 1);
    assert.equal(cleaned.removed[0]?.route, "check");
    assert.equal(cleaned.removed[0]?.ts, "2026-10-07T23:33:03Z");
    assert.equal(cleaned.removed[0]?.url_sha256, url_hash);
    assert.match(lines.join("\n"), /id=\d+ route=check ts=2026-10-07T23:33:03Z/);
    const again = removeDuplicateReceiptBackfillRows(db);
    assert.equal(again.removed.length, 0);
    const rows = listPaidCallRows(db);
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((row) => row.payer).length, 1);
    assert.equal(rows.filter((row) => row.tx && !row.payer).length, 1);
    assert.equal(rows.filter((row) => row.route === "watch").length, 1);
    const now = new Date("2026-10-08T00:00:00Z");
    assert.equal(queryUnattributedWindows(db, now).l7d.watch.calls, 1);
    assert.equal(queryUnattributedWindows(db, now).l7d.check.calls, 1);
    db.close();
  });

  it("still backfills a receipt 121 seconds away and skips one at exactly 120 seconds", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-backfill-edge-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    const near = hashUrl("https://example.com/near");
    const far = hashUrl("https://example.com/far");
    const directTs = "2026-10-07T23:33:05Z";
    const at120 = new Date(Date.parse(directTs) - 120_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const at121 = new Date(Date.parse(directTs) - 121_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const payer = "0x0561f30a23cf47ba6b9acf7bc22fac1144e64fae";
    const db = openPaidCallDb(paidPath);
    insertPaidCallRow(db, {
      ts: directTs,
      route: "check",
      host: "example.com",
      url_sha256: near,
      payer,
      verdict: "observed",
    });
    insertPaidCallRow(db, {
      ts: directTs,
      route: "check",
      host: "example.com",
      url_sha256: far,
      payer,
      verdict: "observed",
    });
    db.close();
    const receipts = initReceiptStore(receiptPath);
    assert.equal(receipts.ok, true);
    rememberConfirmReceipt({
      id: newCheckId(Date.parse(at120)),
      intent: "check",
      verdict: "observed",
      confidence: 0.5,
      evidence_level: 0,
      canonical_json: "{}",
      payload_hash: "11".repeat(32),
      signature: null,
      signer: null,
      observed_at: at120,
      url_hash: near,
      claim_hash: "22".repeat(32),
      created_at: at120,
    });
    rememberConfirmReceipt({
      id: newCheckId(Date.parse(at121)),
      intent: "check",
      verdict: "observed",
      confidence: 0.5,
      evidence_level: 0,
      canonical_json: "{}",
      payload_hash: "33".repeat(32),
      signature: null,
      signer: null,
      observed_at: at121,
      url_hash: far,
      claim_hash: "44".repeat(32),
      created_at: at121,
    });
    const opened = receipts.ok ? receipts.db : undefined;
    assert.ok(opened);
    const paid = openPaidCallDb(paidPath);
    const result = backfillPaidCallsFromReceipts(paid, opened);
    assert.equal(result.inserted, 1);
    const rows = listPaidCallRows(paid);
    assert.equal(rows.length, 3);
    const copied = rows.find((row) => row.url_sha256 === far && !row.payer);
    assert.equal(copied?.attribution, ATTRIBUTION_UNATTRIBUTED);
    assert.equal(copied?.ts, at121);
    assert.equal(rows.filter((row) => row.url_sha256 === near).length, 1);
    paid.close();
    closeReceiptStore();
  });

  it("stores a receipt id on the direct check row", () => {
    closePaidCallStore();
    initPaidCallStore(":memory:");
    const receiptId = newCheckId(Date.parse("2026-10-07T23:33:03Z"));
    const event = buildPaidCallEvent(
      {
        route: "check",
        host: "example.com",
        url_hash: hashUrl("https://example.com/direct"),
        intent: "status_change",
        verdict: "observed",
        receipt_id: receiptId,
      },
      { payer: "0x0561f30a23cf47ba6b9acf7bc22fac1144e64fae", tx: `0x${"ef".repeat(32)}` },
      new Date("2026-10-07T23:33:05Z"),
    );
    assert.equal(event.receipt_id, receiptId);
    assert.equal(retainPaidCall(event), true);
    assert.equal(listPaidCallRowsFromStore()[0]?.receipt_id, receiptId);
    closePaidCallStore();
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
