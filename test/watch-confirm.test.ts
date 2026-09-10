import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { observationHash } from "../src/check.js";
import { WATCH_CONFIRM_REFETCH_MS } from "../src/config.js";
import { confirmationNextCheckAt, decideConfirmation, isChangeCandidate } from "../src/watch-confirm.js";
import { tickDueWatchers } from "../src/watch-scheduler.js";
import {
  closeWatchStore,
  getWatcher,
  initWatchStore,
  insertWatcher,
  listWatchEvents,
  type WatcherRow,
} from "../src/watch-store.js";
import { hashOwnerToken } from "../src/watch.js";

function obs(status: "live" | "closed", httpClass: "2xx" | "4xx" = status === "live" ? "2xx" : "4xx") {
  return {
    status,
    signals: [],
    http_status: status === "live" ? 200 : 404,
    http_class: httpClass,
    hash: observationHash(status, httpClass),
    summary: `${status} ${httpClass}`,
    checked_at: "2026-09-10T18:00:00Z",
    canonical_url: "https://example.com/jobs/1",
  };
}

function row(overrides: Partial<WatcherRow> = {}): WatcherRow {
  const now = "2026-09-10T18:00:00Z";
  return {
    id: "wtc_01CONFIRM0000000000000001",
    payer: "0x2222222222222222222222222222222222222222",
    owner_token_hash: hashOwnerToken("owt_01TEST"),
    status: "active",
    tier: "standard",
    target_url: "https://example.com/jobs/1",
    target: { type: "url", url: "https://example.com/jobs/1", render: "never", selector: null },
    condition: { detector: "status_change", params: {} },
    condition_key: "confirm-1".padEnd(64, "0"),
    interval_s: 900,
    checks_remaining: 2880,
    expires_at: "2026-10-10T18:00:00Z",
    first_check_at: now,
    next_check_at: now,
    baseline: { captured: true, hash: observationHash("live", "2xx"), summary: "live 2xx" },
    last_observation: obs("live"),
    callback_url: "https://example.com/hooks/livecheck",
    callback_secret: "whsec_test",
    callback_deliver: "on_change",
    run: "none",
    chain_budget_usd: null,
    label: null,
    context_json: null,
    created_at: now,
    claimed_until: null,
    consecutive_failures: 0,
    unreachable: false,
    expiring_emitted: false,
    detector_state: {},
    ...overrides,
  };
}

describe("2-of-3 confirmation", () => {
  it("holds the first candidate and confirms on the second", () => {
    const watcher = row();
    const closed = obs("closed");
    assert.equal(isChangeCandidate(watcher, closed, true), true);
    const first = decideConfirmation({
      row: watcher,
      observation: closed,
      fired: true,
      now: new Date("2026-09-10T18:00:00Z"),
    });
    assert.equal(first.emit, false);
    assert.equal(first.next_is_confirm_refetch, true);
    assert.ok(first.detector_state.pending);

    const second = decideConfirmation({
      row: { ...watcher, detector_state: first.detector_state },
      observation: closed,
      fired: true,
      now: new Date("2026-09-10T18:00:20Z"),
    });
    assert.equal(second.emit, true);
    assert.equal(second.next_is_confirm_refetch, false);
    assert.equal(second.detector_state.pending, undefined);
  });

  it("drops a flicker (candidate then back to baseline)", () => {
    const watcher = row();
    const first = decideConfirmation({
      row: watcher,
      observation: obs("closed"),
      fired: true,
      now: new Date("2026-09-10T18:00:00Z"),
    });
    const flicker = decideConfirmation({
      row: { ...watcher, detector_state: first.detector_state },
      observation: obs("live"),
      fired: false,
      now: new Date("2026-09-10T18:00:20Z"),
    });
    assert.equal(flicker.emit, false);
    assert.equal(flicker.detector_state.pending, undefined);
  });

  it("schedules the confirmation re-fetch about 20s out", () => {
    assert.equal(WATCH_CONFIRM_REFETCH_MS, 20_000);
    assert.equal(confirmationNextCheckAt(new Date("2026-09-10T18:00:00Z")), "2026-09-10T18:00:20Z");
  });
});

describe("scheduler 2-of-3 on a live fixture", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    initWatchStore(":memory:");
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => {
    close();
    closeWatchStore();
  });

  it("does not emit change until the ~20s re-fetch agrees", async () => {
    const hostUrl = `${origin}/fixtures/live-apply-now`;
    insertWatcher(
      row({
        id: "wtc_01TWOFTHREE00000000000001",
        target_url: hostUrl,
        target: { type: "url", url: hostUrl, render: "never", selector: null },
        condition_key: "two-of-three".padEnd(64, "0"),
        baseline: { captured: true, hash: observationHash("closed", "4xx"), summary: "closed 4xx" },
        last_observation: obs("closed"),
        next_check_at: "2026-09-10T18:00:00Z",
      }),
    );

    const hookOk: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("example.com/hooks")) return new Response("ok", { status: 200 });
      return fetch(input, init);
    };

    await tickDueWatchers(new Date("2026-09-10T18:00:00Z"), hookOk);
    assert.equal(
      listWatchEvents("wtc_01TWOFTHREE00000000000001").some((event) => event.kind === "change"),
      false,
    );
    const pending = getWatcher("wtc_01TWOFTHREE00000000000001");
    assert.ok(pending?.detector_state.pending);
    assert.equal(pending?.next_check_at, "2026-09-10T18:00:20Z");
    assert.equal(pending?.checks_remaining, 2879);

    await tickDueWatchers(new Date("2026-09-10T18:00:20Z"), hookOk);
    const events = listWatchEvents("wtc_01TWOFTHREE00000000000001");
    assert.ok(events.some((event) => event.kind === "change"));
    const confirmed = getWatcher("wtc_01TWOFTHREE00000000000001");
    assert.equal(confirmed?.detector_state.pending, undefined);
    assert.equal(confirmed?.checks_remaining, 2879);
  });
});
