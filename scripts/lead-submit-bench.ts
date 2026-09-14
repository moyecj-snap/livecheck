#!/usr/bin/env npx tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBenchReport, runLeadSubmitBench } from "../src/lead-submit-bench.js";

const report = runLeadSubmitBench();
const text = formatBenchReport(report);
process.stdout.write(`${text}\n`);

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bench");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "lead-submit-report.json"),
  `${JSON.stringify({ ...report, path: "scripts/lead-submit-bench.ts" }, null, 2)}\n`,
);

if (!report.fc_zero || report.n < 50) {
  process.exitCode = 1;
}
