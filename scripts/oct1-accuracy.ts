#!/usr/bin/env npx tsx
/**
 * Re-fetch the Oct 1 20-URL plate through verifyUrl.
 * Hits the network. Not part of npm test.
 *
 *   npm run bench:oct1-accuracy
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyUrl } from "../src/verify.js";

type Expected = "live" | "closed" | "unknown";

type PlateItem = {
  id: string;
  ats: string;
  expected: Expected;
  url: string;
};

const platePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bench", "oct1-accuracy-urls.json");
const plate = JSON.parse(readFileSync(platePath, "utf8")) as { items: PlateItem[] };

async function main(): Promise<void> {
  let live = 0;
  let closed = 0;
  let unknown = 0;
  let closedToLive = 0;
  let falseLive = 0;

  for (const item of plate.items) {
    const verdict = await verifyUrl(item.url, fetch, new Date(), { atsApi: true, deadlineMs: 20000 });
    const got = verdict.status;
    if (got === "live") live += 1;
    else if (got === "closed") closed += 1;
    else unknown += 1;
    if (item.expected === "closed" && got === "live") closedToLive += 1;
    if (item.expected !== "live" && got === "live") falseLive += 1;
    process.stdout.write(`${item.id}\texpect=${item.expected}\tgot=${got}\t${verdict.signals.join(",")}\n`);
  }

  process.stdout.write(
    `N=${plate.items.length}\nlive=${live} closed=${closed} unknown=${unknown}\nclosed_to_live=${closedToLive}\nfalse_live=${falseLive}\n`,
  );
  if (closedToLive !== 0 || falseLive !== 0) process.exitCode = 1;
}

await main();
