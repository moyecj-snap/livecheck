import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { USDC_BASE } from "../src/config.js";
import { DEFAULT_INTERNAL_WALLETS } from "../src/internal-wallets.js";
import { buildPaidCallEvent, hashUrl } from "../src/paid-call.js";
import {
  ATTRIBUTION_TX_TRANSFER,
  ATTRIBUTION_UNATTRIBUTED,
  NO_TX_ATTRIBUTION_NOTE,
  TX_TRANSFER_NOTE,
  USDC_TRANSFER_TOPIC,
} from "../src/settlement-payer.js";
import { testTrafficAddresses } from "../src/test-traffic.js";
import {
  closePaidCallStore,
  initPaidCallStore,
  insertPaidCallRow,
  listPaidCallRows,
  paidCallEventToRow,
  queryRetentionWindows,
  queryUnattributedWindows,
  recoverPaidCallPayers,
} from "../src/paid-call-store.js";
import { buildStatsDocument, statsHtml } from "../src/stats.js";
import { retainPaidCall } from "../src/paid-call-store.js";

const OUTSIDE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-10-07T18:00:00.000Z");
const WHEN = new Date("2026-10-06T12:00:00.000Z");

function insert(route: "verify" | "check" | "watch", payer: string | undefined, userAgent?: string, tx?: string) {
  const row = paidCallEventToRow(
    buildPaidCallEvent(
      {
        route,
        host: "example.com",
        url_hash: hashUrl(`https://example.com/${route}/${payer ?? "none"}/${userAgent ?? "ua"}`),
        status: route === "verify" ? "live" : undefined,
        intent: route === "verify" ? undefined : "status_change",
        verdict: route === "verify" ? undefined : "observed",
        user_agent: userAgent,
      },
      { payer, tx },
      WHEN,
    ),
  );
  assert.ok(row);
  const opened = initPaidCallStore(":memory:");
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("store closed");
  insertPaidCallRow(opened.db, row);
  return opened.db;
}

describe("paid_calls attribution", () => {
  afterEach(() => {
    closePaidCallStore();
  });

  it("counts a null payer in all and unattributed, and omits it from external", () => {
    const db = insert("watch", undefined);
    const excluded = [...DEFAULT_INTERNAL_WALLETS, ...testTrafficAddresses("grader"), ...testTrafficAddresses("tester")];
    const all = queryRetentionWindows(db, NOW);
    const external = queryRetentionWindows(db, NOW, excluded, [], { external: true });
    const unattributed = queryUnattributedWindows(db, NOW);
    assert.equal(all.l30d.watch.calls, 1);
    assert.equal(all.l30d.watch.unique_payers, 0);
    assert.equal(external.l30d.watch.calls, 0);
    assert.equal(external.l30d.watch.unique_payers, 0);
    assert.equal(unattributed.l30d.watch.calls, 1);
    const listed = listPaidCallRows(db);
    assert.equal(listed[0]?.payer, undefined);
    assert.equal(listed[0]?.attribution, ATTRIBUTION_UNATTRIBUTED);
    assert.equal(listed[0]?.attribution_note, NO_TX_ATTRIBUTION_NOTE);
  });

  it("counts a known outside wallet as external and omits internal and tester wallets", () => {
    closePaidCallStore();
    const opened = initPaidCallStore(":memory:");
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const rows = [
      { payer: OUTSIDE, route: "verify" as const },
      { payer: DEFAULT_INTERNAL_WALLETS[0], route: "check" as const },
      { payer: testTrafficAddresses("tester")[0], route: "watch" as const },
    ];
    for (const item of rows) {
      const row = paidCallEventToRow(
        buildPaidCallEvent(
          {
            route: item.route,
            host: "jobs.example.com",
            url_hash: hashUrl(`https://jobs.example.com/${item.route}`),
            status: item.route === "verify" ? "live" : undefined,
            intent: item.route === "verify" ? undefined : "status_change",
            verdict: item.route === "verify" ? undefined : "created",
          },
          { payer: item.payer, tx: `0x${item.payer.slice(2, 10).padEnd(64, "a")}` },
          WHEN,
        ),
      );
      assert.ok(row);
      insertPaidCallRow(opened.db, row);
    }
    const excluded = [...DEFAULT_INTERNAL_WALLETS, ...testTrafficAddresses("grader"), ...testTrafficAddresses("tester")];
    const all = queryRetentionWindows(opened.db, NOW);
    const external = queryRetentionWindows(opened.db, NOW, excluded, [], { external: true });
    assert.equal(all.l7d.verify.calls + all.l7d.check.calls + all.l7d.watch.calls, 3);
    assert.equal(external.l7d.verify.calls, 1);
    assert.equal(external.l7d.verify.unique_payers, 1);
    assert.equal(external.l7d.check.calls, 0);
    assert.equal(external.l7d.watch.calls, 0);
    assert.equal(queryUnattributedWindows(opened.db, NOW).l7d.verify.calls, 0);
  });

  it("omits a livecheck-internal user agent from external the same way as an internal wallet", () => {
    closePaidCallStore();
    const opened = initPaidCallStore(":memory:");
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const row = paidCallEventToRow(
      buildPaidCallEvent(
        {
          route: "verify",
          host: "example.com",
          url_hash: hashUrl("https://example.com/internal-ua"),
          status: "live",
          user_agent: "livecheck-internal/purl-0.2.8",
        },
        { payer: OUTSIDE, tx: `0x${"ee".repeat(32)}` },
        WHEN,
      ),
    );
    assert.ok(row);
    insertPaidCallRow(opened.db, row);
    const external = queryRetentionWindows(opened.db, NOW, [], [], { external: true });
    const all = queryRetentionWindows(opened.db, NOW);
    assert.equal(all.l7d.verify.calls, 1);
    assert.equal(all.l7d.verify.unique_payers, 1);
    assert.equal(external.l7d.verify.calls, 0);
    assert.equal(queryUnattributedWindows(opened.db, NOW).l7d.verify.calls, 0);
  });

  it("recovers the payer from a settlement tx and leaves a miss unattributed", async () => {
    closePaidCallStore();
    const opened = initPaidCallStore(":memory:");
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const tx = `0x${"ab".repeat(32)}`;
    insertPaidCallRow(opened.db, {
      ts: WHEN.toISOString(),
      route: "check",
      host: "example.com",
      url_sha256: hashUrl("https://example.com/recover"),
      tx,
      intent: "status_change",
      verdict: "observed",
    });
    const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
    const result = await recoverPaidCallPayers(opened.db, async () => ({
      payer: OUTSIDE,
      note: TX_TRANSFER_NOTE,
    }));
    assert.equal(result.recovered, 1);
    assert.equal(result.still_unattributed, 0);
    const recovered = listPaidCallRows(opened.db)[0];
    assert.equal(recovered?.payer, OUTSIDE);
    assert.equal(recovered?.attribution, ATTRIBUTION_TX_TRANSFER);
    assert.equal(topic(OUTSIDE).length, 66);
    assert.equal(USDC_TRANSFER_TOPIC.startsWith("0x"), true);
    assert.equal(USDC_BASE.startsWith("0x"), true);

    insertPaidCallRow(opened.db, {
      ts: new Date(WHEN.getTime() + 1000).toISOString(),
      route: "watch",
      host: "example.com",
      url_sha256: hashUrl("https://example.com/miss"),
      tx: `0x${"cd".repeat(32)}`,
      verdict: "created",
    });
    const miss = await recoverPaidCallPayers(opened.db, async () => ({
      note: "no USDC Transfer into payTo in the settlement tx",
    }));
    assert.equal(miss.recovered, 0);
    assert.equal(miss.still_unattributed, 1);
    const missed = listPaidCallRows(opened.db).find((row) => row.route === "watch");
    assert.equal(missed?.payer, undefined);
    assert.equal(missed?.attribution, ATTRIBUTION_UNATTRIBUTED);
  });

  it("publishes unattributed calls and revenue on /stats and keeps them out of external", () => {
    closePaidCallStore();
    initPaidCallStore(":memory:");
    assert.equal(
      retainPaidCall(
        buildPaidCallEvent(
          {
            route: "watch",
            host: "example.com",
            url_hash: hashUrl("https://example.com/backfill-watch"),
            intent: "status_change",
            verdict: "created",
          },
          {},
          WHEN,
        ),
      ),
      true,
    );
    assert.equal(
      retainPaidCall(
        buildPaidCallEvent(
          {
            route: "verify",
            host: "jobs.example.com",
            url_hash: hashUrl("https://jobs.example.com/customer"),
            status: "live",
          },
          { payer: OUTSIDE, tx: `0x${"11".repeat(32)}` },
          WHEN,
        ),
      ),
      true,
    );
    const doc = buildStatsDocument(NOW);
    assert.equal(doc.traffic.all.payers.l7d.watch.calls, 1);
    assert.equal(doc.traffic.all.payers.l7d.verify.calls, 1);
    assert.equal(doc.traffic.external.payers.l7d.watch.calls, 0);
    assert.equal(doc.traffic.external.payers.l7d.verify.calls, 1);
    assert.equal(doc.traffic.external.payers.l7d.verify.unique_payers, 1);
    assert.equal(doc.traffic.unattributed.available, true);
    assert.equal(doc.traffic.unattributed.calls.l7d, 1);
    assert.equal(doc.traffic.unattributed.calls.l30d, 1);
    assert.equal(doc.traffic.unattributed.revenue.l7d_usd, 2.5);
    assert.equal(doc.traffic.unattributed.revenue.l30d_usd, 2.5);
    assert.equal(doc.traffic.revenue.all.l7d_usd, 2.51);
    assert.equal(doc.traffic.revenue.external.l7d_usd, 0.01);
    const html = statsHtml(doc);
    assert.match(html, /unattributed/i);
    assert.match(html, /1 L7d \/ 1 L30d paid calls/);
    assert.match(doc.traffic.note, /livecheck-internal\//);
    assert.match(doc.traffic.note, /omitted from traffic\.external/);
  });
});
