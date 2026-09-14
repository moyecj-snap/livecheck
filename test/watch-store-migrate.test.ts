import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { observationHash } from "../src/check.js";
import {
  closeWatchStore,
  getWatchEvent,
  initWatchStore,
  insertWatchEvent,
  insertWatcher,
  listDueCallbackEvents,
  listWatchEvents,
  migrateWatchStore,
  watchStoreTableColumns,
  type WatcherRow,
} from "../src/watch-store.js";

/** Exact Phase 2 (301a0e0) schema — no next_attempt_at / delivery columns. */
const PHASE2_SCHEMA = `
CREATE TABLE IF NOT EXISTS watchers (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL,
  owner_token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'standard',
  target_url TEXT NOT NULL,
  target_json TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  condition_key TEXT NOT NULL,
  interval_s INTEGER NOT NULL,
  checks_remaining INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  first_check_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  last_observation_json TEXT,
  callback_url TEXT NOT NULL,
  callback_secret TEXT NOT NULL,
  callback_deliver TEXT NOT NULL,
  run TEXT NOT NULL DEFAULT 'none',
  chain_budget_usd REAL,
  label TEXT,
  context_json TEXT,
  created_at TEXT NOT NULL,
  claimed_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_watchers_due ON watchers(status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_watchers_payer_status ON watchers(payer, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchers_dup
  ON watchers(payer, target_url, condition_key) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS watch_events (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_watch_events_watcher ON watch_events(watcher_id, created_at);
`;

function stubWatcher(id: string, conditionKey = "phase2-migrate-b".padEnd(64, "0")): WatcherRow {
  const now = "2026-09-10T18:00:00Z";
  return {
    id,
    payer: "0x2222222222222222222222222222222222222222",
    owner_token_hash: "aa".repeat(32),
    status: "active",
    tier: "standard",
    target_url: "https://example.com/jobs/1",
    target: { type: "url", url: "https://example.com/jobs/1", render: "never", selector: null },
    condition: { detector: "status_change", params: {} },
    condition_key: conditionKey,
    interval_s: 900,
    checks_remaining: 2880,
    expires_at: "2026-10-10T18:00:00Z",
    first_check_at: now,
    next_check_at: now,
    baseline: { captured: true, hash: observationHash("live", "2xx"), summary: "live 2xx" },
    last_observation: null,
    callback_url: "https://example.com/hooks/livecheck",
    callback_secret: "whsec_test",
    callback_deliver: "on_change",
    run: "none",
    chain_budget_usd: null,
    chain_balance_atomic: 0,
    chain_spent_atomic: 0,
    label: null,
    context_json: null,
    created_at: now,
    claimed_until: null,
    consecutive_failures: 0,
    unreachable: false,
    expiring_emitted: false,
    detector_state: {},
  };
}

function writePhase2Db(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(PHASE2_SCHEMA);
  db.prepare(
    `INSERT INTO watchers (
      id, payer, owner_token_hash, status, tier, target_url, target_json, condition_json,
      condition_key, interval_s, checks_remaining, expires_at, first_check_at, next_check_at,
      baseline_json, last_observation_json, callback_url, callback_secret, callback_deliver,
      run, chain_budget_usd, label, context_json, created_at, claimed_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "wtc_01PHASE2MIGRATE00000000001",
    "0x2222222222222222222222222222222222222222",
    "aa".repeat(32),
    "active",
    "standard",
    "https://example.com/jobs/1",
    JSON.stringify({ type: "url", url: "https://example.com/jobs/1", render: "never", selector: null }),
    JSON.stringify({ detector: "status_change", params: {} }),
    "phase2-migrate".padEnd(64, "0"),
    900,
    2880,
    "2026-10-10T18:00:00Z",
    "2026-09-10T18:00:00Z",
    "2026-09-10T18:00:00Z",
    JSON.stringify({ captured: true, hash: observationHash("live", "2xx"), summary: "live 2xx" }),
    null,
    "https://example.com/hooks/livecheck",
    "whsec_test",
    "on_change",
    "none",
    null,
    null,
    null,
    "2026-09-10T18:00:00Z",
    null,
  );
  db.prepare(
    `INSERT INTO watch_events (id, watcher_id, kind, payload_json, created_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "wte_01PHASE2OLDEVENT000000001",
    "wtc_01PHASE2MIGRATE00000000001",
    "callback_pending",
    JSON.stringify({ deliver: "on_change", fired: true }),
    "2026-09-10T18:00:00Z",
    null,
  );
  const eventsCols = watchStoreTableColumns(db, "watch_events");
  assert.equal(eventsCols.has("next_attempt_at"), false);
  assert.equal(eventsCols.has("delivery_attempts"), false);
  assert.equal(eventsCols.has("last_error"), false);
  db.close();
}

describe("watch store Phase 2 → step 3 migrate", () => {
  const dir = mkdtempSync(join(tmpdir(), "livecheck-watch-migrate-"));
  const path = join(dir, "watchers.sqlite");

  after(() => {
    closeWatchStore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ALTERs a Phase-2 DB, then insert/list events succeed (idempotent)", () => {
    writePhase2Db(path);

    const opened = initWatchStore(path);
    if (!opened.ok) throw new Error(opened.reason);

    const eventsCols = watchStoreTableColumns(opened.db, "watch_events");
    assert.equal(eventsCols.has("next_attempt_at"), true);
    assert.equal(eventsCols.has("delivery_attempts"), true);
    assert.equal(eventsCols.has("last_error"), true);
    const watcherCols = watchStoreTableColumns(opened.db, "watchers");
    assert.equal(watcherCols.has("consecutive_failures"), true);
    assert.equal(watcherCols.has("unreachable"), true);
    assert.equal(watcherCols.has("expiring_emitted"), true);
    assert.equal(watcherCols.has("detector_state_json"), true);
    assert.equal(watcherCols.has("chain_balance_atomic"), true);
    assert.equal(watcherCols.has("chain_spent_atomic"), true);
    assert.equal(watcherCols.has("chain_confirm_json"), true);
    const tables = opened.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'watch_delivery_attempts'`)
      .get() as { name?: string } | undefined;
    assert.equal(tables?.name, "watch_delivery_attempts");

    const legacy = listWatchEvents("wtc_01PHASE2MIGRATE00000000001");
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0]?.id, "wte_01PHASE2OLDEVENT000000001");
    assert.equal(legacy[0]?.kind, "callback_pending");
    assert.equal(legacy[0]?.delivery_attempts, 0);
    assert.equal(legacy[0]?.next_attempt_at, null);

    insertWatchEvent({
      id: "evt_01PHASE2NEWEVENT000000001",
      watcher_id: "wtc_01PHASE2MIGRATE00000000001",
      kind: "change",
      payload_json: JSON.stringify({ id: "evt_01PHASE2NEWEVENT000000001", type: "change" }),
      created_at: "2026-09-10T18:05:00Z",
      delivered_at: null,
      delivery_attempts: 0,
      next_attempt_at: "2026-09-10T18:05:00Z",
      last_error: null,
    });
    const after = listWatchEvents("wtc_01PHASE2MIGRATE00000000001");
    assert.equal(after.length, 2);
    const created = getWatchEvent("evt_01PHASE2NEWEVENT000000001");
    assert.equal(created?.next_attempt_at, "2026-09-10T18:05:00Z");
    const due = listDueCallbackEvents("2026-09-10T18:06:00Z", 5);
    assert.ok(due.some((event) => event.id === "evt_01PHASE2NEWEVENT000000001"));

    migrateWatchStore(opened.db);
    migrateWatchStore(opened.db);
    const again = initWatchStore(path);
    if (!again.ok) throw new Error(again.reason);
    assert.equal(listWatchEvents("wtc_01PHASE2MIGRATE00000000001").length, 2);
    insertWatcher(stubWatcher("wtc_01PHASE2MIGRATE00000000002"));
  });
});
