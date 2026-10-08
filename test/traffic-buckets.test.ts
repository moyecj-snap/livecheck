import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DOCS_EXAMPLE_URL, DOCS_EXAMPLE_URL_SHA256, docsExampleUrlHashes } from "../src/docs-example-url.js";
import { DEFAULT_GRADER_WALLETS } from "../src/grader-wallets.js";
import { DEFAULT_INTERNAL_WALLETS } from "../src/internal-wallets.js";
import { hashUrl, type PaidCallRoute } from "../src/paid-call.js";
import {
  closePaidCallStore,
  initPaidCallStore,
  insertPaidCallRow,
  queryTrafficBucketWindows,
} from "../src/paid-call-store.js";
import { buildStatsDocument, reconcileTraffic, statsHtml } from "../src/stats.js";
import { mergeFleetStats } from "../src/stats-fleet.js";
import { testTrafficAddresses } from "../src/test-traffic.js";
import {
  TRAFFIC_BUCKET_ORDER,
  bucketPaidCallRows,
  classifyPaidCallBucket,
  type TrafficBucketLists,
} from "../src/traffic-buckets.js";

const INTERNAL = DEFAULT_INTERNAL_WALLETS[0]!;
const GRADER = DEFAULT_GRADER_WALLETS[0]!;
const TESTER = testTrafficAddresses("tester")[0]!;
const OUTSIDE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROBABLE = "0xe3badbd4f38214b9eae528a1a5398f6678f63fb3";
const DOCS = DOCS_EXAMPLE_URL_SHA256;
const REAL_URL = hashUrl("https://jobs.example.com/opening-42");

const LISTS: TrafficBucketLists = {
  internal: DEFAULT_INTERNAL_WALLETS,
  graders: DEFAULT_GRADER_WALLETS,
  testers: [TESTER],
  docsExampleUrlSha256: docsExampleUrlHashes(),
};

const NOW = new Date("2026-10-08T03:00:00Z");

describe("traffic bucket rules (first match wins)", () => {
  it("rule 1: an internal wallet is Internal, with or without a docs URL", () => {
    assert.equal(classifyPaidCallBucket({ payer: INTERNAL, url_sha256: REAL_URL }, LISTS), "internal");
    assert.equal(classifyPaidCallBucket({ payer: INTERNAL, url_sha256: DOCS }, LISTS), "internal");
    assert.equal(classifyPaidCallBucket({ payer: INTERNAL.toUpperCase().replace("0X", "0x") }, LISTS), "internal");
  });

  it("rule 2: grader and tester wallets are Graders / Testers, even on a docs-example URL", () => {
    assert.equal(classifyPaidCallBucket({ payer: GRADER, url_sha256: REAL_URL }, LISTS), "graders");
    assert.equal(classifyPaidCallBucket({ payer: GRADER, url_sha256: DOCS }, LISTS), "graders");
    assert.equal(classifyPaidCallBucket({ payer: TESTER, url_sha256: DOCS }, LISTS), "testers");
    assert.equal(classifyPaidCallBucket({ payer: TESTER, url_sha256: REAL_URL }, LISTS), "testers");
  });

  it("rule 3: no payer is Unattributed, even on a docs-example URL", () => {
    assert.equal(classifyPaidCallBucket({ payer: null, url_sha256: DOCS }, LISTS), "unattributed");
    assert.equal(classifyPaidCallBucket({ payer: "   ", url_sha256: DOCS }, LISTS), "unattributed");
    assert.equal(classifyPaidCallBucket({ url_sha256: REAL_URL }, LISTS), "unattributed");
  });

  it("rule 4: an unknown payer on a docs-example URL is Testers (probable)", () => {
    assert.equal(classifyPaidCallBucket({ payer: PROBABLE, url_sha256: DOCS }, LISTS), "testers_probable");
    assert.equal(classifyPaidCallBucket({ payer: PROBABLE, url_sha256: DOCS.toUpperCase() }, LISTS), "testers_probable");
  });

  it("rule 5: an unknown payer on any other URL is External", () => {
    assert.equal(classifyPaidCallBucket({ payer: OUTSIDE, url_sha256: REAL_URL }, LISTS), "external");
    assert.equal(classifyPaidCallBucket({ payer: OUTSIDE }, LISTS), "external");
  });

  it("precedence: internal beats grader, grader beats tester", () => {
    const overlap: TrafficBucketLists = {
      internal: [OUTSIDE],
      graders: [OUTSIDE, PROBABLE],
      testers: [OUTSIDE, PROBABLE, INTERNAL],
      docsExampleUrlSha256: [DOCS],
    };
    assert.equal(classifyPaidCallBucket({ payer: OUTSIDE, url_sha256: DOCS }, overlap), "internal");
    assert.equal(classifyPaidCallBucket({ payer: PROBABLE, url_sha256: DOCS }, overlap), "graders");
    assert.equal(classifyPaidCallBucket({ payer: INTERNAL, url_sha256: DOCS }, overlap), "testers");
  });

  it("every row lands in exactly one bucket and windows use ts >= cutoff", () => {
    const rows = [
      { ts: "2026-10-07T12:00:00Z", route: "verify", payer: INTERNAL, url_sha256: REAL_URL },
      { ts: "2026-10-07T12:00:00Z", route: "confirm", payer: GRADER, url_sha256: DOCS },
      { ts: "2026-10-07T12:00:00Z", route: "check", payer: null, url_sha256: DOCS },
      { ts: "2026-09-14T12:00:00Z", route: "verify/job", payer: PROBABLE, url_sha256: DOCS },
      { ts: "2026-10-07T12:00:00Z", route: "watch", payer: OUTSIDE, url_sha256: REAL_URL },
      { ts: "2026-10-07T12:00:00Z", route: "not-a-route", payer: OUTSIDE, url_sha256: REAL_URL },
    ];
    const out = bucketPaidCallRows(rows, { l7d: "2026-10-01T03:00:00Z", l30d: "2026-09-08T03:00:00Z" }, LISTS);
    assert.equal(out.internal.l30d.calls, 1);
    assert.equal(out.graders.l30d.revenue_cents, 10);
    assert.equal(out.unattributed.l30d.revenue_cents, 2);
    assert.equal(out.unattributed.l30d.unique_payers, 0);
    assert.equal(out.testers_probable.l30d.calls, 1);
    assert.equal(out.testers_probable.l7d.calls, 0);
    assert.equal(out.external.l30d.revenue_cents, 250);
    const total = TRAFFIC_BUCKET_ORDER.reduce((sum, bucket) => sum + out[bucket].l30d.calls, 0);
    assert.equal(total, 5);
  });
});

function insert(
  db: ReturnType<typeof initPaidCallStore> & { ok: true },
  ts: string,
  route: PaidCallRoute,
  payer: string | undefined,
  urlSha256: string,
  userAgent?: string,
  n = 0,
) {
  assert.equal(
    insertPaidCallRow(db.db, {
      ts,
      route,
      host: "example.com",
      url_sha256: urlSha256,
      ...(payer ? { payer } : {}),
      tx: `0x${(n + 1).toString(16).padStart(64, "0")}`,
      ...(userAgent ? { user_agent: userAgent } : {}),
    }),
    true,
  );
}

function openStore() {
  const opened = initPaidCallStore(":memory:");
  assert.equal(opened.ok, true);
  return opened as ReturnType<typeof initPaidCallStore> & { ok: true };
}

describe("/stats buckets and reconciliation", () => {
  afterEach(() => closePaidCallStore());

  it("puts each prod-shaped row in one bucket and the buckets add up", () => {
    const db = openStore();
    let n = 0;
    // internal wallet, no user agent at all -> Internal
    insert(db, "2026-10-07T20:00:00Z", "check", INTERNAL, REAL_URL, undefined, n++);
    // internal wallet with the internal label -> Internal
    insert(db, "2026-10-07T20:01:00Z", "confirm", INTERNAL, REAL_URL, "livecheck-internal/purl-0.2.8", n++);
    // grader on the docs-example URL -> Graders, not Testers (probable)
    insert(db, "2026-10-07T20:02:00Z", "verify/job", GRADER, DOCS, undefined, n++);
    // docs-example tester -> Testers
    insert(db, "2026-10-07T20:03:00Z", "verify", TESTER, DOCS, undefined, n++);
    // null payer on the docs-example URL -> Unattributed
    insert(db, "2026-10-07T20:04:00Z", "check", undefined, DOCS, undefined, n++);
    // unknown payer on the docs-example URL (row 24 shape) -> Testers (probable)
    insert(db, "2026-09-14T18:00:00Z", "verify", PROBABLE, hashUrl(DOCS_EXAMPLE_URL), undefined, n++);
    // outside wallet that sends the internal label -> still External
    insert(db, "2026-10-07T20:05:00Z", "verify", OUTSIDE, REAL_URL, "livecheck-internal/purl-0.2.8", n++);

    const doc = buildStatsDocument(NOW);
    const t = doc.traffic;
    assert.deepEqual(t.internal.calls, { l7d: 2, l30d: 2 });
    assert.deepEqual(t.internal.revenue, { l7d_usd: 0.12, l30d_usd: 0.12 });
    assert.deepEqual(t.graders.calls, { l7d: 1, l30d: 1 });
    assert.deepEqual(t.graders.revenue, { l7d_usd: 0.01, l30d_usd: 0.01 });
    assert.deepEqual(t.testers.calls, { l7d: 1, l30d: 1 });
    assert.deepEqual(t.testers.revenue, { l7d_usd: 0.01, l30d_usd: 0.01 });
    assert.deepEqual(t.unattributed.calls, { l7d: 1, l30d: 1 });
    assert.deepEqual(t.unattributed.revenue, { l7d_usd: 0.02, l30d_usd: 0.02 });
    assert.equal(t.testers_probable.available, true);
    assert.deepEqual(t.testers_probable.calls, { l7d: 0, l30d: 1 });
    assert.deepEqual(t.testers_probable.revenue, { l7d_usd: 0, l30d_usd: 0.01 });
    assert.deepEqual(t.testers_probable.unique_payers, { l7d: 0, l30d: 1 });
    assert.equal(t.external.payers.l30d.verify.calls, 1);
    assert.equal(t.revenue.external.l30d_usd, 0.01);
    assert.equal(t.revenue.all.l30d_usd, 0.18);

    // docs_example and internal_label are overlap counts, outside the sum.
    assert.equal(t.docs_example.calls.l30d, 4);
    assert.equal(t.internal_label.calls.l30d, 2);

    assert.equal(t.reconciliation.checked, true);
    assert.equal(t.reconciliation.ok, true);
    assert.equal(t.reconciliation.warning, null);
    assert.deepEqual(t.reconciliation.not_summed, ["docs_example", "internal_label"]);
    assert.deepEqual(t.reconciliation.l30d.total, { calls: 7, revenue_usd: 0.18 });
    assert.deepEqual(t.reconciliation.l30d.buckets_sum, { calls: 7, revenue_usd: 0.18 });
    assert.deepEqual(t.reconciliation.l30d.gap, { calls: 0, revenue_usd: 0 });
    assert.deepEqual(t.reconciliation.l7d.total, { calls: 6, revenue_usd: 0.17 });
    assert.deepEqual(t.reconciliation.l7d.gap, { calls: 0, revenue_usd: 0 });
    assert.deepEqual(t.reconciliation.l30d.by_bucket.testers_probable, { calls: 1, revenue_usd: 0.01 });
    assert.deepEqual(t.reconciliation.l30d.by_bucket.external, { calls: 1, revenue_usd: 0.01 });

    const html = statsHtml(doc);
    assert.match(html, /Buckets add up/);
    assert.match(html, /4\. Testers \(probable\)/);
    assert.equal(html.includes('class="warning"'), false);
    assert.equal(html.includes(PROBABLE), false);
  });

  it("matches the store bucket pass to the stats document", () => {
    const db = openStore();
    insert(db, "2026-10-07T20:00:00Z", "verify", PROBABLE, DOCS, undefined, 1);
    const windows = queryTrafficBucketWindows(db.db, NOW, LISTS);
    assert.equal(windows.testers_probable.l7d.calls, 1);
    assert.equal(windows.external.l7d.calls, 0);
  });

  it("shows a warning when a bucket is short (injected mismatch)", () => {
    const db = openStore();
    insert(db, "2026-09-14T18:00:00Z", "verify", PROBABLE, DOCS, undefined, 1);
    insert(db, "2026-10-07T20:00:00Z", "check", INTERNAL, REAL_URL, undefined, 2);
    const doc = buildStatsDocument(NOW);
    assert.equal(doc.traffic.reconciliation.ok, true);

    // The pre-fix bug: an unknown payer on a docs URL fell into no bucket.
    doc.traffic.testers_probable = {
      ...doc.traffic.testers_probable,
      calls: { l7d: 0, l30d: 0 },
      revenue: { l7d_usd: 0, l30d_usd: 0 },
    };
    const rec = reconcileTraffic(doc.traffic);
    assert.equal(rec.checked, true);
    assert.equal(rec.ok, false);
    assert.equal(rec.l7d.ok, true);
    assert.equal(rec.l30d.ok, false);
    assert.deepEqual(rec.l30d.gap, { calls: 1, revenue_usd: 0.01 });
    assert.match(rec.warning ?? "", /Buckets do not add up/);
    assert.match(rec.warning ?? "", /L30d: total 2 calls \/ \$0\.03, buckets 1 calls \/ \$0\.02, gap 1 calls \/ \$0\.01/);

    doc.traffic.reconciliation = rec;
    const html = statsHtml(doc);
    assert.match(html, /class="warning" role="alert"/);
    assert.match(html, /Buckets do not add up/);
  });

  it("shows a warning when a row is double-counted (negative gap)", () => {
    const db = openStore();
    insert(db, "2026-10-07T20:00:00Z", "confirm", GRADER, REAL_URL, undefined, 1);
    const doc = buildStatsDocument(NOW);
    doc.traffic.internal = { ...doc.traffic.internal, calls: { l7d: 1, l30d: 1 }, revenue: { l7d_usd: 0.1, l30d_usd: 0.1 } };
    const rec = reconcileTraffic(doc.traffic);
    assert.equal(rec.ok, false);
    assert.deepEqual(rec.l7d.gap, { calls: -1, revenue_usd: -0.1 });
  });

  it("does not claim the buckets add up when a bucket is not a measurement", () => {
    openStore();
    const doc = buildStatsDocument(NOW);
    doc.traffic.testers_probable = { ...doc.traffic.testers_probable, available: false };
    const rec = reconcileTraffic(doc.traffic);
    assert.equal(rec.checked, false);
    assert.equal(rec.ok, false);
    assert.match(rec.warning ?? "", /not checked: traffic\.testers_probable/);

    closePaidCallStore();
    const closed = buildStatsDocument(NOW);
    assert.equal(closed.traffic.reconciliation.ok, false);
    assert.equal(closed.traffic.reconciliation.checked, false);
    assert.match(statsHtml(closed), /class="warning"/);
  });

  it("sums testers_probable and bucket revenue across a fleet and still reconciles", () => {
    const db = openStore();
    insert(db, "2026-10-07T20:00:00Z", "verify", PROBABLE, DOCS, undefined, 1);
    insert(db, "2026-10-07T20:01:00Z", "confirm", GRADER, REAL_URL, undefined, 2);
    const local = buildStatsDocument(NOW);
    local.store.fly_machine_id = "8e4766c7d59608";
    const peer = structuredClone(local);
    peer.store.fly_machine_id = "860792be4622e8";
    const merged = mergeFleetStats(local, [{ doc: peer, machineId: "860792be4622e8", included: true }]);
    assert.deepEqual(merged.traffic.testers_probable.calls, { l7d: 2, l30d: 2 });
    assert.deepEqual(merged.traffic.testers_probable.unique_payers, { l7d: null, l30d: null });
    assert.deepEqual(merged.traffic.graders.revenue, { l7d_usd: 0.2, l30d_usd: 0.2 });
    assert.equal(merged.traffic.reconciliation.ok, true);
    assert.deepEqual(merged.traffic.reconciliation.l7d.total, { calls: 4, revenue_usd: 0.22 });

    // A peer from an older build has no testers_probable: not checked, warning shown.
    const old = structuredClone(peer) as unknown as { traffic: Record<string, unknown> };
    delete old.traffic.testers_probable;
    const partial = mergeFleetStats(local, [
      { doc: old as unknown as typeof peer, machineId: "860792be4622e8", included: true },
    ]);
    assert.equal(partial.traffic.reconciliation.ok, false);
    assert.equal(partial.traffic.reconciliation.checked, false);
  });
});
