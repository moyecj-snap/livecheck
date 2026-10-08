/**
 * Ops: grader / tester wallet list (the `test_wallets` table in the paid-calls
 * SQLite file). /stats reads it on every request, so a change shows up on the
 * next page load. No deploy, no restart.
 *
 *   npm run --silent testers:list
 *   npm run --silent testers:add -- <0x wallet> <grader|tester> "<label>"
 *   npm run --silent testers:remove -- <0x wallet>
 *
 * On Fly (one machine, one volume):
 *   fly ssh console -a livecheck -C "npm run --silent testers:add -- 0xabc… grader 'Acme x402 grader'"
 *
 * Options: --db <path> (default PAID_CALL_DB_PATH, else /data/paid-calls.sqlite
 * on Fly), --json. The DB file must already exist; this never creates one.
 * Internal (team) wallets are refused: those live in src/internal-wallets.ts
 * and win over this list anyway.
 * Run as root (fly ssh default), the script switches to the DB file's owner
 * before opening it so SQLite's -wal/-shm files stay writable by the app.
 */
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { internalWallets } from "../src/internal-wallets.js";
import { sanitizePayer } from "../src/paid-call.js";
import { defaultPaidCallDbPath } from "../src/paid-call-store.js";
import {
  listAllTestWallets,
  migrateTestWalletStore,
  removeTestWallet,
  upsertTestWallet,
} from "../src/test-wallet-store.js";

const USAGE = `usage:
  testers:list
  testers:add -- <0x wallet> <grader|tester> "<label>"
  testers:remove -- <0x wallet>
options: --db <path>  --json`;

function fail(message: string): never {
  console.error(`testers: ${message}\n${USAGE}`);
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
const path = dbPath ?? defaultPaidCallDbPath();
if (!command || !["list", "add", "remove"].includes(command)) fail(`unknown command: ${command ?? "(none)"}`);
if (!existsSync(path)) fail(`no paid-calls database at ${path} (pass --db)`);

// fly ssh runs as root; the app runs as `node`. Open as the file's owner.
if (typeof process.getuid === "function" && process.getuid() === 0) {
  const owner = statSync(path);
  if (owner.uid !== 0 && process.setgid && process.setuid) {
    process.setgid(owner.gid);
    process.setuid(owner.uid);
  }
}

const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000;");
try {
  migrateTestWalletStore(db);
  if (command === "list") {
    const rows = listAllTestWallets(db);
    if (json) {
      console.log(JSON.stringify({ db: path, wallets: rows }));
    } else {
      for (const row of rows) {
        const state = row.removed_at ? `removed ${row.removed_at}` : "active";
        console.log(`${row.address}  ${row.role.padEnd(6)}  ${state.padEnd(28)}  ${row.source.padEnd(5)}  ${row.label}`);
      }
      console.log(`${rows.filter((row) => !row.removed_at).length} active, ${rows.length} total (${path})`);
    }
  } else if (command === "add") {
    const [address, role, ...labelParts] = rest;
    if (!address || !role || labelParts.length === 0) fail("add needs <wallet> <grader|tester> <label>");
    const normalized = sanitizePayer(address);
    if (normalized && internalWallets().includes(normalized)) {
      fail(`${normalized} is an internal (team) wallet; it stays Internal and is not added here`);
    }
    const result = upsertTestWallet(db, { address, role, label: labelParts.join(" ") });
    console.log(json ? JSON.stringify({ db: path, ...result }) : `${result.action}: ${result.wallet.address} ${result.wallet.role} "${result.wallet.label}"`);
  } else {
    const [address] = rest;
    if (!address) fail("remove needs <wallet>");
    const removed = removeTestWallet(db, address);
    console.log(json ? JSON.stringify({ db: path, address: sanitizePayer(address), removed }) : removed ? `removed: ${sanitizePayer(address)}` : `not listed (or already removed): ${sanitizePayer(address)}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  db.close();
}
