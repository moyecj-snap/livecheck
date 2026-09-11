import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvidenceLevel } from "./types.js";

export type ConfirmReceiptRow = {
  id: string;
  intent: string;
  verdict: string;
  confidence: number;
  evidence_level: EvidenceLevel;
  canonical_json: string;
  payload_hash: string;
  signature: string | null;
  signer: string | null;
  observed_at: string;
  url_hash: string;
  claim_hash: string;
  created_at: string;
};

export type ReceiptVerdictCounts = {
  confirmed: number;
  failed: number;
  unknown: number;
};

export type ReceiptStoreStatus =
  | { kind: "sqlite"; path: string }
  | { kind: "memory-fallback"; path?: string; reason: string }
  | { kind: "uninitialized" };

type OpenStore = { ok: true; path: string; db: DatabaseSync };
type ClosedStore = { ok: false; path?: string; reason: string };
type StoreState = OpenStore | ClosedStore;

const memory = new Map<string, ConfirmReceiptRow>();
let state: StoreState | undefined;

/**
 * CREATE TABLE only. Indexes that name columns (created_at) must run AFTER
 * migrate ALTER TABLE — same Fly-volume rule as watchers. Putting CREATE INDEX
 * in this string blows up an older confirm_receipts shape: CREATE TABLE IF NOT
 * EXISTS is a no-op, then CREATE INDEX on a missing column throws and init
 * never reaches migrate.
 */
export const CONFIRM_RECEIPTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS confirm_receipts (
  id TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_level INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature TEXT,
  signer TEXT,
  observed_at TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  claim_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** Indexes that reference columns added in migrate. Run AFTER ALTER TABLE. */
const INDEXES_AFTER_MIGRATE = `
CREATE INDEX IF NOT EXISTS idx_confirm_receipts_created ON confirm_receipts(created_at);
CREATE INDEX IF NOT EXISTS idx_confirm_receipts_intent_created ON confirm_receipts(intent, created_at);
`;

/** @deprecated Use CONFIRM_RECEIPTS_TABLE_SQL + migrateReceiptStore. Kept for callers that only need CREATE TABLE. */
export const CONFIRM_RECEIPTS_SCHEMA = CONFIRM_RECEIPTS_TABLE_SQL;

export function defaultReceiptDbPath(): string {
  const fromEnv = process.env.RECEIPT_DB_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.FLY_APP_NAME?.trim() && existsSync("/data")) {
    return "/data/receipts.sqlite";
  }
  return resolve(process.cwd(), "data/receipts.sqlite");
}

export function receiptStoreTableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name)));
}

function ensureColumn(db: DatabaseSync, table: string, name: string, ddl: string): void {
  if (receiptStoreTableColumns(db, table).has(name)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate column/i.test(message)) return;
    throw error;
  }
}

/**
 * Idempotent upgrade. Safe on a fresh DB and on a volume whose confirm_receipts
 * table is missing later columns (claim_hash, created_at, …).
 * ALTER columns before any index that names them.
 */
export function migrateReceiptStore(db: DatabaseSync): void {
  db.exec(CONFIRM_RECEIPTS_TABLE_SQL);
  ensureColumn(db, "confirm_receipts", "intent", "intent TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "confirm_receipts", "verdict", "verdict TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "confirm_receipts", "confidence", "confidence REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "confirm_receipts", "evidence_level", "evidence_level INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "confirm_receipts", "canonical_json", "canonical_json TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "confirm_receipts", "payload_hash", "payload_hash TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "confirm_receipts", "signature", "signature TEXT");
  ensureColumn(db, "confirm_receipts", "signer", "signer TEXT");
  ensureColumn(db, "confirm_receipts", "observed_at", "observed_at TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "confirm_receipts", "url_hash", "url_hash TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "confirm_receipts", "claim_hash", "claim_hash TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "confirm_receipts", "created_at", "created_at TEXT NOT NULL DEFAULT ''");
  db.exec(INDEXES_AFTER_MIGRATE);
}

function prepareDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec(CONFIRM_RECEIPTS_TABLE_SQL);
  migrateReceiptStore(db);
  return db;
}

export function initReceiptStore(path = defaultReceiptDbPath()): StoreState {
  closeReceiptStore();
  try {
    const db = prepareDatabase(path);
    state = { ok: true, path, db };
    return state;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    state = { ok: false, path, reason };
    return state;
  }
}

export function closeReceiptStore(): void {
  if (state?.ok) {
    try {
      state.db.close();
    } catch {
      // ignore close errors in tests / shutdown
    }
  }
  state = undefined;
}

export function receiptStoreStatus(): ReceiptStoreStatus {
  if (!state) return { kind: "uninitialized" };
  if (state.ok) return { kind: "sqlite", path: state.path };
  return { kind: "memory-fallback", path: state.path, reason: state.reason };
}

export function clearConfirmReceiptMemory(): void {
  memory.clear();
}

function sqliteDb(): DatabaseSync | undefined {
  return state?.ok ? state.db : undefined;
}

function fromSqlRow(item: {
  id: string;
  intent: string;
  verdict: string;
  confidence: number;
  evidence_level: number;
  canonical_json: string;
  payload_hash: string;
  signature: string | null;
  signer: string | null;
  observed_at: string;
  url_hash: string;
  claim_hash: string;
  created_at: string;
}): ConfirmReceiptRow | undefined {
  const level = item.evidence_level;
  if (level !== 0 && level !== 1 && level !== 2 && level !== 3 && level !== 4) return undefined;
  return {
    id: item.id,
    intent: item.intent,
    verdict: item.verdict,
    confidence: Number(item.confidence),
    evidence_level: level,
    canonical_json: item.canonical_json,
    payload_hash: item.payload_hash,
    signature: item.signature,
    signer: item.signer,
    observed_at: item.observed_at,
    url_hash: item.url_hash,
    claim_hash: item.claim_hash,
    created_at: item.created_at,
  };
}

export type ReceiptRememberResult = {
  memory: true;
  /** True only when the row was written to receipts.sqlite. */
  durable: boolean;
};

export function rememberConfirmReceipt(row: ConfirmReceiptRow): ReceiptRememberResult {
  memory.set(row.id, row);
  const database = sqliteDb();
  if (!database) return { memory: true, durable: false };
  try {
    insertConfirmReceiptRow(database, row);
    return { memory: true, durable: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[confirm_receipt] persist failed: ${reason}`);
    return { memory: true, durable: false };
  }
}

export function insertConfirmReceiptRow(database: DatabaseSync, row: ConfirmReceiptRow): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO confirm_receipts (
        id, intent, verdict, confidence, evidence_level, canonical_json, payload_hash,
        signature, signer, observed_at, url_hash, claim_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.intent,
      row.verdict,
      row.confidence,
      row.evidence_level,
      row.canonical_json,
      row.payload_hash,
      row.signature,
      row.signer,
      row.observed_at,
      row.url_hash,
      row.claim_hash,
      row.created_at,
    );
}

export function getConfirmReceipt(id: string): ConfirmReceiptRow | undefined {
  const cached = memory.get(id);
  if (cached) return cached;
  const database = sqliteDb();
  if (!database) return undefined;
  const item = database
    .prepare(
      `SELECT id, intent, verdict, confidence, evidence_level, canonical_json, payload_hash,
              signature, signer, observed_at, url_hash, claim_hash, created_at
       FROM confirm_receipts WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        intent: string;
        verdict: string;
        confidence: number;
        evidence_level: number;
        canonical_json: string;
        payload_hash: string;
        signature: string | null;
        signer: string | null;
        observed_at: string;
        url_hash: string;
        claim_hash: string;
        created_at: string;
      }
    | undefined;
  if (!item) return undefined;
  const row = fromSqlRow(item);
  if (row) memory.set(row.id, row);
  return row;
}

export function emptyReceiptVerdictCounts(): ReceiptVerdictCounts {
  return { confirmed: 0, failed: 0, unknown: 0 };
}

export function countReceiptsSince(
  sinceIso: string,
  intent = "lead_submit",
): { receipts: number; by_verdict: ReceiptVerdictCounts } {
  const database = sqliteDb();
  if (database) {
    try {
      return queryReceiptsSince(database, sinceIso, intent);
    } catch {
      // fall through to memory
    }
  }
  return countMemoryReceiptsSince(sinceIso, intent);
}

export function queryReceiptsSince(
  database: DatabaseSync,
  sinceIso: string,
  intent = "lead_submit",
): { receipts: number; by_verdict: ReceiptVerdictCounts } {
  const by_verdict = emptyReceiptVerdictCounts();
  const rows = database
    .prepare(
      `SELECT verdict, COUNT(*) AS n
       FROM confirm_receipts
       WHERE intent = ? AND created_at >= ?
       GROUP BY verdict`,
    )
    .all(intent, sinceIso) as Array<{ verdict: string; n: number | bigint }>;
  let receipts = 0;
  for (const row of rows) {
    const n = Number(row.n);
    receipts += n;
    if (row.verdict === "confirmed" || row.verdict === "failed" || row.verdict === "unknown") {
      by_verdict[row.verdict] = n;
    }
  }
  return { receipts, by_verdict };
}

function countMemoryReceiptsSince(
  sinceIso: string,
  intent: string,
): { receipts: number; by_verdict: ReceiptVerdictCounts } {
  const by_verdict = emptyReceiptVerdictCounts();
  let receipts = 0;
  for (const row of memory.values()) {
    if (row.intent !== intent || row.created_at < sinceIso) continue;
    receipts += 1;
    if (row.verdict === "confirmed" || row.verdict === "failed" || row.verdict === "unknown") {
      by_verdict[row.verdict] += 1;
    }
  }
  return { receipts, by_verdict };
}

export function listMemoryReceiptIds(): string[] {
  return [...memory.keys()];
}
