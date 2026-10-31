#!/usr/bin/env npx tsx
/**
 * Re-fetch the Oct 1 20-URL plate through verifyUrl.
 * Hits the network. Not part of npm test.
 *
 *   npm run bench:oct1-accuracy
 *   npm run bench:job-accuracy            (Oct 9 21-posting plate, incl. LinkedIn + Lever)
 *   tsx scripts/oct1-accuracy.ts <plate.json>
 *   tsx scripts/oct1-accuracy.ts --robots-mode lenient <plate.json>
 *
 * robots.txt defaults to strict (wait 5s; no file means unknown /
 * robots_unavailable, and the page is not fetched). Public API checks stay
 * lenient. Override with --robots-mode strict|lenient or LIVECHECK_ROBOTS_MODE.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAuditRunnerArgs } from "../src/robots.js";
import { stripTrackingParams } from "../src/tracking-params.js";
import { verifyUrl } from "../src/verify.js";

type Expected = "live" | "closed" | "unknown";

type PlateItem = {
  id: string;
  ats: string;
  expected: Expected;
  url: string;
};

const auditArgs = parseAuditRunnerArgs(process.argv.slice(2), process.env.LIVECHECK_ROBOTS_MODE);
const platePath = auditArgs.platePath
  ? resolve(auditArgs.platePath)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "bench", "oct1-accuracy-urls.json");
const plate = JSON.parse(readFileSync(platePath, "utf8")) as { items: PlateItem[] };

async function main(): Promise<void> {
  let live = 0;
  let closed = 0;
  let unknown = 0;
  let closedToLive = 0;
  let falseLive = 0;
  let liveToClosed = 0;

  for (const item of plate.items) {
    const verdict = await verifyUrl(stripTrackingParams(item.url), fetch, new Date(), {
      atsApi: true,
      deadlineMs: 20000,
      robotsMode: auditArgs.robotsMode,
    });
    const got = verdict.status;
    if (got === "live") live += 1;
    else if (got === "closed") closed += 1;
    else unknown += 1;
    if (item.expected === "closed" && got === "live") closedToLive += 1;
    if (item.expected !== "live" && got === "live") falseLive += 1;
    if (item.expected === "live" && got === "closed") liveToClosed += 1;
    process.stdout.write(`${item.id}\texpect=${item.expected}\tgot=${got}\t${verdict.signals.join(",")}\n`);
  }

  process.stdout.write(
    `N=${plate.items.length}\nlive=${live} closed=${closed} unknown=${unknown}\nclosed_to_live=${closedToLive}\nfalse_live=${falseLive}\nlive_to_closed=${liveToClosed}\nrobots_mode=${auditArgs.robotsMode}\n`,
  );
  if (closedToLive !== 0 || falseLive !== 0) process.exitCode = 1;
}

await main();
