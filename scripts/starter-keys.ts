/**
 * Ops: starter keys in the paid-calls SQLite file. A change is read on the
 * next request. No deploy, no restart.
 *
 *   npm run --silent keys:list
 *   npm run --silent keys:set -- emergency_stop 1
 *   npm run --silent keys:set -- wind_down 1
 *   npm run --silent keys:set -- daily_check_cap 2000
 *   npm run --silent keys:revoke -- k_0123abcd0123abcd
 *   npm run --silent keys:revoke -- <github_login>
 *   npm run --silent keys:mark-internal -- <github_login>
 *   npm run --silent keys:delete -- <github_login>
 *   npm run --silent keys:cleanup
 *   npm run --silent keys:followups
 *   npm run --silent keys:followups -- --mark k_0123abcd0123abcd
 *
 * On Fly:
 *   fly ssh console -a livecheck -C "npm run --silent keys:set -- emergency_stop 1"
 *   fly ssh console -a livecheck -C "npm run --silent keys:set -- wind_down 1"
 *
 * Both switches are rows in api_key_settings. The next request sees them.
 * No Fly secret and no restart.
 *   emergency_stop 1  every key stops immediately (abuse, cost, or a bug).
 *                     Overrides wind_down. Set 0 to turn keys back on.
 *   wind_down 1       /keys sign-up closes. Unexpired keys keep their
 *                     remaining checks until they expire. Set 0 to reopen.
 *
 * Our own dry-run/test key: mark-internal (leaves every starter-key stat and
 * the follow-up list; the key still works), then revoke (stops the key, keeps
 * the record), then optionally delete (removes the record and its per-key
 * counts now, overriding the 90-day retention, so the same GitHub account can
 * get a fresh key). Each takes a key id, GitHub numeric id, or login (@ optional).
 * Nothing prints the key or its hash.
 *
 * daily_check_cap can be raised only by this command. Nothing in the server
 * raises it.
 *
 * Options: --db <path> (default PAID_CALL_DB_PATH, else /data/paid-calls.sqlite
 * on Fly), --json. The DB file must already exist; this never creates one.
 * Run as root (fly ssh default), it switches to the DB file's owner first.
 */
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  deleteExpiredStarterKeys,
  listFollowups,
  listStarterKeys,
  markFollowupDrafted,
  migrateApiKeyStore,
  queryStarterKeyStats,
  readStarterKeySettings,
  deleteStarterKeyRecord,
  markStarterKeyInternal,
  revokeStarterKey,
  setStarterKeySetting,
  starterKeyLimits,
} from "../src/api-key-store.js";
import { defaultPaidCallDbPath } from "../src/paid-call-store.js";
import {
  STARTER_KEY_SETTINGS,
  parseStarterKeySetting,
  type StarterSettingKey,
} from "../src/starter-key.js";

const USAGE = `usage:
  keys:list
  keys:set -- <key> <value>
  keys:revoke -- <id | github id | @login>
  keys:mark-internal -- <id | github id | @login>
  keys:delete -- <id | github id | @login>
  keys:cleanup
  keys:followups [--mark <id>]
keys: ${Object.keys(STARTER_KEY_SETTINGS).join(", ")}
options: --db <path>  --json`;

function fail(message: string): never {
  console.error(`keys: ${message}\n${USAGE}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const json = argv.includes("--json");
let dbPath: string | undefined;
let mark: string | undefined;
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--json") continue;
  if (arg === "--db") {
    dbPath = argv[++i];
    if (!dbPath) fail("--db needs a path");
    continue;
  }
  if (arg === "--mark") {
    mark = argv[++i];
    if (!mark) fail("--mark needs a key id");
    continue;
  }
  positional.push(arg);
}

const [command, ...rest] = positional;
if (!command || !["list", "set", "revoke", "mark-internal", "delete", "cleanup", "followups"].includes(command)) {
  fail(`unknown command: ${command ?? "(none)"}`);
}
const path = dbPath ?? defaultPaidCallDbPath();
if (!existsSync(path)) fail(`no paid-calls database at ${path} (the app creates it on boot; pass --db)`);

if (typeof process.getuid === "function" && process.getuid() === 0) {
  const owner = statSync(path);
  if (owner.uid !== 0 && process.setgid && process.setuid) {
    process.setgid(owner.gid);
    process.setuid(owner.uid);
  }
}

const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000;");
migrateApiKeyStore(db);

function draftFor(login: string): string {
  return `Hi @${login} — you started a Livecheck key about a week ago. How did the checks go? One note is enough; reply on GitHub if you want. — Craig`;
}

try {
  let removed = 0;
  let deleted: { id: string; github_login: string; github_id: string } | undefined;
  if (command === "set") {
    const [key, value] = rest;
    if (!key || value === undefined) fail("set needs <key> <value>");
    const parsed = parseStarterKeySetting(key, value);
    const before = readStarterKeySettings(db);
    const previous = before[parsed.key as StarterSettingKey];
    const fallback = STARTER_KEY_SETTINGS[parsed.key as StarterSettingKey].fallback;
    setStarterKeySetting(db, parsed.key, parsed.value);
    if (parsed.key === "daily_check_cap" && parsed.value > (previous ?? fallback)) {
      console.log(
        `starter_keys: operator set daily_check_cap from ${previous ?? fallback} to ${parsed.value} (manual change, not automatic)`,
      );
    }
  } else if (command === "revoke") {
    const [id] = rest;
    if (!id) fail("revoke needs <id | github id | @login>");
    const row = revokeStarterKey(db, id);
    if (!row) fail(`no starter key matches ${id}`);
  } else if (command === "mark-internal") {
    const [id] = rest;
    if (!id) fail("mark-internal needs <id | github id | @login>");
    const row = markStarterKeyInternal(db, id);
    if (!row) fail(`no starter key matches ${id}`);
  } else if (command === "delete") {
    const [id] = rest;
    if (!id) fail("delete needs <id | github id | @login>");
    const gone = deleteStarterKeyRecord(db, id);
    if (!gone) fail(`no starter key matches ${id}`);
    deleted = gone;
  } else if (command === "cleanup") {
    removed = deleteExpiredStarterKeys(db);
    if (!json) console.log(`starter_keys: deleted ${removed} key records 90 days after expiry`);
  } else if (command === "followups") {
    if (mark) {
      const updated = markFollowupDrafted(db, mark);
      if (!updated) fail(`no unmarked opt-in key with id ${mark}`);
    }
  }

  const settings = readStarterKeySettings(db);
  const limits = starterKeyLimits(db);
  const stats = queryStarterKeyStats(db);
  const keys = listStarterKeys(db).map((row) => ({
    id: row.id,
    github_id: row.github_id,
    github_login: row.github_login,
    status: row.status,
    free_used: row.free_used,
    free_allowance: row.free_allowance,
    paid_left: row.paid_left,
    contact_opt_in: row.contact_opt_in,
    created_at: row.created_at,
    expires_at: row.expires_at,
    suspended_reason: row.suspended_reason,
    followup_drafted_at: row.followup_drafted_at,
    internal: row.internal === 1,
  }));
  const followups = listFollowups(db).map((row) => ({
    ...row,
    draft: draftFor(row.github_login),
  }));

  if (json) {
    const body: Record<string, unknown> = { db: path, settings, limits, stats, keys };
    if (command === "followups" || command === "list") body.followups = followups;
    if (command === "cleanup") body.deleted = removed;
    if (command === "delete") body.deleted_key = deleted;
    console.log(JSON.stringify(body));
  } else if (command !== "cleanup") {
    console.log(
      `effective: emergency_stop=${limits.emergencyStop} wind_down=${limits.windDown} daily_check_cap=${limits.dailyCheckCap} per_key_daily=${limits.perKeyDailyChecks} per_minute=${limits.perKeyPerMinute} issuance_per_ip=${limits.issuancePerIp} issuance_per_day=${limits.issuancePerDay} free_allowance=${limits.freeAllowance} abuse_min_samples=${limits.abuseMinSamples}`,
    );
    console.log(
      `today: free_checks=${stats.daily_cap_used} cap=${stats.daily_cap} cap_hit=${stats.daily_cap_hit} (cap is never raised automatically)`,
    );
    if (keys.length === 0) console.log("no starter keys");
    for (const row of keys) {
      console.log(
        `${row.id}  @${row.github_login}  github:${row.github_id}  ${row.status}  ${row.free_used}/${row.free_allowance} free  paid_left=${row.paid_left}  opt_in=${row.contact_opt_in}  created=${row.created_at}  expires=${row.expires_at}${row.internal ? "  internal" : ""}${row.suspended_reason ? `  reason=${row.suspended_reason}` : ""}`,
      );
    }
    if (command === "followups") {
      if (followups.length === 0) console.log("no 7-day notes to draft");
      for (const row of followups) {
        console.log(`---\nGitHub: @${row.github_login} (${row.id}, ${row.free_used} checks)\nDraft: ${row.draft}`);
      }
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  db.close();
}
