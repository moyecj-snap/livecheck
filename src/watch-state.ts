import type { SourceStatus } from "./types.js";

export type PendingChange = {
  hash: string;
  status: SourceStatus;
  fired: boolean | null;
  at: string;
  content?: string;
};

export type DetectorState = {
  pending?: PendingChange;
  last_content?: string;
  last_fired?: boolean | null;
};

export function parseDetectorState(raw: string | null | undefined): DetectorState {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return value as DetectorState;
  } catch {
    return {};
  }
}
