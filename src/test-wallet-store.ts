import type { DatabaseSync } from "node:sqlite";
import { sanitizePayer } from "./paid-call.js";
import { TEST_TRAFFIC_WALLETS, type TestTrafficRole, type TestTrafficWallet } from "./test-traffic.js";

/**
 * Grader / tester wallets, editable without a deploy.
 *
 * The list lives in the `test_wallets` table inside the paid-calls SQLite
 * file (`/data/paid-calls.sqlite` on Fly). Opening the store creates the table
 * and seeds it from `TEST_TRAFFIC_WALLETS` in `src/test-traffic.ts` with
 * INSERT OR IGNORE, so boot is idempotent: restarts never duplicate a row,
 * never overwrite a label the team edited, and never bring back a wallet the
 * team removed (removal is a `removed_at` timestamp, not a DELETE).
 *
 * `/stats` reads this table on every request, so `npm run testers:add` takes
 * effect on the next page load with no restart. See README "Grader / tester
 * wallets".
 */
export const TEST_WALLETS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS test_wallets (
  address TEXT PRIMARY KEY
    CHECK (address = lower(address) AND length(address) = 42 AND substr(address, 1, 2) = '0x'),
  role TEXT NOT NULL CHECK (role IN ('grader', 'tester')),
  label TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('seed', 'admin')),
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT
);
`;

export const TEST_WALLET_LABEL_MAX = 120;

export type StoredTestWallet = TestTrafficWallet & {
  source: "seed" | "admin";
  added_at: string;
  updated_at: string;
  removed_at: string | null;
};

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseTestWalletRole(value: unknown): TestTrafficRole | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "grader" || raw === "tester") return raw;
  return undefined;
}

export function sanitizeTestWalletLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, TEST_WALLET_LABEL_MAX);
}

/** Create the table and seed the built-in list. Safe to run on every boot. */
export function migrateTestWalletStore(db: DatabaseSync, now = new Date()): { seeded: number } {
  db.exec(TEST_WALLETS_TABLE_SQL);
  const ts = isoNow(now);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO test_wallets (address, role, label, source, added_at, updated_at, removed_at)
     VALUES (?, ?, ?, 'seed', ?, ?, NULL)`,
  );
  let seeded = 0;
  for (const wallet of TEST_TRAFFIC_WALLETS) {
    const result = insert.run(wallet.address, wallet.role, wallet.label, ts, ts);
    seeded += Number(result.changes);
  }
  return { seeded };
}

function rowToWallet(row: Record<string, unknown>): StoredTestWallet | undefined {
  const address = sanitizePayer(row.address);
  const role = parseTestWalletRole(row.role);
  if (!address || !role) return undefined;
  return {
    address,
    role,
    label: String(row.label ?? ""),
    source: row.source === "admin" ? "admin" : "seed",
    added_at: String(row.added_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    removed_at: row.removed_at == null ? null : String(row.removed_at),
  };
}

/** Active wallets (not removed), in the order they were added. */
export function listActiveTestWallets(db: DatabaseSync): TestTrafficWallet[] {
  const rows = db
    .prepare(`SELECT address, role, label FROM test_wallets WHERE removed_at IS NULL ORDER BY rowid`)
    .all() as Array<Record<string, unknown>>;
  const out: TestTrafficWallet[] = [];
  for (const row of rows) {
    const wallet = rowToWallet(row);
    if (wallet) out.push({ address: wallet.address, role: wallet.role, label: wallet.label });
  }
  return out;
}

/** Every row, removed ones included (for `npm run testers:list`). */
export function listAllTestWallets(db: DatabaseSync): StoredTestWallet[] {
  const rows = db
    .prepare(
      `SELECT address, role, label, source, added_at, updated_at, removed_at FROM test_wallets ORDER BY rowid`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToWallet).filter((row): row is StoredTestWallet => Boolean(row));
}

export type UpsertTestWalletResult = {
  action: "added" | "updated" | "restored" | "unchanged";
  wallet: TestTrafficWallet;
};

/**
 * Add a wallet, or change the role/label of one already listed. A removed
 * wallet is restored. Throws on a bad address, role, or label so the admin
 * script never writes a half-valid row.
 */
export function upsertTestWallet(
  db: DatabaseSync,
  input: { address: unknown; role: unknown; label: unknown },
  now = new Date(),
): UpsertTestWalletResult {
  const address = sanitizePayer(input.address);
  if (!address) throw new Error(`not a 0x wallet address: ${String(input.address)}`);
  const role = parseTestWalletRole(input.role);
  if (!role) throw new Error(`role must be grader or tester, got: ${String(input.role)}`);
  const label = sanitizeTestWalletLabel(input.label);
  if (!label) throw new Error("label is required (who this wallet is, e.g. 'cog-x402-audit grader')");
  const ts = isoNow(now);
  const existing = db
    .prepare(`SELECT address, role, label, source, added_at, updated_at, removed_at FROM test_wallets WHERE address = ?`)
    .get(address) as Record<string, unknown> | undefined;
  const wallet = { address, role, label };
  if (!existing) {
    db.prepare(
      `INSERT INTO test_wallets (address, role, label, source, added_at, updated_at, removed_at)
       VALUES (?, ?, ?, 'admin', ?, ?, NULL)`,
    ).run(address, role, label, ts, ts);
    return { action: "added", wallet };
  }
  const wasRemoved = existing.removed_at != null;
  if (!wasRemoved && existing.role === role && existing.label === label) {
    return { action: "unchanged", wallet };
  }
  db.prepare(`UPDATE test_wallets SET role = ?, label = ?, updated_at = ?, removed_at = NULL WHERE address = ?`).run(
    role,
    label,
    ts,
    address,
  );
  return { action: wasRemoved ? "restored" : "updated", wallet };
}

/** Soft-remove. Returns false when the wallet is not listed or already removed. */
export function removeTestWallet(db: DatabaseSync, addressInput: unknown, now = new Date()): boolean {
  const address = sanitizePayer(addressInput);
  if (!address) throw new Error(`not a 0x wallet address: ${String(addressInput)}`);
  const ts = isoNow(now);
  const result = db
    .prepare(`UPDATE test_wallets SET removed_at = ?, updated_at = ? WHERE address = ? AND removed_at IS NULL`)
    .run(ts, ts, address);
  return Number(result.changes) === 1;
}
