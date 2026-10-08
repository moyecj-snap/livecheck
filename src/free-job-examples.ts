/**
 * The two "Try one" examples on /job. One click shows a real check of a fixed
 * Stripe posting, without using the visitor's free checks.
 *
 * Rate-safe for a launch spike: each example's result is cached in memory for
 * EXAMPLE_TTL_MS. When it goes stale, the next click gets the stale result
 * right away and ONE background refresh starts (single flight); clicks during
 * the refresh share it. With no cached result yet, callers wait on that single
 * refresh. A failed refresh is cached for EXAMPLE_FAIL_TTL_MS, so a Stripe
 * outage can't turn clicks into a stream of requests. Worst case is about two
 * upstream checks per example per TTL, whatever the traffic.
 *
 * The cache holds only these two fixed examples' rendered results, keyed by
 * "open" / "filled". Visitor links never go in here.
 */

export const FREE_JOB_EXAMPLES = {
  open: { label: "open job", url: "https://stripe.com/jobs/search?gh_jid=8172508" },
  filled: { label: "filled job", url: "https://stripe.com/jobs/search?gh_jid=7569678" },
} as const;

export type ExampleKey = keyof typeof FREE_JOB_EXAMPLES;

export const EXAMPLE_TTL_MS = 12 * 60_000;
export const EXAMPLE_FAIL_TTL_MS = 60_000;

export function isExampleKey(value: unknown): value is ExampleKey {
  return value === "open" || value === "filled";
}

type Entry<T> = { value: T; expiresAt: number };

export class ExampleCache<T> {
  private entries = new Map<ExampleKey, Entry<T>>();
  private inflight = new Map<ExampleKey, Promise<T>>();
  /** How many upstream refreshes ran (tests and the private stats). */
  refreshes = 0;

  constructor(
    private readonly compute: (key: ExampleKey) => Promise<{ value: T; ok: boolean }>,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = EXAMPLE_TTL_MS,
    private readonly failTtlMs = EXAMPLE_FAIL_TTL_MS,
  ) {}

  private refresh(key: ExampleKey): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running;
    this.refreshes += 1;
    const job = (async () => {
      try {
        const { value, ok } = await this.compute(key);
        this.entries.set(key, { value, expiresAt: this.now() + (ok ? this.ttlMs : this.failTtlMs) });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }

  async get(key: ExampleKey): Promise<{ value: T; cached: boolean }> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return { value: entry.value, cached: true };
    if (entry) {
      // Stale: answer now, refresh once in the background.
      this.refresh(key).catch(() => undefined);
      return { value: entry.value, cached: true };
    }
    return { value: await this.refresh(key), cached: false };
  }

  /** Audit seam: the only keys the cache can hold. */
  keys(): ExampleKey[] {
    return [...this.entries.keys()];
  }
}
