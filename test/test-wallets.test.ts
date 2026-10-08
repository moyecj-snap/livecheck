import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { DOCS_EXAMPLE_URL_SHA256 } from "../src/docs-example-url.js";
import { activeTestTrafficWallets, graderWallets, testerWallets, testWalletListSource } from "../src/grader-wallets.js";
import { DEFAULT_INTERNAL_WALLETS } from "../src/internal-wallets.js";
import { hashUrl, type PaidCallRoute } from "../src/paid-call.js";
import { closePaidCallStore, initPaidCallStore, insertPaidCallRow, openPaidCallDb } from "../src/paid-call-store.js";
import { buildStatsDocument } from "../src/stats.js";
import { TEST_TRAFFIC_WALLETS } from "../src/test-traffic.js";
import {
  listActiveTestWallets,
  listAllTestWallets,
  migrateTestWalletStore,
  removeTestWallet,
  upsertTestWallet,
} from "../src/test-wallet-store.js";
import { TRAFFIC_BUCKET_ORDER } from "../src/traffic-buckets.js";

const COG = "0x6a0b784cf4e3f79e0bca889e35a1b3aa1dc24518";
const ROW24 = "0xe3badbd4f38214b9eae528a1a5398f6678f63fb3";
const NEW_GRADER = "0xcccccccccccccccccccccccccccccccccccccccc";
const INTERNAL = DEFAULT_INTERNAL_WALLETS[0]!;
const DOCS = DOCS_EXAMPLE_URL_SHA256;
const DEMO = hashUrl("https://livecheck.fly.dev/demo/thank-you?ref=ABC123");
const REAL_URL = hashUrl("https://jobs.example.com/opening-42");
const NOW = new Date("2026-10-08T16:00:00Z");

function openStore() {
  const opened = initPaidCallStore(":memory:");
  assert.equal(opened.ok, true);
  return opened as ReturnType<typeof initPaidCallStore> & { ok: true };
}

let n = 0;
function insert(
  db: ReturnType<typeof openStore>,
  ts: string,
  route: PaidCallRoute,
  payer: string,
  urlSha256: string,
  userAgent?: string,
) {
  n += 1;
  assert.equal(
    insertPaidCallRow(db.db, {
      ts,
      route,
      host: "example.com",
      url_sha256: urlSha256,
      payer,
      tx: `0x${n.toString(16).padStart(64, "0")}`,
      ...(userAgent ? { user_agent: userAgent } : {}),
    }),
    true,
  );
}

function sumL30d(doc: ReturnType<typeof buildStatsDocument>) {
  const t = doc.traffic.reconciliation.l30d;
  return t;
}

describe("test_wallets table (grader/tester list without a deploy)", () => {
  afterEach(() => closePaidCallStore());

  it("seeds the built-in list, including cog-x402-audit and the Sep 14 tester", () => {
    const db = openStore();
    const rows = listActiveTestWallets(db.db);
    assert.deepEqual(
      rows.map((row) => row.address),
      TEST_TRAFFIC_WALLETS.map((row) => row.address),
    );
    assert.deepEqual(
      rows.find((row) => row.address === COG),
      { address: COG, role: "grader", label: TEST_TRAFFIC_WALLETS.find((w) => w.address === COG)!.label },
    );
    assert.match(rows.find((row) => row.address === COG)!.label, /cog-x402-audit\/2 \(\+https:\/\/cog\.xyz\)/);
    assert.equal(rows.find((row) => row.address === ROW24)?.role, "tester");
    assert.ok(graderWallets({}).includes(COG));
    assert.ok(testerWallets({}).includes(ROW24));
    assert.equal(testWalletListSource(), "db");
  });

  it("seeding is idempotent: re-running keeps edits, removals, and the row count", () => {
    const db = openStore();
    upsertTestWallet(db.db, { address: NEW_GRADER, role: "grader", label: "Acme grader" });
    upsertTestWallet(db.db, { address: COG, role: "grader", label: "cog (renamed by team)" });
    assert.equal(removeTestWallet(db.db, ROW24), true);
    const before = listAllTestWallets(db.db);
    for (let i = 0; i < 3; i++) assert.deepEqual(migrateTestWalletStore(db.db), { seeded: 0 });
    const after = listAllTestWallets(db.db);
    assert.deepEqual(after, before);
    assert.equal(after.length, TEST_TRAFFIC_WALLETS.length + 1);
    assert.equal(after.find((row) => row.address === COG)?.label, "cog (renamed by team)");
    assert.ok(after.find((row) => row.address === ROW24)?.removed_at, "a removed seed is not resurrected");
    assert.equal(testerWallets({}).includes(ROW24), false);
  });

  it("a file DB survives two reopen cycles (restart) with the same list", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-testers-"));
    try {
      const path = join(dir, "paid-calls.sqlite");
      let db = openPaidCallDb(path);
      upsertTestWallet(db, { address: NEW_GRADER, role: "grader", label: "Acme grader" });
      const first = listAllTestWallets(db);
      db.close();
      for (let i = 0; i < 2; i++) {
        db = openPaidCallDb(path);
        assert.deepEqual(listAllTestWallets(db), first);
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates address, role, and label before writing", () => {
    const db = openStore();
    assert.throws(() => upsertTestWallet(db.db, { address: "nope", role: "grader", label: "x" }), /not a 0x wallet/);
    assert.throws(() => upsertTestWallet(db.db, { address: NEW_GRADER, role: "customer", label: "x" }), /grader or tester/);
    assert.throws(() => upsertTestWallet(db.db, { address: NEW_GRADER, role: "grader", label: "  \n " }), /label is required/);
    assert.equal(listAllTestWallets(db.db).length, TEST_TRAFFIC_WALLETS.length);
    const upper = `0x${NEW_GRADER.slice(2).toUpperCase()}`;
    assert.equal(upsertTestWallet(db.db, { address: upper, role: "GRADER", label: "Acme\tgrader" }).action, "added");
    assert.equal(upsertTestWallet(db.db, { address: NEW_GRADER, role: "grader", label: "Acme grader" }).action, "unchanged");
    assert.equal(upsertTestWallet(db.db, { address: NEW_GRADER, role: "tester", label: "Acme grader" }).action, "updated");
    assert.equal(removeTestWallet(db.db, NEW_GRADER), true);
    assert.equal(removeTestWallet(db.db, NEW_GRADER), false);
    assert.equal(upsertTestWallet(db.db, { address: NEW_GRADER, role: "grader", label: "Acme grader" }).action, "restored");
  });

  it("falls back to the built-in list when the store is closed", () => {
    closePaidCallStore();
    assert.equal(testWalletListSource(), "built-in");
    assert.deepEqual(
      activeTestTrafficWallets({}).map((row) => row.address),
      TEST_TRAFFIC_WALLETS.map((row) => row.address),
    );
  });

  it("env switches still apply on top of the table", () => {
    const db = openStore();
    upsertTestWallet(db.db, { address: NEW_GRADER, role: "grader", label: "Acme grader" });
    assert.deepEqual(activeTestTrafficWallets({ LIVECHECK_TEST_WALLETS: "off" }), []);
    assert.equal(graderWallets({ LIVECHECK_GRADER_WALLETS: "off" }).length, 0);
    assert.ok(testerWallets({ LIVECHECK_GRADER_WALLETS: "off" }).includes(ROW24));
    const extra = "0xdddddddddddddddddddddddddddddddddddddddd";
    assert.ok(graderWallets({ LIVECHECK_TEST_WALLETS: `${extra}:grader:Env grader` }).includes(extra));
    assert.ok(graderWallets({ LIVECHECK_TEST_WALLETS: `${extra}:grader:Env grader` }).includes(NEW_GRADER));
  });
});

describe("/stats with the table-backed list", () => {
  afterEach(() => closePaidCallStore());

  it("cog's 5 calls and the row 24 verify move to graders / testers, buckets still add up", () => {
    const db = openStore();
    const ua = "cog-x402-audit/2 (+https://cog.xyz)";
    insert(db, "2026-10-08T06:26:01Z", "verify", COG, DOCS, ua);
    insert(db, "2026-10-08T06:26:02Z", "verify/job", COG, DOCS, ua);
    insert(db, "2026-10-08T06:26:03Z", "verify/listing", COG, DOCS, ua);
    insert(db, "2026-10-08T06:26:05Z", "check", COG, DOCS, ua);
    insert(db, "2026-10-08T06:26:08Z", "confirm", COG, DEMO, ua);
    insert(db, "2026-09-14T18:00:00Z", "verify", ROW24, DOCS);
    insert(db, "2026-10-07T20:00:00Z", "check", INTERNAL, REAL_URL, "livecheck-internal/purl-0.2.8");
    const t = buildStatsDocument(NOW).traffic;
    assert.deepEqual(t.graders.calls, { l7d: 5, l30d: 5 });
    assert.deepEqual(t.graders.revenue, { l7d_usd: 0.15, l30d_usd: 0.15 });
    assert.deepEqual(t.testers.calls, { l7d: 0, l30d: 1 });
    assert.deepEqual(t.testers.revenue, { l7d_usd: 0, l30d_usd: 0.01 });
    assert.deepEqual(t.testers_probable.calls, { l7d: 0, l30d: 0 });
    assert.equal(t.revenue.external.l30d_usd, 0);
    assert.deepEqual(t.internal.calls, { l7d: 1, l30d: 1 });
    assert.equal(t.reconciliation.ok, true);
    assert.deepEqual(sumL30d(buildStatsDocument(NOW)).gap, { calls: 0, revenue_usd: 0 });
    assert.deepEqual(TRAFFIC_BUCKET_ORDER, ["internal", "graders", "testers", "unattributed", "testers_probable", "external"]);
  });

  it("a wallet added at runtime moves its calls on the next /stats build, no restart", () => {
    const db = openStore();
    insert(db, "2026-10-08T10:00:00Z", "verify", NEW_GRADER, DOCS);
    insert(db, "2026-10-08T10:00:01Z", "confirm", NEW_GRADER, REAL_URL);
    let t = buildStatsDocument(NOW).traffic;
    assert.deepEqual(t.testers_probable.calls, { l7d: 1, l30d: 1 });
    assert.equal(t.revenue.external.l30d_usd, 0.1);

    upsertTestWallet(db.db, { address: NEW_GRADER, role: "grader", label: "Acme grader" });
    t = buildStatsDocument(NOW).traffic;
    assert.deepEqual(t.graders.calls, { l7d: 2, l30d: 2 });
    assert.deepEqual(t.testers_probable.calls, { l7d: 0, l30d: 0 });
    assert.equal(t.revenue.external.l30d_usd, 0);
    assert.equal(t.reconciliation.ok, true);

    removeTestWallet(db.db, NEW_GRADER);
    t = buildStatsDocument(NOW).traffic;
    assert.equal(t.revenue.external.l30d_usd, 0.1);
    assert.equal(t.reconciliation.ok, true);
  });

  it("internal stays wallet-only: an internal wallet on the tester list is still Internal", () => {
    const db = openStore();
    upsertTestWallet(db.db, { address: INTERNAL, role: "tester", label: "mistake" });
    insert(db, "2026-10-08T10:00:00Z", "check", INTERNAL, DOCS);
    const t = buildStatsDocument(NOW).traffic;
    assert.deepEqual(t.internal.calls, { l7d: 1, l30d: 1 });
    assert.deepEqual(t.testers.calls, { l7d: 0, l30d: 0 });
    assert.equal(t.reconciliation.ok, true);
  });
});

describe("npm run testers:* admin script", () => {
  const script = join(process.cwd(), "scripts/test-wallets.ts");
  const tsx = join(process.cwd(), "node_modules/.bin/tsx");
  function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(tsx, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env, FLY_APP_NAME: "" },
    });
  }

  it("adds, lists, refuses internal wallets, removes, and never creates a DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-testers-cli-"));
    try {
      const path = join(dir, "paid-calls.sqlite");
      const missing = run(["list", "--db", path]);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /no paid-calls database/);

      openPaidCallDb(path).close();
      const added = run(["add", NEW_GRADER, "grader", "Acme", "x402", "grader", "--db", path, "--json"]);
      assert.equal(added.status, 0, added.stderr);
      assert.deepEqual(JSON.parse(added.stdout).wallet, { address: NEW_GRADER, role: "grader", label: "Acme x402 grader" });

      const internal = run(["add", INTERNAL, "tester", "nope", "--db", path]);
      assert.equal(internal.status, 2);
      assert.match(internal.stderr, /internal \(team\) wallet/);

      const badRole = run(["add", NEW_GRADER, "customer", "x", "--db", path]);
      assert.equal(badRole.status, 2);
      assert.match(badRole.stderr, /grader or tester/);

      const listed = run(["list", "--db", path, "--json"]);
      assert.equal(listed.status, 0, listed.stderr);
      const wallets = JSON.parse(listed.stdout).wallets as Array<{ address: string; source: string }>;
      assert.equal(wallets.length, TEST_TRAFFIC_WALLETS.length + 1);
      assert.equal(wallets.find((row) => row.address === NEW_GRADER)?.source, "admin");

      const removed = run(["remove", NEW_GRADER, "--db", path, "--json"]);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(JSON.parse(removed.stdout).removed, true);

      const db = new DatabaseSync(path);
      assert.equal(listActiveTestWallets(db).some((row) => row.address === NEW_GRADER), false);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
