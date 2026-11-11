import { WATCH_PRICE_USD } from "./config.js";

/** Default detector advertised on Verify / Confirm cross-sell hints. */
export const WATCH_HINT_DETECTOR = "status_change" as const;
export const WATCH_HINT_SUGGEST = "/v1/watch" as const;

export type WatchHint = {
  suggest: typeof WATCH_HINT_SUGGEST;
  detector: typeof WATCH_HINT_DETECTOR;
  price_usd: number;
};

/** In-band cross-sell on paid Verify / Confirm 200s. Never attach to 402. */
export function watchHint(): WatchHint {
  return {
    suggest: WATCH_HINT_SUGGEST,
    detector: WATCH_HINT_DETECTOR,
    price_usd: WATCH_PRICE_USD,
  };
}

export function withWatchHint<T extends object>(body: T): T & { watch: WatchHint } {
  return { ...body, watch: watchHint() };
}

/**
 * Verify answers: suggest a watch only on a live result. A closed or unknown
 * answer gets no $2.50 cross-sell (a status_change watch on a closed posting
 * has nothing left to watch). Confirm keeps withWatchHint.
 */
export function withWatchHintIfLive<T extends { status: string }>(body: T): T | (T & { watch: WatchHint }) {
  return body.status === "live" ? withWatchHint(body) : body;
}
