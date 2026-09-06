import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { LEAD_SUBMIT_INTENT } from "../src/confirm.js";
import {
  PAID_CALL_EVENT,
  buildPaidCallEvent,
  emitPaidCall,
  extractPayer,
  hashUrl,
  hostnameOnly,
  looksLikeEmail,
  paidCallLineContainsSensitive,
  rememberPaidCall,
  sanitizePayer,
  sanitizePaymentIntent,
  sanitizeTx,
  serializePaidCall,
  urlHostAndHash,
  withPaidCallContext,
} from "../src/paid-call.js";

const SENSITIVE_URL =
  "https://boards.greenhouse.io/northwind/jobs/1842?email=ada@example.com&token=secret-query";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("url hashing and host redaction", () => {
  it("hashes the full URL with query, not the host alone", () => {
    const hashed = hashUrl(SENSITIVE_URL);
    assert.equal(hashed, sha256(SENSITIVE_URL));
    assert.notEqual(hashed, sha256("https://boards.greenhouse.io"));
    assert.equal(hashed.length, 64);
    assert.match(hashed, /^[a-f0-9]{64}$/);
    assert.equal(hashed.includes("ada@example.com"), false);
    assert.equal(hashed.includes("secret-query"), false);
    assert.equal(hashed.includes("http"), false);
  });

  it("different query strings produce different hashes", () => {
    const a = hashUrl("https://example.com/job?email=a@example.com");
    const b = hashUrl("https://example.com/job?email=b@example.com");
    assert.notEqual(a, b);
  });

  it("returns hostname only — no userinfo, path, query, or port in the host field", () => {
    assert.equal(hostnameOnly(SENSITIVE_URL), "boards.greenhouse.io");
    assert.equal(hostnameOnly("https://user:pass@jobs.example.com:8443/apply?ref=1"), "jobs.example.com");
    assert.equal(hostnameOnly("http://127.0.0.1:43127/fixtures/live-apply-now"), "127.0.0.1");
    assert.equal(hostnameOnly("not-a-url"), "");
  });

  it("urlHostAndHash never echoes the raw URL", () => {
    const { host, url_hash } = urlHostAndHash(SENSITIVE_URL);
    assert.equal(host, "boards.greenhouse.io");
    assert.equal(url_hash, sha256(SENSITIVE_URL));
    assert.equal(JSON.stringify({ host, url_hash }).includes(SENSITIVE_URL), false);
    assert.equal(JSON.stringify({ host, url_hash }).includes("ada@example.com"), false);
  });
});

describe("payer / tx / payment_intent sanitizers", () => {
  it("accepts a wallet address and drops emails", () => {
    assert.equal(sanitizePayer("0x2222222222222222222222222222222222222222"), "0x2222222222222222222222222222222222222222");
    assert.equal(sanitizePayer("0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"), "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    assert.equal(sanitizePayer("ada@example.com"), undefined);
    assert.equal(sanitizePayer("not-an-address"), undefined);
    assert.equal(looksLikeEmail("ada@example.com"), true);
    assert.equal(looksLikeEmail("0x2222222222222222222222222222222222222222"), false);
  });

  it("extractPayer reads settle.payer or authorization.from and ignores emails", () => {
    assert.equal(
      extractPayer({ payer: "0x2222222222222222222222222222222222222222" }),
      "0x2222222222222222222222222222222222222222",
    );
    assert.equal(
      extractPayer(
        {},
        { payload: { authorization: { from: "0x3333333333333333333333333333333333333333" } } },
      ),
      "0x3333333333333333333333333333333333333333",
    );
    assert.equal(extractPayer({ payer: "ada@example.com" }), undefined);
    assert.equal(
      extractPayer({}, { payload: { authorization: { from: "payer@example.com" } } }),
      undefined,
    );
  });

  it("only keeps well-formed tx hashes and PaymentIntent ids", () => {
    const tx = `0x${"ab".repeat(32)}`;
    assert.equal(sanitizeTx(tx), tx);
    assert.equal(sanitizeTx("0xdead"), undefined);
    assert.equal(sanitizeTx("ada@example.com"), undefined);
    assert.equal(sanitizePaymentIntent("pi_3abcXYZ"), "pi_3abcXYZ");
    assert.equal(sanitizePaymentIntent("not_a_pi"), undefined);
    assert.equal(sanitizePaymentIntent("user@example.com"), undefined);
  });
});

describe("paid-call event builder redaction", () => {
  it("verify event is host + hash, never the raw URL or query", () => {
    const { host, url_hash } = urlHostAndHash(SENSITIVE_URL);
    const event = buildPaidCallEvent(
      { route: "verify", host, url_hash, status: "live" },
      {
        payer: "0x2222222222222222222222222222222222222222",
        tx: `0x${"11".repeat(32)}`,
        payment_intent: "pi_testPaidCall",
      },
      new Date("2026-09-06T20:34:00.000Z"),
    );
    const line = serializePaidCall(event);
    assert.equal(event.event, PAID_CALL_EVENT);
    assert.equal(event.route, "verify");
    assert.equal(event.status, "live");
    assert.equal(event.intent, undefined);
    assert.equal(event.verdict, undefined);
    assert.equal(event.host, "boards.greenhouse.io");
    assert.equal(event.url_hash, sha256(SENSITIVE_URL));
    assert.equal(event.payer, "0x2222222222222222222222222222222222222222");
    assert.equal(event.payment_intent, "pi_testPaidCall");
    assert.equal(event.ts, "2026-09-06T20:34:00Z");
    assert.deepEqual(paidCallLineContainsSensitive(line, SENSITIVE_URL), []);
    assert.equal(line.includes("?"), false);
    assert.equal(line.includes("ada@example.com"), false);
    assert.equal(line.includes("secret-query"), false);
    assert.equal(line.includes(SENSITIVE_URL), false);
    assert.equal(line.includes("/jobs/1842"), false);
    assert.match(line, /^\{"event":"livecheck\.paid_call"/);
  });

  it("confirm event includes intent and verdict, still redacts the URL", () => {
    const url = "https://example.com/thank-you?ref=ABC123&email=lead@example.com";
    const { host, url_hash } = urlHostAndHash(url);
    const event = buildPaidCallEvent(
      { route: "confirm", host, url_hash, intent: LEAD_SUBMIT_INTENT, verdict: "confirmed" },
      {},
      new Date("2026-09-06T20:34:01.000Z"),
    );
    const line = serializePaidCall(event);
    assert.equal(event.route, "confirm");
    assert.equal(event.intent, "lead_submit");
    assert.equal(event.verdict, "confirmed");
    assert.equal(event.status, undefined);
    assert.equal(event.host, "example.com");
    assert.deepEqual(paidCallLineContainsSensitive(line, url), []);
    assert.equal(line.includes("ABC123"), false);
    assert.equal(line.includes("lead@example.com"), false);
    assert.equal(line.includes("thank-you"), false);
  });

  it("drops email-shaped payer/tx/payment_intent instead of logging them", () => {
    const { host, url_hash } = urlHostAndHash("https://example.com/job");
    const event = buildPaidCallEvent(
      { route: "verify", host, url_hash, status: "closed" },
      { payer: "cfo@example.com", tx: "not-a-hash", payment_intent: "receipt@example.com" },
    );
    const line = serializePaidCall(event);
    assert.equal(event.payer, undefined);
    assert.equal(event.tx, undefined);
    assert.equal(event.payment_intent, undefined);
    assert.equal(line.includes("@example.com"), false);
    assert.equal(line.includes("cfo@"), false);
  });
});

describe("HTTP paid-call logs", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => close());

  function capturePaidCallLogs(run: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (text.includes("livecheck.paid_call")) lines.push(text);
    };
    return run().finally(() => {
      console.log = original;
    }).then(() => lines);
  }

  it("mock-paid verify emits one redacted livecheck.paid_call line", async () => {
    const target = `${origin}/fixtures/live-apply-now`;
    const lines = await capturePaidCallLogs(async () => {
      const res = await fetch(`${origin}/v1/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
        body: JSON.stringify({ url: target }),
      });
      assert.equal(res.status, 200);
    });
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]) as {
      event: string;
      route: string;
      status: string;
      host: string;
      url_hash: string;
    };
    assert.equal(event.event, PAID_CALL_EVENT);
    assert.equal(event.route, "verify");
    assert.equal(event.status, "live");
    assert.equal(event.host, "127.0.0.1");
    assert.equal(event.url_hash, hashUrl(target));
    assert.deepEqual(paidCallLineContainsSensitive(lines[0], target), []);
    assert.equal(lines[0].includes(target), false);
  });

  it("unpaid verify does not emit livecheck.paid_call", async () => {
    const lines = await capturePaidCallLogs(async () => {
      const res = await fetch(`${origin}/v1/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/jobs/1?email=ada@example.com" }),
      });
      assert.equal(res.status, 402);
    });
    assert.equal(lines.length, 0);
  });

  it("mock-paid confirm emits intent + verdict without the thank-you query", async () => {
    const target = `${origin}/fixtures/confirm/thank-you-id`;
    const lines = await capturePaidCallLogs(async () => {
      const res = await fetch(`${origin}/v1/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
        body: JSON.stringify({ url: target, intent: "lead_submit" }),
      });
      assert.equal(res.status, 200);
    });
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]) as {
      route: string;
      intent?: string;
      verdict?: string;
      host: string;
    };
    assert.equal(event.route, "confirm");
    assert.equal(event.intent, "lead_submit");
    assert.equal(event.verdict, "confirmed");
    assert.equal(event.host, "127.0.0.1");
    assert.deepEqual(paidCallLineContainsSensitive(lines[0], target), []);
  });
});

describe("paid-call ALS emit", () => {
  it("emits one JSON line from remembered fields + settlement", async () => {
    const lines: string[] = [];
    const middleware = withPaidCallContext();
    await middleware({} as never, async () => {
      rememberPaidCall({ route: "verify", url: SENSITIVE_URL, status: "unknown" });
      const event = emitPaidCall(
        { payer: "0x2222222222222222222222222222222222222222" },
        (line) => lines.push(line),
        new Date("2026-09-06T20:34:02.000Z"),
      );
      assert.ok(event);
      assert.equal(event.host, "boards.greenhouse.io");
      const again = emitPaidCall({}, (line) => lines.push(line));
      assert.equal(again, undefined);
    });
    assert.equal(lines.length, 1);
    assert.deepEqual(paidCallLineContainsSensitive(lines[0], SENSITIVE_URL), []);
    const parsed = JSON.parse(lines[0]) as { event: string; payer: string; status: string };
    assert.equal(parsed.event, "livecheck.paid_call");
    assert.equal(parsed.status, "unknown");
    assert.equal(parsed.payer, "0x2222222222222222222222222222222222222222");
  });
});
