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
