import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { confirmUrl } from "./confirm.js";
import { isSuccessHttpStatus } from "./confirm-shared.js";
import { defaultPaidCallDbPath } from "./paid-call-store.js";
import { defaultReceiptDbPath } from "./receipt-store.js";

export type RecheckRow = {
  receipt_id: string;
  time: string;
  payer: string;
  url_sha256: string;
  original_evidence: string;
  new_verdict: string;
  flag: string;
};

export type RecheckReport = {
  rows: RecheckRow[];
  paid_calls_path: string | null;
  receipts_path: string | null;
  notes: string[];
};

type StoredConfirm = {
  receipt_id: string;
  time: string;
  payer: string;
  url_sha256: string;
  intent: string;
  http_status?: number;
  evidence_level?: number;
  confidence?: number;
  signals: string[];
  url?: string;
};

const CONFIRM_INTENTS = new Set(["lead_submit", "listing_published", "order_placed"]);

function openReadOnly(path: string): DatabaseSync | undefined {
  if (!existsSync(path)) return undefined;
  return new DatabaseSync(path, { readOnly: true });
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function signalsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function urlFrom(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function evidenceFromCanonical(canonical: string): { signals: string[]; url?: string; confidence?: number; evidence_level?: number } {
  try {
    const parsed = asRecord(JSON.parse(canonical));
    if (!parsed) return { signals: [] };
    const nested = asRecord(parsed.result) ?? parsed;
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : undefined;
    const level = typeof parsed.evidence_level === "number" ? parsed.evidence_level : undefined;
    return {
      signals: signalsFrom(nested.signals ?? parsed.signals),
      url: urlFrom(nested.url ?? parsed.url),
      confidence,
      evidence_level: level,
    };
  } catch {
    return { signals: [] };
  }
}

function intentForRoute(route: string, intent: string | null | undefined): string {
  if (intent && CONFIRM_INTENTS.has(intent)) return intent;
  if (route === "confirm/order") return "order_placed";
  return "lead_submit";
}

function loadReceipts(db: DatabaseSync | undefined): StoredConfirm[] {
  if (!db || !tableExists(db, "confirm_receipts")) return [];
  const cols = columns(db, "confirm_receipts");
  if (!cols.has("verdict") || !cols.has("url_hash")) return [];
  const rows = db
    .prepare(
      `SELECT id, intent, verdict, confidence, evidence_level, canonical_json, observed_at, url_hash, created_at
       FROM confirm_receipts
       WHERE lower(verdict) = 'confirmed'`,
    )
    .all() as Array<Record<string, unknown>>;
  const out: StoredConfirm[] = [];
  for (const row of rows) {
    const intent = String(row.intent ?? "");
    if (!CONFIRM_INTENTS.has(intent)) continue;
    const extra = evidenceFromCanonical(String(row.canonical_json ?? ""));
    out.push({
      receipt_id: String(row.id ?? ""),
      time: String(row.created_at || row.observed_at || ""),
      payer: "",
      url_sha256: String(row.url_hash ?? "").toLowerCase(),
      intent,
      evidence_level: extra.evidence_level ?? Number(row.evidence_level),
      confidence: extra.confidence ?? Number(row.confidence),
      signals: extra.signals,
      url: extra.url,
    });
  }
  return out;
}

function loadPaidCalls(db: DatabaseSync | undefined): StoredConfirm[] {
  if (!db || !tableExists(db, "paid_calls")) return [];
  const cols = columns(db, "paid_calls");
  if (!cols.has("verdict") || !cols.has("route") || !cols.has("url_sha256")) return [];
  const http = cols.has("http_status") ? "http_status" : "NULL AS http_status";
  const payer = cols.has("payer") ? "payer" : "NULL AS payer";
  const intent = cols.has("intent") ? "intent" : "NULL AS intent";
  const rows = db
    .prepare(
      `SELECT ts, route, ${payer}, url_sha256, ${intent}, verdict, ${http}
       FROM paid_calls
       WHERE lower(verdict) = 'confirmed' AND route IN ('confirm', 'confirm/order')`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    receipt_id: "",
    time: String(row.ts ?? ""),
    payer: typeof row.payer === "string" ? row.payer : "",
    url_sha256: String(row.url_sha256 ?? "").toLowerCase(),
    intent: intentForRoute(String(row.route ?? ""), typeof row.intent === "string" ? row.intent : undefined),
    http_status: typeof row.http_status === "number" ? row.http_status : undefined,
    signals: [],
  }));
}

function closestPaid(receipt: StoredConfirm, paid: readonly StoredConfirm[]): StoredConfirm | undefined {
  const matches = paid.filter((row) => row.url_sha256 && row.url_sha256 === receipt.url_sha256);
  if (matches.length === 0) return undefined;
  const target = Date.parse(receipt.time);
  if (!Number.isFinite(target)) return matches[0];
  return matches.slice().sort((a, b) => Math.abs(Date.parse(a.time) - target) - Math.abs(Date.parse(b.time) - target))[0];
}

function pageIdSignal(signals: readonly string[]): boolean {
  return signals.some((signal) => signal === "confirmation_id" || signal === "order_id" || signal === "listing_id");
}

function urlTokenOnly(signals: readonly string[]): boolean {
  const token = signals.some(
    (signal) => signal === "confirmation_url_token" || signal === "order_url_token" || signal === "url_token_not_sufficient",
  );
  return token && !pageIdSignal(signals);
}

function originalEvidence(item: StoredConfirm, refetched: boolean): string {
  const parts: string[] = [];
  if (item.intent) parts.push(`intent=${item.intent}`);
  if (item.evidence_level !== undefined && Number.isFinite(item.evidence_level)) {
    parts.push(`evidence_level=${item.evidence_level}`);
  }
  if (item.confidence !== undefined && Number.isFinite(item.confidence)) parts.push(`confidence=${item.confidence}`);
  if (item.http_status !== undefined) parts.push(`http_status=${item.http_status}`);
  if (item.signals.length) parts.push(`signals=${item.signals.join("+")}`);
  if (item.url) parts.push(refetched ? "refetched" : "raw_url_present");
  else parts.push("hash_only");
  return parts.join(" ");
}

function flagFromResult(verdict: string, signals: readonly string[], httpStatus: number | undefined): string {
  if (httpStatus !== undefined && !isSuccessHttpStatus(httpStatus)) return "non_2xx";
  if (signals.includes("non_2xx")) return "non_2xx";
  if (urlTokenOnly(signals) || signals.includes("url_token_not_sufficient")) return "url_token_only";
  if (verdict === "confirmed") return "still_confirmed";
  return "no_longer_confirmed";
}

async function judge(
  item: StoredConfirm,
  fetchImpl: typeof fetch,
): Promise<Pick<RecheckRow, "new_verdict" | "flag" | "original_evidence">> {
  if (item.url) {
    try {
      const result = await confirmUrl(item.url, fetchImpl, new Date(), {
        intent: item.intent as "lead_submit" | "listing_published" | "order_placed",
      });
      return {
        original_evidence: originalEvidence(item, true),
        new_verdict: result.verdict,
        flag: flagFromResult(result.verdict, result.signals, result.http_status),
      };
    } catch {
      return {
        original_evidence: originalEvidence(item, false),
        new_verdict: "cannot re-evaluate: fetch failed",
        flag: "fetch_failed",
      };
    }
  }
  if (item.http_status !== undefined && !isSuccessHttpStatus(item.http_status)) {
    return {
      original_evidence: originalEvidence(item, false),
      new_verdict: "unknown",
      flag: "non_2xx",
    };
  }
  if (item.signals.length && urlTokenOnly(item.signals)) {
    return {
      original_evidence: originalEvidence(item, false),
      new_verdict: "unknown",
      flag: "url_token_only",
    };
  }
  return {
    original_evidence: originalEvidence(item, false),
    new_verdict: "cannot re-evaluate: hash only",
    flag: "hash_only",
  };
}

/**
 * Read stored confirmed Confirm receipts and paid_calls. Does not write.
 * Re-fetches only when a raw http(s) URL is stored. Otherwise uses http_status
 * and signals when those fields exist, or reports hash-only.
 */
export async function recheckConfirmReceipts(input: {
  paidCallDbPath?: string;
  receiptDbPath?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<RecheckReport> {
  const paidPath = input.paidCallDbPath ?? defaultPaidCallDbPath();
  const receiptPath = input.receiptDbPath ?? defaultReceiptDbPath();
  const fetchImpl = input.fetchImpl ?? fetch;
  const notes = [
    "Read-only. No rows are updated.",
    "Receipts and paid_calls store url_sha256, not the raw URL. A row is re-fetched only when canonical JSON contains an http(s) url.",
    "A stored non-2xx http_status is enough to flag the row. URL-token-only evidence is flagged when signals are stored.",
  ];
  const paidDb = openReadOnly(paidPath);
  const receiptDb = openReadOnly(receiptPath);
  try {
    const receipts = loadReceipts(receiptDb);
    const paid = loadPaidCalls(paidDb);
    const usedPaid = new Set<StoredConfirm>();
    const merged: StoredConfirm[] = receipts.map((receipt) => {
      const match = closestPaid(receipt, paid);
      if (!match) return receipt;
      usedPaid.add(match);
      return {
        ...receipt,
        payer: match.payer || receipt.payer,
        http_status: receipt.http_status ?? match.http_status,
        url: receipt.url,
        signals: receipt.signals.length ? receipt.signals : match.signals,
      };
    });
    for (const row of paid) {
      if (!usedPaid.has(row)) merged.push(row);
    }
    merged.sort((a, b) => a.time.localeCompare(b.time) || a.receipt_id.localeCompare(b.receipt_id));
    const rows: RecheckRow[] = [];
    for (const item of merged) {
      const judged = await judge(item, fetchImpl);
      rows.push({
        receipt_id: item.receipt_id,
        time: item.time,
        payer: item.payer,
        url_sha256: item.url_sha256,
        original_evidence: judged.original_evidence,
        new_verdict: judged.new_verdict,
        flag: judged.flag,
      });
    }
    if (!paidDb) notes.push(`paid_calls sqlite not found at ${paidPath}`);
    if (!receiptDb) notes.push(`receipts sqlite not found at ${receiptPath}`);
    return {
      rows,
      paid_calls_path: paidDb ? paidPath : null,
      receipts_path: receiptDb ? receiptPath : null,
      notes,
    };
  } finally {
    try {
      paidDb?.close();
    } catch {
      // read-only close
    }
    try {
      receiptDb?.close();
    } catch {
      // read-only close
    }
  }
}

export function formatRecheckTable(report: RecheckReport): string {
  const header = ["receipt id", "time", "payer", "url_sha256", "original evidence", "new verdict", "flag"];
  const body = report.rows.map((row) => [
    row.receipt_id || "(paid_call)",
    row.time,
    row.payer || "(none)",
    row.url_sha256,
    row.original_evidence,
    row.new_verdict,
    row.flag,
  ]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...body.map((line) => line[index]?.length ?? 0)));
  const render = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
  const lines = [render(header), widths.map((width) => "-".repeat(width)).join("  "), ...body.map(render)];
  if (body.length === 0) lines.push("(no confirmed confirm receipts or paid_calls)");
  lines.push("");
  lines.push(...report.notes);
  return lines.join("\n");
}
