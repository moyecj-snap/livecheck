import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CheckError, observationHash, parseCheckRequest, runCheck } from "../src/check.js";
import { WATCH_FAILURE_BACKOFF_CAP_S } from "../src/config.js";
import { DAY1_FAILED_CHECK_CREDIT, DAY1_WATCHER_ID } from "../src/day1-credit.js";
import { noisyJobHtml } from "../src/sentinel-bench-fixtures.js";
import { failureBackoffDelayMs, failureBackoffMultiplier } from "../src/watch.js";
import { tickDueWatchers } from "../src/watch-scheduler.js";
import {
  closeWatchStore,
  getWatcher,
  initWatchStore,
  insertWatcher,
  listWatchEvents,
  migrateWatchStore,
  setWatcherNextCheckAt,
  type WatcherRow,
} from "../src/watch-store.js";

const LIVE_HTML = noisyJobHtml({ kind: "combined", tick: 0 });
const ERROR_530 = `<!doctype html><html><head><title>Error 530</title></head><body>
<h1>Error 530</h1><p>LIVE</p><p>This job is closed to new applications.</p></body></html>`;
const CHALLENGE_HTML = `<!doctype html><html><head><title>Just a moment...</title></head><body>
<div id="cf-challenge" class="cf-challenge"><p>Verify you are human. Checking your browser.</p></div></body></html>`;

function htmlFetch(status: number, html: string): typeof fetch {
  return async () => new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function stub(overrides: Partial<WatcherRow>): WatcherRow {
  const now = "2026-09-10T18:00:00Z";
  const url = overrides.target_url ?? "https://bench.livecheck.test/jobs/1842/reliability";
  return {
    id: overrides.id ?? "wtc_01RELIABILITY000000000001",
    payer: overrides.payer ?? "0x1111111111111111111111111111111111111111",
    owner_token_hash: "aa".repeat(32),
    status: "active",
    tier: "standard",
    target_url: url,
    target: overrides.target ?? { type: "url", url, render: "never", selector: null },
    condition: overrides.condition ?? {
      detector: "keyword",
      params: { any: ["Apply now"], all: [], none: [], selector: null, case_sensitive: false },
    },
    condition_key: (overrides.condition_key ?? overrides.id ?? "reliability").padEnd(64, "0"),
    interval_s: overrides.interval_s ?? 300,
    checks_remaining: overrides.checks_remaining ?? 2880,
    expires_at: overrides.expires_at ?? "2026-12-10T18:00:00Z",
    first_check_at: now,
    next_check_at: overrides.next_check_at ?? now,
    baseline: overrides.baseline ?? { captured: true, hash: observationHash("live", "2xx"), summary: "live" },
    last_observation: overrides.last_observation ?? null,
    callback_url: "",
    callback_secret: "whsec_reliability",
    callback_deliver: "on_change",
    run: "none",
    chain_budget_usd: null,
    chain_balance_atomic: 0,
    chain_spent_atomic: 0,
    label: null,
    context_json: null,
    created_at: now,
    claimed_until: null,
    consecutive_failures: overrides.consecutive_failures ?? 0,
    unreachable: overrides.unreachable ?? false,
    expiring_emitted: false,
    detector_state: overrides.detector_state ?? {},
    ...overrides,
  };
}

describe("failure back-off", () => {
  it("schedules 1×, 2×, 4× and caps at 1 hour", () => {
    assert.equal(failureBackoffMultiplier(1), 1);
    assert.equal(failureBackoffMultiplier(2), 2);
    assert.equal(failureBackoffMultiplier(3), 4);
    assert.equal(failureBackoffMultiplier(9), 4);
    const exact = () => 0.5;
    assert.equal(failureBackoffDelayMs(300, 1, exact), 300_000);
    assert.equal(failureBackoffDelayMs(300, 2, exact), 600_000);
    assert.equal(failureBackoffDelayMs(300, 3, exact), 1_200_000);
    assert.equal(failureBackoffDelayMs(900, 3, exact), WATCH_FAILURE_BACKOFF_CAP_S * 1000);
    assert.equal(failureBackoffDelayMs(1_800, 2, () => 0.999999), WATCH_FAILURE_BACKOFF_CAP_S * 1000);
    assert.ok(failureBackoffDelayMs(900, 4, () => 0) <= WATCH_FAILURE_BACKOFF_CAP_S * 1000);
    assert.ok(failureBackoffDelayMs(900, 4, () => 0) >= 900_000);
  });
});

describe("fetch failures are not content", () => {
  const url = "https://bench.livecheck.test/jobs/1842/reliability";

  it("keyword, text_diff, and numeric produce no observation on 530, 500, challenge, timeout, or DNS", async () => {
    const cases: Array<{ detector: "keyword" | "text_diff" | "numeric_threshold"; body: Record<string, unknown> }> = [
      {
        detector: "keyword",
        body: { detector: "keyword", params: { any: ["Apply now"] } },
      },
      {
        detector: "text_diff",
        body: { detector: "text_diff", params: { selector: ".listing-title" } },
      },
      {
        detector: "numeric_threshold",
        body: { detector: "numeric_threshold", params: { selector: ".price", op: "lt", value: 1000 } },
      },
    ];
    for (const item of cases) {
      const parsed = parseCheckRequest({
        target: { type: "url", url, render: "never" },
        condition: item.body,
        baseline_hash: observationHash("live", "2xx"),
      });
      await assert.rejects(
        () => runCheck(parsed, htmlFetch(530, ERROR_530)),
        (error: unknown) => error instanceof CheckError && error.code === "baseline_unreachable",
      );
      await assert.rejects(
        () => runCheck(parsed, htmlFetch(500, ERROR_530)),
        (error: unknown) => error instanceof CheckError && error.code === "baseline_unreachable",
      );
      await assert.rejects(
        () => runCheck(parsed, htmlFetch(200, CHALLENGE_HTML)),
        (error: unknown) =>
          error instanceof CheckError &&
          error.code === "baseline_unreachable" &&
          /challenge/i.test(error.message),
      );
      await assert.rejects(
        () =>
          runCheck(parsed, async () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
          }),
        (error: unknown) => error instanceof CheckError && error.code === "baseline_unreachable",
      );
      await assert.rejects(
        () => runCheck(parsed, async () => {
          throw new Error("getaddrinfo ENOTFOUND bench.livecheck.test");
        }),
        (error: unknown) => error instanceof CheckError && error.code === "baseline_unreachable",
      );
    }
  });

  it("status_change keeps 404/410 closed and treats 5xx as unreachable", async () => {
    const live = await runCheck(
      parseCheckRequest({
        target: { type: "url", url, render: "never" },
        condition: { detector: "status_change", params: {} },
      }),
      htmlFetch(200, LIVE_HTML),
    );
    assert.equal(live.observation.status, "live");
    const closed = await runCheck(
      parseCheckRequest({
        target: { type: "url", url, render: "never" },
        condition: { detector: "status_change", params: {} },
        baseline_hash: live.observation.hash,
      }),
      htmlFetch(404, "<html><body>missing</body></html>"),
    );
    assert.equal(closed.observation.status, "closed");
    assert.equal(closed.observation.http_status, 404);
    assert.equal(closed.fired, true);
    const gone = await runCheck(
      parseCheckRequest({
        target: { type: "url", url, render: "never" },
        condition: { detector: "status_change", params: {} },
        baseline_hash: live.observation.hash,
      }),
      htmlFetch(410, "<html><body>gone</body></html>"),
    );
    assert.equal(gone.observation.status, "closed");
    await assert.rejects(
      () =>
        runCheck(
          parseCheckRequest({
            target: { type: "url", url, render: "never" },
            condition: { detector: "status_change", params: {} },
            baseline_hash: live.observation.hash,
          }),
          htmlFetch(530, ERROR_530),
        ),
      (error: unknown) =>
        error instanceof CheckError &&
        error.code === "baseline_unreachable" &&
        /not a closed page/.test(error.message),
    );
  });
});

describe("watcher lifecycle under fetch failure", () => {
  after(() => closeWatchStore());

  it("backs off, does not burn checks, and emits recovered instead of change", async () => {
    initWatchStore(":memory:");
    const url = "https://bench.livecheck.test/jobs/1842/lifecycle";
    const live = await runCheck(
      parseCheckRequest({
        target: { type: "url", url, render: "never" },
        condition: { detector: "keyword", params: { any: ["Apply now"] } },
      }),
      htmlFetch(200, LIVE_HTML),
    );
    const id = "wtc_01LIFECYCLE0000000000001";
    insertWatcher(
      stub({
        id,
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        target_url: url,
        target: { type: "url", url, render: "never", selector: null },
        interval_s: 300,
        checks_remaining: 2880,
        next_check_at: "2026-09-10T18:00:00Z",
        baseline: { captured: true, hash: live.observation.hash, summary: live.observation.summary },
        last_observation: live.observation,
        detector_state: { last_fired: live.fired },
      }),
    );

    let now = new Date("2026-09-10T18:00:00Z");
    const gaps: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await tickDueWatchers(now, htmlFetch(530, ERROR_530));
      const row = getWatcher(id);
      assert.ok(row);
      gaps.push(Date.parse(row.next_check_at) - now.getTime());
      assert.equal(row.checks_remaining, 2880);
      assert.equal(row.last_observation?.http_status, 200);
      assert.equal(row.last_observation?.status, "live");
      now = new Date(row.next_check_at);
    }
    assert.ok(gaps[0]! >= 270_000 && gaps[0]! <= 330_000, `gap1=${gaps[0]}`);
    assert.ok(gaps[1]! >= 540_000 && gaps[1]! <= 660_000, `gap2=${gaps[1]}`);
    assert.ok(gaps[2]! >= 1_080_000 && gaps[2]! <= 1_320_000, `gap3=${gaps[2]}`);
    assert.ok(gaps.every((gap) => gap <= WATCH_FAILURE_BACKOFF_CAP_S * 1000));
    const failed = getWatcher(id);
    assert.equal(failed?.consecutive_failures, 3);
    assert.equal(failed?.unreachable, true);
    const failEvents = listWatchEvents(id);
    assert.equal(failEvents.filter((event) => event.kind === "unreachable").length, 1);
    assert.equal(failEvents.filter((event) => event.kind === "change").length, 0);

    await tickDueWatchers(now, htmlFetch(200, LIVE_HTML));
    const recovered = getWatcher(id);
    assert.equal(recovered?.unreachable, false);
    assert.equal(recovered?.consecutive_failures, 0);
    assert.equal(recovered?.checks_remaining, 2879);
    const recoverGap = Date.parse(recovered?.next_check_at ?? "") - now.getTime();
    assert.ok(recoverGap >= 270_000 && recoverGap <= 330_000, `recoverGap=${recoverGap}`);
    const events = listWatchEvents(id);
    assert.equal(events.filter((event) => event.kind === "recovered").length, 1);
    assert.equal(events.filter((event) => event.kind === "change").length, 0);
    const recoveredPayload = JSON.parse(
      events.find((event) => event.kind === "recovered")?.payload_json ?? "{}",
    ) as { type?: string };
    assert.equal(recoveredPayload.type, "recovered");
  });

  it("does not emit change across 2xx → 5xx → 2xx, and 404 still closes", async () => {
    initWatchStore(":memory:");
    const url = "https://bench.livecheck.test/jobs/1842/outage-unit";
    const live = await runCheck(
      parseCheckRequest({
        target: { type: "url", url, render: "never" },
        condition: { detector: "status_change", params: {} },
      }),
      htmlFetch(200, LIVE_HTML),
    );
    const id = "wtc_01OUTAGEUNIT000000000001";
    insertWatcher(
      stub({
        id,
        payer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        target_url: url,
        target: { type: "url", url, render: "never", selector: null },
        condition: { detector: "status_change", params: {} },
        interval_s: 300,
        next_check_at: "2026-09-10T18:00:00Z",
        baseline: { captured: true, hash: live.observation.hash, summary: live.observation.summary },
        last_observation: live.observation,
      }),
    );
    let now = new Date("2026-09-10T18:00:00Z");
    for (const status of [530, 500, 200]) {
      await tickDueWatchers(now, htmlFetch(status, status >= 500 ? ERROR_530 : LIVE_HTML));
      const row = getWatcher(id);
      assert.ok(row);
      now = new Date(row.next_check_at);
    }
    assert.equal(listWatchEvents(id).filter((event) => event.kind === "change").length, 0);
    assert.equal(getWatcher(id)?.last_observation?.status, "live");
    assert.equal(listWatchEvents(id).some((event) => event.kind === "recovered"), false);

    setWatcherNextCheckAt(id, now.toISOString().replace(/\.\d{3}Z$/, "Z"));
    await tickDueWatchers(now, htmlFetch(404, "<html><body>missing</body></html>"));
    const pending = getWatcher(id);
    assert.equal(listWatchEvents(id).filter((event) => event.kind === "change").length, 0);
    assert.ok(pending?.detector_state?.pending);
    const confirmAt = new Date(pending?.next_check_at ?? now);
    await tickDueWatchers(confirmAt, htmlFetch(404, "<html><body>missing</body></html>"));
    const changes = listWatchEvents(id).filter((event) => event.kind === "change");
    assert.equal(changes.length, 1);
    const payload = JSON.parse(changes[0]?.payload_json ?? "{}") as { type?: string; current?: { status?: string } };
    assert.equal(payload.type, "change");
    assert.equal(payload.current?.status, "closed");
  });
});

describe("Day-1 failed-check credit", () => {
  const dir = mkdtempSync(join(tmpdir(), "livecheck-day1-credit-"));
  const path = join(dir, "watchers.sqlite");

  after(() => {
    closeWatchStore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("credits 690 once when the watcher exists and skips when it does not", () => {
    const opened = initWatchStore(path);
    if (!opened.ok) throw new Error(opened.reason);
    assert.equal(migrateWatchStore(opened.db).reason, "watcher_missing");

    insertWatcher(
      stub({
        id: DAY1_WATCHER_ID,
        payer: "0xcccccccccccccccccccccccccccccccccccccccc",
        checks_remaining: 2187,
        condition_key: "day1-credit".padEnd(64, "0"),
      }),
    );
    const applied = migrateWatchStore(opened.db);
    assert.equal(applied.applied, true);
    assert.equal(applied.reason, "applied");
    assert.equal(applied.credit, DAY1_FAILED_CHECK_CREDIT);
    assert.equal(applied.previous_checks_remaining, 2187);
    assert.equal(applied.checks_remaining, 2187 + DAY1_FAILED_CHECK_CREDIT);
    assert.equal(getWatcher(DAY1_WATCHER_ID)?.checks_remaining, 2877);

    const again = migrateWatchStore(opened.db);
    assert.equal(again.reason, "already_applied");
    assert.equal(again.applied, false);
    assert.equal(getWatcher(DAY1_WATCHER_ID)?.checks_remaining, 2877);
    assert.equal(getWatcher(DAY1_WATCHER_ID)?.status, "active");
  });
});
