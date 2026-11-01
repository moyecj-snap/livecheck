#!/usr/bin/env npx tsx
/**
 * Re-fetch the Oct 1 20-URL plate through verifyUrl.
 * Hits the network. Not part of npm test.
 *
 *   npm run bench:oct1-accuracy
 *   npm run bench:job-accuracy            (Oct 9 21-posting plate, incl. LinkedIn + Lever)
 *   tsx scripts/oct1-accuracy.ts <plate.json>
 *
 * LinkedIn postings are unsupported by policy (Craig, Nov 1 2026): LinkedIn's
 * robots.txt is "User-agent: * / Disallow: /", so Livecheck answers unknown
 * (robots_disallowed) on purpose. They are still checked, but reported on their
 * own "LinkedIn (unsupported by policy)" line and kept out of the main totals
 * and the exit code, so a deliberate policy choice doesn't read as a miss.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTrackingParams } from "../src/tracking-params.js";
import { verifyUrl } from "../src/verify.js";

type Expected = "live" | "closed" | "unknown";

type PlateItem = {
  id: string;
  ats: string;
  expected: Expected;
  url: string;
};

const platePath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "bench", "oct1-accuracy-urls.json");
const plate = JSON.parse(readFileSync(platePath, "utf8")) as { items: PlateItem[] };

/** LinkedIn is unsupported by policy (robots.txt disallows all bots). */
function isLinkedInItem(item: Pick<PlateItem, "ats" | "url">): boolean {
  if (item.ats.toLowerCase() === "linkedin") return true;
  try {
    const host = new URL(item.url).hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

type Tally = { n: number; live: number; closed: number; unknown: number; closedToLive: number; falseLive: number; liveToClosed: number };

function emptyTally(): Tally {
  return { n: 0, live: 0, closed: 0, unknown: 0, closedToLive: 0, falseLive: 0, liveToClosed: 0 };
}

function count(t: Tally, expected: Expected, got: Expected): void {
  t.n += 1;
  if (got === "live") t.live += 1;
  else if (got === "closed") t.closed += 1;
  else t.unknown += 1;
  if (expected === "closed" && got === "live") t.closedToLive += 1;
  if (expected !== "live" && got === "live") t.falseLive += 1;
  if (expected === "live" && got === "closed") t.liveToClosed += 1;
}

async function main(): Promise<void> {
  const core = emptyTally();
  const linkedIn = emptyTally();

  for (const item of plate.items) {
    const verdict = await verifyUrl(stripTrackingParams(item.url), fetch, new Date(), { atsApi: true, deadlineMs: 20000 });
    const got = verdict.status;
    const policy = isLinkedInItem(item);
    count(policy ? linkedIn : core, item.expected, got);
    process.stdout.write(
      `${item.id}\texpect=${item.expected}\tgot=${got}\t${verdict.signals.join(",")}${policy ? "\tlinkedin_unsupported_by_policy" : ""}\n`,
    );
  }

  process.stdout.write(
    `N=${core.n}\nlive=${core.live} closed=${core.closed} unknown=${core.unknown}\nclosed_to_live=${core.closedToLive}\nfalse_live=${core.falseLive}\nlive_to_closed=${core.liveToClosed}\n`,
  );
  if (linkedIn.n > 0) {
    process.stdout.write(
      `LinkedIn (unsupported by policy): N=${linkedIn.n} live=${linkedIn.live} closed=${linkedIn.closed} unknown=${linkedIn.unknown} (not in the totals above)\n`,
    );
  }
  if (core.closedToLive !== 0 || core.falseLive !== 0) process.exitCode = 1;
}

await main();
