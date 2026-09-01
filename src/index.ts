import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { DEFAULT_PORT, isLiveSettlement, missingLiveKeyNames, port } from "./config.js";
import { loadDotEnvIfPresent } from "./env.js";

loadDotEnvIfPresent();

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

serve({ fetch: app.fetch, port: listenPort, hostname: "0.0.0.0" }, (info) => {
  const shown = info.port || listenPort || DEFAULT_PORT;
  console.log(`Livecheck listening on 0.0.0.0:${shown} (local: http://127.0.0.1:${shown})`);
});
