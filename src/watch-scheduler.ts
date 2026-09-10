import {
  WATCH_EXPIRING_LEAD_MS,
  WATCH_HOST_CONCURRENCY,
  WATCH_SCHEDULER_POLL_MS,
  WATCH_UNREACHABLE_FAILURES,
} from "./config.js";
import { hostnameOnly, isoTs } from "./paid-call.js";
import { runCheck } from "./check.js";
import { deliverDueCallbacks } from "./watch-callback.js";
import {
  emitChangeIfNeeded,
  emitExpiredIfNeeded,
  emitExpiringIfNeeded,
  emitRecovered,
  emitUnreachableIfNeeded,
} from "./watch-events.js";
import {
  claimWatcher,
  expireOverdueWatchers,
  listDueWatchers,
  listExpiringWatchers,
  updateWatcherAfterCheck,
  type WatcherRow,
} from "./watch-store.js";
import { jitteredDelayMs } from "./watch.js";

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

function emitLifecycleEvents(now: Date): void {
  const nowIso = isoTs(now);
  const expired = expireOverdueWatchers(nowIso);
  for (const watcher of expired) {
    emitExpiredIfNeeded(watcher, now);
  }
  const horizon = isoTs(new Date(now.getTime() + WATCH_EXPIRING_LEAD_MS));
  for (const watcher of listExpiringWatchers(nowIso, horizon)) {
    emitExpiringIfNeeded(watcher, now);
  }
}

async function runOneWatcher(row: WatcherRow, now: Date, fetcher: typeof fetch): Promise<void> {
  const claimedUntil = isoTs(new Date(now.getTime() + 60_000));
  const nowIso = isoTs(now);
  if (!claimWatcher(row.id, claimedUntil, nowIso)) return;

  const baselineHash = row.last_observation?.hash ?? row.baseline.hash ?? null;
  let observation = row.last_observation;
  let fired: boolean | null = null;
  let confidence = 0.5;
  let fetchFailed = false;
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
    confidence = result.confidence;
  } catch (error) {
    fetchFailed = true;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[watch] observation failed ${row.id}: ${reason}`);
  }

  const remaining = Math.max(0, row.checks_remaining - 1);
  const next = isoTs(new Date(now.getTime() + jitteredDelayMs(row.interval_s)));
  const expired = remaining <= 0 || row.expires_at <= nowIso;
  const baseline =
    !row.baseline.captured && observation && !fetchFailed
      ? { captured: true, hash: observation.hash, summary: observation.summary }
      : undefined;

  const consecutive_failures = fetchFailed ? row.consecutive_failures + 1 : 0;
  let unreachable = row.unreachable;
  if (fetchFailed) {
    if (consecutive_failures >= WATCH_UNREACHABLE_FAILURES && !row.unreachable) {
      emitUnreachableIfNeeded(row, remaining, now);
      unreachable = true;
    }
  } else if (row.unreachable && observation) {
    emitRecovered(row, observation, remaining, now);
    unreachable = false;
  }

  if (!fetchFailed && observation) {
    emitChangeIfNeeded(row, observation, fired, confidence, remaining, now);
  }

  updateWatcherAfterCheck({
    id: row.id,
    last_observation: observation,
    baseline,
    checks_remaining: remaining,
    next_check_at: next,
    status: expired ? "expired" : "active",
    consecutive_failures,
    unreachable,
  });

  if (expired) {
    emitExpiredIfNeeded({ ...row, checks_remaining: remaining, last_observation: observation }, now);
  }
}

export async function tickDueWatchers(
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<{ ran: number; skipped: number }> {
  if (ticking) return { ran: 0, skipped: 0 };
  ticking = true;
  try {
    emitLifecycleEvents(now);
    const nowIso = isoTs(now);
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
    await deliverDueCallbacks(now, fetcher);
    return { ran, skipped };
  } finally {
    ticking = false;
  }
}
