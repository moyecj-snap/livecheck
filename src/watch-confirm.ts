import { WATCH_CONFIRM_REFETCH_MS } from "./config.js";
import { isoTs } from "./paid-call.js";
import type { CheckObservation } from "./types.js";
import type { DetectorState } from "./watch-state.js";
import type { WatcherRow } from "./watch-store.js";

export type { DetectorState, PendingChange } from "./watch-state.js";
export { parseDetectorState } from "./watch-state.js";

/**
 * Candidate change vs last *confirmed* observation (or baseline).
 * Same fingerprint while a threshold/keyword stays true is not a new change
 * unless the detector newly fires.
 */
export function isChangeCandidate(
  row: WatcherRow,
  observation: CheckObservation,
  fired: boolean | null,
): boolean {
  const previous = row.last_observation;
  if (previous && (previous.hash !== observation.hash || previous.status !== observation.status)) {
    return true;
  }
  if (!previous && row.baseline.hash && row.baseline.hash !== observation.hash) return true;
  if (fired === true && row.detector_state?.last_fired !== true) return true;
  return false;
}

export function confirmationNextCheckAt(now: Date): string {
  return isoTs(new Date(now.getTime() + WATCH_CONFIRM_REFETCH_MS));
}

export type ConfirmationDecision = {
  emit: boolean;
  detector_state: DetectorState;
  next_is_confirm_refetch: boolean;
  /** Keep last_observation as the last confirmed snapshot while pending. */
  update_last_observation: boolean;
};

/**
 * Standard-tier 2-of-3: emit `change` only after two consecutive candidate
 * checks, or one candidate plus a ~20s confirmation re-fetch (scheduled).
 */
export function decideConfirmation(input: {
  row: WatcherRow;
  observation: CheckObservation;
  fired: boolean | null;
  content?: string | null;
  now: Date;
}): ConfirmationDecision {
  const { row, observation, fired, now } = input;
  const content = input.content ?? undefined;
  const prev = row.detector_state ?? {};
  const candidate = isChangeCandidate(row, observation, fired);

  if (!candidate) {
    return {
      emit: false,
      detector_state: { last_content: content ?? prev.last_content, last_fired: fired },
      next_is_confirm_refetch: false,
      update_last_observation: true,
    };
  }

  if (prev.pending) {
    return {
      emit: true,
      detector_state: { last_content: content ?? prev.last_content, last_fired: fired },
      next_is_confirm_refetch: false,
      update_last_observation: true,
    };
  }

  return {
    emit: false,
    detector_state: {
      last_content: prev.last_content,
      last_fired: prev.last_fired,
      pending: {
        hash: observation.hash,
        status: observation.status,
        fired,
        at: isoTs(now),
        ...(content ? { content } : {}),
      },
    },
    next_is_confirm_refetch: true,
    update_last_observation: false,
  };
}
