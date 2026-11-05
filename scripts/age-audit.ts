/**
 * Board-audit posting-age table.
 *
 *   npm run audit:age -- urls.txt [--board "VentureLoop"] [--stale-after-days 60] [--csv out.csv]
 *
 * urls.txt: one job URL per line (or a JSON array). Runs the same check as
 * POST /v1/verify/job in strict robots.txt mode (audits always run strict),
 * one URL at a time with a pause. Reads pages and public ATS APIs only; it
 * never submits an application. Prints the summary JSON (with the check date
 * and sample size) and writes per-row CSV columns when --csv is given.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ageAuditCsv, summarizeAges, type AgeAuditRow } from "../src/age-audit.js";
import { clampStaleAfterDays } from "../src/posting-age.js";
import { verifyUrl } from "../src/verify.js";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function readUrls(path: string): string[] {
  const raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith("[")) return (JSON.parse(raw) as unknown[]).filter((u): u is string => typeof u === "string");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) {
    console.error("usage: npm run audit:age -- urls.txt [--board NAME] [--stale-after-days N] [--csv out.csv]");
    process.exit(2);
  }
  const staleAfterDays = clampStaleAfterDays(arg("--stale-after-days"));
  const urls = readUrls(file);
  const rows: AgeAuditRow[] = [];
  for (const url of urls) {
    try {
      const verdict = await verifyUrl(url, fetch, new Date(), {
        atsApi: true,
        robotsMode: "strict",
        age: { mode: "job", staleAfterDays },
      });
      rows.push({ url, status: verdict.status, age: verdict.age ?? null });
    } catch {
      rows.push({ url, status: "error", age: null });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const checkedOn = new Date().toISOString().slice(0, 10);
  const csvPath = arg("--csv");
  if (csvPath) writeFileSync(csvPath, ageAuditCsv(rows));
  console.log(JSON.stringify(summarizeAges(rows, { checkedOn, board: arg("--board") }), null, 2));
}

void main();
