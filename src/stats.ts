import {
  CHECK_PRICE_USD,
  CHAIN_TOPUP_PRICE_USD,
  CONFIRM_PRICE_USD,
  ORDER_PLACED_PRICE_USD,
  WATCH_PRICE_USD,
} from "./config.js";
import { isoCutoff, queryRetentionWindowsFromStore } from "./paid-call-store.js";
import { countReceiptsSince, emptyReceiptVerdictCounts } from "./receipt-store.js";
import {
  emptySentinelWatchStats,
  querySentinelWatchStats,
  type SentinelDetectorCounts,
} from "./watch-store.js";

export type ConfirmIntentStats = {
  payable: true;
  price_usd: number;
  status: "ga" | "payable";
  l7d: IntentWindow;
  l30d: IntentWindow;
};

export type SentinelBenches = {
  false_positive_rate: null;
  median_latency_ms: null;
  note: string;
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

export type StatsDocument = {
  ok: true;
  service: "livecheck";
  generated_at: string;
  intents: {
    lead_submit: ConfirmIntentStats;
    listing_published: ConfirmIntentStats;
    order_placed: ConfirmIntentStats;
  };
  sentinel: SentinelStats;
  benches: {
    false_confirmed_rate: null;
    note: string;
  };
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

const BENCH_NOTE =
  "Accuracy benches are not published. Do not infer a false-confirmed rate from these counts; missing is not zero.";

const SENTINEL_BENCH_NOTE =
  "Sentinel false-positive rate and median latency are not published on this route (no dispute endpoint). Local/CI benches: docs/sentinel-benches.md. Missing is not zero.";

export function emptyIntentWindow(): IntentWindow {
  return {
    paid_calls: 0,
    receipts: 0,
    by_verdict: emptyReceiptVerdictCounts(),
  };
}

function windowFromReceipts(
  receipts: { receipts: number; by_verdict: IntentWindow["by_verdict"] },
  paidCallsFallback?: number,
): IntentWindow {
  return {
    paid_calls: paidCallsFallback ?? receipts.receipts,
    receipts: receipts.receipts,
    by_verdict: receipts.by_verdict,
  };
}

export function buildSentinelStats(): SentinelStats {
  const watch = (() => {
    try {
      return querySentinelWatchStats();
    } catch {
      return emptySentinelWatchStats();
    }
  })();
  const oneShot = countReceiptsSince("1970-01-01T00:00:00Z", "check").receipts;
  return {
    payable: true,
    status: "payable",
    prices: {
      check_usd: CHECK_PRICE_USD,
      watch_usd: WATCH_PRICE_USD,
      chain_topup_usd: CHAIN_TOPUP_PRICE_USD,
    },
    active_watchers: watch.active_watchers,
    checks_run: oneShot + watch.checks_run_scheduled,
    change_events: watch.change_events,
    by_detector: watch.by_detector,
    benches: {
      false_positive_rate: null,
      median_latency_ms: null,
      note: SENTINEL_BENCH_NOTE,
    },
  };
}

export function buildStatsDocument(now = new Date()): StatsDocument {
  const windows = queryRetentionWindowsFromStore(now);
  const lead7 = countReceiptsSince(isoCutoff(now, 7), "lead_submit");
  const lead30 = countReceiptsSince(isoCutoff(now, 30), "lead_submit");
  const listing7 = countReceiptsSince(isoCutoff(now, 7), "listing_published");
  const listing30 = countReceiptsSince(isoCutoff(now, 30), "listing_published");
  const order7 = countReceiptsSince(isoCutoff(now, 7), "order_placed");
  const order30 = countReceiptsSince(isoCutoff(now, 30), "order_placed");
  return {
    ok: true,
    service: "livecheck",
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    intents: {
      lead_submit: {
        payable: true,
        price_usd: CONFIRM_PRICE_USD,
        status: "ga",
        l7d: windowFromReceipts(lead7, windows?.l7d.confirm.calls ?? 0),
        l30d: windowFromReceipts(lead30, windows?.l30d.confirm.calls ?? 0),
      },
      listing_published: {
        payable: true,
        price_usd: CONFIRM_PRICE_USD,
        status: "ga",
        l7d: windowFromReceipts(listing7),
        l30d: windowFromReceipts(listing30),
      },
      order_placed: {
        payable: true,
        price_usd: ORDER_PLACED_PRICE_USD,
        status: "ga",
        l7d: windowFromReceipts(order7),
        l30d: windowFromReceipts(order30),
      },
    },
    sentinel: buildSentinelStats(),
    benches: {
      false_confirmed_rate: null,
      note: BENCH_NOTE,
    },
    notes: [
      "Payable Confirm intents: lead_submit (GA, $0.10) and listing_published ($0.10) on POST /v1/confirm; order_placed ($0.25) on POST /v1/confirm/order.",
      "Bazaar 402 copy stays lead_submit-primary on /v1/confirm. order_placed is a separate fixed-price resource. Sentinel Bazaar GA is held.",
      "lead_submit paid_calls are confirm-route volume. listing_published and order_placed paid_calls placeholders are receipt-backed until paid_calls rows store intent.",
      "Sentinel checks_run is one-shot POST /v1/check receipts plus scheduled watcher observations (term quota minus checks_remaining). by_detector is SQLite watchers + change events.",
    ],
  };
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
  </style>
</head>
<body>
  <h1>Livecheck stats</h1>
  <p>Generated ${doc.generated_at}. Payable Confirm intents: <code>lead_submit</code> (GA) and <code>listing_published</code> at $${lead.price_usd.toFixed(2)} USDC; <code>order_placed</code> at $${order.price_usd.toFixed(2)} USDC.</p>
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
  <p class="muted">${doc.benches.note}</p>
  <h2>Sentinel</h2>
  <p>Payable: <code>POST /v1/check</code> $${sentinel.prices.check_usd.toFixed(2)}, <code>POST /v1/watch</code> $${sentinel.prices.watch_usd.toFixed(2)}, <code>POST /v1/watch/{id}/chain/topup</code> $${sentinel.prices.chain_topup_usd.toFixed(2)}. Status: ${sentinel.status} (Bazaar GA held).</p>
  <table>
    <thead>
      <tr><th>Active watchers</th><th>Checks run</th><th>Change events</th><th>False-positive rate</th><th>Median latency</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>${sentinel.active_watchers}</td>
        <td>${sentinel.checks_run}</td>
        <td>${sentinel.change_events}</td>
        <td>${sentinel.benches.false_positive_rate === null ? "null" : sentinel.benches.false_positive_rate}</td>
        <td>${sentinel.benches.median_latency_ms === null ? "null" : `${sentinel.benches.median_latency_ms} ms`}</td>
      </tr>
    </tbody>
  </table>
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
  <p class="muted">${sentinel.benches.note}</p>
  <p class="muted">${doc.notes.join(" ")}</p>
  <p><a href="/stats?format=json">JSON</a> · <a href="/health">health</a></p>
</body>
</html>`;
}
