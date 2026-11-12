import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Transform } from "node:stream";
import { createGzip } from "node:zlib";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { readCappedBody } from "../src/capped-body.js";
import { MAX_BODY_BYTES } from "../src/config.js";
import { PAGE_TRUNCATED_EVENT, PAGE_TRUNCATED_SIGNAL, setPageTruncationWriterForTests } from "../src/page-truncation.js";
import { fetchPage, verifyUrl } from "../src/verify.js";

// Nov 12, 2026 (Craig): stop reading at 2 MB instead of downloading the whole
// page first. A real local HTTP server streams an oversized (or endless) page;
// the fetcher must stop near the cap, close the connection, and give the same
// verdict and truncation log line as before.

const HEAD = `<html><head><title>Big Jacket</title></head><body><h1>Big Jacket</h1><p>$120.00</p><button>Add to cart</button>`;
const FILLER = Buffer.from(`<p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(18)}</p>\n`);
const MB = 1024 * 1024;

/** Endless (limit=Infinity) or bounded HTML stream, generated on demand (no buffering on the server). */
function htmlStream(limitBytes: number): Readable {
  let sent = 0;
  let headSent = false;
  return new Readable({
    read() {
      if (sent >= limitBytes) return this.push(null);
      let chunk = headSent ? Buffer.concat(Array(64).fill(FILLER)) : Buffer.from(HEAD);
      headSent = true;
      if (sent + chunk.length > limitBytes) chunk = chunk.subarray(0, limitBytes - sent);
      sent += chunk.length;
      this.push(chunk);
    },
  });
}

type Stats = { wireBytes: number; generatedBytes: number; closed: boolean; finished: boolean };
let server: Server;
let base = "";
const stats = new Map<string, Stats>();

function counter(onBytes: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

function streamTo(res: ServerResponse, path: string, limit: number, gzip: boolean): void {
  const s: Stats = { wireBytes: 0, generatedBytes: 0, closed: false, finished: false };
  stats.set(path, s);
  res.on("close", () => {
    s.closed = true;
  });
  res.on("finish", () => {
    s.finished = true;
  });
  const source = htmlStream(limit).pipe(counter((n) => (s.generatedBytes += n)));
  const wire = gzip ? source.pipe(createGzip({ level: 6 })) : source;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(gzip ? { "content-encoding": "gzip" } : {}) });
  const out = wire.pipe(counter((n) => (s.wireBytes += n)));
  out.pipe(res);
  res.on("close", () => {
    source.destroy();
    out.destroy();
  });
}

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path.startsWith("/endless/")) return streamTo(res, path, Infinity, false);
    if (path.startsWith("/huge60/")) return streamTo(res, path, 60 * MB, false);
    if (path.startsWith("/gzip-endless/")) return streamTo(res, path, Infinity, true);
    if (path.startsWith("/small/")) return streamTo(res, path, 1_700_000, true);
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  setPageTruncationWriterForTests((line) => lines.push(line));
});
afterEach(() => setPageTruncationWriterForTests(null));

async function waitClosed(path: string): Promise<Stats> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const s = stats.get(path);
    if (s?.closed) return s;
    if (Date.now() > deadline) assert.fail(`server connection for ${path} still open`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function truncationLines(): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === PAGE_TRUNCATED_EVENT);
}

describe("streamed body cap: stop at 2 MB, never download the rest", () => {
  it("an endless page: fetchPage returns 2,000,000 bytes, flags truncated, and closes the connection", async () => {
    const path = "/endless/product/big-jacket-1";
    const heapBefore = process.memoryUsage().arrayBuffers;
    const page = await fetchPage(`${base}${path}`, fetch, { timeoutMs: 10_000 });
    assert.equal(page.truncated, true);
    assert.equal(Buffer.byteLength(page.html), MAX_BODY_BYTES);
    const s = await waitClosed(path);
    assert.equal(s.finished, false, "server never finished sending");
    // Bytes pulled from the source: the cap plus socket/stream buffers, nowhere near "everything".
    assert.ok(s.generatedBytes < MAX_BODY_BYTES + 8 * MB, `server generated ${s.generatedBytes} bytes`);
    const grown = process.memoryUsage().arrayBuffers - heapBefore;
    assert.ok(grown < 32 * MB, `arrayBuffers grew ${grown} bytes`);
  });

  it("a 60 MB page: read stops near the cap; log line keeps its shape (domain only)", async () => {
    const path = "/huge60/product/big-jacket-2";
    const page = await fetchPage(`${base}${path}?email=buyer%40example.com`, fetch, { timeoutMs: 10_000 });
    assert.equal(page.truncated, true);
    const s = await waitClosed(path);
    assert.ok(s.generatedBytes < MAX_BODY_BYTES + 8 * MB, `server generated ${s.generatedBytes} of 60 MB`);
    const logged = truncationLines();
    assert.equal(logged.length, 1);
    assert.deepEqual(Object.keys(logged[0]).sort(), ["body_bytes", "domain", "event", "http_status", "limit_bytes", "ts"]);
    assert.equal(logged[0].domain, "127.0.0.1");
    assert.equal(logged[0].limit_bytes, MAX_BODY_BYTES);
    assert.equal(logged[0].http_status, 200);
    assert.ok((logged[0].body_bytes as number) > MAX_BODY_BYTES);
    assert.ok(!lines.join("").includes("buyer") && !lines.join("").includes("/product"));
  });

  it("verdict is unchanged: an endless live-looking page is can't tell (page_truncated), same as a 2.5 MB in-memory page", async () => {
    const path = "/endless/product/big-jacket-3";
    const streamed = await verifyUrl(`${base}${path}`, fetch, new Date("2026-11-12T19:40:00Z"));
    await waitClosed(path);
    const body = `${HEAD}${FILLER.toString().repeat(Math.ceil(2_500_000 / FILLER.length))}`;
    const inMemoryFetch: typeof fetch = async (input) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    };
    const buffered = await verifyUrl(`${base}${path}`, inMemoryFetch, new Date("2026-11-12T19:40:00Z"));
    assert.equal(streamed.status, "unknown");
    assert.ok(streamed.signals.includes(PAGE_TRUNCATED_SIGNAL));
    assert.equal(streamed.status, buffered.status);
    assert.deepEqual(streamed.signals, buffered.signals);
    assert.equal(streamed.confidence, buffered.confidence);
    assert.equal(truncationLines().length, 2);
  });

  it("gzip: the cap is on decoded bytes and the compressed download stops too", async () => {
    const path = "/gzip-endless/product/big-jacket-4";
    const page = await fetchPage(`${base}${path}`, fetch, { timeoutMs: 10_000 });
    assert.equal(page.truncated, true);
    assert.equal(Buffer.byteLength(page.html), MAX_BODY_BYTES);
    assert.ok(page.html.startsWith("<html><head><title>Big Jacket"), "decoded, not gzip bytes");
    const s = await waitClosed(path);
    assert.equal(s.finished, false);
    assert.ok(s.generatedBytes < MAX_BODY_BYTES + 64 * MB, `generated ${s.generatedBytes} decoded bytes`);
    assert.ok(s.wireBytes < 8 * MB, `sent ${s.wireBytes} compressed bytes`);
  });

  it("gzip page under the cap (1.7 MB decoded) is read in full, not truncated, not logged", async () => {
    const page = await fetchPage(`${base}/small/product/big-jacket-5`, fetch, { timeoutMs: 10_000 });
    assert.equal(page.truncated, undefined);
    assert.equal(Buffer.byteLength(page.html), 1_700_000);
    assert.equal(truncationLines().length, 0);
  });

  it("readCappedBody pulls at most one chunk past the cap from a stream that never ends, then cancels it", async () => {
    let pulled = 0;
    let cancelled = false;
    let stopped = false;
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const out = await readCappedBody(new Response(stream), MAX_BODY_BYTES, () => (stopped = true));
    assert.equal(out.truncated, true);
    assert.equal(out.bytes.byteLength, MAX_BODY_BYTES);
    assert.ok(out.received <= MAX_BODY_BYTES + chunk.byteLength);
    assert.ok(pulled <= MAX_BODY_BYTES + 2 * chunk.byteLength, `pulled ${pulled}`);
    assert.ok(cancelled && stopped);
  });

  it("a body of exactly the cap is not truncated", async () => {
    const out = await readCappedBody(new Response(new Uint8Array(MAX_BODY_BYTES).fill(98)), MAX_BODY_BYTES);
    assert.equal(out.truncated, false);
    assert.equal(out.bytes.byteLength, MAX_BODY_BYTES);
  });
});
