import { PAID_CALL_ROUTES, isPaidCallRoute, type PaidCallRoute } from "./paid-call.js";

/**
 * Every paid call lands in exactly one /stats bucket. The rules run in this
 * order and the first match wins:
 *
 * 1. Payer is one of our wallets (`src/internal-wallets.ts`)  -> internal
 * 2. Payer is on the grader/tester list (`src/test-traffic.ts`) -> graders / testers
 * 3. No payer recorded                                          -> unattributed
 * 4. Unknown payer, but the target is a docs-example URL        -> testers_probable
 * 5. Everything else                                            -> external
 *
 * Internal is decided by payer wallet only. A `livecheck-internal/` user
 * agent is a label (`traffic.internal_label`), not a bucket. External means a
 * known outside wallet that is on no list and did not hit a docs-example URL.
 */
export type TrafficBucket = "internal" | "graders" | "testers" | "unattributed" | "testers_probable" | "external";

/** Rule order. graders and testers share rule 2 (a grader match is checked first). */
export const TRAFFIC_BUCKET_ORDER: readonly TrafficBucket[] = [
  "internal",
  "graders",
  "testers",
  "unattributed",
  "testers_probable",
  "external",
];

export const TRAFFIC_BUCKET_RULES: readonly string[] = [
  "1. payer is one of our wallets -> internal",
  "2. payer is on the grader/tester list -> graders / testers",
  "3. no payer recorded -> unattributed",
  "4. unknown payer, target is a docs-example URL -> testers_probable",
  "5. everything else -> external",
];

export type TrafficBucketLists = {
  internal: readonly string[];
  graders: readonly string[];
  testers: readonly string[];
  /** paid_calls.url_sha256 values of the docs-example URLs. */
  docsExampleUrlSha256: readonly string[];
};

export type TrafficBucketRow = {
  payer?: string | null;
  url_sha256?: string | null;
};

type NormalizedLists = {
  internal: Set<string>;
  graders: Set<string>;
  testers: Set<string>;
  docs: Set<string>;
};

function lowerSet(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

function normalizeLists(lists: TrafficBucketLists): NormalizedLists {
  return {
    internal: lowerSet(lists.internal),
    graders: lowerSet(lists.graders),
    testers: lowerSet(lists.testers),
    docs: lowerSet(lists.docsExampleUrlSha256),
  };
}

function classifyNormalized(row: TrafficBucketRow, lists: NormalizedLists): TrafficBucket {
  const payer = (row.payer ?? "").trim().toLowerCase();
  if (payer && lists.internal.has(payer)) return "internal";
  if (payer && lists.graders.has(payer)) return "graders";
  if (payer && lists.testers.has(payer)) return "testers";
  if (!payer) return "unattributed";
  const hash = (row.url_sha256 ?? "").trim().toLowerCase();
  if (hash && lists.docs.has(hash)) return "testers_probable";
  return "external";
}

/** The one bucket a paid call belongs to. See the rule order above. */
export function classifyPaidCallBucket(row: TrafficBucketRow, lists: TrafficBucketLists): TrafficBucket {
  return classifyNormalized(row, normalizeLists(lists));
}

export const ROUTE_PRICE_CENTS: Record<PaidCallRoute, number> = {
  verify: 1,
  "verify/job": 1,
  "verify/listing": 1,
  confirm: 10,
  "confirm/order": 25,
  check: 2,
  watch: 250,
  "watch/renew": 250,
};

export type BucketWindow = {
  calls: number;
  /** Whole cents: calls times the route price. */
  revenue_cents: number;
  /** COUNT(DISTINCT payer) inside the bucket. Blank payers are not a payer. */
  unique_payers: number;
  routes: Record<PaidCallRoute, number>;
};

export type BucketWindows = Record<TrafficBucket, { l7d: BucketWindow; l30d: BucketWindow }>;

export function emptyBucketWindow(): BucketWindow {
  const routes = {} as Record<PaidCallRoute, number>;
  for (const route of PAID_CALL_ROUTES) routes[route] = 0;
  return { calls: 0, revenue_cents: 0, unique_payers: 0, routes };
}

export function emptyBucketWindows(): BucketWindows {
  const out = {} as BucketWindows;
  for (const bucket of TRAFFIC_BUCKET_ORDER) out[bucket] = { l7d: emptyBucketWindow(), l30d: emptyBucketWindow() };
  return out;
}

export type BucketSourceRow = TrafficBucketRow & { ts: string; route: string };

/**
 * Bucket rows for the L7d and L30d windows (`ts >= cutoff`, the same cutoff the
 * all-traffic query uses). Rows whose route is not a paid route are skipped,
 * as traffic.all skips them.
 */
export function bucketPaidCallRows(
  rows: readonly BucketSourceRow[],
  cutoffs: { l7d: string; l30d: string },
  lists: TrafficBucketLists,
): BucketWindows {
  const normalized = normalizeLists(lists);
  const out = emptyBucketWindows();
  const payers = new Map<string, Set<string>>();
  const addTo = (bucket: TrafficBucket, window: "l7d" | "l30d", route: PaidCallRoute, payer: string) => {
    const slot = out[bucket][window];
    slot.calls += 1;
    slot.revenue_cents += ROUTE_PRICE_CENTS[route];
    slot.routes[route] += 1;
    if (payer) {
      const key = `${bucket}:${window}`;
      let set = payers.get(key);
      if (!set) {
        set = new Set();
        payers.set(key, set);
      }
      set.add(payer);
      slot.unique_payers = set.size;
    }
  };
  for (const row of rows) {
    if (!isPaidCallRoute(row.route)) continue;
    const bucket = classifyNormalized(row, normalized);
    const payer = (row.payer ?? "").trim().toLowerCase();
    if (row.ts >= cutoffs.l30d) addTo(bucket, "l30d", row.route, payer);
    if (row.ts >= cutoffs.l7d) addTo(bucket, "l7d", row.route, payer);
  }
  return out;
}
