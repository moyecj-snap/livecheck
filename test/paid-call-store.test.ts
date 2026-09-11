import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import {
  PAID_CALL_EVENT,
  buildPaidCallEvent,
  hashUrl,
  paidCallLineContainsSensitive,
  urlHostAndHash,
} from "../src/paid-call.js";
import {
  aggregatePaidCallRows,
  closePaidCallStore,
  initPaidCallStore,
  insertPaidCallRow,
  isoCutoff,
  listPaidCallRows,
  openPaidCallDb,
  paidCallEventToRow,
  parsePaidCallLogLine,
  queryConfirmIntentWindows,
  queryConfirmIntentWindowsFromStore,
  queryRetentionWindows,
  queryRetentionWindowsFromStore,
  listPaidCallRowsFromStore,
  retainPaidCall,
  rowContainsSensitive,
  rowsFromLogText,
  safeHost,
  backfillPaidCallIntentFromEvent,
  migratePaidCallStore,
  paidCallStoreTableColumns,
} from "../src/paid-call-store.js";

const execFileAsync = promisify(execFile);

const SENSITIVE_URL =
  "https://boards.greenhouse.io/northwind/jobs/1842?email=ada@example.com&token=secret-query";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const PAYER_A = "0x2222222222222222222222222222222222222222";
const PAYER_B = "0x3333333333333333333333333333333333333333";
const TX = `0x${"11".repeat(32)}`;

describe("paid-call row mapping redaction", () => {
  it("maps url_hash to url_sha256 and never copies the raw URL", () => {
    const { host, url_hash } = urlHostAndHash(SENSITIVE_URL);
    const event = buildPaidCallEvent(
      { route: "verify", host, url_hash, status: "live" },
      { payer: PAYER_A, tx: TX, payment_intent: "pi_retainTest" },
      new Date("2026-09-06T20:34:00.000Z"),
    );
    const row = paidCallEventToRow(event);
    assert.ok(row);
    assert.equal(row.host, "boards.greenhouse.io");
    assert.equal(row.url_sha256, sha256(SENSITIVE_URL));
    assert.equal(row.url_sha256, event.url_hash);
    assert.equal(row.payer, PAYER_A);
    assert.equal(row.tx, TX);
    assert.equal(row.payment_intent, "pi_retainTest");
    assert.equal("url" in row, false);
    assert.equal("url_hash" in row, false);
    assert.deepEqual(rowContainsSensitive(row, SENSITIVE_URL), []);
    assert.equal(JSON.stringify(row).includes(SENSITIVE_URL), false);
    assert.equal(JSON.stringify(row).includes("ada@example.com"), false);
    assert.equal(JSON.stringify(row).includes("secret-query"), false);
    assert.equal(JSON.stringify(row).includes("/jobs/1842"), false);
  });

  it("drops email-shaped payer and URL-shaped host", () => {
    const event = buildPaidCallEvent(
      {
        route: "confirm",
        host: "https://example.com/thank-you?email=lead@example.com",
        url_hash: hashUrl("https://example.com/thank-you?email=lead@example.com"),
        intent: "lead_submit",
        verdict: "confirmed",
      },
      { payer: "lead@example.com" },
    );
    const row = paidCallEventToRow(event);
    assert.ok(row);
    assert.equal(row.host, "");
    assert.equal(row.payer, undefined);
    assert.deepEqual(rowContainsSensitive(row, "https://example.com/thank-you?email=lead@example.com"), []);
  });

  it("rejects a non-sha256 url_hash so a raw URL cannot be stored", () => {
    assert.equal(
      paidCallEventToRow({
        event: PAID_CALL_EVENT,
        route: "verify",
        host: "example.com",
        url_hash: SENSITIVE_URL,
        ts: "2026-09-06T20:34:00Z",
      }),
      undefined,
    );
    assert.equal(safeHost("https://evil.example/path?q=1"), "");
    assert.equal(safeHost("user@example.com"), "");
    assert.equal(safeHost("boards.greenhouse.io"), "boards.greenhouse.io");
  });
});

describe("sqlite insert and L7d/L30d queries", () => {
  after(() => closePaidCallStore());

  it("inserts sanitized rows and counts calls + unique payers by route", () => {
    const opened = initPaidCallStore(":memory:");
    assert.equal(opened.ok, true);
    const now = new Date("2026-09-07T15:00:00.000Z");
    const hashVerify = hashUrl("https://example.com/job-a");
    const hashConfirm = hashUrl("https://example.com/thanks");

    const recentVerifyA = paidCallEventToRow(
      buildPaidCallEvent(
        { route: "verify", host: "example.com", url_hash: hashVerify, status: "live" },
        { payer: PAYER_A, tx: TX },
        new Date("2026-09-06T12:00:00.000Z"),
      ),
    );
    const recentVerifyB = paidCallEventToRow(
      buildPaidCallEvent(
        { route: "verify", host: "example.com", url_hash: hashVerify, status: "closed" },
        { payer: PAYER_B },
        new Date("2026-09-05T12:00:00.000Z"),
      ),
    );
    const recentConfirm = paidCallEventToRow(
      buildPaidCallEvent(
        {
          route: "confirm",
          host: "example.com",
          url_hash: hashConfirm,
          intent: "lead_submit",
          verdict: "confirmed",
        },
        { payer: PAYER_A, payment_intent: "pi_confirm1" },
        new Date("2026-09-06T18:00:00.000Z"),
      ),
    );
    const oldVerify = paidCallEventToRow(
      buildPaidCallEvent(
        { route: "verify", host: "example.com", url_hash: hashVerify, status: "unknown" },
        { payer: PAYER_A },
        new Date("2026-08-01T12:00:00.000Z"),
      ),
    );
    const mockNoPayer = paidCallEventToRow(
      buildPaidCallEvent(
        { route: "verify", host: "example.com", url_hash: hashVerify, status: "live" },
        {},
        new Date("2026-09-07T10:00:00.000Z"),
      ),
    );

    assert.ok(recentVerifyA && recentVerifyB && recentConfirm && oldVerify && mockNoPayer);
    assert.ok(opened.ok);
    insertPaidCallRow(opened.db, recentVerifyA);
    insertPaidCallRow(opened.db, recentVerifyB);
    insertPaidCallRow(opened.db, recentConfirm);
    insertPaidCallRow(opened.db, oldVerify);
    insertPaidCallRow(opened.db, mockNoPayer);

    const windows = queryRetentionWindows(opened.db, now);
    assert.equal(windows.l7d.verify.calls, 3);
    assert.equal(windows.l7d.verify.unique_payers, 2);
    assert.equal(windows.l7d.confirm.calls, 1);
    assert.equal(windows.l7d.confirm.unique_payers, 1);
    const intents = queryConfirmIntentWindows(opened.db, now);
    assert.equal(intents.l7d.lead_submit, 1);
    assert.equal(intents.l7d.unscoped, 0);
    assert.equal(windows.l30d.verify.calls, 3);
    assert.equal(windows.l30d.verify.unique_payers, 2);
    assert.equal(windows.l30d.confirm.calls, 1);

    const listed = listPaidCallRows(opened.db, isoCutoff(now, 7));
    assert.equal(listed.length, 4);
    const hashes = new Set(listed.map((row) => row.url_sha256));
    assert.equal(hashes.has(hashVerify), true);
    assert.equal(hashes.has(hashConfirm), true);
    for (const row of listed) {
      assert.deepEqual(rowContainsSensitive(row, "https://example.com/job-a"), []);
      assert.match(row.url_sha256, /^[a-f0-9]{64}$/);
    }

    const fromMemory = aggregatePaidCallRows(listPaidCallRows(opened.db), now);
    assert.deepEqual(fromMemory, windows);
  });

  it("retainPaidCall is a no-op until the store is opened, then inserts", () => {
    closePaidCallStore();
    const event = buildPaidCallEvent(
      { route: "verify", host: "example.com", url_hash: hashUrl("https://example.com/x"), status: "live" },
      { payer: PAYER_A },
    );
    assert.equal(retainPaidCall(event), false);
    initPaidCallStore(":memory:");
    assert.equal(retainPaidCall(event), true);
    const windows = queryRetentionWindowsFromStore(new Date("2026-09-07T15:00:00.000Z"));
    assert.ok(windows);
    assert.equal(windows.l7d.verify.calls, 1);
    assert.equal(windows.l7d.verify.unique_payers, 1);
  });
});

describe("fly-log interim parser", () => {
  it("extracts JSON from a fly-prefixed line and ignores non-events", () => {
    const { host, url_hash } = urlHostAndHash(SENSITIVE_URL);
    const event = buildPaidCallEvent(
      { route: "verify", host, url_hash, status: "live" },
      { payer: PAYER_A },
      new Date("2026-09-06T20:34:00.000Z"),
    );
    const flyLine = `2026-09-06T20:34:00Z app[9080123f] sjc [info]${JSON.stringify(event)}`;
    const parsed = parsePaidCallLogLine(flyLine);
    assert.ok(parsed);
    assert.equal(parsed.event, PAID_CALL_EVENT);
    assert.equal(parsed.host, "boards.greenhouse.io");
    assert.equal(parsed.url_hash, sha256(SENSITIVE_URL));
    const row = paidCallEventToRow(parsed);
    assert.ok(row);
    assert.deepEqual(rowContainsSensitive(row, SENSITIVE_URL), []);
    assert.equal(parsePaidCallLogLine("2026-09-06T20:34:00Z app[1] sjc [info]health ok"), undefined);
  });

  it("aggregates L7d/L30d from a mixed log export without leaking the URL", () => {
    const now = new Date("2026-09-07T15:00:00.000Z");
    const verifyHash = hashUrl(SENSITIVE_URL);
    const text = [
      `prefix ${JSON.stringify({
        event: PAID_CALL_EVENT,
        route: "verify",
        host: "boards.greenhouse.io",
        url_hash: verifyHash,
        payer: PAYER_A,
        ts: "2026-09-06T20:34:00Z",
      })}`,
      JSON.stringify({
        event: PAID_CALL_EVENT,
        route: "confirm",
        host: "example.com",
        url_hash: hashUrl("https://example.com/thanks"),
        payer: PAYER_A,
        ts: "2026-09-06T21:00:00Z",
      }),
      JSON.stringify({
        event: PAID_CALL_EVENT,
        route: "verify",
        host: "example.com",
        url_hash: verifyHash,
        payer: PAYER_B,
        ts: "2026-08-01T12:00:00Z",
      }),
      "not a paid call",
    ].join("\n");
    const rows = rowsFromLogText(text);
    assert.equal(rows.length, 3);
    const windows = aggregatePaidCallRows(rows, now);
    assert.equal(windows.l7d.verify.calls, 1);
    assert.equal(windows.l7d.verify.unique_payers, 1);
    assert.equal(windows.l7d.confirm.calls, 1);
    assert.equal(windows.l30d.verify.calls, 1);
    assert.equal(JSON.stringify(rows).includes(SENSITIVE_URL), false);
    assert.equal(JSON.stringify(rows).includes("ada@example.com"), false);
  });
});

describe("HTTP paid check writes a retained row", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    initPaidCallStore(":memory:");
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => {
    close();
    closePaidCallStore();
  });

  it("mock-paid verify emits the stable JSON line and inserts a redacted row", async () => {
    const target = `${origin}/fixtures/live-apply-now`;
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (text.includes("livecheck.paid_call")) lines.push(text);
    };
    try {
      const res = await fetch(`${origin}/v1/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
        body: JSON.stringify({ url: target }),
      });
      assert.equal(res.status, 200);
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\{"event":"livecheck\.paid_call"/);
    assert.deepEqual(paidCallLineContainsSensitive(lines[0], target), []);

    const windows = queryRetentionWindowsFromStore();
    assert.ok(windows);
    assert.equal(windows.l7d.verify.calls, 1);
    assert.equal(windows.l7d.verify.unique_payers, 0);
    const rows = listPaidCallRowsFromStore();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].route, "verify");
    assert.equal(rows[0].host, "127.0.0.1");
    assert.equal(rows[0].url_sha256, hashUrl(target));
    assert.equal(rows[0].payer, undefined);
    assert.deepEqual(rowContainsSensitive(rows[0], target), []);
    assert.equal(JSON.stringify(rows[0]).includes(target), false);
  });

  it("mock-paid confirm stores intent and verdict on the paid_calls row", async () => {
    const target = `${origin}/fixtures/confirm/thank-you-id`;
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: target, intent: "lead_submit" }),
    });
    assert.equal(res.status, 200);
    const rows = listPaidCallRowsFromStore();
    const confirm = rows.filter((row) => row.route === "confirm");
    assert.equal(confirm.length, 1);
    assert.equal(confirm[0].intent, "lead_submit");
    assert.equal(confirm[0].verdict, "confirmed");
    const scoped = queryConfirmIntentWindowsFromStore();
    assert.ok(scoped);
    assert.equal(scoped.l7d.lead_submit, 1);
    assert.equal(scoped.l7d.unscoped, 0);
  });
});

describe("CoS CLI", () => {
  it("prints L7d/L30d counts from a sqlite file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paid-call-cos-"));
    const dbPath = join(dir, "paid-calls.sqlite");
    const db = openPaidCallDb(dbPath);
    insertPaidCallRow(db, {
      ts: "2026-09-06T20:34:00Z",
      route: "verify",
      host: "example.com",
      url_sha256: hashUrl("https://example.com/job"),
      payer: PAYER_A,
    });
    insertPaidCallRow(db, {
      ts: "2026-09-06T21:00:00Z",
      route: "confirm",
      host: "example.com",
      url_sha256: hashUrl("https://example.com/thanks"),
      payer: PAYER_A,
    });
    db.close();

    const { stdout } = await execFileAsync("npx", ["tsx", "scripts/paid-call-cos.ts", "--db", dbPath, "--json"], {
      cwd: process.cwd(),
    });
    const report = JSON.parse(stdout) as {
      source: { kind: string; path: string };
      windows: { l7d: { verify: { calls: number; unique_payers: number }; confirm: { calls: number } } };
    };
    assert.equal(report.source.kind, "sqlite");
    assert.equal(report.source.path, dbPath);
    assert.equal(report.windows.l7d.verify.calls, 1);
    assert.equal(report.windows.l7d.verify.unique_payers, 1);
    assert.equal(report.windows.l7d.confirm.calls, 1);
    assert.equal(stdout.includes("https://example.com"), false);
    const withIntent = JSON.parse(stdout) as {
      confirm_intents: { l7d: { lead_submit: number; unscoped: number } };
      note: string;
    };
    assert.equal(withIntent.confirm_intents.l7d.unscoped, 1);
    assert.match(withIntent.note, /one volume/i);
  });

  it("prints --machines-help without touching sqlite", async () => {
    const { stdout } = await execFileAsync("npx", ["tsx", "scripts/paid-call-cos.ts", "--machines-help"], {
      cwd: process.cwd(),
    });
    assert.match(stdout, /fly machines list -a livecheck/);
    assert.match(stdout, /839744b76061e8/);
    assert.match(stdout, /860792be4622e8/);
    assert.match(stdout, /receipt:rescue/);
  });

  it("parses a log file via --from-logs --log-file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paid-call-logs-"));
    const logPath = join(dir, "export.txt");
    const event = buildPaidCallEvent(
      { route: "verify", host: "example.com", url_hash: hashUrl("https://example.com/job"), status: "live" },
      { payer: PAYER_B },
      new Date("2026-09-06T20:34:00.000Z"),
    );
    writeFileSync(logPath, `2026-09-06T20:34:00Z app[abc] sjc [info]${JSON.stringify(event)}\n`);
    const { stdout } = await execFileAsync(
      "npx",
      ["tsx", "scripts/paid-call-cos.ts", "--from-logs", "--log-file", logPath, "--json"],
      { cwd: process.cwd() },
    );
    const report = JSON.parse(stdout) as {
      source: { kind: string };
      windows: { l7d: { verify: { calls: number; unique_payers: number } } };
    };
    assert.equal(report.source.kind, "logs");
    assert.equal(report.windows.l7d.verify.calls, 1);
    assert.equal(report.windows.l7d.verify.unique_payers, 1);
  });
});

describe("paid_calls intent migrate and backfill", () => {
  after(() => closePaidCallStore());

  it("ALTERs intent/verdict onto a pre-intent paid_calls table", () => {
    const dir = mkdtempSync(join(tmpdir(), "paid-call-migrate-"));
    const path = join(dir, "paid-calls.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE paid_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        route TEXT NOT NULL,
        payer TEXT,
        tx TEXT,
        payment_intent TEXT,
        host TEXT NOT NULL,
        url_sha256 TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO paid_calls (ts, route, host, url_sha256) VALUES (?, ?, ?, ?)`,
    ).run("2026-09-10T18:00:00Z", "confirm", "example.com", hashUrl("https://example.com/thanks"));
    assert.equal(paidCallStoreTableColumns(db, "paid_calls").has("intent"), false);
    migratePaidCallStore(db);
    assert.equal(paidCallStoreTableColumns(db, "paid_calls").has("intent"), true);
    assert.equal(paidCallStoreTableColumns(db, "paid_calls").has("verdict"), true);
    const intents = queryConfirmIntentWindows(db, new Date("2026-09-11T19:00:00.000Z"));
    assert.equal(intents.l7d.unscoped, 1);
    assert.equal(intents.l7d.lead_submit, 0);
    db.close();
  });

  it("backfills intent from a matching log event and refuses a second write", () => {
    const opened = initPaidCallStore(":memory:");
    if (!opened.ok) throw new Error("paid_call store failed");
    const url_hash = hashUrl("https://example.com/thanks");
    insertPaidCallRow(opened.db, {
      ts: "2026-09-10T18:00:00Z",
      route: "confirm",
      host: "example.com",
      url_sha256: url_hash,
    });
    const event = buildPaidCallEvent(
      { route: "confirm", host: "example.com", url_hash, intent: "lead_submit", verdict: "unknown" },
      {},
      new Date("2026-09-10T18:00:00.000Z"),
    );
    assert.equal(backfillPaidCallIntentFromEvent(opened.db, event), 1);
    assert.equal(backfillPaidCallIntentFromEvent(opened.db, event), 0);
    const intents = queryConfirmIntentWindows(opened.db, new Date("2026-09-11T19:00:00.000Z"));
    assert.equal(intents.l7d.lead_submit, 1);
    assert.equal(intents.l7d.unscoped, 0);
    const rows = listPaidCallRows(opened.db);
    assert.equal(rows[0].intent, "lead_submit");
    assert.equal(rows[0].verdict, "unknown");
  });
});
