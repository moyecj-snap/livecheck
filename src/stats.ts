import {
  CHECK_PRICE_USD,
  CHAIN_TOPUP_PRICE_USD,
  CONFIRM_PRICE_USD,
  ORDER_PLACED_PRICE_USD,
  WATCH_PRICE_USD,
} from "./config.js";
import { internalWallets } from "./internal-wallets.js";
import {
  emptyWindowCounts,
  isoCutoff,
  paidCallStoreStatus,
  queryConfirmIntentWindowsFromStore,
  queryRetentionWindowsFromStore,
  type ConfirmIntentCounts,
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
  /** verify + confirm paid_calls only. Check and watch payers live on sentinel. */
  payers: TrafficPayers;
};

export const INTERNAL_TEST_TRAFFIC_LABEL = "Includes internal test traffic.";

export type TrafficHonesty = {
  includes_internal_test_traffic: true;
  label: typeof INTERNAL_TEST_TRAFFIC_LABEL;
  note: string;
  /** Count only. Addresses stay off the public document. */
  internal_wallets_configured: number;
  /**
   * False when an included fleet volume did not publish this split
   * (older build). external is then not a full-fleet figure.
   */
  external_complete: boolean;
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
  "Counts are this Fly machine's livecheck_data volume only. On Fly, public GET /stats sums started machines (store.scope=fleet_volumes); this document is one volume. CoS: fly machines list -a livecheck, then fly ssh console -a livecheck --machine <id> -C \"npm run paid-call:cos\".";

export const FLEET_VOLUME_NOTE =
  "Counts sum each started Fly machine's livecheck_data volume (store.scope=fleet_volumes). Writes are partitioned across volumes, not replicated, so the sum is the fleet total and is not a second copy of one machine. CI benches are not summed. Stopped machines are omitted. Per-machine CoS: fly machines list -a livecheck, then fly ssh console -a livecheck --machine <id> -C \"npm run paid-call:cos\". scope=local reads only the machine that answered.";

export const PARTIAL_FLEET_VOLUME_NOTE =
  "Fleet sum is incomplete: at least one started machine did not answer. Included machines are store.machines. Missing machines are omitted, not treated as zero. Do not read active_watchers, checks_run, change_events, or paid_calls as the full fleet until scope is fleet_volumes.";

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
}): string {
  const parts = [
    INTERNAL_TEST_TRAFFIC_LABEL,
    "Headline confirm windows and sentinel counts are all wallets.",
    input.walletCount === 0
      ? "No internal wallets are configured, so traffic.external matches traffic.all."
      : `traffic.external omits ${input.walletCount} configured team wallets (built-in list plus LIVECHECK_INTERNAL_WALLETS).`,
    "One-shot check receipts have no payer and stay in both checks_run totals. paid_calls with a null payer stay in external.",
    "traffic.payers counts verify and confirm paid_calls only.",
  ];
  if (input.fleet) {
    parts.push(
      "On a fleet sum, unique_payers adds per-volume distinct payers and is not a fleet-wide distinct.",
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
      l7d: {
        verify: { ...slice.payers.l7d.verify },
        confirm: { ...slice.payers.l7d.confirm },
      },
      l30d: {
        verify: { ...slice.payers.l30d.verify },
        confirm: { ...slice.payers.l30d.confirm },
      },
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

function copyWindowCounts(window: WindowCounts): WindowCounts {
  return {
    verify: { ...window.verify },
    confirm: { ...window.confirm },
  };
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
    unique_payers: left.unique_payers + right.unique_payers,
  };
}

function addWindowCounts(left: WindowCounts, right: WindowCounts): WindowCounts {
  return {
    verify: addRouteCounts(left.verify, right.verify),
    confirm: addRouteCounts(left.confirm, right.confirm),
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

/**
 * Sum per-volume wallet splits. A peer without `traffic` still adds its
 * sentinel headlines to `all` (that is what the old document counted) and
 * marks external incomplete. unique_payers stays a per-volume sum.
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
  const walletCounts = new Set<number>();
  if (localTraffic) walletCounts.add(localTraffic.internal_wallets_configured);

  for (const peer of peers) {
    if (!peer.included || !peer.doc) continue;
    const traffic = publishedTraffic(peer.doc);
    if (!traffic) {
      externalComplete = false;
      all = {
        sentinel: addTrafficSentinel(all.sentinel, legacyTrafficSentinel(peer.doc), false),
        payers: { ...all.payers, available: false },
      };
      external = { ...external, payers: { ...external.payers, available: false } };
      continue;
    }
    if (!traffic.external_complete) externalComplete = false;
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
  return {
    includes_internal_test_traffic: true,
    label: INTERNAL_TEST_TRAFFIC_LABEL,
    note: trafficHonestyNote({
      walletCount,
      externalComplete,
      fleet: true,
      walletCountsDisagree: walletCounts.size > 1,
    }),
    internal_wallets_configured: walletCount,
    external_complete: externalComplete,
    all,
    external,
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
): TrafficHonesty {
  return {
    includes_internal_test_traffic: true,
    label: INTERNAL_TEST_TRAFFIC_LABEL,
    note: trafficHonestyNote({ walletCount, externalComplete: true, fleet: false }),
    internal_wallets_configured: walletCount,
    external_complete: true,
    all: {
      sentinel: trafficSentinelFromWatch(watchAll, oneShotChecks),
      payers: trafficPayersFromStore(payersAll),
    },
    external: {
      sentinel: trafficSentinelFromWatch(watchExternal, oneShotChecks),
      payers: trafficPayersFromStore(payersExternal),
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
  const watchAll = loadWatchStats();
  const watchExternal = loadWatchStats(wallets);
  const oneShotChecks = countReceiptsSince("1970-01-01T00:00:00Z", "check").receipts;
  const payersAll = queryRetentionWindowsFromStore(now);
  const payersExternal = wallets.length > 0 ? queryRetentionWindowsFromStore(now, wallets) : payersAll;
  return {
    ok: true,
    service: "livecheck",
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    traffic: buildTrafficHonesty(watchAll, watchExternal, oneShotChecks, payersAll, payersExternal, wallets.length),
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
  <p class="muted">Verify and confirm payer windows are not published for this response. A closed paid-call store is missing, not zero. Check and watch payers are not in this table.</p>`;
  }
  const row = (audience: string, windowLabel: string, counts: WindowCounts) =>
    `<tr><td>${audience}</td><td>${windowLabel}</td><td>${counts.verify.calls}</td><td>${counts.verify.unique_payers}</td><td>${counts.confirm.calls}</td><td>${counts.confirm.unique_payers}</td></tr>`;
  return `<h3>Payers</h3>
  <p class="muted">Verify and confirm paid_calls only. All includes internal test traffic. External omits configured team wallets. Null payers stay in external calls and are not a unique payer. On a fleet sum, unique payers add per volume.</p>
  <table>
    <thead>
      <tr><th>Audience</th><th>Window</th><th>Verify calls</th><th>Verify unique payers</th><th>Confirm calls</th><th>Confirm unique payers</th></tr>
    </thead>
    <tbody>
      ${row("All (includes internal test traffic)", "L7d", all.l7d)}
      ${row("External", "L7d", external.l7d)}
      ${row("All (includes internal test traffic)", "L30d", all.l30d)}
      ${row("External", "L30d", external.l30d)}
    </tbody>
  </table>`;
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
