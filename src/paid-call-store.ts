import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PAID_CALL_EVENT,
  looksLikeEmail,
  sanitizePayer,
  sanitizePaymentIntent,
  sanitizeTx,
  type PaidCallEvent,
  type PaidCallRoute,
} from "./paid-call.js";

export const PAID_CALLS_TABLE = "paid_calls" as const;

export const CONFIRM_PAID_INTENTS = ["lead_submit", "listing_published", "order_placed"] as const;
export type ConfirmPaidIntent = (typeof CONFIRM_PAID_INTENTS)[number];

export const CONFIRM_PAID_VERDICTS = ["confirmed", "failed", "unknown"] as const;
export type ConfirmPaidVerdict = (typeof CONFIRM_PAID_VERDICTS)[number];

export type PaidCallRow = {
  ts: string;
  route: PaidCallRoute;
  payer?: string;
  tx?: string;
  payment_intent?: string;
  host: string;
  url_sha256: string;
  /** Confirm only. Absent on verify rows and on pre-intent-column history. */
  intent?: ConfirmPaidIntent;
  verdict?: ConfirmPaidVerdict;
};

export type RouteCounts = {
  calls: number;
  unique_payers: number;
};

export type WindowCounts = {
  verify: RouteCounts;
  confirm: RouteCounts;
};

export type RetentionWindows = {
  l7d: WindowCounts;
  l30d: WindowCounts;
};

/** Per-intent confirm-route counts. `unscoped` = route=confirm with no stored intent. */
export type ConfirmIntentCounts = {
  lead_submit: number;
  listing_published: number;
  order_placed: number;
  unscoped: number;
};

export type ConfirmIntentWindows = {
  l7d: ConfirmIntentCounts;
  l30d: ConfirmIntentCounts;
};

export type PaidCallStoreStatus =
  | { kind: "sqlite"; path: string }
  | { kind: "stdout"; reason: string };

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS paid_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('verify', 'confirm')),
  payer TEXT,
  tx TEXT,
  payment_intent TEXT,
  host TEXT NOT NULL,
  url_sha256 TEXT NOT NULL,
  intent TEXT,
  verdict TEXT
);
`;

const INDEXES_AFTER_MIGRATE = `
CREATE INDEX IF NOT EXISTS idx_paid_calls_ts ON paid_calls(ts);
CREATE INDEX IF NOT EXISTS idx_paid_calls_route_ts ON paid_calls(route, ts);
CREATE INDEX IF NOT EXISTS idx_paid_calls_route_intent_ts ON paid_calls(route, intent, ts);
`;

/** @deprecated CREATE TABLE only; migrate adds intent/verdict then indexes. */
export const SCHEMA = TABLE_SQL + INDEXES_AFTER_MIGRATE;

type OpenStore = { ok: true; path: string; db: DatabaseSync };
type ClosedStore = { ok: false; path?: string; reason: string };
type StoreState = OpenStore | ClosedStore;

let state: StoreState | undefined;

export function defaultPaidCallDbPath(): string {
  const fromEnv = process.env.PAID_CALL_DB_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.FLY_APP_NAME?.trim() && existsSync("/data")) {
    return "/data/paid-calls.sqlite";
  }
  return resolve(process.cwd(), "data/paid-calls.sqlite");
}

export function isoCutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function emptyWindowCounts(): WindowCounts {
  return {
    verify: { calls: 0, unique_payers: 0 },
    confirm: { calls: 0, unique_payers: 0 },
  };
}

export function emptyRetentionWindows(): RetentionWindows {
  return { l7d: emptyWindowCounts(), l30d: emptyWindowCounts() };
}

export function emptyConfirmIntentCounts(): ConfirmIntentCounts {
  return { lead_submit: 0, listing_published: 0, order_placed: 0, unscoped: 0 };
}

export function emptyConfirmIntentWindows(): ConfirmIntentWindows {
  return { l7d: emptyConfirmIntentCounts(), l30d: emptyConfirmIntentCounts() };
}

export function paidCallStoreTableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name)));
}

function ensureColumn(db: DatabaseSync, table: string, name: string, ddl: string): void {
  if (paidCallStoreTableColumns(db, table).has(name)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate column/i.test(message)) return;
    throw error;
  }
}

/**
 * Idempotent upgrade. Safe on a fresh DB and on a volume whose paid_calls
 * table predates intent/verdict (those rows stay NULL = unscoped).
 * ALTER columns before any index that names them.
 *
 * Never CREATE confirm_receipts here. Pre-26c702e bound receipts into this
 * file; rescue copies those rows into receipts.sqlite and drops the stray table.
 */
export function migratePaidCallStore(db: DatabaseSync): void {
  db.exec(TABLE_SQL);
  ensureColumn(db, "paid_calls", "intent", "intent TEXT");
  ensureColumn(db, "paid_calls", "verdict", "verdict TEXT");
  db.exec(INDEXES_AFTER_MIGRATE);
}

export function isConfirmPaidIntent(value: unknown): value is ConfirmPaidIntent {
  return value === "lead_submit" || value === "listing_published" || value === "order_placed";
}

export function isConfirmPaidVerdict(value: unknown): value is ConfirmPaidVerdict {
  return value === "confirmed" || value === "failed" || value === "unknown";
}

export function sanitizeConfirmIntent(value: unknown): ConfirmPaidIntent | undefined {
  return isConfirmPaidIntent(value) ? value : undefined;
}

export function sanitizeConfirmVerdict(value: unknown): ConfirmPaidVerdict | undefined {
  return isConfirmPaidVerdict(value) ? value : undefined;
}

/** Hostname only. Drop anything that looks like a URL, path, query, or email. */
export function safeHost(host: string): string {
  const value = host.trim();
  if (!value) return "";
  if (/[/?#@]/.test(value) || looksLikeEmail(value) || /^https?:/i.test(value)) return "";
  return value;
}

export function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/**
 * Map a paid_call event onto the retained row shape.
 * Re-sanitizes payer/tx/payment_intent. Never copies a raw URL.
 */
export function paidCallEventToRow(event: PaidCallEvent): PaidCallRow | undefined {
  if (event.route !== "verify" && event.route !== "confirm") return undefined;
  const url_sha256 = event.url_hash?.trim() ?? "";
  if (!isSha256Hex(url_sha256)) return undefined;
  const row: PaidCallRow = {
    ts: event.ts,
    route: event.route,
    host: safeHost(event.host ?? ""),
    url_sha256,
  };
  const payer = sanitizePayer(event.payer);
  const tx = sanitizeTx(event.tx);
  const paymentIntent = sanitizePaymentIntent(event.payment_intent);
  if (payer) row.payer = payer;
  if (tx) row.tx = tx;
  if (paymentIntent) row.payment_intent = paymentIntent;
  if (event.route === "confirm") {
    const intent = sanitizeConfirmIntent(event.intent);
    const verdict = sanitizeConfirmVerdict(event.verdict);
    if (intent) row.intent = intent;
    if (verdict) row.verdict = verdict;
  }
  return row;
}

export function rowContainsSensitive(row: PaidCallRow, rawUrl: string): string[] {
  const blob = JSON.stringify(row);
  const leaks: string[] = [];
  if (blob.includes(rawUrl)) leaks.push("full_url");
  try {
    const parsed = new URL(rawUrl);
    if (parsed.search && blob.includes(parsed.search)) leaks.push("query_string");
    if (parsed.pathname.length > 1 && blob.includes(parsed.pathname)) leaks.push("path");
    for (const value of parsed.searchParams.values()) {
      if (value && looksLikeEmail(value) && blob.includes(value)) leaks.push("email");
    }
  } catch {
    // ignore unparseable probe URLs
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(blob)) leaks.push("email");
  return [...new Set(leaks)];
}

export function aggregatePaidCallRows(rows: readonly PaidCallRow[], now = new Date()): RetentionWindows {
  return {
    l7d: aggregateSince(rows, isoCutoff(now, 7)),
    l30d: aggregateSince(rows, isoCutoff(now, 30)),
  };
}

function aggregateSince(rows: readonly PaidCallRow[], sinceIso: string): WindowCounts {
  const out = emptyWindowCounts();
  const payers: Record<PaidCallRoute, Set<string>> = {
    verify: new Set(),
    confirm: new Set(),
  };
  for (const row of rows) {
    if (row.ts < sinceIso) continue;
    if (row.route !== "verify" && row.route !== "confirm") continue;
    out[row.route].calls += 1;
    if (row.payer) payers[row.route].add(row.payer);
  }
  out.verify.unique_payers = payers.verify.size;
  out.confirm.unique_payers = payers.confirm.size;
  return out;
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
  db.exec(TABLE_SQL);
  migratePaidCallStore(db);
  return db;
}

export function initPaidCallStore(path = defaultPaidCallDbPath()): StoreState {
  closePaidCallStore();
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

export function closePaidCallStore(): void {
  if (state?.ok) {
    try {
      state.db.close();
    } catch {
      // ignore close errors in tests / shutdown
    }
  }
  state = undefined;
}

export function paidCallStoreStatus(): PaidCallStoreStatus {
  if (!state) return { kind: "stdout", reason: "not_initialized" };
  if (state.ok) return { kind: "sqlite", path: state.path };
  return { kind: "stdout", reason: state.reason };
}

export function openPaidCallDb(path: string): DatabaseSync {
  return prepareDatabase(path);
}

export function insertPaidCallRow(db: DatabaseSync, row: PaidCallRow): void {
  const mapped = paidCallEventToRow({
    event: "livecheck.paid_call",
    route: row.route,
    host: row.host,
    url_hash: row.url_sha256,
    payer: row.payer,
    tx: row.tx,
    payment_intent: row.payment_intent,
    ts: row.ts,
    intent: row.intent,
    verdict: row.verdict,
  });
  if (!mapped) {
    throw new Error("refusing to insert unsanitized paid_call row");
  }
  db.prepare(
    `INSERT INTO paid_calls (ts, route, payer, tx, payment_intent, host, url_sha256, intent, verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mapped.ts,
    mapped.route,
    mapped.payer ?? null,
    mapped.tx ?? null,
    mapped.payment_intent ?? null,
    mapped.host,
    mapped.url_sha256,
    mapped.intent ?? null,
    mapped.verdict ?? null,
  );
}

/** Best-effort retain. Never throws; stdout JSON is the durable fallback. */
export function retainPaidCall(event: PaidCallEvent): boolean {
  const row = paidCallEventToRow(event);
  if (!row) return false;
  if (!state?.ok) return false;
  try {
    insertPaidCallRow(state.db, row);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[paid_call] retain failed: ${reason}`);
    return false;
  }
}

export function listPaidCallRows(db: DatabaseSync, sinceIso?: string): PaidCallRow[] {
  const sql = sinceIso
    ? `SELECT ts, route, payer, tx, payment_intent, host, url_sha256, intent, verdict
       FROM paid_calls WHERE ts >= ? ORDER BY ts ASC`
    : `SELECT ts, route, payer, tx, payment_intent, host, url_sha256, intent, verdict
       FROM paid_calls ORDER BY ts ASC`;
  const stmt = db.prepare(sql);
  const raw = (sinceIso ? stmt.all(sinceIso) : stmt.all()) as Array<{
    ts: string;
    route: string;
    payer: string | null;
    tx: string | null;
    payment_intent: string | null;
    host: string;
    url_sha256: string;
    intent: string | null;
    verdict: string | null;
  }>;
  const rows: PaidCallRow[] = [];
  for (const item of raw) {
    if (item.route !== "verify" && item.route !== "confirm") continue;
    const row: PaidCallRow = {
      ts: item.ts,
      route: item.route,
      host: item.host,
      url_sha256: item.url_sha256,
    };
    if (item.payer) row.payer = item.payer;
    if (item.tx) row.tx = item.tx;
    if (item.payment_intent) row.payment_intent = item.payment_intent;
    const intent = sanitizeConfirmIntent(item.intent);
    const verdict = sanitizeConfirmVerdict(item.verdict);
    if (intent) row.intent = intent;
    if (verdict) row.verdict = verdict;
    rows.push(row);
  }
  return rows;
}

export function queryRetentionWindows(db: DatabaseSync, now = new Date()): RetentionWindows {
  return {
    l7d: queryWindow(db, isoCutoff(now, 7)),
    l30d: queryWindow(db, isoCutoff(now, 30)),
  };
}

function queryWindow(db: DatabaseSync, sinceIso: string): WindowCounts {
  const out = emptyWindowCounts();
  const rows = db
    .prepare(
      `SELECT route,
              COUNT(*) AS calls,
              COUNT(DISTINCT payer) AS unique_payers
       FROM paid_calls
       WHERE ts >= ?
       GROUP BY route`,
    )
    .all(sinceIso) as Array<{ route: string; calls: number | bigint; unique_payers: number | bigint }>;
  for (const row of rows) {
    if (row.route !== "verify" && row.route !== "confirm") continue;
    out[row.route] = {
      calls: Number(row.calls),
      unique_payers: Number(row.unique_payers),
    };
  }
  return out;
}

export function queryRetentionWindowsFromStore(now = new Date()): RetentionWindows | undefined {
  if (!state?.ok) return undefined;
  return queryRetentionWindows(state.db, now);
}

export function queryConfirmIntentCounts(db: DatabaseSync, sinceIso: string): ConfirmIntentCounts {
  const out = emptyConfirmIntentCounts();
  const rows = db
    .prepare(
      `SELECT intent, COUNT(*) AS n
       FROM paid_calls
       WHERE route = 'confirm' AND ts >= ?
       GROUP BY intent`,
    )
    .all(sinceIso) as Array<{ intent: string | null; n: number | bigint }>;
  for (const row of rows) {
    const n = Number(row.n);
    const intent = sanitizeConfirmIntent(row.intent);
    if (intent) out[intent] += n;
    else out.unscoped += n;
  }
  return out;
}

export function queryConfirmIntentWindows(db: DatabaseSync, now = new Date()): ConfirmIntentWindows {
  return {
    l7d: queryConfirmIntentCounts(db, isoCutoff(now, 7)),
    l30d: queryConfirmIntentCounts(db, isoCutoff(now, 30)),
  };
}

export function queryConfirmIntentWindowsFromStore(now = new Date()): ConfirmIntentWindows | undefined {
  if (!state?.ok) return undefined;
  return queryConfirmIntentWindows(state.db, now);
}

export function aggregateConfirmIntentRows(rows: readonly PaidCallRow[], now = new Date()): ConfirmIntentWindows {
  return {
    l7d: aggregateConfirmSince(rows, isoCutoff(now, 7)),
    l30d: aggregateConfirmSince(rows, isoCutoff(now, 30)),
  };
}

function aggregateConfirmSince(rows: readonly PaidCallRow[], sinceIso: string): ConfirmIntentCounts {
  const out = emptyConfirmIntentCounts();
  for (const row of rows) {
    if (row.route !== "confirm" || row.ts < sinceIso) continue;
    if (row.intent) out[row.intent] += 1;
    else out.unscoped += 1;
  }
  return out;
}

/**
 * Apply intent/verdict from a log event onto matching paid_calls rows that
 * lack intent. Match is (ts, url_sha256, route=confirm) — no raw URL.
 * Returns how many rows were updated.
 */
export function backfillPaidCallIntentFromEvent(db: DatabaseSync, event: PaidCallEvent): number {
  if (event.route !== "confirm") return 0;
  const intent = sanitizeConfirmIntent(event.intent);
  const verdict = sanitizeConfirmVerdict(event.verdict);
  if (!intent) return 0;
  const url_sha256 = event.url_hash?.trim() ?? "";
  if (!isSha256Hex(url_sha256)) return 0;
  const result = db
    .prepare(
      `UPDATE paid_calls
       SET intent = ?, verdict = COALESCE(?, verdict)
       WHERE route = 'confirm' AND ts = ? AND url_sha256 = ? AND (intent IS NULL OR intent = '')`,
    )
    .run(intent, verdict ?? null, event.ts, url_sha256);
  return Number(result.changes);
}

export function listPaidCallRowsFromStore(sinceIso?: string): PaidCallRow[] {
  if (!state?.ok) return [];
  return listPaidCallRows(state.db, sinceIso);
}

/** Pull a livecheck.paid_call JSON object out of a raw or fly-prefixed line. */
export function parsePaidCallLogLine(line: string): PaidCallEvent | undefined {
  const start = line.indexOf("{");
  if (start < 0) return undefined;
  const sliced = line.slice(start);
  const candidates = [sliced];
  const end = sliced.lastIndexOf("}");
  if (end > 0) candidates.push(sliced.slice(0, end + 1));
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text) as Partial<PaidCallEvent>;
      if (parsed?.event !== PAID_CALL_EVENT) continue;
      if (parsed.route !== "verify" && parsed.route !== "confirm") continue;
      if (typeof parsed.ts !== "string" || typeof parsed.url_hash !== "string") continue;
      return {
        event: PAID_CALL_EVENT,
        route: parsed.route,
        host: typeof parsed.host === "string" ? parsed.host : "",
        url_hash: parsed.url_hash,
        ts: parsed.ts,
        payer: parsed.payer,
        tx: parsed.tx,
        payment_intent: parsed.payment_intent,
        intent: parsed.intent,
        status: parsed.status,
        verdict: parsed.verdict,
      };
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

export function rowsFromLogText(text: string): PaidCallRow[] {
  const rows: PaidCallRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(PAID_CALL_EVENT)) continue;
    const event = parsePaidCallLogLine(line);
    if (!event) continue;
    const row = paidCallEventToRow(event);
    if (row) rows.push(row);
  }
  return rows;
}
