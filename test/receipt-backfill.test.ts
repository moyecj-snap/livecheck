import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isReceiptId, newCheckId } from "../src/confirm-id.js";
import { buildPaidCallEvent, hashUrl } from "../src/paid-call.js";
import {
  backfillPaidCallsFromReceipts,
  closePaidCallStore,
  initPaidCallStore,
  insertPaidCallRow,
  listPaidCallRows,
  listPaidCallRowsFromStore,
  migratePaidCallStore,
  openPaidCallDb,
  queryRetentionWindows,
  queryUnattributedWindows,
  removeDuplicateReceiptBackfillRows,
  retainPaidCall,
} from "../src/paid-call-store.js";
import { paidCallRevenueUsd } from "../src/stats.js";
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
    const receiptId = newCheckId(Date.parse("2026-09-10T18:00:00Z"));
    const receipts = initReceiptStore(receiptPath);
    assert.equal(receipts.ok, true);
    rememberConfirmReceipt({
      id: receiptId,
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
    assert.equal(rows[0].receipt_id, receiptId);
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

  it("ignores a direct insert that reuses an existing tx and creates the unique indexes", () => {
    const db = openPaidCallDb(":memory:");
    const tx = `0x${"11".repeat(32)}`;
    const payer = "0x1111111111111111111111111111111111111111";
    const receiptId = newCheckId(Date.parse("2026-10-07T23:33:05Z"));
    assert.equal(
      insertPaidCallRow(db, {
        ts: "2026-10-07T23:33:05Z",
        route: "check",
        host: "example.com",
        url_sha256: hashUrl("https://example.com/first"),
        payer,
        tx,
        receipt_id: receiptId,
        verdict: "observed",
      }),
      true,
    );
    assert.equal(
      insertPaidCallRow(db, {
        ts: "2026-10-07T23:40:00Z",
        route: "check",
        host: "example.com",
        url_sha256: hashUrl("https://example.com/second"),
        payer,
        tx,
        verdict: "observed",
      }),
      false,
    );
    assert.equal(
      insertPaidCallRow(db, {
        ts: "2026-10-07T23:50:00Z",
        route: "watch",
        host: "example.com",
        url_sha256: hashUrl("https://example.com/third"),
        payer,
        tx: `0x${"22".repeat(32)}`,
        receipt_id: receiptId,
        verdict: "created",
      }),
      false,
    );
    assert.equal(listPaidCallRows(db).length, 1);
    const indexes = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'paid_calls'`)
      .all() as Array<{ name: string; sql: string }>;
    const byName = new Map(indexes.map((row) => [row.name, row.sql]));
    assert.match(byName.get("idx_paid_calls_tx") ?? "", /UNIQUE INDEX idx_paid_calls_tx ON paid_calls\(tx\) WHERE tx IS NOT NULL/);
    assert.match(
      byName.get("idx_paid_calls_receipt_id") ?? "",
      /UNIQUE INDEX idx_paid_calls_receipt_id ON paid_calls\(receipt_id\) WHERE receipt_id IS NOT NULL/,
    );
    db.close();
  });

  it("boots twice on a prod-shaped rows 100-107 snapshot and removes only 107", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-backfill-prod-"));
    const paidPath = join(dir, "paid-calls.sqlite");
    const receiptPath = join(dir, "receipts.sqlite");
    const now = new Date("2026-10-08T12:00:00Z");
    const purlUrl = hashUrl("https://example.com/purl-check");
    const urls = {
      watchSep10: hashUrl("https://example.com/watch-2026-09-10"),
      checkSep10: hashUrl("https://example.com/check-2026-09-10"),
      watchSep24: hashUrl("https://example.com/watch-2026-09-24"),
      verifyA: hashUrl("https://example.com/verify-a"),
      confirmA: hashUrl("https://example.com/confirm-a"),
      verifyB: hashUrl("https://example.com/verify-b"),
    };
    const payer = "0x2222222222222222222222222222222222222222";
    const tx = (n: string) => `0x${n.repeat(32)}`;
    const paid = new DatabaseSync(paidPath);
    paid.exec(`
      CREATE TABLE paid_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        route TEXT NOT NULL CHECK (route IN ('verify', 'verify/job', 'verify/listing', 'confirm', 'confirm/order', 'check', 'watch', 'watch/renew')),
        payer TEXT,
        tx TEXT,
        payment_intent TEXT,
        host TEXT NOT NULL,
        url_sha256 TEXT NOT NULL,
        intent TEXT,
        verdict TEXT,
        http_status INTEGER,
        user_agent TEXT,
        status TEXT,
        attribution TEXT,
        attribution_note TEXT
      );
    `);
    const insert = paid.prepare(
      `INSERT INTO paid_calls (id, ts, route, payer, tx, host, url_sha256, verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(100, "2026-09-10T18:00:00Z", "watch", null, null, "", urls.watchSep10, "created");
    insert.run(101, "2026-09-10T18:05:00Z", "check", null, null, "", urls.checkSep10, "observed");
    insert.run(102, "2026-09-24T18:00:00Z", "watch", null, null, "", urls.watchSep24, "created");
    insert.run(103, "2026-10-01T18:00:00Z", "verify", payer, tx("a1"), "example.com", urls.verifyA, null);
    insert.run(104, "2026-10-02T18:00:00Z", "confirm", payer, tx("b2"), "example.com", urls.confirmA, "confirmed");
    insert.run(105, "2026-10-07T23:33:05Z", "check", payer, tx("c3"), "example.com", purlUrl, "observed");
    insert.run(106, "2026-10-07T22:00:00Z", "verify", payer, tx("d4"), "example.com", urls.verifyB, null);
    insert.run(107, "2026-10-07T23:33:03Z", "check", null, null, "", purlUrl, "observed");

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
      observed_at: "2026-10-07T23:33:03Z",
      url_hash: purlUrl,
      claim_hash: "ef".repeat(32),
      created_at: "2026-10-07T23:33:03Z",
    });
    const receiptDb = receipts.ok ? receipts.db : undefined;
    assert.ok(receiptDb);

    const lines: string[] = [];
    const original = console.log;
    console.log = (message?: unknown) => {
      lines.push(String(message));
    };
    try {
      migratePaidCallStore(paid);
    } finally {
      console.log = original;
    }
    assert.deepEqual(
      lines.filter((line) => line.includes("removed id=")),
      [`paid_call duplicate cleanup: removed id=107 route=check ts=2026-10-07T23:33:03Z url_sha256=${purlUrl}`],
    );
    const indexes = paid
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'paid_calls'`)
      .all() as Array<{ name: string; sql: string }>;
    const byName = new Map(indexes.map((row) => [row.name, row.sql]));
    assert.match(byName.get("idx_paid_calls_tx") ?? "", /WHERE tx IS NOT NULL/);
    assert.match(byName.get("idx_paid_calls_receipt_id") ?? "", /WHERE receipt_id IS NOT NULL/);

    assert.equal(isReceiptId("chk_01M4CBD86KK8N4R8ATVGM5ZBX7"), true);
    const copied = backfillPaidCallsFromReceipts(paid, receiptDb);
    assert.equal(copied.inserted, 0);
    assert.equal(copied.skipped, 1);
    const count = () => Number((paid.prepare(`SELECT COUNT(*) AS n FROM paid_calls`).get() as { n: number }).n);
    const ids = () =>
      (paid.prepare(`SELECT id FROM paid_calls ORDER BY id`).all() as Array<{ id: number }>).map((row) => row.id);
    const revenue = () => paidCallRevenueUsd(queryRetentionWindows(paid, now).l30d.routes);
    const afterFirst = { count: count(), ids: ids(), revenue: revenue() };
    assert.deepEqual(afterFirst.ids, [100, 101, 102, 103, 104, 105, 106]);
    assert.equal(afterFirst.revenue, 5.16);
    const kept = paid.prepare(`SELECT payer, tx FROM paid_calls WHERE id = 105`).get() as { payer: string; tx: string };
    assert.equal(kept.payer, payer);
    assert.equal(kept.tx, tx("c3"));

    const secondLines: string[] = [];
    console.log = (message?: unknown) => {
      secondLines.push(String(message));
    };
    try {
      migratePaidCallStore(paid);
      assert.equal(removeDuplicateReceiptBackfillRows(paid).removed.length, 0);
    } finally {
      console.log = original;
    }
    assert.equal(backfillPaidCallsFromReceipts(paid, receiptDb).inserted, 0);
    assert.equal(
      secondLines.some((line) => line.includes("removed id=")),
      false,
    );
    assert.equal(count(), afterFirst.count);
    assert.deepEqual(ids(), afterFirst.ids);
    assert.equal(revenue(), afterFirst.revenue);
    paid.close();
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
