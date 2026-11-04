import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import type { SettleResponse } from "@x402/core/types";
import { createApp } from "../src/app.js";
import { NETWORK } from "../src/config.js";
import { setLiveSettleEmitForTests } from "../src/paid-call.js";
import {
  closePaidCallStore,
  initPaidCallStore,
  listPaidCallRowsFromStore,
  listRefundCandidatesFromStore,
} from "../src/paid-call-store.js";
import { attachPaidCallRecording, livePaymentMiddlewareFromServer, resourceServerFromFacilitator } from "../src/payments.js";
import { LATE_SETTLE_REASON, setFacilitatorTimeoutForTests } from "../src/processor-guard.js";
import { setRefundCandidateWriterForTests } from "../src/refund-candidate-log.js";
import { SETTLED_NO_RESPONSE_REASON } from "../src/settle-abort.js";
import { buildStatsDocument } from "../src/stats.js";
import { decodePaymentRequired } from "../src/x402-payload.js";

const LIVE_HTML = "<!doctype html><title>Apply now</title><body><a href=\"/apply\">Apply now</a></body>";
const EXTERNAL_PAYER = "0x7a11111111111111111111111111111111111111";
const INTERNAL_PAYER = "0x7b22222222222222222222222222222222222222";
const PAY_TO = "0x2222222222222222222222222222222222222222";

function txHash(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function paymentSignature(accepted: unknown, from: string, nonce: number): string {
  const envelope = {
    x402Version: 2,
    accepted,
    payload: { signature: "test-sig", authorization: { from, to: PAY_TO, value: "10000", nonce: txHash(nonce) } },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Stats = ReturnType<typeof buildStatsDocument> & Record<string, any>;

function snapshot() {
  const doc = buildStatsDocument() as Stats;
  const traffic = doc.traffic as any;
  return {
    all: traffic.all.payers.l7d.verify.calls as number,
    external: traffic.external.payers.l7d.verify.calls as number,
    internal: traffic.internal.calls.l7d as number,
    reconciled: traffic.reconciliation.ok as boolean,
    total: traffic.reconciliation.l7d.total as { calls: number; revenue_usd: number },
    late: doc.store.settle_late_paid_calls as { l7d: number; l30d: number },
  };
}

describe("late x402 settlements count as paid calls (live accounting)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-late-acct-"));
  const prevInternal = process.env.LIVECHECK_INTERNAL_WALLETS;
  let settleImpl: () => Promise<SettleResponse> = async () => {
    throw new Error("unset");
  };
  const facilitator: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
    },
    async verify() {
      return { isValid: true };
    },
    settle() {
      return settleImpl();
    },
  };
  const server = resourceServerFromFacilitator(facilitator);
  attachPaidCallRecording(server); // live wiring without Stripe
  const app = createApp(livePaymentMiddlewareFromServer(server, PAY_TO));
  let origin = "";
  let closeApp: () => void = () => {};
  const pages: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LIVE_HTML);
  });
  let pagesOrigin = "";

  before(async () => {
    process.env.LIVECHECK_INTERNAL_WALLETS = INTERNAL_PAYER;
    initPaidCallStore(join(dir, "paid-calls.sqlite"));
    setLiveSettleEmitForTests(true);
    setRefundCandidateWriterForTests(() => {});
    await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", () => resolve()));
    const address = pages.address();
    if (!address || typeof address === "string") throw new Error("expected tcp address");
    pagesOrigin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        closeApp = () => s.close();
        resolve();
      });
    });
  });

  after(async () => {
    closeApp();
    await new Promise<void>((resolve) => pages.close(() => resolve()));
    setLiveSettleEmitForTests(false);
    setRefundCandidateWriterForTests(null);
    setFacilitatorTimeoutForTests(null);
    closePaidCallStore();
    rmSync(dir, { recursive: true, force: true });
    if (prevInternal === undefined) delete process.env.LIVECHECK_INTERNAL_WALLETS;
    else process.env.LIVECHECK_INTERNAL_WALLETS = prevInternal;
  });

  afterEach(() => setFacilitatorTimeoutForTests(null));

  async function accepted(path: string): Promise<unknown> {
    const res = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${pagesOrigin}/job` }),
    });
    assert.equal(res.status, 402);
    return (decodePaymentRequired(res.headers.get("payment-required") ?? "").accepts as unknown[])[0];
  }

  function paid(path: string, signature: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": signature },
      body: JSON.stringify({ url: `${pagesOrigin}/job` }),
      ...(signal ? { signal } : {}),
    });
  }

  const rowsFor = (tx: string) => listPaidCallRowsFromStore().filter((r) => r.tx === tx);

  it("an in-time settle is one paid call with no late marker", async () => {
    const tx = txHash(0x101);
    settleImpl = async () => ({ success: true, transaction: tx, network: NETWORK, payer: EXTERNAL_PAYER });
    const before = snapshot();
    const res = await paid("/v1/verify", paymentSignature(await accepted("/v1/verify"), EXTERNAL_PAYER, 1));
    assert.equal(res.status, 200);
    await res.json();
    await waitFor(() => rowsFor(tx).length === 1);
    assert.equal(rowsFor(tx)[0]!.settle_late, undefined);
    const now = snapshot();
    assert.equal(now.all, before.all + 1);
    assert.equal(now.external, before.external + 1);
    assert.equal(now.late.l7d, 0);
    assert.equal(now.reconciled, true);
  });

  it("a late external settle: paid call in external marked settle_late, on the refund list, totals reconcile, a retry is not counted twice", async () => {
    setFacilitatorTimeoutForTests(40);
    const tx = txHash(0x102);
    let release: (value: SettleResponse) => void = () => {};
    settleImpl = () => new Promise((resolve) => (release = resolve));
    const before = snapshot();
    const signature = paymentSignature(await accepted("/v1/verify"), EXTERNAL_PAYER, 2);
    const res = await paid("/v1/verify", signature);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error?: string }).error, "payment_status_unknown");
    assert.equal(rowsFor(tx).length, 0, "nothing counted before the money settles");
    assert.equal(snapshot().all, before.all);

    release({ success: true, transaction: tx, network: NETWORK, payer: EXTERNAL_PAYER });
    await waitFor(() => rowsFor(tx).length === 1 && listRefundCandidatesFromStore().some((r) => r.payment_id === tx));
    const row = rowsFor(tx)[0]!;
    assert.equal(row.settle_late, true);
    assert.equal(row.route, "verify");
    assert.equal(row.payer, EXTERNAL_PAYER);
    assert.equal(row.protocol, "x402");
    const refund = listRefundCandidatesFromStore().filter((r) => r.payment_id === tx);
    assert.equal(refund.length, 1);
    assert.equal(refund[0]!.reason, LATE_SETTLE_REASON);

    const afterLate = snapshot();
    assert.equal(afterLate.all, before.all + 1);
    assert.equal(afterLate.external, before.external + 1, "late call lands in its usual bucket");
    assert.equal(afterLate.internal, before.internal);
    assert.equal(afterLate.late.l7d, before.late.l7d + 1);
    assert.equal(afterLate.reconciled, true, "buckets still add up to traffic.all");
    assert.equal(afterLate.total.calls, before.total.calls + 1);
    assert.equal(Math.round(afterLate.total.revenue_usd * 100), Math.round(before.total.revenue_usd * 100) + 1);

    // The caller retries after 60s with the same signature; the facilitator
    // answers with the same tx. Counted once, listed once.
    setFacilitatorTimeoutForTests(null);
    settleImpl = async () => ({ success: true, transaction: tx, network: NETWORK, payer: EXTERNAL_PAYER });
    const retry = await paid("/v1/verify", signature);
    assert.equal(retry.status, 200);
    await retry.json();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rowsFor(tx).length, 1, "no second paid call for the same tx");
    assert.equal(rowsFor(tx)[0]!.settle_late, true, "the first (late) row is kept");
    assert.equal(listRefundCandidatesFromStore().filter((r) => r.payment_id === tx).length, 1);
    const afterRetry = snapshot();
    assert.equal(afterRetry.all, afterLate.all);
    assert.equal(afterRetry.external, afterLate.external);
    assert.equal(afterRetry.late.l7d, afterLate.late.l7d);
    assert.equal(afterRetry.reconciled, true);
  });

  it("a late internal-wallet settle lands in internal, not external", async () => {
    setFacilitatorTimeoutForTests(40);
    const tx = txHash(0x103);
    let release: (value: SettleResponse) => void = () => {};
    settleImpl = () => new Promise((resolve) => (release = resolve));
    const before = snapshot();
    const res = await paid("/v1/verify/job", paymentSignature(await accepted("/v1/verify/job"), INTERNAL_PAYER, 3));
    assert.equal(res.status, 503);
    await res.text();
    release({ success: true, transaction: tx, network: NETWORK, payer: INTERNAL_PAYER });
    await waitFor(() => rowsFor(tx).length === 1);
    assert.equal(rowsFor(tx)[0]!.settle_late, true);
    assert.equal(rowsFor(tx)[0]!.route, "verify/job");
    const now = snapshot();
    assert.equal(now.internal, before.internal + 1);
    assert.equal(now.external, before.external);
    assert.equal(now.late.l7d, before.late.l7d + 1);
    assert.equal(now.reconciled, true);
  });

  it("paid then disconnected (x402): already one paid call (not late) plus a refund candidate", async () => {
    setFacilitatorTimeoutForTests(3_000);
    const tx = txHash(0x104);
    let started = false;
    let release: (value: SettleResponse) => void = () => {};
    settleImpl = () => {
      started = true;
      return new Promise((resolve) => (release = resolve));
    };
    const before = snapshot();
    const controller = new AbortController();
    const pending = paid("/v1/verify", paymentSignature(await accepted("/v1/verify"), EXTERNAL_PAYER, 4), controller.signal).catch(
      (error: unknown) => error,
    );
    await waitFor(() => started);
    controller.abort();
    assert.ok((await pending) instanceof Error);
    await new Promise((r) => setTimeout(r, 100));
    release({ success: true, transaction: tx, network: NETWORK, payer: EXTERNAL_PAYER });
    await waitFor(() => rowsFor(tx).length === 1 && listRefundCandidatesFromStore().some((r) => r.payment_id === tx));
    assert.equal(rowsFor(tx)[0]!.settle_late, undefined);
    assert.equal(listRefundCandidatesFromStore().find((r) => r.payment_id === tx)!.reason, SETTLED_NO_RESPONSE_REASON);
    const now = snapshot();
    assert.equal(now.all, before.all + 1);
    assert.equal(now.external, before.external + 1);
    assert.equal(now.reconciled, true);
  });
});

describe("settle_late column: migration, round-trip, dedup", () => {
  it("adds the column to an older paid_calls table and keeps one row per tx", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { migratePaidCallStore, insertPaidCallRow, listPaidCallRows, querySettleLateCounts, paidCallStoreTableColumns } =
      await import("../src/paid-call-store.js");
    const dir = mkdtempSync(join(tmpdir(), "lc-late-mig-"));
    try {
      const db = new DatabaseSync(join(dir, "old.sqlite"));
      db.exec("CREATE TABLE paid_calls (ts TEXT NOT NULL, route TEXT NOT NULL, payer TEXT, tx TEXT, payment_intent TEXT, host TEXT, url_sha256 TEXT)");
      db.exec(`INSERT INTO paid_calls (ts, route, tx, host, url_sha256) VALUES ('2026-11-01T00:00:00.000Z', 'verify', '0xold', 'example.com', '${"a".repeat(64)}')`);
      migratePaidCallStore(db);
      assert.ok(paidCallStoreTableColumns(db, "paid_calls").has("settle_late"));
      const ts = new Date().toISOString();
      const base = { ts, route: "verify" as const, payer: EXTERNAL_PAYER, tx: txHash(0x201), host: "example.com", url_sha256: "b".repeat(64) };
      assert.equal(insertPaidCallRow(db, { ...base, settle_late: true }), true);
      assert.equal(insertPaidCallRow(db, { ...base }), false, "same tx is not inserted twice");
      const rows = listPaidCallRows(db);
      assert.equal(rows.find((r) => r.tx === "0xold")?.settle_late, undefined);
      assert.equal(rows.filter((r) => r.tx === base.tx).length, 1);
      assert.equal(rows.find((r) => r.tx === base.tx)?.settle_late, true);
      assert.deepEqual(querySettleLateCounts(db, new Date()), { l7d: 1, l30d: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
