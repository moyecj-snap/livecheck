import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { hashUrl } from "../src/paid-call.js";
import { recheckConfirmReceipts } from "../src/recheck-confirm-receipts.js";

function openPair() {
  const dir = mkdtempSync(join(tmpdir(), "recheck-"));
  const paidPath = join(dir, "paid-calls.sqlite");
  const receiptPath = join(dir, "receipts.sqlite");
  const paid = new DatabaseSync(paidPath);
  paid.exec(`
    CREATE TABLE paid_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      route TEXT NOT NULL,
      payer TEXT,
      tx TEXT,
      payment_intent TEXT,
      host TEXT NOT NULL,
      url_sha256 TEXT NOT NULL,
      intent TEXT,
      verdict TEXT,
      http_status INTEGER,
      user_agent TEXT,
      status TEXT
    );
  `);
  const receipts = new DatabaseSync(receiptPath);
  receipts.exec(`
    CREATE TABLE confirm_receipts (
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
  return { paid, receipts, paidPath, receiptPath };
}

function insertReceipt(
  db: DatabaseSync,
  row: { id: string; urlHash: string; canonical: string; createdAt: string },
) {
  db.prepare(
    `INSERT INTO confirm_receipts (
      id, intent, verdict, confidence, evidence_level, canonical_json, payload_hash,
      observed_at, url_hash, claim_hash, created_at
    ) VALUES (?, 'lead_submit', 'confirmed', 0.92, 2, ?, 'hash', ?, ?, 'claim', ?)`,
  ).run(row.id, row.canonical, row.createdAt, row.urlHash, row.createdAt);
}

function insertPaid(
  db: DatabaseSync,
  row: { ts: string; payer: string; urlHash: string; httpStatus: number },
) {
  db.prepare(
    `INSERT INTO paid_calls (ts, route, payer, host, url_sha256, intent, verdict, http_status)
     VALUES (?, 'confirm', ?, 'example.com', ?, 'lead_submit', 'confirmed', ?)`,
  ).run(row.ts, row.payer, row.urlHash, row.httpStatus);
}

function counts(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe("recheckConfirmReceipts", () => {
  it("flags stored rows without writing, and re-fetches only a raw URL", async () => {
    const { paid, receipts, paidPath, receiptPath } = openPair();
    const hashOnly = hashUrl("https://forms.example.com/hash-only");
    const non2xx = hashUrl("https://example.com/thank-you?ref=ABC123");
    const pageId = hashUrl("https://forms.example.com/received");
    const urlOnly = hashUrl("https://forms.example.com/thank-you?ref=ABC123");
    const payer = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";

    insertReceipt(receipts, {
      id: "cfm_hash",
      urlHash: hashOnly,
      canonical: JSON.stringify({ confidence: 0.92, evidence_level: 2 }),
      createdAt: "2026-10-07T16:00:00Z",
    });
    insertPaid(paid, { ts: "2026-10-07T16:00:01Z", payer, urlHash: hashOnly, httpStatus: 200 });

    insertReceipt(receipts, {
      id: "cfm_404",
      urlHash: non2xx,
      canonical: JSON.stringify({ confidence: 0.92, evidence_level: 2 }),
      createdAt: "2026-10-07T16:01:00Z",
    });
    insertPaid(paid, { ts: "2026-10-07T16:01:01Z", payer, urlHash: non2xx, httpStatus: 404 });

    insertReceipt(receipts, {
      id: "cfm_page",
      urlHash: pageId,
      canonical: JSON.stringify({
        url: "https://forms.example.com/received",
        confidence: 0.92,
        evidence_level: 2,
      }),
      createdAt: "2026-10-07T16:02:00Z",
    });

    insertReceipt(receipts, {
      id: "cfm_url",
      urlHash: urlOnly,
      canonical: JSON.stringify({
        url: "https://forms.example.com/thank-you?ref=ABC123",
        confidence: 0.92,
        evidence_level: 2,
        signals: ["confirmation_url_token"],
      }),
      createdAt: "2026-10-07T16:03:00Z",
    });

    const beforeReceipts = counts(receipts, "confirm_receipts");
    const beforePaid = counts(paid, "paid_calls");
    receipts.close();
    paid.close();

    const fetched: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const href = String(input);
      fetched.push(href);
      const html = href.includes("received")
        ? "<html><title>Thank you</title><body><p>We've received your request.</p><p>Confirmation number: ABC123</p></body></html>"
        : "<html><title>Thanks</title><body><p>Thank you</p></body></html>";
      return new Response(html, { status: 200 });
    };

    const report = await recheckConfirmReceipts({ paidCallDbPath: paidPath, receiptDbPath: receiptPath, fetchImpl });
    const byId = new Map(report.rows.map((row) => [row.receipt_id, row]));

    const hashRow = byId.get("cfm_hash");
    assert.ok(hashRow);
    assert.equal(hashRow.new_verdict, "cannot re-evaluate: hash only");
    assert.equal(hashRow.flag, "hash_only");
    assert.equal(hashRow.payer, payer);
    assert.equal(hashRow.url_sha256, hashOnly);

    const missing = byId.get("cfm_404");
    assert.ok(missing);
    assert.equal(missing.new_verdict, "unknown");
    assert.equal(missing.flag, "non_2xx");
    assert.equal(missing.payer, payer);

    const printed = byId.get("cfm_page");
    assert.ok(printed);
    assert.equal(printed.new_verdict, "confirmed");
    assert.equal(printed.flag, "still_confirmed");

    const token = byId.get("cfm_url");
    assert.ok(token);
    assert.equal(token.new_verdict, "unknown");
    assert.equal(token.flag, "url_token_only");

    assert.deepEqual(fetched.sort(), [
      "https://forms.example.com/received",
      "https://forms.example.com/thank-you?ref=ABC123",
    ]);
    assert.equal(report.rows.some((row) => row.original_evidence.includes("https://")), false);

    const paidAfter = new DatabaseSync(paidPath, { readOnly: true });
    const receiptsAfter = new DatabaseSync(receiptPath, { readOnly: true });
    try {
      assert.equal(counts(receiptsAfter, "confirm_receipts"), beforeReceipts);
      assert.equal(counts(paidAfter, "paid_calls"), beforePaid);
      const still = paidAfter
        .prepare(`SELECT verdict, http_status FROM paid_calls WHERE url_sha256 = ?`)
        .get(non2xx) as { verdict: string; http_status: number };
      assert.equal(still.verdict, "confirmed");
      assert.equal(still.http_status, 404);
    } finally {
      paidAfter.close();
      receiptsAfter.close();
    }
  });
});
