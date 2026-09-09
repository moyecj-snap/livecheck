#!/usr/bin/env npx tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBenchReport, runListingPublishedBench } from "../src/listing-published-bench.js";

const report = runListingPublishedBench();
const text = formatBenchReport(report);
process.stdout.write(`${text}\n`);

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bench");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "listing-published-report.json"),
  `${JSON.stringify({ ...report, path: "scripts/listing-published-bench.ts" }, null, 2)}\n`,
);

if (!report.fc_zero || report.n < 50) {
  process.exitCode = 1;
}
