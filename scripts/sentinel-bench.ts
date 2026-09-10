#!/usr/bin/env npx tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSentinelBenchMarkdown,
  formatSentinelBenchText,
  runSentinelBench,
} from "../src/sentinel-bench.js";

const report = await runSentinelBench();
const text = formatSentinelBenchText(report);
process.stdout.write(`${text}\n`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const benchDir = resolve(root, "bench");
const docsDir = resolve(root, "docs");
mkdirSync(benchDir, { recursive: true });
mkdirSync(docsDir, { recursive: true });
writeFileSync(
  resolve(benchDir, "sentinel-report.json"),
  `${JSON.stringify({ ...report, path: "scripts/sentinel-bench.ts" }, null, 2)}\n`,
);
writeFileSync(resolve(docsDir, "sentinel-benches.md"), `${formatSentinelBenchMarkdown(report)}\n`);

if (!report.pass) {
  process.exitCode = 1;
}
