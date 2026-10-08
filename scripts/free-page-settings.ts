/**
 * Ops: live knobs for the free /job page (the `free_page_settings` table in
 * /data/free-page.sqlite). The page reads it on every request, so a change
 * takes effect on the next check. No deploy, no restart.
 *
 *   npm run --silent free:get
 *   npm run --silent free:set -- hourly_cap 1000
 *   npm run --silent free:unset -- hourly_cap        (back to env / default)
 *
 * Keys: hourly_cap (0–100000), concurrency (1–16), per_visitor_daily (1–1000),
 * per_ip_daily (1–10000), enabled (0/1, on/off).
 *
 * On Fly:
 *   fly ssh console -a livecheck -C "npm run --silent free:set -- hourly_cap 1000"
 *
 * Options: --db <path> (default FREE_PAGE_DB_PATH, else /data/free-page.sqlite
 * on Fly), --json. Never creates the file. Run as root (fly ssh default), it
 * switches to the DB file's owner first so the app keeps write access.
 */
import { existsSync, statSync } from "node:fs";
import { resolveFreeJobConfig } from "../src/free-job-page.js";
import {
  FREE_PAGE_SETTINGS,
  defaultFreePageDbPath,
  openFreePageDbForAdmin,
  readFreePageSettingsFrom,
  setFreePageSettingIn,
  unsetFreePageSettingIn,
} from "../src/free-job-store.js";

const USAGE = `usage:
  free:get
  free:set -- <key> <value>
  free:unset -- <key>
keys: ${Object.keys(FREE_PAGE_SETTINGS).join(", ")}
options: --db <path>  --json`;

function fail(message: string): never {
  console.error(`free: ${message}\n${USAGE}`);
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
if (!command || !["get", "set", "unset"].includes(command)) fail(`unknown command: ${command ?? "(none)"}`);
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
  if (command === "set") {
    const [key, value] = rest;
    if (!key || value === undefined) fail("set needs <key> <value>");
    setFreePageSettingIn(db, key, value);
  } else if (command === "unset") {
    const [key] = rest;
    if (!key) fail("unset needs <key>");
    unsetFreePageSettingIn(db, key);
  }
  const settings = readFreePageSettingsFrom(db);
  const effective = resolveFreeJobConfig(process.env, settings);
  if (json) {
    console.log(JSON.stringify({ db: path, settings, effective }));
  } else {
    console.log(`settings table: ${JSON.stringify(settings)}`);
    console.log(
      `effective now: hourly_cap=${effective.hourlyCap} concurrency=${effective.concurrency} per_visitor_daily=${effective.perVisitorDaily} per_ip_daily=${effective.perIpDaily} enabled=${effective.enabled}`,
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  db.close();
}
