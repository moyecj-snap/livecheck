import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PAID_CALL_EVENT,
  PAID_CALL_ROUTES,
  isConfirmPaidRoute,
  isPaidCallRoute,
  isVerifyPaidRoute,
  looksLikeEmail,
  sanitizeHttpStatus,
  sanitizePayer,
  sanitizePaymentIntent,
  sanitizeTx,
  sanitizeUserAgent,
  sanitizeVerifyStatus,
  type PaidCallEvent,
  type PaidCallRoute,
  type VerifyPaidStatus,
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
  /**
   * Target domain (hostname only). Same fact as the brief's "target domain".
   * Never a raw URL, path, query, or userinfo.
   */
  host: string;
  url_sha256: string;
  /** Confirm only. Absent on verify rows and on pre-intent-column history. */
  intent?: ConfirmPaidIntent;
  /** Confirm product verdict. Absent on verify rows. */
  verdict?: ConfirmPaidVerdict;
  /**
   * Verify product verdict (`live` | `closed` | `unknown`).
   * Absent on confirm rows and on rows written before this column.
   */
  status?: VerifyPaidStatus;
  /**
   * HTTP status of the fetched target page. Not Livecheck's response code
   * (a row is written only when that response is about to be 200).
   */
  http_status?: number;
  /** Caller User-Agent, truncated, with emails and query strings removed. */
  user_agent?: string;
};

export type RouteCounts = {
  calls: number;
  /**
   * COUNT(DISTINCT payer) on one SQLite file. Null payers are not counted.
   * Null here means the count was withheld (emergency fleet sum). Never a
   * sum of per-volume distincts.
   */
  unique_payers: number | null;
};

/** Per stored route. Keys match `paid_calls.route`, not the family rollup. */
export type PaidRouteCounts = Record<PaidCallRoute, RouteCounts>;

export type WindowCounts = {
  /** Family rollup: `verify` + `verify/job` + `verify/listing`. */
  verify: RouteCounts;
  /** Family rollup: `confirm` + `confirm/order`. */
  confirm: RouteCounts;
  /** Calls and distinct payers for each stored route. */
  routes: PaidRouteCounts;
};

export type RetentionWindows = {
  l7d: WindowCounts;
  l30d: WindowCounts;
};

/** Per-intent confirm-family counts. `unscoped` = `confirm` or `confirm/order` with no stored intent. */
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

/** CHECK list. SQLite will not change this on an existing table; see rebuildPaidCallsRouteCheck. */
export const PAID_CALL_ROUTE_CHECK = `route IN ('verify', 'verify/job', 'verify/listing', 'confirm', 'confirm/order')`;

const PAID_CALLS_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  route TEXT NOT NULL CHECK (${PAID_CALL_ROUTE_CHECK}),
  payer TEXT,
  tx TEXT,
  payment_intent TEXT,
  host TEXT NOT NULL,
  url_sha256 TEXT NOT NULL,
  intent TEXT,
  verdict TEXT,
  http_status INTEGER,
  user_agent TEXT,
  status TEXT
`;

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS paid_calls (
${PAID_CALLS_COLUMNS}
);
`;

const ROUTE_REBUILD_TABLE = "paid_calls_route_v2";

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

export function emptyRouteCounts(): PaidRouteCounts {
  return {
    verify: { calls: 0, unique_payers: 0 },
    "verify/job": { calls: 0, unique_payers: 0 },
    "verify/listing": { calls: 0, unique_payers: 0 },
    confirm: { calls: 0, unique_payers: 0 },
    "confirm/order": { calls: 0, unique_payers: 0 },
  };
}

export function emptyWindowCounts(): WindowCounts {
  return {
    verify: { calls: 0, unique_payers: 0 },
    confirm: { calls: 0, unique_payers: 0 },
    routes: emptyRouteCounts(),
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

function paidCallsCreateSql(db: DatabaseSync): string | undefined {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paid_calls'`)
    .get() as { sql?: string } | undefined;
  return row?.sql;
}

/**
 * True when `paid_calls.route` already allows the specific aliases.
 * A missing table is not current — the caller creates it.
 */
export function paidCallsRouteCheckIsSpecific(sql: string | undefined): boolean {
  if (!sql) return false;
  return sql.includes("'verify/job'") && sql.includes("'verify/listing'") && sql.includes("'confirm/order'");
}

/**
 * SQLite cannot ALTER a CHECK. Copy rows into a new table whose CHECK lists
 * `verify`, `verify/job`, `verify/listing`, `confirm`, and `confirm/order`,
 * then rename it over `paid_calls`. Existing `verify` and `confirm` values
 * stay as stored (the alias was not known). Idempotent: a current CHECK is
 * left alone. A crashed rebuild drops the leftover `paid_calls_route_v2`.
 */
function rebuildPaidCallsRouteCheck(db: DatabaseSync): void {
  const sql = paidCallsCreateSql(db);
  if (!sql) {
    db.exec(TABLE_SQL);
    return;
  }
  if (paidCallsRouteCheckIsSpecific(sql)) return;

  const copyColumns = [
    "id",
    "ts",
    "route",
    "payer",
    "tx",
    "payment_intent",
    "host",
    "url_sha256",
    "intent",
    "verdict",
    "http_status",
    "user_agent",
    "status",
  ].filter((name) => paidCallStoreTableColumns(db, "paid_calls").has(name));
  const columnList = copyColumns.join(", ");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS ${ROUTE_REBUILD_TABLE};
      CREATE TABLE ${ROUTE_REBUILD_TABLE} (
      ${PAID_CALLS_COLUMNS}
      );
      INSERT INTO ${ROUTE_REBUILD_TABLE} (${columnList})
      SELECT ${columnList} FROM paid_calls;
      DROP TABLE paid_calls;
      ALTER TABLE ${ROUTE_REBUILD_TABLE} RENAME TO paid_calls;
      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failed script may already have rolled back.
    }
    throw error;
  }
  const sequence = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`)
    .get() as { name?: string } | undefined;
  if (sequence) {
    db.prepare(`UPDATE sqlite_sequence SET name = 'paid_calls' WHERE name = ?`).run(ROUTE_REBUILD_TABLE);
  }
}

/**
 * Idempotent upgrade. Safe on a fresh DB and on a volume whose paid_calls
 * table predates intent/verdict (those rows stay NULL = unscoped) or the
 * later http_status / user_agent / verify status columns (those stay NULL).
 * ALTER columns before any index that names them, then rebuild the route
 * CHECK if it still allows only verify|confirm.
 *
 * `host` is the target domain. Facilitator is not a column: the x402 settle
 * payload does not name one. Check and watch are not rows in this table.
 *
 * Never CREATE confirm_receipts here. Pre-26c702e bound receipts into this
 * file; rescue copies those rows into receipts.sqlite and drops the stray table.
 */
export function migratePaidCallStore(db: DatabaseSync): void {
  db.exec(TABLE_SQL);
  ensureColumn(db, "paid_calls", "intent", "intent TEXT");
  ensureColumn(db, "paid_calls", "verdict", "verdict TEXT");
  ensureColumn(db, "paid_calls", "http_status", "http_status INTEGER");
  ensureColumn(db, "paid_calls", "user_agent", "user_agent TEXT");
  ensureColumn(db, "paid_calls", "status", "status TEXT");
  rebuildPaidCallsRouteCheck(db);
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
  if (!isPaidCallRoute(event.route)) return undefined;
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
  if (isConfirmPaidRoute(event.route)) {
    const intent = sanitizeConfirmIntent(event.intent);
    const verdict = sanitizeConfirmVerdict(event.verdict);
    if (intent) row.intent = intent;
    if (verdict) row.verdict = verdict;
  }
  if (isVerifyPaidRoute(event.route)) {
    const status = sanitizeVerifyStatus(event.status);
    if (status) row.status = status;
  }
  const httpStatus = sanitizeHttpStatus(event.http_status);
  const userAgent = sanitizeUserAgent(event.user_agent);
  if (httpStatus !== undefined) row.http_status = httpStatus;
  if (userAgent) row.user_agent = userAgent;
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
  const payers = emptyPayerSets();
  const verifyFamily = new Set<string>();
  const confirmFamily = new Set<string>();
  for (const row of rows) {
    if (row.ts < sinceIso) continue;
    if (!isPaidCallRoute(row.route)) continue;
    out.routes[row.route].calls += 1;
    if (row.payer) payers[row.route].add(row.payer);
    if (isVerifyPaidRoute(row.route)) {
      out.verify.calls += 1;
      if (row.payer) verifyFamily.add(row.payer);
    } else if (isConfirmPaidRoute(row.route)) {
      out.confirm.calls += 1;
      if (row.payer) confirmFamily.add(row.payer);
    }
  }
  for (const route of PAID_CALL_ROUTES) {
    out.routes[route].unique_payers = payers[route].size;
  }
  out.verify.unique_payers = verifyFamily.size;
  out.confirm.unique_payers = confirmFamily.size;
  return out;
}

function emptyPayerSets(): Record<PaidCallRoute, Set<string>> {
  return {
    verify: new Set(),
    "verify/job": new Set(),
    "verify/listing": new Set(),
    confirm: new Set(),
    "confirm/order": new Set(),
  };
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
    status: row.status,
    http_status: row.http_status,
    user_agent: row.user_agent,
  });
  if (!mapped) {
    throw new Error("refusing to insert unsanitized paid_call row");
  }
  db.prepare(
    `INSERT INTO paid_calls (
       ts, route, payer, tx, payment_intent, host, url_sha256, intent, verdict, http_status, user_agent, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    mapped.http_status ?? null,
    mapped.user_agent ?? null,
    mapped.status ?? null,
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
  const columns =
    "ts, route, payer, tx, payment_intent, host, url_sha256, intent, verdict, http_status, user_agent, status";
  const sql = sinceIso
    ? `SELECT ${columns} FROM paid_calls WHERE ts >= ? ORDER BY ts ASC`
    : `SELECT ${columns} FROM paid_calls ORDER BY ts ASC`;
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
    http_status: number | bigint | null;
    user_agent: string | null;
    status: string | null;
  }>;
  const rows: PaidCallRow[] = [];
  for (const item of raw) {
    if (!isPaidCallRoute(item.route)) continue;
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
    if (isConfirmPaidRoute(item.route) && verdict) row.verdict = verdict;
    if (isVerifyPaidRoute(item.route)) {
      const status = sanitizeVerifyStatus(item.status);
      if (status) row.status = status;
    }
    const httpStatus = sanitizeHttpStatus(
      typeof item.http_status === "bigint" ? Number(item.http_status) : item.http_status,
    );
    const userAgent = sanitizeUserAgent(item.user_agent);
    if (httpStatus !== undefined) row.http_status = httpStatus;
    if (userAgent) row.user_agent = userAgent;
    rows.push(row);
  }
  return rows;
}

export function queryRetentionWindows(
  db: DatabaseSync,
  now = new Date(),
  excludePayers: readonly string[] = [],
): RetentionWindows {
  return {
    l7d: queryWindow(db, isoCutoff(now, 7), excludePayers),
    l30d: queryWindow(db, isoCutoff(now, 30), excludePayers),
  };
}

const VERIFY_FAMILY_SQL = `('verify', 'verify/job', 'verify/listing')`;
const CONFIRM_FAMILY_SQL = `('confirm', 'confirm/order')`;

function payerExcludeClause(exclude: readonly string[]): string {
  if (exclude.length === 0) return "";
  return ` AND (payer IS NULL OR lower(payer) NOT IN (${exclude.map(() => "?").join(", ")}))`;
}

function queryFamilyCounts(
  db: DatabaseSync,
  sinceIso: string,
  familySql: string,
  exclude: readonly string[],
): RouteCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COUNT(DISTINCT payer) AS unique_payers
       FROM paid_calls
       WHERE ts >= ? AND route IN ${familySql}${payerExcludeClause(exclude)}`,
    )
    .get(sinceIso, ...exclude) as { calls: number | bigint; unique_payers: number | bigint };
  return { calls: Number(row.calls), unique_payers: Number(row.unique_payers) };
}

function queryWindow(db: DatabaseSync, sinceIso: string, excludePayers: readonly string[] = []): WindowCounts {
  const out = emptyWindowCounts();
  const exclude = [...new Set(excludePayers.map((payer) => payer.toLowerCase()))];
  const rows = db
    .prepare(
      `SELECT route,
              COUNT(*) AS calls,
              COUNT(DISTINCT payer) AS unique_payers
       FROM paid_calls
       WHERE ts >= ?${payerExcludeClause(exclude)}
       GROUP BY route`,
    )
    .all(sinceIso, ...exclude) as Array<{ route: string; calls: number | bigint; unique_payers: number | bigint }>;
  for (const row of rows) {
    if (!isPaidCallRoute(row.route)) continue;
    out.routes[row.route] = {
      calls: Number(row.calls),
      unique_payers: Number(row.unique_payers),
    };
  }
  out.verify = queryFamilyCounts(db, sinceIso, VERIFY_FAMILY_SQL, exclude);
  out.confirm = queryFamilyCounts(db, sinceIso, CONFIRM_FAMILY_SQL, exclude);
  return out;
}

export function queryRetentionWindowsFromStore(
  now = new Date(),
  excludePayers: readonly string[] = [],
): RetentionWindows | undefined {
  if (!state?.ok) return undefined;
  return queryRetentionWindows(state.db, now, excludePayers);
}

export function queryConfirmIntentCounts(db: DatabaseSync, sinceIso: string): ConfirmIntentCounts {
  const out = emptyConfirmIntentCounts();
  const rows = db
    .prepare(
      `SELECT intent, COUNT(*) AS n
       FROM paid_calls
       WHERE route IN ('confirm', 'confirm/order') AND ts >= ?
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
    if (!isConfirmPaidRoute(row.route) || row.ts < sinceIso) continue;
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
  if (!isConfirmPaidRoute(event.route)) return 0;
  const intent = sanitizeConfirmIntent(event.intent);
  const verdict = sanitizeConfirmVerdict(event.verdict);
  if (!intent) return 0;
  const url_sha256 = event.url_hash?.trim() ?? "";
  if (!isSha256Hex(url_sha256)) return 0;
  const result = db
    .prepare(
      `UPDATE paid_calls
       SET intent = ?, verdict = COALESCE(?, verdict)
       WHERE route = ? AND ts = ? AND url_sha256 = ? AND (intent IS NULL OR intent = '')`,
    )
    .run(intent, verdict ?? null, event.route, event.ts, url_sha256);
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
      if (typeof parsed.route !== "string" || !isPaidCallRoute(parsed.route)) continue;
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
        http_status: parsed.http_status,
        user_agent: parsed.user_agent,
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
