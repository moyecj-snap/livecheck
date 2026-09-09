import { CONFIRM_PRICE_USD } from "./config.js";
import { isoCutoff, queryRetentionWindowsFromStore } from "./paid-call-store.js";
import { countReceiptsSince, emptyReceiptVerdictCounts } from "./receipt-store.js";

export type ConfirmIntentStats = {
  payable: true;
  price_usd: number;
  status: "ga" | "payable";
  l7d: IntentWindow;
  l30d: IntentWindow;
};

export type StatsDocument = {
  ok: true;
  service: "livecheck";
  generated_at: string;
  intents: {
    lead_submit: ConfirmIntentStats;
    listing_published: ConfirmIntentStats;
  };
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

export function buildStatsDocument(now = new Date()): StatsDocument {
  const windows = queryRetentionWindowsFromStore(now);
  const lead7 = countReceiptsSince(isoCutoff(now, 7), "lead_submit");
  const lead30 = countReceiptsSince(isoCutoff(now, 30), "lead_submit");
  const listing7 = countReceiptsSince(isoCutoff(now, 7), "listing_published");
  const listing30 = countReceiptsSince(isoCutoff(now, 30), "listing_published");
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
        status: "payable",
        l7d: windowFromReceipts(listing7),
        l30d: windowFromReceipts(listing30),
      },
    },
    benches: {
      false_confirmed_rate: null,
      note: BENCH_NOTE,
    },
    notes: [
      "Payable Confirm intents: lead_submit (GA) and listing_published (payable). order_placed remains unsupported_intent.",
      "Bazaar 402 copy stays lead_submit-primary. listing_published is documented on OpenAPI/x402, not advertised as the Confirm hero.",
      "lead_submit paid_calls are confirm-route volume. listing_published paid_calls placeholders are receipt-backed until paid_calls rows store intent.",
    ],
  };
}

export function statsHtml(doc: StatsDocument): string {
  const lead = doc.intents.lead_submit;
  const listing = doc.intents.listing_published;
  const row = (intent: string, label: string, w: IntentWindow) =>
    `<tr><td>${intent}</td><td>${label}</td><td>${w.paid_calls}</td><td>${w.receipts}</td><td>${w.by_verdict.confirmed}</td><td>${w.by_verdict.failed}</td><td>${w.by_verdict.unknown}</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Livecheck Confirm stats</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #14211a; background: #f4efe4; }
    table { border-collapse: collapse; margin: 1rem 0; }
    th, td { border: 1px solid #c9c0ae; padding: 0.4rem 0.7rem; text-align: left; }
    .muted { color: #5c5346; max-width: 40rem; }
    code { font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Livecheck Confirm stats</h1>
  <p>Generated ${doc.generated_at}. Payable intents: <code>lead_submit</code> (GA) and <code>listing_published</code> at $${lead.price_usd.toFixed(2)} USDC. <code>order_placed</code> is not payable.</p>
  <table>
    <thead>
      <tr><th>Intent</th><th>Window</th><th>Paid calls</th><th>Receipts</th><th>confirmed</th><th>failed</th><th>unknown</th></tr>
    </thead>
    <tbody>
      ${row("lead_submit", "L7d", lead.l7d)}
      ${row("lead_submit", "L30d", lead.l30d)}
      ${row("listing_published", "L7d", listing.l7d)}
      ${row("listing_published", "L30d", listing.l30d)}
    </tbody>
  </table>
  <p class="muted">${doc.benches.note}</p>
  <p class="muted">${doc.notes.join(" ")}</p>
  <p><a href="/stats?format=json">JSON</a> · <a href="/health">health</a></p>
</body>
</html>`;
}
