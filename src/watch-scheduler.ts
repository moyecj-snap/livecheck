import {
  WATCH_HOST_CONCURRENCY,
  WATCH_SCHEDULER_POLL_MS,
} from "./config.js";
import { hostnameOnly, isoTs } from "./paid-call.js";
import { runCheck } from "./check.js";
import {
  claimWatcher,
  expireOverdueWatchers,
  insertWatchEvent,
  listDueWatchers,
  updateWatcherAfterCheck,
  type WatcherRow,
} from "./watch-store.js";
import { jitteredDelayMs, newWatchEventId } from "./watch.js";

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;
const hostInFlight = new Map<string, number>();
const watcherInFlight = new Set<string>();

export function startWatchScheduler(pollMs = WATCH_SCHEDULER_POLL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void tickDueWatchers().catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[watch] scheduler tick failed: ${reason}`);
    });
  }, pollMs);
  timer.unref?.();
  console.log(`watch scheduler: in-process poll every ${pollMs}ms (same Fly machine as HTTP)`);
}

export function stopWatchScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

function enqueueCallbackStub(row: WatcherRow, fired: boolean | null, now: Date): void {
  const createdAt = isoTs(now);
  insertWatchEvent({
    id: newWatchEventId(now.getTime()),
    watcher_id: row.id,
    kind: "callback_pending",
    payload_json: JSON.stringify({
      deliver: row.callback_deliver,
      fired,
      observation_hash: row.last_observation?.hash ?? row.baseline.hash ?? null,
    }),
    created_at: createdAt,
    delivered_at: null,
  });
  console.log(
    JSON.stringify({
      event: "livecheck.watch_callback_stub",
      watcher_id: row.id,
      fired,
      host: hostnameOnly(row.target_url),
    }),
  );
}

async function runOneWatcher(row: WatcherRow, now: Date, fetcher: typeof fetch): Promise<void> {
  const claimedUntil = isoTs(new Date(now.getTime() + 60_000));
  const nowIso = isoTs(now);
  if (!claimWatcher(row.id, claimedUntil, nowIso)) return;

  const baselineHash = row.last_observation?.hash ?? row.baseline.hash ?? null;
  let observation = row.last_observation;
  let fired: boolean | null = null;
  try {
    const result = await runCheck(
      {
        target: row.target,
        condition: row.condition,
        baseline_hash: row.condition.detector === "status_change" ? baselineHash : null,
      },
      fetcher,
      now,
    );
    observation = result.observation;
    fired = result.fired;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[watch] observation failed ${row.id}: ${reason}`);
  }

  const remaining = Math.max(0, row.checks_remaining - 1);
  const next = isoTs(new Date(now.getTime() + jitteredDelayMs(row.interval_s)));
  const expired = remaining <= 0 || row.expires_at <= nowIso;
  const baseline =
    !row.baseline.captured && observation
      ? { captured: true, hash: observation.hash, summary: observation.summary }
      : undefined;

  updateWatcherAfterCheck({
    id: row.id,
    last_observation: observation,
    baseline,
    checks_remaining: remaining,
    next_check_at: next,
    status: expired ? "expired" : "active",
  });

  if (fired === true) {
    enqueueCallbackStub({ ...row, last_observation: observation }, fired, now);
  }
}

export async function tickDueWatchers(
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<{ ran: number; skipped: number }> {
  if (ticking) return { ran: 0, skipped: 0 };
  ticking = true;
  try {
    const nowIso = isoTs(now);
    expireOverdueWatchers(nowIso);
    const due = listDueWatchers(nowIso);
    let ran = 0;
    let skipped = 0;
    const tasks: Promise<void>[] = [];

    for (const watcher of due) {
      const host = hostnameOnly(watcher.target_url);
      const live = hostInFlight.get(host) ?? 0;
      if (live >= WATCH_HOST_CONCURRENCY || watcherInFlight.has(watcher.id)) {
        skipped += 1;
        continue;
      }
      hostInFlight.set(host, live + 1);
      watcherInFlight.add(watcher.id);
      tasks.push(
        runOneWatcher(watcher, now, fetcher).finally(() => {
          watcherInFlight.delete(watcher.id);
          const n = (hostInFlight.get(host) ?? 1) - 1;
          if (n <= 0) hostInFlight.delete(host);
          else hostInFlight.set(host, n);
        }),
      );
      ran += 1;
    }

    await Promise.all(tasks);
    return { ran, skipped };
  } finally {
    ticking = false;
  }
}
