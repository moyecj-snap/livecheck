/**
 * CoS pull: L7d / L30d unique payers + call counts by route.
 *
 * Counts rows only. Does not invent KPIs, revenue, or conversion.
 *
 * Preferred (retained SQLite on the Fly volume):
 *   npm run paid-call:cos
 *   fly ssh console -a livecheck -C "npm run paid-call:cos"
 *
 * Interim (stdout JSON / fly logs) if the volume is empty or missing:
 *   fly logs -a livecheck | npm run paid-call:cos -- --from-logs
 *
 * TODO: once Patty attaches volume `livecheck_data` at /data and the
 * process can write /data/paid-calls.sqlite, drop the --from-logs path
 * for production pulls. Keep it for local exports.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  sanitizePayer,
  sanitizePaymentIntent,
  sanitizeTx,
} from "../src/paid-call.js";
import {
  aggregatePaidCallRows,
  defaultPaidCallDbPath,
  listPaidCallRows,
  openPaidCallDb,
  queryRetentionWindows,
  rowsFromLogText,
  safeHost,
  type PaidCallRow,
  type RetentionWindows,
} from "../src/paid-call-store.js";
import type { PaidCallRoute } from "../src/paid-call.js";

type CosReport = {
  source: { kind: "sqlite" | "logs"; path?: string };
  as_of: string;
  windows: RetentionWindows;
  rows?: PaidCallRow[];
  note: string;
};

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function asOfIso(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatWindow(label: string, window: RetentionWindows["l7d"]): string {
  const routes: PaidCallRoute[] = ["verify", "confirm"];
  const body = routes
    .map((route) => `  ${route.padEnd(8)} calls=${window[route].calls}  unique_payers=${window[route].unique_payers}`)
    .join("\n");
  return `${label}\n${body}`;
}

function printHuman(report: CosReport): void {
  const lines = [
    `source=${report.source.kind}${report.source.path ? ` ${report.source.path}` : ""}`,
    `as_of=${report.as_of}`,
    report.note,
    "",
    formatWindow("L7d", report.windows.l7d),
    formatWindow("L30d", report.windows.l30d),
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const fromLogs = argFlag("--from-logs");
  const jsonOut = argFlag("--json");
  const includeRows = argFlag("--rows");
  const dbPath = argValue("--db") ?? defaultPaidCallDbPath();
  const logFile = argValue("--log-file");
  const now = new Date();

  let source: CosReport["source"];
  let windows: RetentionWindows;
  let rows: PaidCallRow[] | undefined;

  if (fromLogs || logFile) {
    const text = logFile ? readFileSync(logFile, "utf8") : await readStdin();
    const parsed = rowsFromLogText(text);
    windows = aggregatePaidCallRows(parsed, now);
    source = { kind: "logs", path: logFile };
    if (includeRows) rows = parsed;
  } else if (!existsSync(dbPath) && dbPath !== ":memory:") {
    console.error(
      [
        `paid_call SQLite not found at ${dbPath}.`,
        "Interim: pipe fly logs into this script:",
        "  fly logs -a livecheck | npm run paid-call:cos -- --from-logs",
        "TODO: attach Fly volume livecheck_data at /data (see README) so rows persist across deploys.",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  } else {
    const db = openPaidCallDb(dbPath);
    try {
      windows = queryRetentionWindows(db, now);
      source = { kind: "sqlite", path: dbPath };
      if (includeRows) rows = listPaidCallRows(db);
    } finally {
      db.close();
    }
  }

  const report: CosReport = {
    source,
    as_of: asOfIso(now),
    windows,
    note: "Row counts only: calls = rows in window; unique_payers = distinct non-null wallet in window.",
  };
  if (rows) {
    report.rows = rows.map((row) => ({
      ts: row.ts,
      route: row.route,
      host: safeHost(row.host),
      url_sha256: row.url_sha256,
      ...(sanitizePayer(row.payer) ? { payer: sanitizePayer(row.payer) } : {}),
      ...(sanitizeTx(row.tx) ? { tx: sanitizeTx(row.tx) } : {}),
      ...(sanitizePaymentIntent(row.payment_intent)
        ? { payment_intent: sanitizePaymentIntent(row.payment_intent) }
        : {}),
    }));
  }

  if (jsonOut) {
    console.log(JSON.stringify(report));
    return;
  }
  printHuman(report);
  if (includeRows && report.rows) {
    console.log("");
    console.log(JSON.stringify(report.rows));
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
