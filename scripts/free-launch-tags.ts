/**
 * Ops: free /job launch utm/ref tags (free_page_launch_utm in free-page.sqlite).
 * Built-ins (producthunt, linkedin, x, email, test, clawhub) are always on.
 * Extra tags can be added here and are read on the next /job hit — no deploy.
 *
 *   npm run --silent free:launch-tags:list
 *   npm run --silent free:launch-tags:add -- mycampaign
 *   npm run --silent free:launch-tags:remove -- mycampaign
 *
 * On Fly:
 *   fly ssh console -a livecheck -C "npm run --silent free:launch-tags:add -- mycampaign"
 *
 * Counts only (PR #39): no links, IPs, cookies, or per-visitor rows.
 * Options: --db <path> (default FREE_PAGE_DB_PATH / /data/free-page.sqlite), --json.
 */
import { existsSync, statSync } from "node:fs";
import {
  listLaunchUtmTagsFrom,
  removeLaunchUtmTagIn,
  upsertLaunchUtmTagIn,
} from "../src/free-job-sources.js";
import { defaultFreePageDbPath, openFreePageDbForAdmin } from "../src/free-job-store.js";

const USAGE = `usage:
  free:launch-tags:list
  free:launch-tags:add -- <tag>
  free:launch-tags:remove -- <tag>
options: --db <path>  --json`;

function fail(message: string): never {
  console.error(`free:launch-tags: ${message}
${USAGE}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const json = argv.includes("--json");
let dbPath: string | undefined;
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--json") continue;
  if (arg === "--db") {
    dbPath = argv[++i];
    if (!dbPath) fail("--db needs a path");
    continue;
  }
  positional.push(arg);
}
const [command, ...rest] = positional;
if (!command || !["list", "add", "remove"].includes(command)) fail(`unknown command: ${command ?? "(none)"}`);
const path = dbPath ?? defaultFreePageDbPath();
if (!existsSync(path)) fail(`no free-page database at ${path} (the app creates it on boot; pass --db)`);

if (typeof process.getuid === "function" && process.getuid() === 0) {
  const owner = statSync(path);
  if (owner.uid !== 0 && process.setgid && process.setuid) {
    process.setgid(owner.gid);
    process.setuid(owner.uid);
  }
}

let db;
try {
  db = openFreePageDbForAdmin(path);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
try {
  if (command === "list") {
    const tags = listLaunchUtmTagsFrom(db);
    if (json) console.log(JSON.stringify({ db: path, tags }));
    else for (const row of tags) console.log(`${row.tag}	${row.source}${row.added_at ? `	${row.added_at}` : ""}`);
  } else if (command === "add") {
    const [tag] = rest;
    if (!tag) fail("add needs <tag>");
    const saved = upsertLaunchUtmTagIn(db, tag);
    if (json) console.log(JSON.stringify({ ok: true, tag: saved }));
    else console.log(`added ${saved}`);
  } else {
    const [tag] = rest;
    if (!tag) fail("remove needs <tag>");
    const removed = removeLaunchUtmTagIn(db, tag);
    if (!removed) fail(`not found: ${tag}`);
    if (json) console.log(JSON.stringify({ ok: true, tag, removed: true }));
    else console.log(`removed ${tag}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  db.close();
}
