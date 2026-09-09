import { CONFIRM_PRICE_USD } from "./config.js";
import { isoCutoff, queryRetentionWindowsFromStore } from "./paid-call-store.js";
import { countReceiptsSince, emptyReceiptVerdictCounts } from "./receipt-store.js";

export type StatsDocument = {
  ok: true;
  service: "livecheck";
  generated_at: string;
  intents: {
    lead_submit: {
      payable: true;
      price_usd: number;
      status: "ga";
      l7d: IntentWindow;
      l30d: IntentWindow;
    };
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

export function buildStatsDocument(now = new Date()): StatsDocument {
  const windows = queryRetentionWindowsFromStore(now);
  const l7dReceipts = countReceiptsSince(isoCutoff(now, 7), "lead_submit");
  const l30dReceipts = countReceiptsSince(isoCutoff(now, 30), "lead_submit");
  return {
    ok: true,
    service: "livecheck",
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    intents: {
      lead_submit: {
        payable: true,
        price_usd: CONFIRM_PRICE_USD,
        status: "ga",
        l7d: {
          paid_calls: windows?.l7d.confirm.calls ?? 0,
          receipts: l7dReceipts.receipts,
          by_verdict: l7dReceipts.by_verdict,
        },
        l30d: {
          paid_calls: windows?.l30d.confirm.calls ?? 0,
          receipts: l30dReceipts.receipts,
          by_verdict: l30dReceipts.by_verdict,
        },
      },
    },
    benches: {
      false_confirmed_rate: null,
      note: BENCH_NOTE,
    },
    notes: [
      "Only lead_submit is a payable Confirm intent in this phase.",
      "Unknown intents return HTTP 400 unsupported_intent and are not listed on Bazaar.",
      "paid_calls are confirm-route volume (day-1 = lead_submit). Verdict breakdown is from receipt records when present.",
    ],
  };
}

export function statsHtml(doc: StatsDocument): string {
  const lead = doc.intents.lead_submit;
  const row = (label: string, w: IntentWindow) =>
    `<tr><td>${label}</td><td>${w.paid_calls}</td><td>${w.receipts}</td><td>${w.by_verdict.confirmed}</td><td>${w.by_verdict.failed}</td><td>${w.by_verdict.unknown}</td></tr>`;
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
  <p>Generated ${doc.generated_at}. Payable intent: <code>lead_submit</code> at $${lead.price_usd.toFixed(2)} USDC.</p>
  <table>
    <thead>
      <tr><th>Window</th><th>Paid calls</th><th>Receipts</th><th>confirmed</th><th>failed</th><th>unknown</th></tr>
    </thead>
    <tbody>
      ${row("L7d", lead.l7d)}
      ${row("L30d", lead.l30d)}
    </tbody>
  </table>
  <p class="muted">${doc.benches.note}</p>
  <p class="muted">${doc.notes.join(" ")}</p>
  <p><a href="/stats?format=json">JSON</a> · <a href="/health">health</a></p>
</body>
</html>`;
}
