import type { DatabaseSync } from "node:sqlite";
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

const memory = new Map<string, ConfirmReceiptRow>();

let sqliteAccessor: (() => DatabaseSync | undefined) | undefined;

export const CONFIRM_RECEIPTS_SCHEMA = `
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
CREATE INDEX IF NOT EXISTS idx_confirm_receipts_created ON confirm_receipts(created_at);
CREATE INDEX IF NOT EXISTS idx_confirm_receipts_intent_created ON confirm_receipts(intent, created_at);
`;

export function bindReceiptSqlite(accessor: () => DatabaseSync | undefined): void {
  sqliteAccessor = accessor;
}

export function clearConfirmReceiptMemory(): void {
  memory.clear();
}

function db(): DatabaseSync | undefined {
  return sqliteAccessor?.();
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

export function rememberConfirmReceipt(row: ConfirmReceiptRow): boolean {
  memory.set(row.id, row);
  const database = db();
  if (!database) return true;
  try {
    insertConfirmReceiptRow(database, row);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[confirm_receipt] persist failed: ${reason}`);
    return false;
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
  const database = db();
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
  const database = db();
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
