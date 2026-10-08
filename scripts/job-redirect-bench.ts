#!/usr/bin/env npx tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatJobBenchReport, runJobRedirectBench } from "../src/job-redirect-bench.js";

const report = runJobRedirectBench();
process.stdout.write(`${formatJobBenchReport(report)}\n`);
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bench");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "job-redirect-report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (report.closed_to_live !== 0) process.exitCode = 1;
