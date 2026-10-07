import { createApp } from "./app.js";
import { DEFAULT_PORT, isLiveSettlement, missingLiveKeyNames, port } from "./config.js";
import { isEbayAdapterEnabled, logEbayAdapterDisabled } from "./ebay.js";
import { loadDotEnvIfPresent } from "./env.js";
import { backfillPaidCallsFromReceipts, initPaidCallStore } from "./paid-call-store.js";
import { rescueMisplacedReceipts } from "./receipt-rescue.js";
import { initReceiptStore } from "./receipt-store.js";
import { startWatchScheduler } from "./watch-scheduler.js";
import { confirmBenchesLoadInfo } from "./confirm-stats-benches.js";
import { sentinelBenchesLoadInfo } from "./sentinel-stats-benches.js";
import { formatListenBinding, listenHttp } from "./listen.js";
import { initWatchStore } from "./watch-store.js";

loadDotEnvIfPresent();

const store = initPaidCallStore();
if (store.ok) {
  console.log(`paid_call retention: sqlite ${store.path}`);
} else {
  console.warn(
    `paid_call retention: stdout-only (${store.reason}). CoS interim: npm run paid-call:cos -- --from-logs`,
  );
}

const receiptStore = initReceiptStore();
if (receiptStore.ok) {
  console.log(`receipt persistence: sqlite ${receiptStore.path} (Fly volume /data, survives restarts)`);
} else {
  console.warn(
    `receipt persistence failed (${receiptStore.reason}). GET /v1/receipt/{id} will 404 after this process exits. Live Confirm returns 503 receipt_persist_failed so x402 does not settle without a durable receipt.`,
  );
}

if (store.ok && receiptStore.ok) {
  const rescue = rescueMisplacedReceipts({
    paidCallDb: store.db,
    receiptDb: receiptStore.db,
    paidCallPath: store.path,
    receiptPath: receiptStore.path,
  });
  if (rescue.found > 0 || rescue.same_path_refused) {
    console.log(
      `receipt rescue: copied ${rescue.copied}/${rescue.found} confirm_receipts from paid-calls.sqlite → receipts.sqlite; dropped_source=${rescue.dropped_source_table} ids=${rescue.ids.join(",")}`,
    );
  } else {
    console.log(
      "receipt rescue: no leftover confirm_receipts on paid-calls.sqlite (already migrated or never misplaced)",
    );
  }
  const backfill = backfillPaidCallsFromReceipts(store.db, receiptStore.db);
  if (backfill.inserted > 0) {
    console.log(
      `paid_call backfill: inserted ${backfill.inserted} check/watch/renew rows from receipts (payer, tx, and user-agent are not on receipts)`,
    );
  }
}

const watchStore = initWatchStore();
if (watchStore.ok) {
  console.log(`watch persistence: sqlite ${watchStore.path} (Fly volume /data, survives restarts)`);
} else {
  console.warn(`watch persistence failed (${watchStore.reason}). Watchers will not survive this process.`);
}
startWatchScheduler();

const confirmBenches = confirmBenchesLoadInfo();
const cb = confirmBenches.benches;
console.log(
  `confirm benches: source=${confirmBenches.source} lead_submit=${cb.lead_submit.false_confirmed}/${cb.lead_submit.n} listing_published=${cb.listing_published.false_confirmed}/${cb.listing_published.n} order_placed=${cb.order_placed.false_confirmed}/${cb.order_placed.n}`,
);

const sentinelBenches = sentinelBenchesLoadInfo();
console.log(
  `sentinel benches: source=${sentinelBenches.source}${sentinelBenches.path ? ` path=${sentinelBenches.path}` : ""} p50=${sentinelBenches.benches.median_latency_ms}ms p95=${sentinelBenches.benches.latency_p95_ms}ms commit=${sentinelBenches.benches.commit}`,
);

const listenPort = port();
const app = createApp();

if (!isLiveSettlement()) {
  const missing = missingLiveKeyNames().join(", ") || "none";
  console.warn(
    [
      "",
      "==============================================================",
      " LIVECHECK — settlement is DISABLED (mock / dev mode)",
      " Unpaid POST /v1/verify still returns a realistic 402.",
      ` Missing: ${missing}`,
      " Bypass for fixtures: X-Livecheck-Mock: 1",
      "==============================================================",
      "",
    ].join("\n"),
  );
} else {
  console.log("Livecheck settlement: Stripe x402 on Base (USDC), $0.01 per verify.");
}

if (isEbayAdapterEnabled()) {
  console.log("eBay adapter: Browse availability enabled.");
} else {
  logEbayAdapterDisabled();
}

const onFly = Boolean(process.env.FLY_APP_NAME?.trim());
listenHttp({ fetch: app.fetch, port: listenPort, requireIPv6: onFly })
  .then((listened) => {
    const shown = listened.bindings[0]?.port || listenPort || DEFAULT_PORT;
    const where = listened.bindings.map(formatListenBinding).join(" and ");
    console.log(`Livecheck listening on ${where} (local: http://127.0.0.1:${shown})`);
    if (listened.ipv6Error) {
      console.warn(
        `IPv6 listen failed (${listened.ipv6Error}). Fly 6PN peer fetches to <machine>.vm.<app>.internal will be refused until [::] is bound.`,
      );
    }
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
