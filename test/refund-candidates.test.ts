import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import {
  insertRefundCandidate,
  listRefundCandidates,
  migratePaidCallStore,
  paidCallStoreTableColumns,
} from "../src/paid-call-store.js";

const PAYER = "0x1111111111111111111111111111111111111111";
const TX = `0x${"ab".repeat(32)}`;

describe("refund_candidates store and refunds:list", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-refunds-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("adds amount, responded_at and settled_at to an existing table without losing rows", () => {
    const path = join(dir, "old.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE refund_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, protocol TEXT NOT NULL, payment_id TEXT,
      route TEXT NOT NULL, reason TEXT NOT NULL, payer TEXT, http_status INTEGER);`);
    db.prepare("INSERT INTO refund_candidates (ts, protocol, payment_id, route, reason) VALUES (?, ?, ?, ?, ?)").run(
      "2026-11-01T00:00:00Z",
      "mpp_tempo",
      `0x${"cd".repeat(32)}`,
      "verify",
      "handler_threw",
    );
    migratePaidCallStore(db);
    const columns = paidCallStoreTableColumns(db, "refund_candidates");
    for (const name of ["amount_usd", "responded_at", "settled_at"]) assert.ok(columns.has(name), name);
    assert.equal(listRefundCandidates(db).length, 1);
    db.close();
  });

  it("round-trips the new fields, sanitizes junk, and dedupes by tx", () => {
    const db = new DatabaseSync(join(dir, "rt.sqlite"));
    migratePaidCallStore(db);
    assert.equal(
      insertRefundCandidate(db, {
        ts: "2026-11-04T18:00:05Z",
        protocol: "x402",
        payment_id: TX,
        route: "verify/listing",
        reason: "settled_after_status_unknown",
        payer: PAYER,
        amount_usd: "0.01",
        responded_at: "2026-11-04T18:00:05Z",
        settled_at: "2026-11-04T18:00:09Z",
      }),
      true,
    );
    assert.equal(
      insertRefundCandidate(db, { ts: "2026-11-04T18:00:10Z", protocol: "x402", payment_id: TX, route: "verify", reason: "settled_no_response_delivered" }),
      false,
      "same tx is listed once",
    );
    insertRefundCandidate(db, {
      ts: "2026-11-04T18:01:00Z",
      protocol: "x402",
      route: "verify",
      reason: "settle_timeout_unresolved",
      amount_usd: "https://example.com/not-money",
      responded_at: "yesterday",
    });
    const rows = listRefundCandidates(db);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      ts: "2026-11-04T18:00:05Z",
      protocol: "x402",
      payment_id: TX,
      route: "verify/listing",
      reason: "settled_after_status_unknown",
      payer: PAYER,
      amount_usd: "0.01",
      responded_at: "2026-11-04T18:00:05Z",
      settled_at: "2026-11-04T18:00:09Z",
    });
    assert.equal(rows[1]!.amount_usd, undefined);
    assert.equal(rows[1]!.responded_at, undefined);
    assert.equal(listRefundCandidates(db, "2026-11-04T18:00:30Z").length, 1);
    db.close();
  });

  it("refunds:list reads the list as JSON (read-only, --since)", () => {
    const path = join(dir, "list.sqlite");
    const db = new DatabaseSync(path);
    migratePaidCallStore(db);
    insertRefundCandidate(db, {
      ts: "2026-11-03T23:00:00Z",
      protocol: "x402",
      route: "verify",
      reason: "settle_error_unresolved",
      payer: PAYER,
      amount_usd: "0.01",
      responded_at: "2026-11-03T23:00:00Z",
    });
    insertRefundCandidate(db, {
      ts: "2026-11-04T01:00:00Z",
      protocol: "x402",
      payment_id: TX,
      route: "verify",
      reason: "settled_after_status_unknown",
      payer: PAYER,
      amount_usd: "0.01",
      responded_at: "2026-11-04T01:00:00Z",
      settled_at: "2026-11-04T01:00:07Z",
    });
    db.close();
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/refund-candidates.ts", "list", "--db", path, "--since", "2026-11-04", "--json"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(out) as { count: number; since: string; candidates: Array<Record<string, unknown>> };
    assert.equal(parsed.since, "2026-11-04T00:00:00Z");
    assert.equal(parsed.count, 1);
    assert.equal(parsed.candidates[0]!.payment_id, TX);
    assert.equal(parsed.candidates[0]!.settled_at, "2026-11-04T01:00:07Z");
    const text = execFileSync(process.execPath, ["--import", "tsx", "scripts/refund-candidates.ts", "list", "--db", path], {
      encoding: "utf8",
    });
    assert.match(text, /refund_candidates: 2/);
    assert.match(text, /settle_error_unresolved/);
  });
});
