import { newEventId } from "./confirm-id.js";
import { isoTs } from "./paid-call.js";
import { sealWatchEventReceipt } from "./receipt.js";
import type {
  CheckObservation,
  WatchCallbackPayload,
  WatchEventType,
  WatchObservationSnapshot,
} from "./types.js";
import { isChangeCandidate } from "./watch-confirm.js";
import { hasWatchEventKind, insertWatchEvent, markExpiringEmitted, type WatcherRow } from "./watch-store.js";

export function snapshotObservation(obs: CheckObservation | null | undefined): WatchObservationSnapshot | null {
  if (!obs) return null;
  return {
    hash: obs.hash,
    status: obs.status,
    http_status: obs.http_status,
    http_class: obs.http_class,
    summary: obs.summary,
  };
}

export function observationDiff(
  previous: WatchObservationSnapshot | null,
  current: WatchObservationSnapshot | null,
  fired: boolean | null,
): { fired: boolean | null; changed: string[] } {
  const changed: string[] = [];
  if (previous && current) {
    if (previous.status !== current.status) changed.push("status");
    if (previous.http_class !== current.http_class) changed.push("http_class");
    if (previous.hash !== current.hash) changed.push("hash");
  } else if (current && !previous) {
    changed.push("hash");
  }
  return { fired, changed };
}

/**
 * Candidate change vs last confirmed observation. Standard tier still
 * requires 2-of-3 (`decideConfirmation`) before emitChangeIfNeeded runs.
 */
export function shouldEmitChange(
  row: WatcherRow,
  observation: CheckObservation,
  fired: boolean | null,
): boolean {
  return isChangeCandidate(row, observation, fired);
}

function parseContext(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function emitWatchEvent(input: {
  watcher: WatcherRow;
  type: WatchEventType;
  previous: WatchObservationSnapshot | null;
  current: WatchObservationSnapshot | null;
  fired: boolean | null;
  confidence: number;
  checks_remaining: number;
  now: Date;
  requestUrl?: string;
  host?: string;
}): WatchCallbackPayload {
  const createdAt = isoTs(input.now);
  const id = newEventId(input.now.getTime());
  const diff = observationDiff(input.previous, input.current, input.fired);
  const unsigned: Omit<WatchCallbackPayload, "receipt"> = {
    id,
    type: input.type,
    watcher_id: input.watcher.id,
    created_at: createdAt,
    previous: input.previous,
    current: input.current,
    diff,
    confidence: input.confidence,
    checks_remaining: input.checks_remaining,
    expires_at: input.watcher.expires_at,
    context: parseContext(input.watcher.context_json),
    chain: { run: "none" },
  };
  const receipt = sealWatchEventReceipt({
    id,
    type: input.type,
    url: input.watcher.target_url,
    createdAt,
    confidence: input.confidence,
    watcherId: input.watcher.id,
    requestUrl: input.requestUrl,
    host: input.host,
  });
  const payload: WatchCallbackPayload = { ...unsigned, receipt };
  insertWatchEvent({
    id,
    watcher_id: input.watcher.id,
    kind: input.type,
    payload_json: JSON.stringify(payload),
    created_at: createdAt,
    delivered_at: null,
    delivery_attempts: 0,
    next_attempt_at: createdAt,
    last_error: null,
  });
  return payload;
}

export function emitChangeIfNeeded(
  watcher: WatcherRow,
  observation: CheckObservation,
  fired: boolean | null,
  confidence: number,
  checksRemaining: number,
  now: Date,
): WatchCallbackPayload | undefined {
  if (!shouldEmitChange(watcher, observation, fired)) return undefined;
  return emitWatchEvent({
    watcher,
    type: "change",
    previous: snapshotObservation(watcher.last_observation) ??
      (watcher.baseline.hash
        ? {
            hash: watcher.baseline.hash,
            status: watcher.last_observation?.status ?? "unknown",
            http_status: watcher.last_observation?.http_status ?? 0,
            http_class: watcher.last_observation?.http_class ?? "other",
            summary: watcher.baseline.summary ?? watcher.last_observation?.summary ?? "",
          }
        : null),
    current: snapshotObservation(observation),
    fired,
    confidence,
    checks_remaining: checksRemaining,
    now,
  });
}

export function emitUnreachableIfNeeded(watcher: WatcherRow, checksRemaining: number, now: Date): WatchCallbackPayload | undefined {
  if (watcher.unreachable) return undefined;
  if (hasWatchEventKind(watcher.id, "unreachable") && watcher.unreachable) return undefined;
  return emitWatchEvent({
    watcher,
    type: "unreachable",
    previous: snapshotObservation(watcher.last_observation),
    current: null,
    fired: null,
    confidence: 0.9,
    checks_remaining: checksRemaining,
    now,
  });
}

export function emitRecovered(
  watcher: WatcherRow,
  observation: CheckObservation,
  checksRemaining: number,
  now: Date,
): WatchCallbackPayload {
  return emitWatchEvent({
    watcher,
    type: "recovered",
    previous: snapshotObservation(watcher.last_observation),
    current: snapshotObservation(observation),
    fired: null,
    confidence: 0.85,
    checks_remaining: checksRemaining,
    now,
  });
}

export function emitExpiringIfNeeded(watcher: WatcherRow, now: Date): WatchCallbackPayload | undefined {
  if (watcher.expiring_emitted) return undefined;
  const payload = emitWatchEvent({
    watcher,
    type: "expiring",
    previous: snapshotObservation(watcher.last_observation),
    current: snapshotObservation(watcher.last_observation),
    fired: null,
    confidence: 1,
    checks_remaining: watcher.checks_remaining,
    now,
  });
  markExpiringEmitted(watcher.id);
  return payload;
}

export function emitExpiredIfNeeded(watcher: WatcherRow, now: Date): WatchCallbackPayload | undefined {
  if (hasWatchEventKind(watcher.id, "expired")) return undefined;
  return emitWatchEvent({
    watcher,
    type: "expired",
    previous: snapshotObservation(watcher.last_observation),
    current: snapshotObservation(watcher.last_observation),
    fired: null,
    confidence: 1,
    checks_remaining: watcher.checks_remaining,
    now,
  });
}
