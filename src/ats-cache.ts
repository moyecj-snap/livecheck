import {
  ATS_BOARD_CACHE_MAX_BYTES,
  ATS_BOARD_CACHE_MAX_ENTRIES,
  ATS_BOARD_CACHE_TTL_MS,
} from "./config.js";

type CacheKeyRef = {
  vendor: string;
  board: string;
  apiUrl: string;
};

/**
 * Ashby's public posting API is the whole board. Greenhouse, Lever, and
 * Workday expose one posting by id, and those URLs are preferred so a check
 * does not re-parse the board. Board responses are keyed by company/board.
 * Single-posting responses are keyed by that posting URL, not by each
 * incoming page URL, so /apply and the canonical job share one entry.
 */

export type AtsFetchScope = "board" | "posting";

export type CachedAtsResponse = {
  status: number;
  text: string;
  truncated: boolean;
};

type Entry = CachedAtsResponse & {
  bytes: number;
  expiresAt: number;
};

let clock: () => number = () => Date.now();
let maxEntries = ATS_BOARD_CACHE_MAX_ENTRIES;
let maxBytes = ATS_BOARD_CACHE_MAX_BYTES;
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export function atsFetchScope(vendor: string): AtsFetchScope {
  return vendor === "ashby" ? "board" : "posting";
}

/** Board-scoped for Ashby. Posting-scoped for vendors with a single-job URL. */
export function atsResponseCacheKey(ref: CacheKeyRef): string {
  if (atsFetchScope(ref.vendor) === "board") return `board:${ref.vendor}:${ref.board}`;
  return `posting:${ref.vendor}:${ref.apiUrl}`;
}

export function cacheableAtsResponse(status: number, truncated: boolean): boolean {
  if (truncated) return false;
  if (status >= 200 && status < 300) return true;
  if (status === 403 || status === 404 || status === 410) return true;
  return false;
}

export function readAtsResponseCache(key: string): CachedAtsResponse | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (clock() >= hit.expiresAt) {
    store.delete(key);
    return null;
  }
  store.delete(key);
  store.set(key, hit);
  return { status: hit.status, text: hit.text, truncated: hit.truncated };
}

export function writeAtsResponseCache(key: string, body: CachedAtsResponse): boolean {
  if (!cacheableAtsResponse(body.status, body.truncated)) return false;
  const bytes = Buffer.byteLength(body.text);
  if (bytes > maxBytes) return false;
  store.delete(key);
  store.set(key, {
    status: body.status,
    text: body.text,
    truncated: body.truncated,
    bytes,
    expiresAt: clock() + ATS_BOARD_CACHE_TTL_MS,
  });
  evict();
  return store.has(key);
}

function evict(): void {
  let bytes = 0;
  for (const entry of store.values()) bytes += entry.bytes;
  while (store.size > 0 && (store.size > maxEntries || bytes > maxBytes)) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    const removed = store.get(oldest);
    store.delete(oldest);
    bytes -= removed?.bytes ?? 0;
  }
}

/**
 * Concurrent checks for the same board share one fetch. The promise is
 * registered before `run` awaits so a second caller cannot start another fetch.
 */
export function joinAtsFetch<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  inflight.set(key, promise);
  run().then(resolve, reject).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  return promise;
}

export function atsCacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const entry of store.values()) bytes += entry.bytes;
  return { entries: store.size, bytes };
}

export function clearAtsResponseCache(): void {
  store.clear();
  inflight.clear();
}

export function setAtsCacheClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

export function setAtsCacheLimitsForTests(limits: { maxEntries?: number; maxBytes?: number } | null): void {
  maxEntries = limits?.maxEntries ?? ATS_BOARD_CACHE_MAX_ENTRIES;
  maxBytes = limits?.maxBytes ?? ATS_BOARD_CACHE_MAX_BYTES;
}
