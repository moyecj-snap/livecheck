/**
 * The two "Try one" examples on /job. One click shows a real check of a fixed
 * posting, without using the visitor's free checks.
 *
 * Rate-safe for a launch spike: each example's result is cached in memory for
 * EXAMPLE_TTL_MS. When it goes stale, the next click gets the stale result
 * right away and ONE background refresh starts (single flight); clicks during
 * the refresh share it. With no cached result yet, callers wait on that single
 * refresh. A failed refresh keeps the last good result for another TTL (so
 * steady state is one refresh per example per TTL, whatever the traffic); with
 * no good result yet, the failure is cached for EXAMPLE_FAIL_TTL_MS. A refresh
 * of `open` is the primary check, plus the backup only if the primary gave no
 * clear answer.
 *
 * The cache holds only these two fixed examples' rendered results, keyed by
 * "open" / "filled". Visitor links never go in here.
 */

/**
 * SWAP THE EXAMPLES HERE. `open` is the "Try an example" button on /job, so it
 * should be a long-running role at a large company. If it stops giving a clear
 * Open/Closed answer, the cache falls back to `open.backup`. None of these are
 * Stripe postings. Livecheck also accepts Stripe machine payments, and a
 * Stripe job sample would suggest Stripe is part of the check.
 * Checked 2026-10-22 with Livecheck's own verify (Greenhouse board API listed
 * or missing, then the page classifier):
 *   - Figma "Compliance Engineer", open (first published 2026-10-16)
 *   - Databricks "Senior Software Engineer - Distributed Data Systems", open
 *     since 2019-11-14 (still listed on Greenhouse's databricks board)
 * `filled` must stay closed. It has no backup: only `open` falls back.
 * Discord's closed posting lands on the Discord board, so the card title is
 * "Discord". `employer` is shown in the result note.
 */
export const FREE_JOB_EXAMPLES = {
  open: {
    label: "open job",
    employer: "Figma",
    url: "https://job-boards.greenhouse.io/figma/jobs/6223155004",
    backup: { employer: "Databricks", url: "https://job-boards.greenhouse.io/databricks/jobs/4513122002" },
  },
  filled: { label: "filled job", employer: "Discord", url: "https://job-boards.greenhouse.io/discord/jobs/8656854002" },
} as const;

export type ExampleKey = keyof typeof FREE_JOB_EXAMPLES;

export const EXAMPLE_TTL_MS = 10 * 60_000;
export const EXAMPLE_FAIL_TTL_MS = 60_000;

export function isExampleKey(value: unknown): value is ExampleKey {
  return value === "open" || value === "filled";
}

type Entry<T> = { value: T; ok: boolean; expiresAt: number };

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
        const previous = this.entries.get(key);
        if (!ok && previous?.ok) {
          // Keep showing the last good answer rather than an error card.
          this.entries.set(key, { ...previous, expiresAt: this.now() + this.ttlMs });
          return previous.value;
        }
        this.entries.set(key, { value, ok, expiresAt: this.now() + (ok ? this.ttlMs : this.failTtlMs) });
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
