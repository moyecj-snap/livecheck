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
import { PAID_CALL_ROUTES, type PaidCallRoute } from "./paid-call.js";
import {
  emptyRouteCounts,
  emptyWindowCounts,
  isoCutoff,
  paidCallStoreStatus,
  queryConfirmIntentWindowsFromStore,
  queryPaidCallCountsForPayersFromStore,
  queryPaidCallCountsForUrlHashesFromStore,
  queryRetentionWindowsFromStore,
  type ConfirmIntentCounts,
  type PaidRouteCounts,
  type RouteCounts,
  type WindowCounts,
} from "./paid-call-store.js";
import { countReceiptsSince, emptyReceiptVerdictCounts, receiptStoreStatus } from "./receipt-store.js";
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
    "One-shot check receipts have no payer and stay in both sentinel checks_run totals. Check, watch, and renew payers are on traffic.payers when the paid_call row stored one. paid_calls with a null payer stay in external unless the URL is a docs example.",
    "traffic.payers counts every paid route in paid_calls: verify, confirm, check, watch, and watch/renew.",
    "traffic.revenue is calls times the route price (verify $0.01, check $0.02, confirm $0.10, confirm/order $0.25, watch and watch/renew $2.50), from paid_calls. external revenue uses the same wallet and docs-example omissions.",
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

export function emptyGraderTraffic(): GraderTraffic {
  return {
    label: GRADER_TEST_TRAFFIC_LABEL,
    available: false,
    wallets_configured: 0,
    calls: { l7d: 0, l30d: 0 },
    unique_payers: { l7d: 0, l30d: 0 },
  };
}

const ROUTE_PRICE_CENTS: Record<PaidCallRoute, number> = {
  verify: 1,
  "verify/job": 1,
  "verify/listing": 1,
  confirm: 10,
  "confirm/order": 25,
  check: 2,
  watch: 250,
  "watch/renew": 250,
};

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
  const revenue = mergeTrafficRevenue(localTraffic, peers, all.payers, external.payers);
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
): TrafficHonesty {
  const allPayers = trafficPayersFromStore(payersAll);
  const externalPayers = trafficPayersFromStore(payersExternal);
  const revenue: TrafficRevenue = {
    source: "paid_calls",
    available: allPayers.available && externalPayers.available,
    all: revenueFromPayers(allPayers),
    external: revenueFromPayers(externalPayers),
  };
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
    }),
    internal_wallets_configured: walletCount,
    docs_example: docsExample,
    graders,
    testers,
    revenue,
    external_complete: true,
    routes_complete: true,
    all: {
      sentinel: trafficSentinelFromWatch(watchAll, oneShotChecks),
      payers: allPayers,
    },
    external: {
      sentinel: trafficSentinelFromWatch(watchExternal, oneShotChecks),
      payers: externalPayers,
    },
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
  const payersExternal = queryRetentionWindowsFromStore(now, externalPayersExcluded, exampleHashes);
  const exampleCounts = queryPaidCallCountsForUrlHashesFromStore(now, exampleHashes);
  const graderCounts = queryPaidCallCountsForPayersFromStore(now, graders);
  const testerCounts = queryPaidCallCountsForPayersFromStore(now, testers);
  const docsExample: DocsExampleTraffic = exampleCounts
    ? {
        label: DOCS_EXAMPLE_TEST_TRAFFIC_LABEL,
        available: true,
        url: DOCS_EXAMPLE_URL,
        urls: DOCS_EXAMPLE_URLS,
        calls: exampleCounts,
      }
    : emptyDocsExampleTraffic();
  const graderTraffic: GraderTraffic = graderCounts
    ? {
        label: GRADER_TEST_TRAFFIC_LABEL,
        available: true,
        wallets_configured: graders.length,
        calls: { l7d: graderCounts.l7d.calls, l30d: graderCounts.l30d.calls },
        unique_payers: {
          l7d: graderCounts.l7d.unique_payers,
          l30d: graderCounts.l30d.unique_payers,
        },
      }
    : { ...emptyGraderTraffic(), label: GRADER_TEST_TRAFFIC_LABEL, wallets_configured: graders.length };
  const testerTraffic: GraderTraffic = testerCounts
    ? {
        label: TESTER_TEST_TRAFFIC_LABEL,
        available: true,
        wallets_configured: testers.length,
        calls: { l7d: testerCounts.l7d.calls, l30d: testerCounts.l30d.calls },
        unique_payers: {
          l7d: testerCounts.l7d.unique_payers,
          l30d: testerCounts.l30d.unique_payers,
        },
      }
    : { ...emptyGraderTraffic(), label: TESTER_TEST_TRAFFIC_LABEL, wallets_configured: testers.length };
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
  <p class="muted">${escHtml(doc.traffic.label)} Every paid route in paid_calls. Family totals: verify includes verify/job and verify/listing; confirm includes confirm/order; watch includes watch/renew. Unique payers in a family are distinct across that family, not the sum of the route rows. All includes internal and grader test traffic. External omits configured team wallets, known grader wallets, and docs-example URLs. Null payers stay in external calls unless the URL is a docs example, and are not a unique payer. On this machine, unique payers are COUNT(DISTINCT payer). A fleet document shows withheld instead of adding per-volume distincts. Revenue is calls times the route price.</p>
  <p class="muted">Revenue from paid_calls: all L7d $${doc.traffic.revenue.all.l7d_usd.toFixed(2)} / L30d $${doc.traffic.revenue.all.l30d_usd.toFixed(2)}; external L7d $${doc.traffic.revenue.external.l7d_usd.toFixed(2)} / L30d $${doc.traffic.revenue.external.l30d_usd.toFixed(2)}.${doc.traffic.revenue.available ? "" : " Revenue is not a measurement on this response."}</p>
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

function docsExampleHtml(doc: StatsDocument): string {
  const docs = doc.traffic.docs_example;
  const label = escHtml(docs.label);
  if (!docs.available) {
    return `${label} Counts are not a measurement on this response (paid-call store closed, or a machine did not publish the split).`;
  }
  const urls = (docs.urls?.length ? docs.urls : [docs.url]).map((url) => `<code>${escHtml(url)}</code>`).join(", ");
  return `${label} ${docs.calls.l7d} L7d / ${docs.calls.l30d} L30d paid calls. These rows stay in All and are omitted from External. URLs: ${urls}.`;
}

function testerHtml(doc: StatsDocument): string {
  const testers = doc.traffic.testers;
  const label = escHtml(testers.label);
  if (!testers.available) {
    return `${label} Counts are not a measurement on this response (paid-call store closed, or a machine did not publish the split).`;
  }
  const payers = (value: number | null) => (value === null ? "withheld" : String(value));
  return `${label} ${testers.wallets_configured} wallets configured. ${testers.calls.l7d} L7d / ${testers.calls.l30d} L30d paid calls (${payers(testers.unique_payers.l7d)} / ${payers(testers.unique_payers.l30d)} unique payers). These rows stay in All and are omitted from External. The wallet list is src/test-traffic.ts.`;
}

function graderHtml(doc: StatsDocument): string {
  const graders = doc.traffic.graders;
  const label = escHtml(graders.label);
  if (!graders.available) {
    return `${label} Counts are not a measurement on this response (paid-call store closed, or a machine did not publish the split).`;
  }
  const payers = (value: number | null) => (value === null ? "withheld" : String(value));
  return `${label} ${graders.wallets_configured} wallets configured. ${graders.calls.l7d} L7d / ${graders.calls.l30d} L30d paid calls (${payers(graders.unique_payers.l7d)} / ${payers(graders.unique_payers.l30d)} unique payers). These rows stay in All and are omitted from External.`;
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
  </style>
</head>
<body>
  <h1>Livecheck stats</h1>
  <p class="honesty"><strong>${escHtml(doc.traffic.label)}</strong> ${escHtml(doc.traffic.note)}</p>
  <p class="muted">${docsExampleHtml(doc)}</p>
  <p class="muted">${graderHtml(doc)}</p>
  <p class="muted">${testerHtml(doc)}</p>
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
  <p class="muted">Both check totals include ${doc.traffic.all.sentinel.checks_run_unattributed} one-shot check receipts with no stored payer. Those receipts stay in external. False-positive rate and latency below are CI benches, not live usage.</p>
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
