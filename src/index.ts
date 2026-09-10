import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { DEFAULT_PORT, isLiveSettlement, missingLiveKeyNames, port } from "./config.js";
import { isEbayAdapterEnabled, logEbayAdapterDisabled } from "./ebay.js";
import { loadDotEnvIfPresent } from "./env.js";
import { initPaidCallStore } from "./paid-call-store.js";
import { initReceiptStore } from "./receipt-store.js";
import { startWatchScheduler } from "./watch-scheduler.js";
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
    `receipt persistence failed (${receiptStore.reason}). GET /v1/receipt/{id} will 404 after this process exits.`,
  );
}

const watchStore = initWatchStore();
if (watchStore.ok) {
  console.log(`watch persistence: sqlite ${watchStore.path} (Fly volume /data, survives restarts)`);
} else {
  console.warn(`watch persistence failed (${watchStore.reason}). Watchers will not survive this process.`);
}
startWatchScheduler();

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

serve({ fetch: app.fetch, port: listenPort, hostname: "0.0.0.0" }, (info) => {
  const shown = info.port || listenPort || DEFAULT_PORT;
  console.log(`Livecheck listening on 0.0.0.0:${shown} (local: http://127.0.0.1:${shown})`);
});
