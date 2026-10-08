import {
  CHECK_PRICE_USD,
  CHAIN_TOPUP_PRICE_USD,
  CONFIRM_PRICE_USD,
  ORDER_PLACED_PRICE_USD,
  WATCH_PRICE_USD,
} from "./config.js";
import {
  DOCS_EXAMPLE_URL,
  DOCS_EXAMPLE_URLS,
  docsExampleUrlHashes,
} from "./docs-example-url.js";
import { graderWallets } from "./grader-wallets.js";
import { testTrafficAddresses } from "./test-traffic.js";
import { internalWallets } from "./internal-wallets.js";
import { PAID_CALL_ROUTES } from "./paid-call.js";
import {
  emptyRouteCounts,
  emptyWindowCounts,
  isoCutoff,
  paidCallStoreStatus,
  queryConfirmIntentWindowsFromStore,
  queryPaidCallCountsForUrlHashesFromStore,
  queryRetentionWindowsFromStore,
  queryIncludedPayerWindowsFromStore,
  queryInternalLabelCountsFromStore,
  queryUnattributedWindowsFromStore,
  queryTrafficBucketWindowsFromStore,
  type ConfirmIntentCounts,
  type PaidRouteCounts,
  type RouteCounts,
  type WindowCounts,
} from "./paid-call-store.js";
import { countReceiptsSince, emptyReceiptVerdictCounts, receiptStoreStatus } from "./receipt-store.js";
import {
  ROUTE_PRICE_CENTS,
  TRAFFIC_BUCKET_ORDER,
  TRAFFIC_BUCKET_RULES,
  type BucketWindow,
  type BucketWindows,
  type TrafficBucket,
} from "./traffic-buckets.js";
import {
  loadConfirmBenches,
  type ConfirmBenches,
} from "./confirm-stats-benches.js";
import {
  loadSentinelBenches,
  type SentinelBenches,
} from "./sentinel-stats-benches.js";
import {
  emptySentinelDetectorCounts,
  emptySentinelWatchStats,
  querySentinelWatchStats,
  type SentinelDetectorCounts,
  type SentinelWatchStats,
} from "./watch-store.js";

export type { ConfirmBenches } from "./confirm-stats-benches.js";
export type { SentinelBenches } from "./sentinel-stats-benches.js";

export type ConfirmIntentStats = {
  payable: true;
  price_usd: number;
  status: "ga" | "payable";
  l7d: IntentWindow;
  l30d: IntentWindow;
};

export type SentinelStats = {
  payable: true;
  status: "payable";
  prices: {
    check_usd: number;
    watch_usd: number;
    chain_topup_usd: number;
  };
  active_watchers: number;
  checks_run: number;
  change_events: number;
  by_detector: SentinelDetectorCounts;
  benches: SentinelBenches;
};

export type StatsVolumeScope = "this_machine_volume" | "fleet_volumes" | "partial_fleet_volumes";

export type StatsMachineContribution = {
  fly_machine_id: string | null;
  included: boolean;
  error?: string;
};

export type StatsStoreScope = {
  scope: StatsVolumeScope;
  fly_app_name: string | null;
  fly_machine_id: string | null;
  /** Present when this response summed or attempted to sum other machines. */
  machines?: StatsMachineContribution[];
  paid_calls: ReturnType<typeof paidCallStoreStatus>;
  receipts: ReturnType<typeof receiptStoreStatus>;
  confirm_unscoped_paid_calls: { l7d: number; l30d: number };
  note: string;
};

/** Sentinel aggregates for one audience (all wallets, or external only). */
export type TrafficSentinelCounts = {
  active_watchers: number;
  checks_run: number;
  change_events: number;
  /**
   * One-shot chk_ receipts inside checks_run. Receipts have no payer column,
   * so external does not remove them.
   */
  checks_run_unattributed: number;
  by_detector: SentinelDetectorCounts;
};

export type TrafficPayers = {
  /** False when this volume's paid-call store is closed. Zeros are not a measurement. */
  available: boolean;
  l7d: WindowCounts;
  l30d: WindowCounts;
};

export type TrafficSlice = {
  sentinel: TrafficSentinelCounts;
  /** Every paid route in paid_calls: verify, confirm, check, watch, renew. */
  payers: TrafficPayers;
};

export const INTERNAL_TEST_TRAFFIC_LABEL = "Includes internal test traffic.";

export const DOCS_EXAMPLE_TEST_TRAFFIC_LABEL =
  "Docs-example URLs are test traffic and are omitted from traffic.external.";

export const GRADER_TEST_TRAFFIC_LABEL =
  "Known grader and auditor wallets are test traffic and are omitted from traffic.external.";

export const TESTER_TEST_TRAFFIC_LABEL =
  "Docs and manual tester wallets are test traffic and are omitted from traffic.external.";

export const UNATTRIBUTED_TRAFFIC_LABEL =
  "Paid calls with no known payer. Counted in traffic.all and traffic.unattributed. Omitted from traffic.external and from unique payers.";

export const INTERNAL_WALLET_TRAFFIC_LABEL =
  "Paid calls whose payer is on the internal wallet list. Counted in traffic.all and traffic.internal. Omitted from traffic.external.";

export const PROBABLE_TESTER_TRAFFIC_LABEL =
  "Unknown payer on a docs-example URL (bucket rule 4). Probably a tester. Counted in traffic.all and traffic.testers_probable. Omitted from traffic.external.";

export const RECONCILIATION_LABEL =
  "Each paid call lands in exactly one bucket: internal, graders, testers, unattributed, testers_probable, external. The buckets must add up to traffic.all for calls and revenue in every window. docs_example and internal_label are overlap counts and are not part of the sum.";

export const INTERNAL_LABEL_NOTE =
  "user_agent prefix livecheck-internal/ is a label only. It does not remove a call from traffic.external. External is decided by wallet.";

/** Paid calls to the public docs examples. Still inside traffic.all. */
export type DocsExampleTraffic = {
  label: typeof DOCS_EXAMPLE_TEST_TRAFFIC_LABEL;
  /**
   * False when this volume's paid-call store is closed, or a fleet peer
   * did not publish the split. Zeros are not a measurement in that case.
   */
  available: boolean;
  /** Canonical verify docs example. Rows match paid_calls.url_sha256, not a stored raw URL. */
  url: typeof DOCS_EXAMPLE_URL;
  /** Verify and confirm docs/Bazaar examples. Matched by url_sha256. */
  urls: readonly string[];
  calls: { l7d: number; l30d: number };
};

/** Paid calls from known grader wallets. Still inside traffic.all. Addresses stay off this document. */
export type GraderTraffic = {
  label: string;
  available: boolean;
  wallets_configured: number;
  calls: { l7d: number; l30d: number };
  /** Null on a fleet document: a sum of per-volume distincts is not a fleet distinct. */
  unique_payers: { l7d: number | null; l30d: number | null };
  /** Route-priced revenue of this bucket. Missing on documents from older builds. */
  revenue?: TrafficRevenueWindow;
};

export type TrafficRevenueWindow = {
  l7d_usd: number;
  l30d_usd: number;
};

/** Sum of paid_calls × route price. Check, watch, and renew are included. */
export type TrafficRevenue = {
  source: "paid_calls";
  available: boolean;
  all: TrafficRevenueWindow;
  external: TrafficRevenueWindow;
};

/** Internal-wallet paid_calls. Still inside traffic.all. Never external. Blank payers stay unattributed. */
export type InternalWalletTraffic = {
  label: typeof INTERNAL_WALLET_TRAFFIC_LABEL;
  /**
   * False when this volume's paid-call store is closed, or a fleet peer
   * did not publish the split. Zeros are not a measurement in that case.
   */
  available: boolean;
  calls: { l7d: number; l30d: number };
  revenue: TrafficRevenueWindow;
};

/** Count of paid_calls whose user_agent starts with livecheck-internal/. Not an audience filter. */
export type InternalLabelAnnotation = {
  label: typeof INTERNAL_LABEL_NOTE;
  available: boolean;
  calls: { l7d: number; l30d: number };
};

/** Blank-payer paid_calls. Still inside traffic.all revenue. Never external. */
export type UnattributedTraffic = {
  label: typeof UNATTRIBUTED_TRAFFIC_LABEL;
  /**
   * False when this volume's paid-call store is closed, or a fleet peer
   * did not publish the split. Zeros are not a measurement in that case.
   */
  available: boolean;
  calls: { l7d: number; l30d: number };
  revenue: TrafficRevenueWindow;
};

/** Bucket rule 4: unknown payer on a docs-example URL. Shown on its own line, never dropped. */
export type ProbableTesterTraffic = {
  label: typeof PROBABLE_TESTER_TRAFFIC_LABEL;
  available: boolean;
  calls: { l7d: number; l30d: number };
  revenue: TrafficRevenueWindow;
  /** Null on a fleet document. */
  unique_payers: { l7d: number | null; l30d: number | null };
};

export type ReconciliationAmounts = { calls: number; revenue_usd: number };

export type ReconciliationWindow = {
  ok: boolean;
  /** traffic.all calls and revenue.all. */
  total: ReconciliationAmounts;
  /** internal + graders + testers + unattributed + testers_probable + external. */
  buckets_sum: ReconciliationAmounts;
  /** total minus buckets_sum. Zero when every call sits in exactly one bucket. */
  gap: ReconciliationAmounts;
  by_bucket: Record<TrafficBucket, ReconciliationAmounts>;
};

export type TrafficReconciliation = {
  label: typeof RECONCILIATION_LABEL;
  /** False when a bucket or the total is not a measurement on this response. */
  checked: boolean;
  /** True only when checked and every window has a zero gap. */
  ok: boolean;
  rules: readonly string[];
  buckets: readonly TrafficBucket[];
  /** Overlap counts shown on /stats that are not buckets and are not summed. */
  not_summed: readonly string[];
  l7d: ReconciliationWindow;
  l30d: ReconciliationWindow;
  /** Visible warning when ok is false. Null when the buckets add up. */
  warning: string | null;
};

export type TrafficHonesty = {
  includes_internal_test_traffic: true;
  label: typeof INTERNAL_TEST_TRAFFIC_LABEL;
  note: string;
  /** Count only. Addresses stay off the public document. */
  internal_wallets_configured: number;
  /** Docs-example paid_calls counted in `all` and omitted from `external`. */
  docs_example: DocsExampleTraffic;
  /** Grader/auditor wallets counted in `all` and omitted from `external`. */
  graders: GraderTraffic;
  /** Manual tester wallets counted in `all` and omitted from `external`. */
  testers: GraderTraffic;
  /** Internal-wallet rows counted in `all` and omitted from `external`. */
  internal: InternalWalletTraffic;
  /** Blank-payer rows counted in `all` and omitted from `external`. */
  unattributed: UnattributedTraffic;
  /** Unknown payer on a docs-example URL (rule 4). Counted in `all`, omitted from `external`. */
  testers_probable: ProbableTesterTraffic;
  /** Buckets (internal, graders, testers, unattributed, testers_probable, external) vs traffic.all. */
  reconciliation: TrafficReconciliation;
  /** Label count for livecheck-internal/ user agents. Does not change external. */
  internal_label: InternalLabelAnnotation;
  /** Route-priced sum of paid_calls. external uses the same omissions as traffic.external. */
  revenue: TrafficRevenue;
  /**
   * False when an included fleet volume did not publish this split
   * (older build). external is then not a full-fleet figure.
   */
  external_complete: boolean;
  /**
   * False when an included volume did not publish per-route payer counts.
   * Family verify and confirm totals still include those calls.
   */
  routes_complete: boolean;
  all: TrafficSlice;
  external: TrafficSlice;
};

export type StatsDocument = {
  ok: true;
  service: "livecheck";
  generated_at: string;
  traffic: TrafficHonesty;
  intents: {
    lead_submit: ConfirmIntentStats;
    listing_published: ConfirmIntentStats;
    order_placed: ConfirmIntentStats;
  };
  sentinel: SentinelStats;
  benches: ConfirmBenches;
  store: StatsStoreScope;
  notes: string[];
};

export type IntentWindow = {
  paid_calls: number;
  receipts: number;
  by_verdict: {
    confirmed: number;
    failed: number;
    unknown: number;
  };
};

export function emptyIntentWindow(): IntentWindow {
  return {
    paid_calls: 0,
    receipts: 0,
    by_verdict: emptyReceiptVerdictCounts(),
  };
}

function windowFromReceipts(
  receipts: { receipts: number; by_verdict: IntentWindow["by_verdict"] },
  paidCalls: number | undefined,
): IntentWindow {
  return {
    // Intent-scoped paid_calls when the store is open. Do not dump all
    // confirm-route rows onto lead_submit. If the store is closed, keep
    // the receipt count so missing paid_calls is not shown as 0 volume.
    paid_calls: paidCalls ?? receipts.receipts,
    receipts: receipts.receipts,
    by_verdict: receipts.by_verdict,
  };
}

export function statsMachineId(): string | null {
  const machine = process.env.FLY_MACHINE_ID?.trim();
  if (machine) return machine;
  const alloc = process.env.FLY_ALLOC_ID?.trim();
  return alloc || null;
}

export const LOCAL_VOLUME_NOTE =
  "Counts are this Fly machine's livecheck_data volume only. unique_payers is COUNT(DISTINCT payer) in this SQLite file (null payers are not a payer). Public GET /stats is this volume, on Fly and off. Emergency multi-machine summing is LIVECHECK_STATS_FLEET=1 and withholds unique_payers instead of adding per-volume distincts. CoS: fly ssh console -a livecheck -C \"npm run paid-call:cos\".";

export const FLEET_VOLUME_NOTE =
  "Emergency multi-machine sum (LIVECHECK_STATS_FLEET=1, store.scope=fleet_volumes). Row counts add each included machine's livecheck_data volume. unique_payers is null: a sum of per-volume distincts is not a fleet-wide distinct. Writes are partitioned, not replicated. CI benches are not summed. Stopped machines are omitted. The default public document is one machine. Per-machine CoS: fly machines list -a livecheck, then fly ssh console -a livecheck --machine <id> -C \"npm run paid-call:cos\". scope=local reads only the machine that answered.";

export const PARTIAL_FLEET_VOLUME_NOTE =
  "Fleet sum is incomplete: at least one started machine did not answer. Included machines are store.machines. Missing machines are omitted, not treated as zero. unique_payers is null on this document so a partial sum of distincts is not published. Do not read active_watchers, checks_run, change_events, or paid_calls as the full fleet until scope is fleet_volumes.";

const BAZAAR_NOTE =
  "Unpaid POST /v1/check, POST /v1/watch, and POST /v1/watch/renew include extensions.bazaar (input schema, output schema, and an example). Bazaar copy on POST /v1/confirm stays lead_submit-primary. order_placed is a separate fixed-price resource. This is 402 discovery metadata, not a claim that a CDP catalog index is complete.";

export function unscopedPaidCallsNote(
  unscoped: { l7d: number; l30d: number },
  subject: "volume" | "fleet",
): string {
  const who = subject === "fleet" ? "These volumes have" : "This volume has";
  return `${who} ${unscoped.l7d} L7d / ${unscoped.l30d} L30d confirm-route paid_calls with no stored intent. Signed receipts cannot be reconstructed from paid_calls alone (no cfm_ id, evidence, or signature). Backfill intent from logs: npm run receipt:backfill.`;
}

export function trafficHonestyNote(input: {
  walletCount: number;
  externalComplete: boolean;
  fleet: boolean;
  walletCountsDisagree?: boolean;
  routesComplete?: boolean;
  docsExample: {
    available: boolean;
    calls: { l7d: number; l30d: number };
    /** False when a fleet peer did not publish traffic.docs_example. */
    complete: boolean;
  };
  graders: {
    available: boolean;
    wallets_configured: number;
    calls: { l7d: number; l30d: number };
    complete: boolean;
  };
  testers: {
    available: boolean;
    wallets_configured: number;
    calls: { l7d: number; l30d: number };
    complete: boolean;
  };
  unattributed: {
    available: boolean;
    calls: { l7d: number; l30d: number };
    revenue: TrafficRevenueWindow;
    complete: boolean;
  };
  internal: {
    available: boolean;
    calls: { l7d: number; l30d: number };
    revenue: TrafficRevenueWindow;
    complete: boolean;
  };
  internalLabel: {
    available: boolean;
    calls: { l7d: number; l30d: number };
    complete: boolean;
  };
  testersProbable?: {
    available: boolean;
    calls: { l7d: number; l30d: number };
    revenue: TrafficRevenueWindow;
    complete: boolean;
  };
  reconciliation?: TrafficReconciliation;
}): string {
  const parts = [
    INTERNAL_TEST_TRAFFIC_LABEL,
    "Headline confirm windows and sentinel counts are all wallets.",
    input.walletCount === 0
      ? "No internal wallets are configured (LIVECHECK_INTERNAL_WALLETS=off disables the team-wallet list)."
      : `traffic.external omits ${input.walletCount} configured team wallets (built-in list plus LIVECHECK_INTERNAL_WALLETS).`,
    GRADER_TEST_TRAFFIC_LABEL,
    input.graders.wallets_configured === 0
      ? "No grader wallets are configured (LIVECHECK_GRADER_WALLETS=off disables the list)."
      : `traffic.external omits ${input.graders.wallets_configured} known grader wallets (built-in list plus LIVECHECK_GRADER_WALLETS).`,
    graderNote(input.graders, input.fleet),
    input.testers.wallets_configured === 0
      ? "No tester wallets are configured."
      : `traffic.external omits ${input.testers.wallets_configured} tester wallets from src/test-traffic.ts.`,
    testerNote(input.testers, input.fleet),
    DOCS_EXAMPLE_TEST_TRAFFIC_LABEL,
    `The stored paid_calls column is url_sha256 (SHA-256 of the full URL). traffic.external omits ${DOCS_EXAMPLE_URLS.join(", ")}. Those calls stay in traffic.all.`,
    docsExampleNote(input.docsExample, input.fleet),
    "One-shot check receipts have no payer and stay in both sentinel checks_run totals. Check, watch, and renew payers are on traffic.payers when the paid_call row stored one.",
    "A paid_calls row with a null or blank payer is traffic.unattributed. It stays in traffic.all and in all revenue. It is omitted from traffic.external, external revenue, and unique payers.",
    `traffic.unattributed is ${input.unattributed.calls.l7d} L7d / ${input.unattributed.calls.l30d} L30d calls ($${input.unattributed.revenue.l7d_usd.toFixed(2)} / $${input.unattributed.revenue.l30d_usd.toFixed(2)}).`,
    unattributedNote(input.unattributed, input.fleet),
    `traffic.internal is ${input.internal.calls.l7d} L7d / ${input.internal.calls.l30d} L30d calls ($${input.internal.revenue.l7d_usd.toFixed(2)} / $${input.internal.revenue.l30d_usd.toFixed(2)}).`,
    internalWalletNote(input.internal, input.fleet),
    "A user_agent that starts with livecheck-internal/ is an internal-label annotation on the paid-call log and on traffic.internal_label. It does not remove the call from traffic.external. External is decided by wallet only.",
    `traffic.internal_label is ${input.internalLabel.calls.l7d} L7d / ${input.internalLabel.calls.l30d} L30d calls.`,
    internalLabelNote(input.internalLabel, input.fleet),
    "Each paid call lands in exactly one bucket, first match wins: 1) payer is an internal wallet -> traffic.internal; 2) payer is on the grader/tester list -> traffic.graders or traffic.testers; 3) no payer -> traffic.unattributed; 4) unknown payer on a docs-example URL -> traffic.testers_probable; 5) everything else -> traffic.external. traffic.docs_example and traffic.internal_label are overlap counts, not buckets.",
    testersProbableNote(input.testersProbable, input.fleet),
    reconciliationNote(input.reconciliation),
    "traffic.payers counts every paid route in paid_calls: verify, confirm, check, watch, and watch/renew.",
    "traffic.revenue is calls times the route price (verify $0.01, check $0.02, confirm $0.10, confirm/order $0.25, watch and watch/renew $2.50), from paid_calls. All revenue includes every bucket. External revenue is bucket 5 only: a known outside wallet on no list, not on a docs-example URL.",
    "traffic.payers windows include routes for verify, verify/job, verify/listing, confirm, confirm/order, check, watch, and watch/renew (calls and distinct payers). verify, confirm, and watch remain family totals: calls are the sum, unique payers are distinct across that family on one SQLite file. Rows written before a route was stored keep the older route value.",
    input.fleet
      ? "unique_payers is withheld on this fleet document. Adding per-volume distinct payers is not a fleet-wide distinct."
      : "unique_payers is COUNT(DISTINCT payer) on this machine's SQLite.",
  ];
  if (input.routesComplete === false) {
    parts.push(
      "Per-route payer counts are incomplete: at least one included machine did not publish routes. Do not read verify/job or verify/listing as the full fleet. Family totals still include those calls.",
    );
  }
  if (input.walletCountsDisagree) {
    parts.push("Included machines disagree on how many internal wallets are configured. This count is the answering machine.");
  }
  if (!input.externalComplete) {
    parts.push(
      "traffic.external is incomplete: at least one included machine did not publish a wallet split. Do not read external as the full fleet.",
    );
  }
  return parts.join(" ");
}

function testersProbableNote(
  row:
    | {
        available: boolean;
        calls: { l7d: number; l30d: number };
        revenue: TrafficRevenueWindow;
        complete: boolean;
      }
    | undefined,
  fleet: boolean,
): string {
  if (!row || !row.complete) {
    return "traffic.testers_probable is incomplete: at least one included machine did not publish it. Do not treat the missing count as zero.";
  }
  if (!row.available) {
    return fleet
      ? "Probable-tester counts are not a measurement on this fleet response."
      : "Probable-tester counts are not a measurement on this response (paid-call store closed).";
  }
  return `traffic.testers_probable is ${row.calls.l7d} L7d / ${row.calls.l30d} L30d calls ($${row.revenue.l7d_usd.toFixed(2)} / $${row.revenue.l30d_usd.toFixed(2)}): unknown payers on a docs-example URL.`;
}

function reconciliationNote(reconciliation: TrafficReconciliation | undefined): string {
  if (!reconciliation) return "Bucket reconciliation is not on this response.";
  if (reconciliation.ok) {
    return `traffic.reconciliation: buckets add up to traffic.all (L7d ${reconciliation.l7d.total.calls} calls / $${reconciliation.l7d.total.revenue_usd.toFixed(2)}, L30d ${reconciliation.l30d.total.calls} calls / $${reconciliation.l30d.total.revenue_usd.toFixed(2)}).`;
  }
  return `WARNING: ${reconciliation.warning ?? "Buckets do not add up to traffic.all."}`;
}

function graderNote(
  graders: {
    available: boolean;
    calls: { l7d: number; l30d: number };
    complete: boolean;
  },
  fleet: boolean,
): string {
  if (!graders.complete) {
    return "Grader omission is incomplete: at least one included machine did not publish traffic.graders. That machine may still count those wallets in traffic.external.";
  }
  if (!graders.available) {
    return "Grader paid_call counts are not published for this response. A closed paid-call store is missing, not zero.";
  }
  const who = fleet ? "Included machines have" : "This volume has";
  return `${who} ${graders.calls.l7d} L7d / ${graders.calls.l30d} L30d grader paid_calls.`;
}

function testerNote(
  testers: {
    available: boolean;
    calls: { l7d: number; l30d: number };
    complete: boolean;
  },
  fleet: boolean,
): string {
  if (!testers.complete) {
    return "Tester omission is incomplete: at least one included machine did not publish traffic.testers. That machine may still count those wallets in traffic.external.";
  }
  if (!testers.available) {
    return "Tester paid_call counts are not published for this response. A closed paid-call store is missing, not zero.";
  }
  const who = fleet ? "Included machines have" : "This volume has";
  return `${who} ${testers.calls.l7d} L7d / ${testers.calls.l30d} L30d tester paid_calls.`;
}

function internalWalletNote(
  internal: { available: boolean; complete: boolean },
  fleet: boolean,
): string {
  if (!internal.complete) {
    return "traffic.internal is incomplete: at least one included machine did not publish the split. Do not read internal calls or revenue as the full fleet, and do not treat the gap as zero.";
  }
  if (!internal.available) {
    return fleet
      ? "Internal-wallet counts are not a measurement on this fleet response."
      : "Internal-wallet counts are not a measurement on this response (paid-call store closed).";
  }
  return "When a blank-payer row later gets an internal wallet, that revenue moves from traffic.unattributed to traffic.internal.";
}

function internalLabelNote(
  label: { available: boolean; complete: boolean },
  fleet: boolean,
): string {
  if (!label.complete) {
    return "traffic.internal_label is incomplete: at least one included machine did not publish the annotation. Do not treat the missing count as zero.";
  }
  if (!label.available) {
    return fleet
      ? "The internal-label count is not a measurement on this fleet response."
      : "The internal-label count is not a measurement on this response (paid-call store closed).";
  }
  return "The label is a user_agent prefix. An outside wallet that sends it still counts as external.";
}

function unattributedNote(
  unattributed: { available: boolean; complete: boolean },
  fleet: boolean,
): string {
  if (!unattributed.complete) {
    return "traffic.unattributed is incomplete: at least one included machine did not publish the split. Do not read unattributed calls or revenue as the full fleet, and do not treat the gap as zero.";
  }
  if (!unattributed.available) {
    return fleet
      ? "Unattributed counts are not a measurement on this fleet response."
      : "Unattributed counts are not a measurement on this response (paid-call store closed).";
  }
  return "Unattributed rows are visible so the gap between all revenue and external revenue stays on the document.";
}

function docsExampleNote(
  docsExample: {
    available: boolean;
    calls: { l7d: number; l30d: number };
    complete: boolean;
  },
  fleet: boolean,
): string {
  if (!docsExample.complete) {
    return "Docs-example omission is incomplete: at least one included machine did not publish traffic.docs_example. That machine may still count those paid_calls in traffic.external.";
  }
  if (!docsExample.available) {
    return "Docs-example paid_call counts are not published for this response. A closed paid-call store is missing, not zero.";
  }
  const who = fleet ? "Included machines have" : "This volume has";
  return `${who} ${docsExample.calls.l7d} L7d / ${docsExample.calls.l30d} L30d docs-example paid_calls.`;
}

export function emptyDocsExampleTraffic(): DocsExampleTraffic {
  return {
    label: DOCS_EXAMPLE_TEST_TRAFFIC_LABEL,
    available: false,
    url: DOCS_EXAMPLE_URL,
    urls: DOCS_EXAMPLE_URLS,
    calls: { l7d: 0, l30d: 0 },
  };
}

export function emptyUnattributedTraffic(): UnattributedTraffic {
  return {
    label: UNATTRIBUTED_TRAFFIC_LABEL,
    available: false,
    calls: { l7d: 0, l30d: 0 },
    revenue: { l7d_usd: 0, l30d_usd: 0 },
  };
}

function routeCallTotal(routes: PaidRouteCounts | undefined): number {
  let calls = 0;
  for (const route of PAID_CALL_ROUTES) calls += routes?.[route]?.calls ?? 0;
  return calls;
}

export function emptyInternalWalletTraffic(): InternalWalletTraffic {
  return {
    label: INTERNAL_WALLET_TRAFFIC_LABEL,
    available: false,
    calls: { l7d: 0, l30d: 0 },
    revenue: { l7d_usd: 0, l30d_usd: 0 },
  };
}

export function emptyInternalLabelAnnotation(): InternalLabelAnnotation {
  return {
    label: INTERNAL_LABEL_NOTE,
    available: false,
    calls: { l7d: 0, l30d: 0 },
  };
}

export function internalFromWindows(
  windows: ReturnType<typeof queryIncludedPayerWindowsFromStore>,
): InternalWalletTraffic {
  if (!windows) return emptyInternalWalletTraffic();
  return {
    label: INTERNAL_WALLET_TRAFFIC_LABEL,
    available: true,
    calls: {
      l7d: routeCallTotal(windows.l7d.routes),
      l30d: routeCallTotal(windows.l30d.routes),
    },
    revenue: {
      l7d_usd: paidCallRevenueUsd(windows.l7d.routes),
      l30d_usd: paidCallRevenueUsd(windows.l30d.routes),
    },
  };
}

export function internalLabelFromCounts(
  counts: { l7d: number; l30d: number } | undefined,
): InternalLabelAnnotation {
  if (!counts) return emptyInternalLabelAnnotation();
  return { label: INTERNAL_LABEL_NOTE, available: true, calls: counts };
}

export function unattributedFromWindows(
  windows: ReturnType<typeof queryUnattributedWindowsFromStore>,
): UnattributedTraffic {
  if (!windows) return emptyUnattributedTraffic();
  return {
    label: UNATTRIBUTED_TRAFFIC_LABEL,
    available: true,
    calls: {
      l7d: routeCallTotal(windows.l7d.routes),
      l30d: routeCallTotal(windows.l30d.routes),
    },
    revenue: {
      l7d_usd: paidCallRevenueUsd(windows.l7d.routes),
      l30d_usd: paidCallRevenueUsd(windows.l30d.routes),
    },
  };
}

export function emptyGraderTraffic(): GraderTraffic {
  return {
    label: GRADER_TEST_TRAFFIC_LABEL,
    available: false,
    wallets_configured: 0,
    calls: { l7d: 0, l30d: 0 },
    unique_payers: { l7d: 0, l30d: 0 },
  };
}

export function emptyProbableTesterTraffic(): ProbableTesterTraffic {
  return {
    label: PROBABLE_TESTER_TRAFFIC_LABEL,
    available: false,
    calls: { l7d: 0, l30d: 0 },
    revenue: { l7d_usd: 0, l30d_usd: 0 },
    unique_payers: { l7d: 0, l30d: 0 },
  };
}

type BucketPair = { l7d: BucketWindow; l30d: BucketWindow };

function bucketCalls(pair: BucketPair): { l7d: number; l30d: number } {
  return { l7d: pair.l7d.calls, l30d: pair.l30d.calls };
}

function bucketRevenue(pair: BucketPair): TrafficRevenueWindow {
  return { l7d_usd: pair.l7d.revenue_cents / 100, l30d_usd: pair.l30d.revenue_cents / 100 };
}

function bucketPayers(pair: BucketPair): { l7d: number; l30d: number } {
  return { l7d: pair.l7d.unique_payers, l30d: pair.l30d.unique_payers };
}

/** traffic.internal from the bucket pass (rule 1). */
export function internalFromBuckets(buckets: BucketWindows | undefined): InternalWalletTraffic {
  if (!buckets) return emptyInternalWalletTraffic();
  return {
    label: INTERNAL_WALLET_TRAFFIC_LABEL,
    available: true,
    calls: bucketCalls(buckets.internal),
    revenue: bucketRevenue(buckets.internal),
  };
}

/** traffic.unattributed from the bucket pass (rule 3). */
export function unattributedFromBuckets(buckets: BucketWindows | undefined): UnattributedTraffic {
  if (!buckets) return emptyUnattributedTraffic();
  return {
    label: UNATTRIBUTED_TRAFFIC_LABEL,
    available: true,
    calls: bucketCalls(buckets.unattributed),
    revenue: bucketRevenue(buckets.unattributed),
  };
}

/** traffic.testers_probable from the bucket pass (rule 4). */
export function probableTestersFromBuckets(buckets: BucketWindows | undefined): ProbableTesterTraffic {
  if (!buckets) return emptyProbableTesterTraffic();
  return {
    label: PROBABLE_TESTER_TRAFFIC_LABEL,
    available: true,
    calls: bucketCalls(buckets.testers_probable),
    revenue: bucketRevenue(buckets.testers_probable),
    unique_payers: bucketPayers(buckets.testers_probable),
  };
}

/** traffic.graders or traffic.testers from the bucket pass (rule 2). */
export function testWalletTrafficFromBuckets(
  buckets: BucketWindows | undefined,
  bucket: "graders" | "testers",
  walletsConfigured: number,
): GraderTraffic {
  const label = bucket === "graders" ? GRADER_TEST_TRAFFIC_LABEL : TESTER_TEST_TRAFFIC_LABEL;
  if (!buckets) {
    return { ...emptyGraderTraffic(), label, wallets_configured: walletsConfigured, revenue: { l7d_usd: 0, l30d_usd: 0 } };
  }
  return {
    label,
    available: true,
    wallets_configured: walletsConfigured,
    calls: bucketCalls(buckets[bucket]),
    unique_payers: bucketPayers(buckets[bucket]),
    revenue: bucketRevenue(buckets[bucket]),
  };
}

const RECONCILIATION_NOT_SUMMED = ["docs_example", "internal_label"] as const;

function toCents(usd: number): number {
  return Math.round(usd * 100);
}

function emptyReconciliationWindow(): ReconciliationWindow {
  const zero = () => ({ calls: 0, revenue_usd: 0 });
  const by_bucket = {} as Record<TrafficBucket, ReconciliationAmounts>;
  for (const bucket of TRAFFIC_BUCKET_ORDER) by_bucket[bucket] = zero();
  return { ok: false, total: zero(), buckets_sum: zero(), gap: zero(), by_bucket };
}

/**
 * Check that internal + graders + testers + unattributed + testers_probable +
 * external equals traffic.all, for calls and revenue, in each window. Sums run
 * in whole cents. Any gap, or any bucket that is not a measurement, sets
 * ok=false and a warning that /stats shows.
 */
export function reconcileTraffic(
  traffic: Pick<
    TrafficHonesty,
    "all" | "external" | "revenue" | "internal" | "graders" | "testers" | "unattributed" | "testers_probable" | "external_complete"
  >,
): TrafficReconciliation {
  const missing: string[] = [];
  if (!traffic.all.payers.available) missing.push("traffic.all");
  if (!traffic.external.payers.available || !traffic.external_complete) missing.push("traffic.external");
  if (!traffic.revenue.available) missing.push("traffic.revenue");
  if (!traffic.internal?.available) missing.push("traffic.internal");
  if (!traffic.graders?.available || !traffic.graders.revenue) missing.push("traffic.graders");
  if (!traffic.testers?.available || !traffic.testers.revenue) missing.push("traffic.testers");
  if (!traffic.unattributed?.available) missing.push("traffic.unattributed");
  if (!traffic.testers_probable?.available) missing.push("traffic.testers_probable");

  const windowFor = (key: "l7d" | "l30d"): ReconciliationWindow => {
    const out = emptyReconciliationWindow();
    const usdKey = key === "l7d" ? "l7d_usd" : "l30d_usd";
    const amounts: Record<TrafficBucket, { calls: number; cents: number }> = {
      internal: { calls: traffic.internal?.calls[key] ?? 0, cents: toCents(traffic.internal?.revenue[usdKey] ?? 0) },
      graders: { calls: traffic.graders?.calls[key] ?? 0, cents: toCents(traffic.graders?.revenue?.[usdKey] ?? 0) },
      testers: { calls: traffic.testers?.calls[key] ?? 0, cents: toCents(traffic.testers?.revenue?.[usdKey] ?? 0) },
      unattributed: {
        calls: traffic.unattributed?.calls[key] ?? 0,
        cents: toCents(traffic.unattributed?.revenue[usdKey] ?? 0),
      },
      testers_probable: {
        calls: traffic.testers_probable?.calls[key] ?? 0,
        cents: toCents(traffic.testers_probable?.revenue[usdKey] ?? 0),
      },
      external: {
        calls: routeCallTotal(traffic.external.payers[key].routes),
        cents: toCents(traffic.revenue.external[usdKey]),
      },
    };
    let sumCalls = 0;
    let sumCents = 0;
    for (const bucket of TRAFFIC_BUCKET_ORDER) {
      const amount = amounts[bucket];
      out.by_bucket[bucket] = { calls: amount.calls, revenue_usd: amount.cents / 100 };
      sumCalls += amount.calls;
      sumCents += amount.cents;
    }
    const totalCalls = routeCallTotal(traffic.all.payers[key].routes);
    const totalCents = toCents(traffic.revenue.all[usdKey]);
    out.total = { calls: totalCalls, revenue_usd: totalCents / 100 };
    out.buckets_sum = { calls: sumCalls, revenue_usd: sumCents / 100 };
    out.gap = { calls: totalCalls - sumCalls, revenue_usd: (totalCents - sumCents) / 100 };
    out.ok = totalCalls === sumCalls && totalCents === sumCents;
    return out;
  };

  const l7d = windowFor("l7d");
  const l30d = windowFor("l30d");
  const checked = missing.length === 0;
  const ok = checked && l7d.ok && l30d.ok;
  let warning: string | null = null;
  if (!checked) {
    warning = `Bucket reconciliation was not checked: ${missing.join(", ")} is not a measurement on this response. Do not assume the buckets add up.`;
  } else if (!ok) {
    const gaps: string[] = [];
    for (const [name, w] of [
      ["L7d", l7d],
      ["L30d", l30d],
    ] as const) {
      if (w.ok) continue;
      gaps.push(
        `${name}: total ${w.total.calls} calls / $${w.total.revenue_usd.toFixed(2)}, buckets ${w.buckets_sum.calls} calls / $${w.buckets_sum.revenue_usd.toFixed(2)}, gap ${w.gap.calls} calls / $${w.gap.revenue_usd.toFixed(2)}`,
      );
    }
    warning = `Buckets do not add up to traffic.all. ${gaps.join("; ")}. Some paid calls are in no bucket or in more than one.`;
  }
  return {
    label: RECONCILIATION_LABEL,
    checked,
    ok,
    rules: TRAFFIC_BUCKET_RULES,
    buckets: TRAFFIC_BUCKET_ORDER,
    not_summed: RECONCILIATION_NOT_SUMMED,
    l7d,
    l30d,
    warning,
  };
}

/** Whole cents, then dollars. Avoids binary float drift on $0.10 and $2.50. */
export function paidCallRevenueUsd(routes: PaidRouteCounts | undefined): number {
  let cents = 0;
  for (const route of PAID_CALL_ROUTES) {
    cents += (routes?.[route]?.calls ?? 0) * ROUTE_PRICE_CENTS[route];
  }
  return cents / 100;
}

export function emptyTrafficRevenue(): TrafficRevenue {
  return {
    source: "paid_calls",
    available: false,
    all: { l7d_usd: 0, l30d_usd: 0 },
    external: { l7d_usd: 0, l30d_usd: 0 },
  };
}

function revenueFromPayers(payers: TrafficPayers): TrafficRevenueWindow {
  if (!payers.available) return { l7d_usd: 0, l30d_usd: 0 };
  return {
    l7d_usd: paidCallRevenueUsd(payers.l7d.routes),
    l30d_usd: paidCallRevenueUsd(payers.l30d.routes),
  };
}

export function emptyTrafficPayers(): TrafficPayers {
  return { available: false, l7d: emptyWindowCounts(), l30d: emptyWindowCounts() };
}

export function cloneDetectorCounts(counts: SentinelDetectorCounts): SentinelDetectorCounts {
  return {
    status_change: { ...counts.status_change },
    keyword: { ...counts.keyword },
    text_diff: { ...counts.text_diff },
    numeric_threshold: { ...counts.numeric_threshold },
  };
}

export function emptyTrafficSentinelCounts(): TrafficSentinelCounts {
  return {
    active_watchers: 0,
    checks_run: 0,
    change_events: 0,
    checks_run_unattributed: 0,
    by_detector: emptySentinelDetectorCounts(),
  };
}

export function cloneTrafficSlice(slice: TrafficSlice): TrafficSlice {
  return {
    sentinel: {
      ...slice.sentinel,
      by_detector: cloneDetectorCounts(slice.sentinel.by_detector),
    },
    payers: {
      available: slice.payers.available,
      l7d: copyWindowCounts(slice.payers.l7d),
      l30d: copyWindowCounts(slice.payers.l30d),
    },
  };
}

export function statsNotes(
  unscoped: { l7d: number; l30d: number },
  volumeNote: string,
  subject: "volume" | "fleet" = "volume",
): string[] {
  const notes = [
    INTERNAL_TEST_TRAFFIC_LABEL,
    "Payable Confirm intents: lead_submit (GA, $0.10) and listing_published ($0.10) on POST /v1/confirm; order_placed ($0.25) on POST /v1/confirm/order.",
    BAZAAR_NOTE,
    "paid_calls are confirm-route rows with that intent stored. Pre-intent-column confirm rows are store.confirm_unscoped_paid_calls and are not attributed to lead_submit.",
    "Sentinel checks_run is one-shot POST /v1/check receipts plus successful scheduled observations (term quota minus checks_remaining; failed fetches do not decrement checks_remaining). by_detector is SQLite watchers + change events. sentinel.benches are CI/local gate results from bench/sentinel-report.json (fallback: main 590627c), not a live dispute rate. The outage gate outage_no_content_change is not in sentinel.benches; do not treat this payload as a republish of that gate.",
    "Confirm benches.false_confirmed_rate is per-intent CI/local honesty (lead_submit / listing_published / order_placed) from bench/*-report.json, not a live dispute rate. Do not infer FC from paid_calls.",
    volumeNote,
  ];
  if (unscoped.l7d > 0 || unscoped.l30d > 0) {
    notes.push(unscopedPaidCallsNote(unscoped, subject));
  }
  return notes;
}

function buildStoreScope(unscoped: { l7d: number; l30d: number }): StatsStoreScope {
  return {
    scope: "this_machine_volume",
    fly_app_name: process.env.FLY_APP_NAME?.trim() || null,
    fly_machine_id: statsMachineId(),
    paid_calls: paidCallStoreStatus(),
    receipts: receiptStoreStatus(),
    confirm_unscoped_paid_calls: unscoped,
    note: LOCAL_VOLUME_NOTE,
  };
}

function loadWatchStats(excludePayers: readonly string[] = []): SentinelWatchStats {
  try {
    return querySentinelWatchStats(excludePayers.length > 0 ? { excludePayers } : {});
  } catch {
    return emptySentinelWatchStats();
  }
}

function trafficSentinelFromWatch(watch: SentinelWatchStats, oneShotChecks: number): TrafficSentinelCounts {
  return {
    active_watchers: watch.active_watchers,
    checks_run: oneShotChecks + watch.checks_run_scheduled,
    change_events: watch.change_events,
    checks_run_unattributed: oneShotChecks,
    by_detector: watch.by_detector,
  };
}

function copyRouteCounts(routes: PaidRouteCounts | undefined): PaidRouteCounts {
  const out = emptyRouteCounts();
  if (!routes) return out;
  for (const route of PAID_CALL_ROUTES) {
    const counts = routes[route];
    if (!counts) continue;
    out[route] = { calls: counts.calls, unique_payers: counts.unique_payers };
  }
  return out;
}

function copyWindowCounts(window: WindowCounts): WindowCounts {
  return {
    verify: { ...window.verify },
    confirm: { ...window.confirm },
    check: {
      calls: window.check?.calls ?? 0,
      unique_payers: window.check?.unique_payers ?? 0,
    },
    watch: {
      calls: window.watch?.calls ?? 0,
      unique_payers: window.watch?.unique_payers ?? 0,
    },
    routes: copyRouteCounts(window.routes),
  };
}

function payersHaveRoutes(payers: TrafficPayers | undefined): boolean {
  return Boolean(payers?.l7d?.routes && payers?.l30d?.routes);
}

function trafficPayersFromStore(windows: ReturnType<typeof queryRetentionWindowsFromStore>): TrafficPayers {
  if (!windows) return emptyTrafficPayers();
  return { available: true, l7d: copyWindowCounts(windows.l7d), l30d: copyWindowCounts(windows.l30d) };
}

function addRouteCounts(
  left: WindowCounts["verify"],
  right: WindowCounts["verify"],
): WindowCounts["verify"] {
  return {
    calls: left.calls + right.calls,
    // A sum of per-volume COUNT(DISTINCT) values is not a distinct.
    unique_payers: null,
  };
}

function addRouteCountMap(left: PaidRouteCounts | undefined, right: PaidRouteCounts | undefined): PaidRouteCounts {
  const out = emptyRouteCounts();
  for (const route of PAID_CALL_ROUTES) {
    out[route] = addRouteCounts(left?.[route] ?? out[route], right?.[route] ?? out[route]);
  }
  return out;
}

/** Drop distinct-payer fields on any multi-volume document, including partial sums. */
export function withholdUniquePayers(payers: TrafficPayers): TrafficPayers {
  const blank = (counts: { calls: number }): RouteCounts => ({
    calls: counts.calls,
    unique_payers: null,
  });
  const window = (counts: WindowCounts): WindowCounts => {
    const routes = emptyRouteCounts();
    for (const route of PAID_CALL_ROUTES) {
      routes[route] = blank(counts.routes?.[route] ?? { calls: 0 });
    }
    return {
      verify: blank(counts.verify),
      confirm: blank(counts.confirm),
      check: blank(counts.check ?? { calls: 0 }),
      watch: blank(counts.watch ?? { calls: 0 }),
      routes,
    };
  };
  return { available: payers.available, l7d: window(payers.l7d), l30d: window(payers.l30d) };
}

function addWindowCounts(left: WindowCounts, right: WindowCounts): WindowCounts {
  const family = (a: RouteCounts | undefined, b: RouteCounts | undefined): RouteCounts =>
    addRouteCounts(a ?? { calls: 0, unique_payers: 0 }, b ?? { calls: 0, unique_payers: 0 });
  return {
    verify: family(left.verify, right.verify),
    confirm: family(left.confirm, right.confirm),
    check: family(left.check, right.check),
    watch: family(left.watch, right.watch),
    routes: addRouteCountMap(left.routes, right.routes),
  };
}

function addTrafficPayers(left: TrafficPayers, right: TrafficPayers): TrafficPayers {
  return {
    available: left.available && right.available,
    l7d: addWindowCounts(left.l7d, right.l7d),
    l30d: addWindowCounts(left.l30d, right.l30d),
  };
}

const TRAFFIC_DETECTORS = ["status_change", "keyword", "text_diff", "numeric_threshold"] as const;

function addTrafficSentinel(
  left: TrafficSentinelCounts,
  right: TrafficSentinelCounts,
  includeUnattributed: boolean,
): TrafficSentinelCounts {
  const by_detector = cloneDetectorCounts(left.by_detector);
  for (const detector of TRAFFIC_DETECTORS) {
    const extra = right.by_detector[detector];
    by_detector[detector] = {
      watchers: by_detector[detector].watchers + (extra?.watchers ?? 0),
      change_events: by_detector[detector].change_events + (extra?.change_events ?? 0),
    };
  }
  return {
    active_watchers: left.active_watchers + right.active_watchers,
    checks_run: left.checks_run + right.checks_run,
    change_events: left.change_events + right.change_events,
    checks_run_unattributed: includeUnattributed
      ? left.checks_run_unattributed + right.checks_run_unattributed
      : left.checks_run_unattributed,
    by_detector,
  };
}

/** Headline sentinel fields from a peer that predates the traffic split. */
export function legacyTrafficSentinel(doc: StatsDocument): TrafficSentinelCounts {
  return {
    active_watchers: doc.sentinel.active_watchers,
    checks_run: doc.sentinel.checks_run,
    change_events: doc.sentinel.change_events,
    checks_run_unattributed: 0,
    by_detector: cloneDetectorCounts(doc.sentinel.by_detector),
  };
}

export function publishedTraffic(doc: StatsDocument): TrafficHonesty | undefined {
  const traffic = doc.traffic;
  if (!traffic?.all?.sentinel || !traffic.external?.sentinel) return undefined;
  if (!traffic.all.payers || !traffic.external.payers) return undefined;
  if (traffic.label !== INTERNAL_TEST_TRAFFIC_LABEL) return undefined;
  return traffic;
}

function readDocsExample(traffic: TrafficHonesty | undefined): DocsExampleTraffic | undefined {
  const docs = traffic?.docs_example;
  if (!docs) return undefined;
  if (docs.label !== DOCS_EXAMPLE_TEST_TRAFFIC_LABEL) return undefined;
  if (docs.url !== DOCS_EXAMPLE_URL) return undefined;
  if (typeof docs.available !== "boolean") return undefined;
  if (typeof docs.calls?.l7d !== "number" || typeof docs.calls?.l30d !== "number") return undefined;
  return docs;
}

/**
 * Sum docs-example call counts. A peer that predates the field does not
 * contribute a number, and the merged count is not a full measurement.
 */
function mergeDocsExampleTraffic(
  localTraffic: TrafficHonesty | undefined,
  peers: readonly { included: boolean; doc?: StatsDocument }[],
): { available: boolean; calls: { l7d: number; l30d: number }; complete: boolean } {
  let calls = { l7d: 0, l30d: 0 };
  let available = true;
  let complete = true;
  const absorb = (traffic: TrafficHonesty | undefined) => {
    const docs = readDocsExample(traffic);
    if (!docs) {
      complete = false;
      available = false;
      return;
    }
    if (!docs.available) available = false;
    calls = { l7d: calls.l7d + docs.calls.l7d, l30d: calls.l30d + docs.calls.l30d };
  };
  absorb(localTraffic);
  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    absorb(publishedTraffic(peer.doc));
  }
  return { available: complete && available, calls, complete };
}

function readGraders(traffic: TrafficHonesty | undefined): GraderTraffic | undefined {
  const graders = traffic?.graders;
  if (!graders || graders.label !== GRADER_TEST_TRAFFIC_LABEL) return undefined;
  if (typeof graders.available !== "boolean") return undefined;
  if (typeof graders.wallets_configured !== "number") return undefined;
  if (typeof graders.calls?.l7d !== "number" || typeof graders.calls?.l30d !== "number") return undefined;
  const l7 = graders.unique_payers?.l7d;
  const l30 = graders.unique_payers?.l30d;
  if (l7 !== null && typeof l7 !== "number") return undefined;
  if (l30 !== null && typeof l30 !== "number") return undefined;
  return graders;
}

function mergeGraderTraffic(
  localTraffic: TrafficHonesty | undefined,
  peers: readonly { included: boolean; doc?: StatsDocument }[],
): { traffic: GraderTraffic; complete: boolean } {
  let calls = { l7d: 0, l30d: 0 };
  let revenue: TrafficRevenueWindow | undefined = { l7d_usd: 0, l30d_usd: 0 };
  let available = true;
  let complete = true;
  const absorb = (traffic: TrafficHonesty | undefined) => {
    const graders = readGraders(traffic);
    if (!graders) {
      complete = false;
      available = false;
      return;
    }
    if (!graders.available) available = false;
    calls = { l7d: calls.l7d + graders.calls.l7d, l30d: calls.l30d + graders.calls.l30d };
    revenue = addRevenueWindow(revenue, graders.revenue);
  };
  absorb(localTraffic);
  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    absorb(publishedTraffic(peer.doc));
  }
  return {
    complete,
    traffic: {
      label: GRADER_TEST_TRAFFIC_LABEL,
      available: complete && available,
      wallets_configured: localTraffic?.graders?.wallets_configured ?? 0,
      calls,
      unique_payers: { l7d: null, l30d: null },
      ...(revenue ? { revenue } : {}),
    },
  };
}

function readTesters(traffic: TrafficHonesty | undefined): GraderTraffic | undefined {
  const testers = traffic?.testers;
  if (!testers || testers.label !== TESTER_TEST_TRAFFIC_LABEL) return undefined;
  if (typeof testers.available !== "boolean") return undefined;
  if (typeof testers.wallets_configured !== "number") return undefined;
  if (typeof testers.calls?.l7d !== "number" || typeof testers.calls?.l30d !== "number") return undefined;
  const l7 = testers.unique_payers?.l7d;
  const l30 = testers.unique_payers?.l30d;
  if (l7 !== null && typeof l7 !== "number") return undefined;
  if (l30 !== null && typeof l30 !== "number") return undefined;
  return testers;
}

function mergeTesterTraffic(
  localTraffic: TrafficHonesty | undefined,
  peers: readonly { included: boolean; doc?: StatsDocument }[],
): { traffic: GraderTraffic; complete: boolean } {
  let calls = { l7d: 0, l30d: 0 };
  let revenue: TrafficRevenueWindow | undefined = { l7d_usd: 0, l30d_usd: 0 };
  let available = true;
  let complete = true;
  const absorb = (traffic: TrafficHonesty | undefined) => {
    const testers = readTesters(traffic);
    if (!testers) {
      complete = false;
      available = false;
      return;
    }
    if (!testers.available) available = false;
    calls = { l7d: calls.l7d + testers.calls.l7d, l30d: calls.l30d + testers.calls.l30d };
    revenue = addRevenueWindow(revenue, testers.revenue);
  };
  absorb(localTraffic);
  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    absorb(publishedTraffic(peer.doc));
  }
  return {
    complete,
    traffic: {
      label: TESTER_TEST_TRAFFIC_LABEL,
      available: complete && available,
      wallets_configured: localTraffic?.testers?.wallets_configured ?? 0,
      calls,
      unique_payers: { l7d: null, l30d: null },
      ...(revenue ? { revenue } : {}),
    },
  };
}

/** Whole-cent add. Undefined (an older peer without revenue) stays undefined. */
function addRevenueWindow(
  left: TrafficRevenueWindow | undefined,
  right: TrafficRevenueWindow | undefined,
): TrafficRevenueWindow | undefined {
  if (!left || !right) return undefined;
  if (typeof right.l7d_usd !== "number" || typeof right.l30d_usd !== "number") return undefined;
  return {
    l7d_usd: (toCents(left.l7d_usd) + toCents(right.l7d_usd)) / 100,
    l30d_usd: (toCents(left.l30d_usd) + toCents(right.l30d_usd)) / 100,
  };
}

function readProbableTesters(traffic: TrafficHonesty | undefined): ProbableTesterTraffic | undefined {
  const row = traffic?.testers_probable;
  if (!row || row.label !== PROBABLE_TESTER_TRAFFIC_LABEL) return undefined;
  if (typeof row.available !== "boolean") return undefined;
  if (typeof row.calls?.l7d !== "number" || typeof row.calls?.l30d !== "number") return undefined;
  if (typeof row.revenue?.l7d_usd !== "number" || typeof row.revenue?.l30d_usd !== "number") return undefined;
  return row;
}

function mergeProbableTesters(
  localTraffic: TrafficHonesty | undefined,
  peers: readonly { included: boolean; doc?: StatsDocument }[],
): { traffic: ProbableTesterTraffic; complete: boolean } {
  let calls = { l7d: 0, l30d: 0 };
  let revenue: TrafficRevenueWindow = { l7d_usd: 0, l30d_usd: 0 };
  let available = true;
  let complete = true;
  const absorb = (traffic: TrafficHonesty | undefined) => {
    const row = readProbableTesters(traffic);
    if (!row) {
      complete = false;
      available = false;
      return;
    }
    if (!row.available) available = false;
    calls = { l7d: calls.l7d + row.calls.l7d, l30d: calls.l30d + row.calls.l30d };
    revenue = addRevenueWindow(revenue, row.revenue) ?? revenue;
  };
  absorb(localTraffic);
  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    absorb(publishedTraffic(peer.doc));
  }
  return {
    complete,
    traffic: {
      label: PROBABLE_TESTER_TRAFFIC_LABEL,
      available: complete && available,
      calls,
      revenue,
      unique_payers: { l7d: null, l30d: null },
    },
  };
}

function readInternal(traffic: TrafficHonesty | undefined): InternalWalletTraffic | undefined {
  const row = traffic?.internal;
  if (!row || row.label !== INTERNAL_WALLET_TRAFFIC_LABEL) return undefined;
  if (typeof row.available !== "boolean") return undefined;
  if (typeof row.calls?.l7d !== "number" || typeof row.calls?.l30d !== "number") return undefined;
  if (typeof row.revenue?.l7d_usd !== "number" || typeof row.revenue?.l30d_usd !== "number") return undefined;
  return row;
}

function mergeInternalTraffic(
  localTraffic: TrafficHonesty | undefined,
  peers: readonly { included: boolean; doc?: StatsDocument }[],
): { traffic: InternalWalletTraffic; complete: boolean } {
  let calls = { l7d: 0, l30d: 0 };
  let revenue = { l7d_usd: 0, l30d_usd: 0 };
  let available = true;
  let complete = true;
  const absorb = (traffic: TrafficHonesty | undefined) => {
    const row = readInternal(traffic);
    if (!row) {
      complete = false;
      available = false;
      return;
    }
    if (!row.available) available = false;
    calls = { l7d: calls.l7d + row.calls.l7d, l30d: calls.l30d + row.calls.l30d };
    revenue = {
      l7d_usd: revenue.l7d_usd + row.revenue.l7d_usd,
      l30d_usd: revenue.l30d_usd + row.revenue.l30d_usd,
    };
  };
  absorb(localTraffic);
  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    absorb(publishedTraffic(peer.doc));
  }
  return {
    complete,
    traffic: {
      label: INTERNAL_WALLET_TRAFFIC_LABEL,
      available: complete && available,
      calls,
      revenue,
    },
  };
}

function readInternalLabel(traffic: TrafficHonesty | undefined): InternalLabelAnnotation | undefined {
  const row = traffic?.internal_label;
  if (!row || row.label !== INTERNAL_LABEL_NOTE) return undefined;
  if (typeof row.available !== "boolean") return undefined;
  if (typeof row.calls?.l7d !== "number" || typeof row.calls?.l30d !== "number") return undefined;
  return row;
}

function mergeInternalLabel(
  localTraffic: TrafficHonesty | undefined,
  peers: readonly { included: boolean; doc?: StatsDocument }[],
): { traffic: InternalLabelAnnotation; complete: boolean } {
  let calls = { l7d: 0, l30d: 0 };
  let available = true;
  let complete = true;
  const absorb = (traffic: TrafficHonesty | undefined) => {
    const row = readInternalLabel(traffic);
    if (!row) {
      complete = false;
      available = false;
      return;
    }
    if (!row.available) available = false;
    calls = { l7d: calls.l7d + row.calls.l7d, l30d: calls.l30d + row.calls.l30d };
  };
  absorb(localTraffic);
  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    absorb(publishedTraffic(peer.doc));
  }
  return {
    complete,
    traffic: {
      label: INTERNAL_LABEL_NOTE,
      available: complete && available,
      calls,
    },
  };
}

function readUnattributed(traffic: TrafficHonesty | undefined): UnattributedTraffic | undefined {
  const row = traffic?.unattributed;
  if (!row || row.label !== UNATTRIBUTED_TRAFFIC_LABEL) return undefined;
  if (typeof row.available !== "boolean") return undefined;
  if (typeof row.calls?.l7d !== "number" || typeof row.calls?.l30d !== "number") return undefined;
  if (typeof row.revenue?.l7d_usd !== "number" || typeof row.revenue?.l30d_usd !== "number") return undefined;
  return row;
}

function mergeUnattributedTraffic(
  localTraffic: TrafficHonesty | undefined,
  peers: readonly { included: boolean; doc?: StatsDocument }[],
): { traffic: UnattributedTraffic; complete: boolean } {
  let calls = { l7d: 0, l30d: 0 };
  let revenue = { l7d_usd: 0, l30d_usd: 0 };
  let available = true;
  let complete = true;
  const absorb = (traffic: TrafficHonesty | undefined) => {
    const row = readUnattributed(traffic);
    if (!row) {
      complete = false;
      available = false;
      return;
    }
    if (!row.available) available = false;
    calls = { l7d: calls.l7d + row.calls.l7d, l30d: calls.l30d + row.calls.l30d };
    revenue = {
      l7d_usd: revenue.l7d_usd + row.revenue.l7d_usd,
      l30d_usd: revenue.l30d_usd + row.revenue.l30d_usd,
    };
  };
  absorb(localTraffic);
  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    absorb(publishedTraffic(peer.doc));
  }
  return {
    complete,
    traffic: {
      label: UNATTRIBUTED_TRAFFIC_LABEL,
      available: complete && available,
      calls,
      revenue,
    },
  };
}

function readRevenue(traffic: TrafficHonesty | undefined): TrafficRevenue | undefined {
  const revenue = traffic?.revenue;
  if (!revenue || revenue.source !== "paid_calls") return undefined;
  if (typeof revenue.available !== "boolean") return undefined;
  if (typeof revenue.all?.l7d_usd !== "number" || typeof revenue.all?.l30d_usd !== "number") return undefined;
  if (typeof revenue.external?.l7d_usd !== "number" || typeof revenue.external?.l30d_usd !== "number") return undefined;
  return revenue;
}

function mergeTrafficRevenue(
  localTraffic: TrafficHonesty | undefined,
  peers: readonly { included: boolean; doc?: StatsDocument }[],
  allPayers: TrafficPayers,
  externalPayers: TrafficPayers,
): TrafficRevenue {
  let complete = Boolean(readRevenue(localTraffic));
  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    if (!readRevenue(publishedTraffic(peer.doc))) complete = false;
  }
  return {
    source: "paid_calls",
    available: complete && allPayers.available && externalPayers.available,
    all: revenueFromPayers(allPayers),
    external: revenueFromPayers(externalPayers),
  };
}

/**
 * Sum per-volume wallet splits. A peer without `traffic` still adds its
 * sentinel headlines to `all` (that is what the old document counted) and
 * marks external incomplete. unique_payers is withheld, never added.
 */
export function mergeTrafficHonesty(
  local: StatsDocument,
  peers: readonly { included: boolean; doc?: StatsDocument }[],
): TrafficHonesty {
  const localTraffic = publishedTraffic(local);
  let all = localTraffic
    ? cloneTrafficSlice(localTraffic.all)
    : { sentinel: legacyTrafficSentinel(local), payers: emptyTrafficPayers() };
  let external = localTraffic
    ? cloneTrafficSlice(localTraffic.external)
    : { sentinel: emptyTrafficSentinelCounts(), payers: emptyTrafficPayers() };
  let externalComplete = Boolean(localTraffic?.external_complete);
  let routesComplete = Boolean(
    localTraffic && payersHaveRoutes(localTraffic.all.payers) && payersHaveRoutes(localTraffic.external.payers),
  );
  const walletCounts = new Set<number>();
  if (localTraffic) walletCounts.add(localTraffic.internal_wallets_configured);
  const docsExample = mergeDocsExampleTraffic(localTraffic, peers);

  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    const traffic = publishedTraffic(peer.doc);
    if (!traffic) {
      externalComplete = false;
      routesComplete = false;
      all = {
        sentinel: addTrafficSentinel(all.sentinel, legacyTrafficSentinel(peer.doc), false),
        payers: { ...all.payers, available: false },
      };
      external = { ...external, payers: { ...external.payers, available: false } };
      continue;
    }
    if (!traffic.external_complete) externalComplete = false;
    if (!payersHaveRoutes(traffic.all.payers) || !payersHaveRoutes(traffic.external.payers)) routesComplete = false;
    walletCounts.add(traffic.internal_wallets_configured);
    all = {
      sentinel: addTrafficSentinel(all.sentinel, traffic.all.sentinel, true),
      payers: addTrafficPayers(all.payers, traffic.all.payers),
    };
    external = {
      sentinel: addTrafficSentinel(external.sentinel, traffic.external.sentinel, true),
      payers: addTrafficPayers(external.payers, traffic.external.payers),
    };
  }

  const walletCount = localTraffic?.internal_wallets_configured ?? 0;
  const graders = mergeGraderTraffic(localTraffic, peers);
  const testers = mergeTesterTraffic(localTraffic, peers);
  const unattributed = mergeUnattributedTraffic(localTraffic, peers);
  const internal = mergeInternalTraffic(localTraffic, peers);
  const internalLabel = mergeInternalLabel(localTraffic, peers);
  const testersProbable = mergeProbableTesters(localTraffic, peers);
  const revenue = mergeTrafficRevenue(localTraffic, peers, all.payers, external.payers);
  const reconciliation = reconcileTraffic({
    all,
    external,
    revenue,
    internal: internal.traffic,
    graders: graders.traffic,
    testers: testers.traffic,
    unattributed: unattributed.traffic,
    testers_probable: testersProbable.traffic,
    external_complete: externalComplete,
  });
  return {
    includes_internal_test_traffic: true,
    label: INTERNAL_TEST_TRAFFIC_LABEL,
    note: trafficHonestyNote({
      walletCount,
      externalComplete,
      fleet: true,
      walletCountsDisagree: walletCounts.size > 1,
      routesComplete,
      docsExample,
      graders: {
        available: graders.traffic.available,
        wallets_configured: graders.traffic.wallets_configured,
        calls: graders.traffic.calls,
        complete: graders.complete,
      },
      testers: {
        available: testers.traffic.available,
        wallets_configured: testers.traffic.wallets_configured,
        calls: testers.traffic.calls,
        complete: testers.complete,
      },
      unattributed: {
        available: unattributed.traffic.available,
        calls: unattributed.traffic.calls,
        revenue: unattributed.traffic.revenue,
        complete: unattributed.complete,
      },
      internal: {
        available: internal.traffic.available,
        calls: internal.traffic.calls,
        revenue: internal.traffic.revenue,
        complete: internal.complete,
      },
      internalLabel: {
        available: internalLabel.traffic.available,
        calls: internalLabel.traffic.calls,
        complete: internalLabel.complete,
      },
      testersProbable: {
        available: testersProbable.traffic.available,
        calls: testersProbable.traffic.calls,
        revenue: testersProbable.traffic.revenue,
        complete: testersProbable.complete,
      },
      reconciliation,
    }),
    internal_wallets_configured: walletCount,
    docs_example: {
      label: DOCS_EXAMPLE_TEST_TRAFFIC_LABEL,
      available: docsExample.available,
      url: DOCS_EXAMPLE_URL,
      urls: DOCS_EXAMPLE_URLS,
      calls: docsExample.calls,
    },
    graders: graders.traffic,
    testers: testers.traffic,
    internal: internal.traffic,
    unattributed: unattributed.traffic,
    testers_probable: testersProbable.traffic,
    reconciliation,
    internal_label: internalLabel.traffic,
    revenue,
    external_complete: externalComplete,
    routes_complete: routesComplete,
    all: { ...all, payers: withholdUniquePayers(all.payers) },
    external: { ...external, payers: withholdUniquePayers(external.payers) },
  };
}

export function buildSentinelStats(
  watch = loadWatchStats(),
  oneShotChecks = countReceiptsSince("1970-01-01T00:00:00Z", "check").receipts,
): SentinelStats {
  return {
    payable: true,
    status: "payable",
    prices: {
      check_usd: CHECK_PRICE_USD,
      watch_usd: WATCH_PRICE_USD,
      chain_topup_usd: CHAIN_TOPUP_PRICE_USD,
    },
    active_watchers: watch.active_watchers,
    checks_run: oneShotChecks + watch.checks_run_scheduled,
    change_events: watch.change_events,
    by_detector: watch.by_detector,
    benches: loadSentinelBenches(),
  };
}

export function buildTrafficHonesty(
  watchAll: SentinelWatchStats,
  watchExternal: SentinelWatchStats,
  oneShotChecks: number,
  payersAll: ReturnType<typeof queryRetentionWindowsFromStore>,
  payersExternal: ReturnType<typeof queryRetentionWindowsFromStore>,
  walletCount: number,
  docsExample: DocsExampleTraffic,
  graders: GraderTraffic,
  testers: GraderTraffic,
  unattributed: UnattributedTraffic,
  internal: InternalWalletTraffic,
  internalLabel: InternalLabelAnnotation,
  testersProbable: ProbableTesterTraffic = emptyProbableTesterTraffic(),
): TrafficHonesty {
  const allPayers = trafficPayersFromStore(payersAll);
  const externalPayers = trafficPayersFromStore(payersExternal);
  const revenue: TrafficRevenue = {
    source: "paid_calls",
    available: allPayers.available && externalPayers.available,
    all: revenueFromPayers(allPayers),
    external: revenueFromPayers(externalPayers),
  };
  const allSlice: TrafficSlice = {
    sentinel: trafficSentinelFromWatch(watchAll, oneShotChecks),
    payers: allPayers,
  };
  const externalSlice: TrafficSlice = {
    sentinel: trafficSentinelFromWatch(watchExternal, oneShotChecks),
    payers: externalPayers,
  };
  const reconciliation = reconcileTraffic({
    all: allSlice,
    external: externalSlice,
    revenue,
    internal,
    graders,
    testers,
    unattributed,
    testers_probable: testersProbable,
    external_complete: true,
  });
  return {
    includes_internal_test_traffic: true,
    label: INTERNAL_TEST_TRAFFIC_LABEL,
    note: trafficHonestyNote({
      walletCount,
      externalComplete: true,
      fleet: false,
      routesComplete: true,
      docsExample: { available: docsExample.available, calls: docsExample.calls, complete: true },
      graders: {
        available: graders.available,
        wallets_configured: graders.wallets_configured,
        calls: graders.calls,
        complete: true,
      },
      testers: {
        available: testers.available,
        wallets_configured: testers.wallets_configured,
        calls: testers.calls,
        complete: true,
      },
      unattributed: {
        available: unattributed.available,
        calls: unattributed.calls,
        revenue: unattributed.revenue,
        complete: true,
      },
      internal: {
        available: internal.available,
        calls: internal.calls,
        revenue: internal.revenue,
        complete: true,
      },
      internalLabel: {
        available: internalLabel.available,
        calls: internalLabel.calls,
        complete: true,
      },
      testersProbable: {
        available: testersProbable.available,
        calls: testersProbable.calls,
        revenue: testersProbable.revenue,
        complete: true,
      },
      reconciliation,
    }),
    internal_wallets_configured: walletCount,
    docs_example: docsExample,
    graders,
    testers,
    internal,
    unattributed,
    testers_probable: testersProbable,
    reconciliation,
    internal_label: internalLabel,
    revenue,
    external_complete: true,
    routes_complete: true,
    all: allSlice,
    external: externalSlice,
  };
}

export function buildStatsDocument(now = new Date()): StatsDocument {
  const confirmWindows = queryConfirmIntentWindowsFromStore(now);
  const lead7 = countReceiptsSince(isoCutoff(now, 7), "lead_submit");
  const lead30 = countReceiptsSince(isoCutoff(now, 30), "lead_submit");
  const listing7 = countReceiptsSince(isoCutoff(now, 7), "listing_published");
  const listing30 = countReceiptsSince(isoCutoff(now, 30), "listing_published");
  const order7 = countReceiptsSince(isoCutoff(now, 7), "order_placed");
  const order30 = countReceiptsSince(isoCutoff(now, 30), "order_placed");
  const scoped7: ConfirmIntentCounts | undefined = confirmWindows?.l7d;
  const scoped30: ConfirmIntentCounts | undefined = confirmWindows?.l30d;
  const unscoped = { l7d: scoped7?.unscoped ?? 0, l30d: scoped30?.unscoped ?? 0 };
  const notes = statsNotes(unscoped, LOCAL_VOLUME_NOTE, "volume");
  const wallets = internalWallets();
  const graders = graderWallets();
  const testers = testTrafficAddresses("tester");
  const externalPayersExcluded = [...new Set([...wallets, ...graders, ...testers])];
  const watchAll = loadWatchStats();
  const watchExternal = loadWatchStats(externalPayersExcluded);
  const oneShotChecks = countReceiptsSince("1970-01-01T00:00:00Z", "check").receipts;
  const exampleHashes = docsExampleUrlHashes();
  const payersAll = queryRetentionWindowsFromStore(now);
  const payersExternal = queryRetentionWindowsFromStore(now, externalPayersExcluded, exampleHashes, {
    external: true,
  });
  // One pass puts every paid call in exactly one bucket (src/traffic-buckets.ts).
  const buckets = queryTrafficBucketWindowsFromStore(now, {
    internal: wallets,
    graders,
    testers,
    docsExampleUrlSha256: exampleHashes,
  });
  const unattributed = unattributedFromBuckets(buckets);
  const internal = internalFromBuckets(buckets);
  const testersProbable = probableTestersFromBuckets(buckets);
  const internalLabel = internalLabelFromCounts(queryInternalLabelCountsFromStore(now));
  const exampleCounts = queryPaidCallCountsForUrlHashesFromStore(now, exampleHashes);
  const docsExample: DocsExampleTraffic = exampleCounts
    ? {
        label: DOCS_EXAMPLE_TEST_TRAFFIC_LABEL,
        available: true,
        url: DOCS_EXAMPLE_URL,
        urls: DOCS_EXAMPLE_URLS,
        calls: exampleCounts,
      }
    : emptyDocsExampleTraffic();
  const graderTraffic = testWalletTrafficFromBuckets(buckets, "graders", graders.length);
  const testerTraffic = testWalletTrafficFromBuckets(buckets, "testers", testers.length);
  return {
    ok: true,
    service: "livecheck",
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    traffic: buildTrafficHonesty(
      watchAll,
      watchExternal,
      oneShotChecks,
      payersAll,
      payersExternal,
      wallets.length,
      docsExample,
      graderTraffic,
      testerTraffic,
      unattributed,
      internal,
      internalLabel,
      testersProbable,
    ),
    intents: {
      lead_submit: {
        payable: true,
        price_usd: CONFIRM_PRICE_USD,
        status: "ga",
        l7d: windowFromReceipts(lead7, scoped7?.lead_submit),
        l30d: windowFromReceipts(lead30, scoped30?.lead_submit),
      },
      listing_published: {
        payable: true,
        price_usd: CONFIRM_PRICE_USD,
        status: "ga",
        l7d: windowFromReceipts(listing7, scoped7?.listing_published),
        l30d: windowFromReceipts(listing30, scoped30?.listing_published),
      },
      order_placed: {
        payable: true,
        price_usd: ORDER_PLACED_PRICE_USD,
        status: "ga",
        l7d: windowFromReceipts(order7, scoped7?.order_placed),
        l30d: windowFromReceipts(order30, scoped30?.order_placed),
      },
    },
    sentinel: buildSentinelStats(watchAll, oneShotChecks),
    benches: loadConfirmBenches(),
    store: buildStoreScope(unscoped),
    notes,
  };
}

function escHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    return "&quot;";
  });
}

function statsMachineSummary(doc: StatsDocument): string {
  const machines = doc.store.machines;
  if (!machines?.length) return "";
  const included = machines
    .filter((machine) => machine.included)
    .map((machine) => escHtml(machine.fly_machine_id ?? "unknown"));
  const failed = machines
    .filter((machine) => !machine.included)
    .map((machine) => {
      const id = escHtml(machine.fly_machine_id ?? "unknown");
      return machine.error ? `${id} (${escHtml(machine.error)})` : id;
    });
  return ` Included: ${included.join(", ") || "none"}. Failed: ${failed.join(", ") || "none"}.`;
}

function payerTable(doc: StatsDocument): string {
  const all = doc.traffic.all.payers;
  const external = doc.traffic.external.payers;
  if (!all.available || !external.available) {
    return `<h3>Payers</h3>
  <p class="muted">Payer windows are not published for this response. A closed paid-call store is missing, not zero.</p>`;
  }
  const payerCell = (value: number | null) => (value === null ? "withheld" : String(value));
  const familyCell = (counts: RouteCounts | undefined) => {
    const calls = counts?.calls ?? 0;
    const payers = counts?.unique_payers;
    return `<td>${calls}</td><td>${payerCell(payers ?? null)}</td>`;
  };
  const row = (audience: string, windowLabel: string, counts: WindowCounts) =>
    `<tr><td>${audience}</td><td>${windowLabel}</td>${familyCell(counts.verify)}${familyCell(counts.confirm)}${familyCell(counts.check)}${familyCell(counts.watch)}</tr>`;
  const routeRow = (audience: string, windowLabel: string, counts: WindowCounts) =>
    PAID_CALL_ROUTES.map((route) => {
      const item = counts.routes?.[route] ?? { calls: 0, unique_payers: null };
      return `<tr><td>${audience}</td><td>${windowLabel}</td><td><code>${route}</code></td><td>${item.calls}</td><td>${payerCell(item.unique_payers)}</td></tr>`;
    }).join("");
  const routesNote = doc.traffic.routes_complete
    ? ""
    : `<p class="muted">Per-route payer counts are incomplete: at least one included machine did not publish routes. Family totals above still include those calls.</p>`;
  return `<h3>Payers</h3>
  <p class="muted">${escHtml(doc.traffic.label)} Every paid route in paid_calls. Family totals: verify includes verify/job and verify/listing; confirm includes confirm/order; watch includes watch/renew. Unique payers in a family are distinct across that family, not the sum of the route rows. All includes internal and grader test traffic. External is bucket 5: a known payer that is not an internal, grader, or tester wallet, on a URL that is not a docs-example URL. Blank payers are Unattributed. External is decided by wallet only. A blank payer is unattributed and is not a unique payer. On this machine, unique payers are COUNT(DISTINCT payer). A fleet document shows withheld instead of adding per-volume distincts. Revenue is calls times the route price.</p>
  <p class="muted">Revenue from paid_calls: all L7d $${doc.traffic.revenue.all.l7d_usd.toFixed(2)} / L30d $${doc.traffic.revenue.all.l30d_usd.toFixed(2)}; external L7d $${doc.traffic.revenue.external.l7d_usd.toFixed(2)} / L30d $${doc.traffic.revenue.external.l30d_usd.toFixed(2)}; internal L7d $${doc.traffic.internal.revenue.l7d_usd.toFixed(2)} / L30d $${doc.traffic.internal.revenue.l30d_usd.toFixed(2)} (${doc.traffic.internal.calls.l7d} / ${doc.traffic.internal.calls.l30d} calls); ${bucketRevenueText("graders", doc.traffic.graders)}; ${bucketRevenueText("testers", doc.traffic.testers)}; unattributed L7d $${doc.traffic.unattributed.revenue.l7d_usd.toFixed(2)} / L30d $${doc.traffic.unattributed.revenue.l30d_usd.toFixed(2)} (${doc.traffic.unattributed.calls.l7d} / ${doc.traffic.unattributed.calls.l30d} calls); ${bucketRevenueText("testers (probable)", doc.traffic.testers_probable)}.${doc.traffic.revenue.available ? "" : " Revenue is not a measurement on this response."}</p>
  ${bucketTable(doc)}
  <table>
    <thead>
      <tr><th>Audience</th><th>Window</th><th>Verify calls</th><th>Verify unique payers</th><th>Confirm calls</th><th>Confirm unique payers</th><th>Check calls</th><th>Check unique payers</th><th>Watch calls</th><th>Watch unique payers</th></tr>
    </thead>
    <tbody>
      ${row("All (includes internal test traffic)", "L7d", all.l7d)}
      ${row("External", "L7d", external.l7d)}
      ${row("All (includes internal test traffic)", "L30d", all.l30d)}
      ${row("External", "L30d", external.l30d)}
    </tbody>
  </table>
  <h3>Payers by route</h3>
  <p class="muted">${escHtml(doc.traffic.label)} Stored route after /v1/ (verify, verify/job, verify/listing, confirm, confirm/order, check, watch, watch/renew). External rows omit configured team wallets, known grader wallets, and docs-example URLs.</p>
  ${routesNote}
  <table>
    <thead>
      <tr><th>Audience</th><th>Window</th><th>Route</th><th>Calls</th><th>Unique payers</th></tr>
    </thead>
    <tbody>
      ${routeRow("All (includes internal test traffic)", "L7d", all.l7d)}
      ${routeRow("External", "L7d", external.l7d)}
      ${routeRow("All (includes internal test traffic)", "L30d", all.l30d)}
      ${routeRow("External", "L30d", external.l30d)}
    </tbody>
  </table>`;
}

function bucketRevenueText(
  name: string,
  row: { calls: { l7d: number; l30d: number }; revenue?: TrafficRevenueWindow } | undefined,
): string {
  if (!row) return `${name} not published`;
  const revenue = row.revenue;
  const money = revenue
    ? `L7d $${revenue.l7d_usd.toFixed(2)} / L30d $${revenue.l30d_usd.toFixed(2)}`
    : "revenue not published";
  return `${name} ${money} (${row.calls.l7d} / ${row.calls.l30d} calls)`;
}

const BUCKET_DISPLAY: Record<TrafficBucket, string> = {
  internal: "1. Internal (our wallets)",
  graders: "2. Graders",
  testers: "2. Testers",
  unattributed: "3. Unattributed (no payer)",
  testers_probable: "4. Testers (probable): unknown payer, docs-example URL",
  external: "5. External",
};

function bucketTable(doc: StatsDocument): string {
  const rec = doc.traffic.reconciliation;
  if (!rec) return "";
  const cell = (a: ReconciliationAmounts) => `<td>${a.calls}</td><td>$${a.revenue_usd.toFixed(2)}</td>`;
  const rows = rec.buckets
    .map(
      (bucket) =>
        `<tr><td>${escHtml(BUCKET_DISPLAY[bucket] ?? bucket)}</td>${cell(rec.l7d.by_bucket[bucket])}${cell(rec.l30d.by_bucket[bucket])}</tr>`,
    )
    .join("");
  return `<h3>Buckets</h3>
  <p class="muted">${escHtml(rec.label)}</p>
  <table>
    <thead>
      <tr><th>Bucket (first match wins)</th><th>L7d calls</th><th>L7d revenue</th><th>L30d calls</th><th>L30d revenue</th></tr>
    </thead>
    <tbody>
      ${rows}
      <tr><td><strong>Sum of buckets</strong></td>${cell(rec.l7d.buckets_sum)}${cell(rec.l30d.buckets_sum)}</tr>
      <tr><td><strong>All traffic</strong></td>${cell(rec.l7d.total)}${cell(rec.l30d.total)}</tr>
      <tr><td><strong>Gap</strong></td>${cell(rec.l7d.gap)}${cell(rec.l30d.gap)}</tr>
    </tbody>
  </table>
  <p class="muted">Not summed (overlap counts): ${rec.not_summed.map((name) => `<code>traffic.${escHtml(name)}</code>`).join(", ")}.</p>`;
}

function reconciliationHtml(doc: StatsDocument): string {
  const rec = doc.traffic.reconciliation;
  if (!rec) {
    return `<p class="warning"><strong>Warning:</strong> bucket reconciliation is not on this response.</p>`;
  }
  if (rec.ok) {
    return `<p class="muted">Buckets add up: every paid call sits in exactly one bucket (L7d ${rec.l7d.total.calls} calls / $${rec.l7d.total.revenue_usd.toFixed(2)}, L30d ${rec.l30d.total.calls} calls / $${rec.l30d.total.revenue_usd.toFixed(2)}).</p>`;
  }
  return `<p class="warning" role="alert"><strong>Warning:</strong> ${escHtml(rec.warning ?? "Buckets do not add up to all traffic.")}</p>`;
}

function probableTesterHtml(doc: StatsDocument): string {
  const row = doc.traffic.testers_probable;
  const label = escHtml(row?.label ?? PROBABLE_TESTER_TRAFFIC_LABEL);
  if (!row?.available) {
    return `${label} Counts are not a measurement on this response (paid-call store closed, or a machine did not publish the split).`;
  }
  const payers = (value: number | null) => (value === null ? "withheld" : String(value));
  return `${label} ${row.calls.l7d} L7d / ${row.calls.l30d} L30d paid calls ($${row.revenue.l7d_usd.toFixed(2)} / $${row.revenue.l30d_usd.toFixed(2)}; ${payers(row.unique_payers.l7d)} / ${payers(row.unique_payers.l30d)} unique payers). These rows stay in All and are omitted from External.`;
}

function docsExampleHtml(doc: StatsDocument): string {
  const docs = doc.traffic.docs_example;
  const label = escHtml(docs.label);
  if (!docs.available) {
    return `${label} Counts are not a measurement on this response (paid-call store closed, or a machine did not publish the split).`;
  }
  const urls = (docs.urls?.length ? docs.urls : [docs.url]).map((url) => `<code>${escHtml(url)}</code>`).join(", ");
  return `${label} ${docs.calls.l7d} L7d / ${docs.calls.l30d} L30d paid calls. These rows stay in All and are omitted from External. This is an overlap count, not a bucket: a docs-example call from one of our wallets is Internal, from a grader is Graders, from an unknown wallet is Testers (probable). URLs: ${urls}.`;
}

function internalHtml(doc: StatsDocument): string {
  const row = doc.traffic.internal;
  const label = escHtml(row?.label ?? INTERNAL_WALLET_TRAFFIC_LABEL);
  if (!row?.available) {
    return `${label} Counts are not a measurement on this response (paid-call store closed, or a machine did not publish the split).`;
  }
  return `${label} ${row.calls.l7d} L7d / ${row.calls.l30d} L30d paid calls ($${row.revenue.l7d_usd.toFixed(2)} / $${row.revenue.l30d_usd.toFixed(2)}). These rows stay in All and are omitted from External.`;
}

function internalLabelHtml(doc: StatsDocument): string {
  const row = doc.traffic.internal_label;
  const label = escHtml(row?.label ?? INTERNAL_LABEL_NOTE);
  if (!row?.available) {
    return `${label} The count is not a measurement on this response.`;
  }
  return `${label} ${row.calls.l7d} L7d / ${row.calls.l30d} L30d paid calls carry that user agent. This is an overlap count, not a bucket.`;
}

function unattributedHtml(doc: StatsDocument): string {
  const row = doc.traffic.unattributed;
  const label = escHtml(row?.label ?? UNATTRIBUTED_TRAFFIC_LABEL);
  if (!row?.available) {
    return `${label} Counts are not a measurement on this response (paid-call store closed, or a machine did not publish the split).`;
  }
  return `${label} ${row.calls.l7d} L7d / ${row.calls.l30d} L30d paid calls ($${row.revenue.l7d_usd.toFixed(2)} / $${row.revenue.l30d_usd.toFixed(2)}). These rows stay in All and are omitted from External.`;
}

function testerHtml(doc: StatsDocument): string {
  const testers = doc.traffic.testers;
  const label = escHtml(testers.label);
  if (!testers.available) {
    return `${label} Counts are not a measurement on this response (paid-call store closed, or a machine did not publish the split).`;
  }
  const payers = (value: number | null) => (value === null ? "withheld" : String(value));
  return `${label} ${testers.wallets_configured} wallets configured. ${testers.calls.l7d} L7d / ${testers.calls.l30d} L30d paid calls (${payers(testers.unique_payers.l7d)} / ${payers(testers.unique_payers.l30d)} unique payers${revenueSuffix(testers.revenue)}). These rows stay in All and are omitted from External. The wallet list is src/test-traffic.ts.`;
}

function revenueSuffix(revenue: TrafficRevenueWindow | undefined): string {
  if (!revenue) return "";
  return `; $${revenue.l7d_usd.toFixed(2)} / $${revenue.l30d_usd.toFixed(2)}`;
}

function graderHtml(doc: StatsDocument): string {
  const graders = doc.traffic.graders;
  const label = escHtml(graders.label);
  if (!graders.available) {
    return `${label} Counts are not a measurement on this response (paid-call store closed, or a machine did not publish the split).`;
  }
  const payers = (value: number | null) => (value === null ? "withheld" : String(value));
  return `${label} ${graders.wallets_configured} wallets configured. ${graders.calls.l7d} L7d / ${graders.calls.l30d} L30d paid calls (${payers(graders.unique_payers.l7d)} / ${payers(graders.unique_payers.l30d)} unique payers${revenueSuffix(graders.revenue)}). These rows stay in All and are omitted from External.`;
}

export function statsHtml(doc: StatsDocument): string {
  const lead = doc.intents.lead_submit;
  const listing = doc.intents.listing_published;
  const order = doc.intents.order_placed;
  const sentinel = doc.sentinel;
  const row = (intent: string, label: string, w: IntentWindow) =>
    `<tr><td>${intent}</td><td>${label}</td><td>${w.paid_calls}</td><td>${w.receipts}</td><td>${w.by_verdict.confirmed}</td><td>${w.by_verdict.failed}</td><td>${w.by_verdict.unknown}</td></tr>`;
  const detectorRow = (name: string, counts: { watchers: number; change_events: number }) =>
    `<tr><td>${name}</td><td>${counts.watchers}</td><td>${counts.change_events}</td></tr>`;
  const confirmBenches = doc.benches;
  const confirmBenchRow = (intent: "lead_submit" | "listing_published" | "order_placed") => {
    const b = confirmBenches[intent];
    return `<tr><td>${intent}</td><td>${b.false_confirmed}/${b.n}</td><td>${b.false_confirmed_rate}</td><td>${b.n}</td><td><code>${b.commit}</code></td></tr>`;
  };
  const fp = sentinel.benches.false_positive_rate;
  const hmac = sentinel.benches.hmac;
  const fires = (rate: number, n: number) => `${Math.round(rate * n)}/${n}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Livecheck stats</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #14211a; background: #f4efe4; }
    table { border-collapse: collapse; margin: 1rem 0; }
    th, td { border: 1px solid #c9c0ae; padding: 0.4rem 0.7rem; text-align: left; }
    .muted { color: #5c5346; max-width: 40rem; }
    code { font-size: 0.9em; }
    h2 { margin-top: 2rem; }
    .honesty { border: 1px solid #8a6d1b; background: #f8e7c7; padding: 0.7rem 0.85rem; max-width: 42rem; }
    .warning { border: 2px solid #a12a1c; background: #fbe3df; color: #5a130b; padding: 0.7rem 0.85rem; max-width: 42rem; }
  </style>
</head>
<body>
  <h1>Livecheck stats</h1>
  ${reconciliationHtml(doc)}
  <p class="honesty"><strong>${escHtml(doc.traffic.label)}</strong> ${escHtml(doc.traffic.note)}</p>
  <p class="muted">${internalHtml(doc)}</p>
  <p class="muted">${graderHtml(doc)}</p>
  <p class="muted">${testerHtml(doc)}</p>
  <p class="muted">${unattributedHtml(doc)}</p>
  <p class="muted">${probableTesterHtml(doc)}</p>
  <p class="muted">${docsExampleHtml(doc)}</p>
  <p class="muted">${internalLabelHtml(doc)}</p>
  <p>Generated ${doc.generated_at}. Payable Confirm intents: <code>lead_submit</code> (GA) and <code>listing_published</code> at $${lead.price_usd.toFixed(2)} USDC; <code>order_placed</code> at $${order.price_usd.toFixed(2)} USDC.</p>
  <p class="muted">Volume scope: ${doc.store.scope}${doc.store.fly_machine_id ? ` · serving machine <code>${doc.store.fly_machine_id}</code>` : ""}. Unscoped confirm paid_calls (no stored intent): L7d ${doc.store.confirm_unscoped_paid_calls.l7d} / L30d ${doc.store.confirm_unscoped_paid_calls.l30d}.${statsMachineSummary(doc)}</p>
  <table>
    <thead>
      <tr><th>Intent</th><th>Window</th><th>Paid calls</th><th>Receipts</th><th>confirmed</th><th>failed</th><th>unknown</th></tr>
    </thead>
    <tbody>
      ${row("lead_submit", "L7d", lead.l7d)}
      ${row("lead_submit", "L30d", lead.l30d)}
      ${row("listing_published", "L7d", listing.l7d)}
      ${row("listing_published", "L30d", listing.l30d)}
      ${row("order_placed", "L7d", order.l7d)}
      ${row("order_placed", "L30d", order.l30d)}
    </tbody>
  </table>
  <p class="muted">Paid calls and receipts in this table include internal test traffic. Receipts have no payer, so they are not split. External confirm calls and unique payers are in the payer table below.</p>
  <h3>Confirm benches</h3>
  <table>
    <thead>
      <tr><th>Intent</th><th>false_confirmed / N</th><th>false_confirmed_rate</th><th>N</th><th>commit</th></tr>
    </thead>
    <tbody>
      ${confirmBenchRow("lead_submit")}
      ${confirmBenchRow("listing_published")}
      ${confirmBenchRow("order_placed")}
    </tbody>
  </table>
  <p class="muted">${confirmBenches.note} Report: <code>${confirmBenches.report}</code>.</p>
  <h2>Sentinel</h2>
  <p>Payable: <code>POST /v1/check</code> $${sentinel.prices.check_usd.toFixed(2)}, <code>POST /v1/watch</code> $${sentinel.prices.watch_usd.toFixed(2)}, <code>POST /v1/watch/{id}/chain/topup</code> $${sentinel.prices.chain_topup_usd.toFixed(2)}. Status: ${sentinel.status}. Unpaid 402 bazaar: check, watch, renew.</p>
  <table>
    <thead>
      <tr><th>Audience</th><th>Active watchers</th><th>Checks run</th><th>Change events</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>All (includes internal test traffic)</td>
        <td>${doc.traffic.all.sentinel.active_watchers}</td>
        <td>${doc.traffic.all.sentinel.checks_run}</td>
        <td>${doc.traffic.all.sentinel.change_events}</td>
      </tr>
      <tr>
        <td>External${doc.traffic.external_complete ? "" : " (incomplete — not the full fleet)"}</td>
        <td>${doc.traffic.external.sentinel.active_watchers}</td>
        <td>${doc.traffic.external.sentinel.checks_run}</td>
        <td>${doc.traffic.external.sentinel.change_events}</td>
      </tr>
    </tbody>
  </table>
  <p class="muted">Both sentinel check totals include ${doc.traffic.all.sentinel.checks_run_unattributed} one-shot check receipts with no stored payer. Those receipt counters stay in both sentinel totals. paid_calls rows with no payer are traffic.unattributed and are omitted from external revenue. False-positive rate and latency below are CI benches, not live usage.</p>
  <table>
    <thead>
      <tr><th>False-positive rate</th><th>Median latency</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>status_change ${fires(fp.status_change, fp.n_checks)} (rate ${fp.status_change}); text_diff ${fires(fp.text_diff, fp.n_checks)} (rate ${fp.text_diff})</td>
        <td>${sentinel.benches.median_latency_ms} ms (p95 ${sentinel.benches.latency_p95_ms} ms)</td>
      </tr>
    </tbody>
  </table>
  <p class="muted">Detector rows below are all wallets (includes internal test traffic). External detector counts are <code>traffic.external.sentinel.by_detector</code>.</p>
  <table>
    <thead>
      <tr><th>Detector</th><th>Watchers</th><th>Change events</th></tr>
    </thead>
    <tbody>
      ${detectorRow("status_change", sentinel.by_detector.status_change)}
      ${detectorRow("keyword", sentinel.by_detector.keyword)}
      ${detectorRow("text_diff", sentinel.by_detector.text_diff)}
      ${detectorRow("numeric_threshold", sentinel.by_detector.numeric_threshold)}
    </tbody>
  </table>
  ${payerTable(doc)}
  <h3>Sentinel benches</h3>
  <table>
    <thead>
      <tr><th>status_change FP</th><th>text_diff FP</th><th>Median latency</th><th>p95 latency</th><th>interval_s</th><th>HMAC</th><th>Chain Verify</th><th>commit</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>${fires(fp.status_change, fp.n_checks)} (rate ${fp.status_change})</td>
        <td>${fires(fp.text_diff, fp.n_checks)} (rate ${fp.text_diff})</td>
        <td>${sentinel.benches.median_latency_ms} ms</td>
        <td>${sentinel.benches.latency_p95_ms} ms</td>
        <td>${sentinel.benches.interval_s}</td>
        <td>${hmac.verified}/${hmac.delivered}${hmac.pass ? " pass" : " fail"}</td>
        <td>${sentinel.benches.chain_verify}</td>
        <td><code>${sentinel.benches.commit}</code></td>
      </tr>
    </tbody>
  </table>
  <p class="muted">${sentinel.benches.note} Gate: ${fp.gate}. Report: <code>${sentinel.benches.report}</code>.</p>
  <p class="muted">${doc.notes.join(" ")}</p>
  <p><a href="/stats?format=json">JSON</a> · <a href="/health">health</a></p>
</body>
</html>`;
}
