import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_INTERNAL_WALLETS } from "../src/internal-wallets.js";
import { buildPaidCallEvent, hashUrl, type PaidCallRoute } from "../src/paid-call.js";
import {
  closePaidCallStore,
  initPaidCallStore,
  insertPaidCallRow,
  insertRefundCandidate,
  listPaidCallRows,
  listRefundCandidates,
  migratePaidCallStore,
  parsePaidCallLogLine,
} from "../src/paid-call-store.js";
import { buildStatsDocument, statsHtml } from "../src/stats.js";
import { buildProtocolTraffic, protocolTableHtml } from "../src/stats-protocols.js";
import { decodeMppValue, encodeMppValue, openMppStore } from "../src/mpp-store.js";

const INTERNAL = DEFAULT_INTERNAL_WALLETS[0]!;
const OUTSIDE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REAL_URL = hashUrl("https://jobs.example.com/opening-42");
const NOW = new Date("2026-10-08T03:00:00Z");

function openStore() {
  const opened = initPaidCallStore(":memory:");
  assert.equal(opened.ok, true);
  return opened as ReturnType<typeof initPaidCallStore> & { ok: true };
}

let n = 0;
function insert(
  db: ReturnType<typeof openStore>,
  route: PaidCallRoute,
  payer: string | undefined,
  protocol?: "x402" | "mpp_tempo",
  ts = "2026-10-07T20:00:00Z",
) {
  n += 1;
  assert.equal(
    insertPaidCallRow(db.db, {
      ts,
      route,
      host: "example.com",
      url_sha256: REAL_URL,
      ...(payer ? { payer } : {}),
      tx: `0x${n.toString(16).padStart(64, "0")}`,
      ...(protocol ? { protocol } : {}),
    }),
    true,
  );
}

describe("/stats: MPP and x402 as separate lines per route", () => {
  afterEach(() => closePaidCallStore());

  it("splits each route by protocol, sums to all traffic, and MPP payers use the same buckets", () => {
    const db = openStore();
    insert(db, "verify", OUTSIDE); // legacy shape: no protocol -> x402
    insert(db, "verify", OUTSIDE, "x402");
    insert(db, "verify", OUTSIDE, "mpp_tempo"); // known Tempo payer, on no list -> external
    insert(db, "verify/job", undefined, "mpp_tempo"); // MPP with no payer -> unattributed, never external
    insert(db, "verify/listing", INTERNAL, "mpp_tempo"); // our own Tempo wallet -> internal
    insert(db, "check", OUTSIDE); // x402 only route
    insert(db, "verify/job", OUTSIDE, "mpp_tempo", "2026-09-20T00:00:00Z"); // L30d only

    const doc = buildStatsDocument(NOW);
    const p = doc.traffic.protocols;
    assert.ok(p);
    assert.equal(p.available, true);
    assert.equal(p.ok, true, p.warning ?? "");
    assert.deepEqual(p.protocols, ["x402", "mpp_tempo"]);
    assert.deepEqual(p.l7d.routes.verify, {
      x402: { calls: 2, revenue_usd: 0.02 },
      mpp_tempo: { calls: 1, revenue_usd: 0.01 },
    });
    assert.deepEqual(p.l7d.routes["verify/job"].mpp_tempo, { calls: 1, revenue_usd: 0.01 });
    assert.deepEqual(p.l30d.routes["verify/job"].mpp_tempo, { calls: 2, revenue_usd: 0.02 });
    assert.deepEqual(p.l7d.routes["verify/listing"].mpp_tempo, { calls: 1, revenue_usd: 0.01 });
    assert.deepEqual(p.l7d.routes.check, {
      x402: { calls: 1, revenue_usd: 0.02 },
      mpp_tempo: { calls: 0, revenue_usd: 0 },
    });
    assert.deepEqual(p.l7d.totals.mpp_tempo, { calls: 3, revenue_usd: 0.03 });
    assert.deepEqual(p.l7d.totals.x402, { calls: 3, revenue_usd: 0.04 });
    assert.deepEqual(p.l7d.sum, { calls: 6, revenue_usd: 0.07 });
    assert.deepEqual(p.l7d.all, { calls: 6, revenue_usd: 0.07 });
    assert.deepEqual(p.l7d.gap, { calls: 0, revenue_usd: 0 });
    assert.deepEqual(p.l30d.gap, { calls: 0, revenue_usd: 0 });

    // Bucket reconciliation still sums with MPP rows in it.
    const t = doc.traffic;
    assert.equal(t.reconciliation.ok, true);
    assert.deepEqual(t.reconciliation.l7d.total, { calls: 6, revenue_usd: 0.07 });
    assert.deepEqual(t.reconciliation.l7d.by_bucket.unattributed, { calls: 1, revenue_usd: 0.01 });
    assert.deepEqual(t.reconciliation.l7d.by_bucket.internal, { calls: 1, revenue_usd: 0.01 });
    assert.deepEqual(t.reconciliation.l7d.by_bucket.external, { calls: 4, revenue_usd: 0.05 });

    const html = statsHtml(doc);
    assert.match(html, /Payments by route and protocol/);
    assert.match(html, /MPP \(Tempo\)/);
    assert.match(html, /x402 \(Base\)/);
    assert.match(html, /Payment lines add up to all traffic/);
  });

  it("with no MPP rows (flag off) every line is x402 and MPP lines are zero", () => {
    const db = openStore();
    insert(db, "verify", OUTSIDE);
    insert(db, "confirm", OUTSIDE);
    const p = buildStatsDocument(NOW).traffic.protocols;
    assert.ok(p);
    assert.equal(p.ok, true);
    assert.deepEqual(p.l7d.totals.mpp_tempo, { calls: 0, revenue_usd: 0 });
    assert.deepEqual(p.l7d.totals.x402, { calls: 2, revenue_usd: 0.11 });
  });

  it("warns when the protocol lines do not add up", () => {
    const counts = { verify: { x402: { calls: 2, revenue_cents: 2 }, mpp_tempo: { calls: 1, revenue_cents: 1 } } };
    const p = buildProtocolTraffic(
      { l7d: counts, l30d: counts },
      { l7d: { calls: 4, revenue_usd: 0.04 }, l30d: { calls: 3, revenue_usd: 0.03 } },
    );
    assert.equal(p.ok, false);
    assert.match(p.warning ?? "", /do not add up/);
    assert.match(p.warning ?? "", /L7d: all 4 calls/);
    assert.deepEqual(p.l7d.gap, { calls: 1, revenue_usd: 0.01 });
    assert.match(protocolTableHtml(p), /role="alert"/);
    const unchecked = buildProtocolTraffic({ l7d: counts, l30d: counts }, null);
    assert.equal(unchecked.ok, false);
    assert.match(unchecked.warning ?? "", /not checked/);
    const closed = buildProtocolTraffic(undefined, null);
    assert.equal(closed.available, false);
  });
});

describe("paid_calls protocol column", () => {
  afterEach(() => closePaidCallStore());

  it("an old table without the column migrates in place and reads back as x402", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE paid_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
      route TEXT NOT NULL CHECK (route IN ('verify', 'verify/job', 'verify/listing', 'confirm', 'confirm/order', 'check', 'watch', 'watch/renew')),
      payer TEXT, tx TEXT, payment_intent TEXT, host TEXT NOT NULL, url_sha256 TEXT NOT NULL)`);
    db.prepare("INSERT INTO paid_calls (ts, route, payer, tx, host, url_sha256) VALUES (?, ?, ?, ?, ?, ?)").run(
      "2026-10-01T00:00:00Z",
      "verify",
      OUTSIDE,
      `0x${"ab".repeat(32)}`,
      "example.com",
      REAL_URL,
    );
    migratePaidCallStore(db);
    const raw = db.prepare("SELECT protocol FROM paid_calls").get() as { protocol: string | null };
    assert.equal(raw.protocol, null, "existing rows are not rewritten");
    assert.equal(listPaidCallRows(db)[0]?.protocol, "x402");
    migratePaidCallStore(db); // idempotent
    db.close();
  });

  it("the x402 log line has no protocol field; the MPP line does, and both parse back", () => {
    const remembered = { route: "verify" as const, host: "jobs.example.com", url_hash: REAL_URL, status: "live" as const };
    const settlement = { payer: OUTSIDE, tx: `0x${"cd".repeat(32)}` };
    const x402 = buildPaidCallEvent(remembered, settlement);
    assert.equal("protocol" in x402, false);
    const mpp = buildPaidCallEvent(remembered, { ...settlement, protocol: "mpp_tempo" });
    assert.equal(mpp.protocol, "mpp_tempo");
    assert.equal(parsePaidCallLogLine(JSON.stringify(mpp))?.protocol, "mpp_tempo");
    assert.equal(parsePaidCallLogLine(JSON.stringify(x402))?.protocol, undefined);
  });

  it("refund candidates are one row per payment and keep no URL", () => {
    const db = openStore();
    const candidate = {
      ts: "2026-10-08T18:00:00Z",
      protocol: "mpp_tempo" as const,
      payment_id: `0x${"ef".repeat(32)}`,
      route: "verify" as const,
      reason: "handler_status_502",
      payer: OUTSIDE,
      http_status: 502,
    };
    assert.equal(insertRefundCandidate(db.db, candidate), true);
    assert.equal(insertRefundCandidate(db.db, candidate), false, "same payment twice is one row");
    assert.equal(insertRefundCandidate(db.db, { ...candidate, payment_id: `0x${"ee".repeat(32)}`, reason: "https://x.y/z?q" }), true);
    const rows = listRefundCandidates(db.db);
    assert.equal(rows.length, 2);
    assert.equal(rows.some((r) => r.reason.includes("/")), false);
  });
});

describe("mppx store (SQLite)", () => {
  it("round-trips bigint, updates atomically, and persists across reopen", async () => {
    assert.equal((decodeMppValue(encodeMppValue({ a: 10n ** 30n })) as { a: bigint }).a, 10n ** 30n);
    const dir = mkdtempSync(join(tmpdir(), "lc-mppstore-"));
    const path = join(dir, "mpp.sqlite");
    try {
      const store = openMppStore(path);
      assert.equal(await store.get("missing"), null);
      await store.put("k", { amount: 5n, used: false });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          store.update("counter", (current) => {
            const next = ((current as number | null) ?? 0) + 1;
            return { op: "set", value: next, result: next };
          }),
        ),
      );
      assert.deepEqual(new Set(results).size, 20);
      // Replay guard shape: first claim wins, second sees it used.
      const claim = () =>
        store.update("hash:0x1", (current) =>
          current ? { op: "noop", result: false } : { op: "set", value: { used: true }, result: true },
        );
      assert.equal(await claim(), true);
      assert.equal(await claim(), false);
      await assert.rejects(
        store.update("k", () => {
          throw new Error("boom");
        }),
      );
      assert.deepEqual(await store.get("k"), { amount: 5n, used: false }, "failed update rolled back");
      await store.delete("hash:0x1");
      store.close();
      const reopened = openMppStore(path);
      assert.equal(await reopened.get("counter"), 20);
      assert.deepEqual(await reopened.get("k"), { amount: 5n, used: false });
      assert.equal(await reopened.get("hash:0x1"), null);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
