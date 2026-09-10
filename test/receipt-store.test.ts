import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { createPublicKey } from "node:crypto";
import { createApp } from "../src/app.js";
import { isCheckId, isConfirmId, isEventId, isWatchId, newWatchId } from "../src/confirm-id.js";
import {
  generateReceiptPrivateKeyPem,
  lookupReceiptResponse,
  parseReceiptPrivateKey,
  resetReceiptSignerCache,
  sealCheckResult,
  sealConfirmResult,
  sealWatchEventReceipt,
  sealWatchResult,
  sha256Hex,
  verifyCanonical,
} from "../src/receipt.js";
import {
  clearConfirmReceiptMemory,
  closeReceiptStore,
  getConfirmReceipt,
  initReceiptStore,
  migrateReceiptStore,
  receiptStoreTableColumns,
} from "../src/receipt-store.js";
import type { CheckObservation, ConfirmResult, WatchCreateResult } from "../src/types.js";

/** Older confirm_receipts shape — no claim_hash / created_at, no indexes. */
const LEGACY_RECEIPTS_SCHEMA = `
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
  url_hash TEXT NOT NULL
);
`;

function writeLegacyReceiptsDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(LEGACY_RECEIPTS_SCHEMA);
  db.prepare(
    `INSERT INTO confirm_receipts (
      id, intent, verdict, confidence, evidence_level, canonical_json, payload_hash,
      signature, signer, observed_at, url_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "cfm_01LEGACYRECEIPT000000000001",
    "lead_submit",
    "confirmed",
    0.92,
    2,
    '{"id":"cfm_01LEGACYRECEIPT000000000001"}',
    "ab".repeat(32),
    null,
    null,
    "2026-09-10T18:00:00Z",
    "cd".repeat(32),
  );
  const cols = receiptStoreTableColumns(db, "confirm_receipts");
  assert.equal(cols.has("claim_hash"), false);
  assert.equal(cols.has("created_at"), false);
  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'confirm_receipts'`)
    .all() as Array<{ name: string }>;
  assert.equal(
    indexes.some((row) => row.name === "idx_confirm_receipts_created"),
    false,
  );
  assert.throws(() => {
    db.exec("CREATE INDEX idx_confirm_receipts_created ON confirm_receipts(created_at)");
  }, /no such column: created_at/i);
  db.close();
}

function stubConfirm(): ConfirmResult {
  return {
    verdict: "confirmed",
    effect: { type: "lead_submit", id: "ABC123" },
    evidence_strength: 2,
    signals: ["confirmation id"],
    independent_signals: 1,
    independent_evidence: true,
    evidence_id: "ABC123",
    http_status: 200,
    fetched_at: "2026-09-10T18:00:00Z",
    url: "https://example.com/thanks",
    canonical_url: "https://example.com/thanks",
    price_usd: 0.1,
    evidence_level: 2,
    confidence: 0.92,
  };
}

function stubObservation(url: string): CheckObservation {
  return {
    status: "live",
    signals: ["apply form present"],
    http_status: 200,
    http_class: "2xx",
    hash: "aa".repeat(32),
    summary: "live 2xx (200); apply form present",
    checked_at: "2026-09-10T18:00:00Z",
    canonical_url: url,
  };
}

function stubWatch(id: string, url: string): Omit<WatchCreateResult, "receipt"> {
  return {
    id,
    tier: "standard",
    status: "active",
    owner_token: "owt_01TESTOWNERTOKEN0000000001",
    expires_at: "2026-10-10T18:00:00Z",
    checks_remaining: 2880,
    interval_s: 900,
    first_check_at: "2026-09-10T18:00:00Z",
    next_check_at: "2026-09-10T18:15:00Z",
    baseline: { captured: true, hash: "aa".repeat(32), summary: "live 2xx" },
    target: { type: "url", url, render: "never", selector: null },
    condition: { detector: "status_change", params: {} },
    price_usd: 2.5,
    run: "none",
    on_change: { run: "none" },
    chain_budget_usd: null,
    chain_balance_usd: 0,
  };
}

describe("receipt store legacy migrate", () => {
  const dir = mkdtempSync(join(tmpdir(), "livecheck-receipt-migrate-"));
  const path = join(dir, "receipts.sqlite");

  after(() => {
    closeReceiptStore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ALTERs missing columns before creating indexes (idempotent)", () => {
    writeLegacyReceiptsDb(path);

    const opened = initReceiptStore(path);
    if (!opened.ok) throw new Error(opened.reason);

    const cols = receiptStoreTableColumns(opened.db, "confirm_receipts");
    assert.equal(cols.has("claim_hash"), true);
    assert.equal(cols.has("created_at"), true);
    const indexes = opened.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'confirm_receipts'`)
      .all() as Array<{ name: string }>;
    assert.ok(indexes.some((row) => row.name === "idx_confirm_receipts_created"));
    assert.ok(indexes.some((row) => row.name === "idx_confirm_receipts_intent_created"));

    const legacy = getConfirmReceipt("cfm_01LEGACYRECEIPT000000000001");
    assert.ok(legacy);
    assert.equal(legacy.intent, "lead_submit");
    assert.equal(legacy.claim_hash, "");
    assert.equal(legacy.created_at, "");

    migrateReceiptStore(opened.db);
    migrateReceiptStore(opened.db);
    const again = initReceiptStore(path);
    if (!again.ok) throw new Error(again.reason);
    assert.ok(getConfirmReceipt("cfm_01LEGACYRECEIPT000000000001"));
  });
});

describe("receipt sqlite survives close/reopen", () => {
  const pem = generateReceiptPrivateKeyPem();
  const dir = mkdtempSync(join(tmpdir(), "livecheck-receipt-persist-"));
  const path = join(dir, "receipts.sqlite");
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};
  let previous: string | undefined;

  before(async () => {
    previous = process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    process.env.CONFIRM_RECEIPT_PRIVATE_KEY = pem;
    resetReceiptSignerCache();
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  afterEach(() => {
    closeReceiptStore();
    clearConfirmReceiptMemory();
  });

  after(() => {
    close();
    closeReceiptStore();
    clearConfirmReceiptMemory();
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    else process.env.CONFIRM_RECEIPT_PRIVATE_KEY = previous;
    resetReceiptSignerCache();
  });

  it("write → close DB → reopen → GET /v1/receipt/{id} for cfm_/chk_/wtc_/evt_", async () => {
    const opened = initReceiptStore(path);
    if (!opened.ok) throw new Error(opened.reason);

    const url = "https://boards.greenhouse.io/example/jobs/1842";
    const confirm = sealConfirmResult(stubConfirm(), { intent: "lead_submit", url, requestUrl: origin });
    const check = sealCheckResult(
      {
        target: { type: "url", url, render: "never", selector: null },
        condition: { detector: "status_change", params: {} },
        observation: stubObservation(url),
        fired: null,
        confidence: 0.82,
        price_usd: 0.02,
      },
      { url, requestUrl: origin },
    );
    const watchId = newWatchId();
    const watch = sealWatchResult(stubWatch(watchId, url), {
      url,
      requestUrl: origin,
      observation: stubObservation(url),
    });
    const event = sealWatchEventReceipt({
      type: "change",
      url,
      createdAt: "2026-09-10T18:05:00Z",
      confidence: 0.82,
      watcherId: watch.id,
      requestUrl: origin,
    });

    assert.equal(isConfirmId(confirm.id ?? ""), true);
    assert.equal(isCheckId(check.id), true);
    assert.equal(isWatchId(watch.id), true);
    assert.match(event.verify_url, /\/v1\/receipt\/evt_/);
    const eventId = event.verify_url.split("/").pop() ?? "";
    assert.equal(isEventId(eventId), true);

    assert.ok(confirm.receipt?.signature);
    assert.ok(check.receipt.signature);
    assert.ok(watch.receipt.signature);
    assert.ok(event.signature);
    assert.equal(confirm.receipt?.signer, "livecheck-confirm-v1");
    assert.equal(check.receipt.signer, "livecheck-confirm-v1");
    assert.equal(watch.receipt.signer, "livecheck-confirm-v1");
    assert.equal(event.signer, "livecheck-confirm-v1");

    const expected = [
      { id: confirm.id!, hash: confirm.receipt!.hash, signature: confirm.receipt!.signature!, intent: "lead_submit" },
      { id: check.id, hash: check.receipt.hash, signature: check.receipt.signature!, intent: "check" },
      { id: watch.id, hash: watch.receipt.hash, signature: watch.receipt.signature!, intent: "watch" },
      { id: eventId, hash: event.hash, signature: event.signature!, intent: "watch_event" },
    ];
    const publicKey = createPublicKey(parseReceiptPrivateKey(pem));

    closeReceiptStore();
    clearConfirmReceiptMemory();
    assert.equal(getConfirmReceipt(confirm.id!), undefined);

    const reopened = initReceiptStore(path);
    if (!reopened.ok) throw new Error(reopened.reason);

    for (const item of expected) {
      const row = getConfirmReceipt(item.id);
      assert.ok(row, `sqlite missed ${item.id}`);
      assert.equal(row.intent, item.intent);
      assert.equal(row.payload_hash, item.hash);
      assert.equal(row.signature, item.signature);
      assert.equal(sha256Hex(row.canonical_json), item.hash);
      assert.equal(verifyCanonical(row.canonical_json, item.signature, publicKey), true);

      const looked = lookupReceiptResponse(item.id, origin);
      assert.ok(looked);
      assert.equal(looked.id, item.id);
      assert.equal((looked.verify as { valid?: boolean }).valid, true);

      const res = await fetch(`${origin}/v1/receipt/${item.id}`);
      assert.equal(res.status, 200, `GET /v1/receipt/${item.id}`);
      const body = (await res.json()) as {
        id: string;
        intent: string;
        canonical: string;
        receipt: { hash: string; signature: string };
        verify: { signed: boolean; valid: boolean | null; alg: string };
      };
      assert.equal(body.id, item.id);
      assert.equal(body.intent, item.intent);
      assert.equal(body.receipt.hash, item.hash);
      assert.equal(body.receipt.signature, item.signature);
      assert.equal(body.verify.signed, true);
      assert.equal(body.verify.valid, true);
      assert.equal(body.verify.alg, "Ed25519");
      assert.equal(sha256Hex(body.canonical), item.hash);
    }
  });
});
