import assert from "node:assert/strict";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.js";
import { FETCH_TIMEOUT_MS, NETWORK } from "../src/config.js";
import { PAID_CALL_EVENT } from "../src/paid-call.js";
import { livePaymentMiddlewareFromServer, resourceServerFromFacilitator } from "../src/payments.js";
import { decodePaymentRequired } from "../src/x402-payload.js";

const LIVE_HTML = "<!doctype html><title>Apply now</title><body><a href=\"/apply\">Apply now</a></body>";
const THANK_YOU_HTML =
  "<!doctype html><title>Thank you</title><body><p>Thank you. We have received your application. Confirmation ID ABC123.</p></body>";

type Listening = { origin: string; close: () => Promise<void> };

function listenHttp(server: Server): Promise<Listening> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected tcp address");
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, reject) => {
            server.close((error) => (error ? reject(error) : done()));
          }),
      });
    });
  });
}

function paymentSignature(accepted: unknown): string {
  const envelope = {
    x402Version: 2,
    accepted,
    payload: { signature: "test-sig" },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

async function readAccept(origin: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 402);
  const header = res.headers.get("payment-required");
  assert.ok(header, "unpaid 402 must still carry payment-required");
  const decoded = decodePaymentRequired(header);
  const accepts = decoded.accepts as Array<{ extra?: { paymentFlow?: string; name?: string; version?: string } }>;
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0]?.extra?.paymentFlow, undefined);
  assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
  return accepts[0];
}

describe("x402 settle timing (exact authorization flow)", () => {
  const events: string[] = [];
  let settleCalls = 0;
  const facilitator: FacilitatorClient = {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
        extensions: [],
        signers: {},
      };
    },
    async verify() {
      events.push("verify");
      return { isValid: true };
    },
    async settle() {
      settleCalls += 1;
      events.push("settle");
      return {
        success: true,
        transaction: "0xsettle",
        network: NETWORK,
        payer: "0x1111111111111111111111111111111111111111",
      };
    },
  };

  const previousPublic = process.env.LIVECHECK_PUBLIC_URL;
  process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
  const app = createApp(
    livePaymentMiddlewareFromServer(resourceServerFromFacilitator(facilitator), "0x2222222222222222222222222222222222222222"),
  );
  let origin = "";
  let closeApp: () => void = () => {};

  const pages = createServer((req, res) => {
    events.push(req.url === "/thanks" ? "confirm-fetch" : "verify-fetch");
    const html = req.url === "/thanks" ? THANK_YOU_HTML : LIVE_HTML;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  let pagesOrigin = "";
  let closePages: () => Promise<void> = async () => {};

  before(async () => {
    const listening = await listenHttp(pages);
    pagesOrigin = listening.origin;
    closePages = listening.close;
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        closeApp = () => server.close();
        resolve();
      });
    });
  });

  after(async () => {
    closeApp();
    await closePages();
    if (previousPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
    else process.env.LIVECHECK_PUBLIC_URL = previousPublic;
  });

  function reset() {
    events.length = 0;
    settleCalls = 0;
  }

  it("settles verify only after the page fetch, and only on success", async () => {
    reset();
    const accepted = await readAccept(origin, "/v1/verify", { url: `${pagesOrigin}/job` });
    assert.equal(settleCalls, 0);
    assert.equal(events.length, 0);

    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paymentSignature(accepted),
      },
      body: JSON.stringify({ url: `${pagesOrigin}/job` }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status?: string };
    assert.ok(body.status);
    assert.ok(res.headers.get("payment-response"), "successful paid response carries the settlement header");
    const verifyAt = events.indexOf("verify");
    const fetchAt = events.indexOf("verify-fetch");
    const settleAt = events.indexOf("settle");
    assert.ok(verifyAt >= 0 && fetchAt > verifyAt && settleAt > fetchAt);
    assert.equal(settleCalls, 1);
  });

  it("settles confirm only after the page fetch, and only on success", async () => {
    reset();
    const payload = { url: `${pagesOrigin}/thanks`, intent: "lead_submit" };
    const accepted = await readAccept(origin, "/v1/confirm", payload);
    assert.equal(settleCalls, 0);

    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paymentSignature(accepted),
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict?: string };
    assert.ok(body.verdict);
    assert.ok(res.headers.get("payment-response"));
    const verifyAt = events.indexOf("verify");
    const fetchAt = events.indexOf("confirm-fetch");
    const settleAt = events.indexOf("settle");
    assert.ok(verifyAt >= 0 && fetchAt > verifyAt && settleAt > fetchAt);
    assert.equal(settleCalls, 1);
  });

  it("does not settle a paid verify that returns 400", async () => {
    reset();
    const accepted = await readAccept(origin, "/v1/verify", { url: "https://example.com" });
    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paymentSignature(accepted),
      },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("payment-response"), null);
    assert.equal(events.includes("verify"), true);
    assert.equal(events.includes("settle"), false);
    assert.equal(settleCalls, 0);
  });

  it("does not settle when verify's fetch fails", async () => {
    reset();
    const resetServer = createNetServer((socket) => {
      socket.destroy();
    });
    const listening = await listenNet(resetServer);
    try {
      const target = `http://127.0.0.1:${listening.port}/down`;
      const accepted = await readAccept(origin, "/v1/verify", { url: target });
      const res = await fetch(`${origin}/v1/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": paymentSignature(accepted),
        },
        body: JSON.stringify({ url: target }),
      });
      assert.equal(res.status, 502);
      assert.equal(events.includes("verify"), true);
      assert.equal(events.includes("settle"), false);
      assert.equal(settleCalls, 0);
    } finally {
      await listening.close();
    }
  });

  it("does not settle when confirm's fetch fails", async () => {
    reset();
    const resetServer = createNetServer((socket) => {
      socket.destroy();
    });
    const listening = await listenNet(resetServer);
    try {
      const target = `http://127.0.0.1:${listening.port}/down`;
      const payload = { url: target, intent: "lead_submit" };
      const accepted = await readAccept(origin, "/v1/confirm", payload);
      const res = await fetch(`${origin}/v1/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": paymentSignature(accepted),
        },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 502);
      assert.equal(events.includes("settle"), false);
      assert.equal(settleCalls, 0);
    } finally {
      await listening.close();
    }
  });

  it("does not settle when the verify fetch times out", { timeout: FETCH_TIMEOUT_MS + 10_000 }, async () => {
    reset();
    const hung: Socket[] = [];
    const hang = createNetServer((socket) => {
      hung.push(socket);
    });
    const listening = await listenNet(hang);
    try {
      const target = `http://127.0.0.1:${listening.port}/slow`;
      const accepted = await readAccept(origin, "/v1/verify", { url: target });
      const started = Date.now();
      const res = await fetch(`${origin}/v1/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": paymentSignature(accepted),
        },
        body: JSON.stringify({ url: target }),
      });
      const body = (await res.json()) as { error?: string };
      assert.equal(res.status, 504);
      assert.match(body.error ?? "", /Timed out/);
      assert.ok(Date.now() - started >= FETCH_TIMEOUT_MS - 500);
      assert.equal(events.includes("verify"), true);
      assert.equal(events.includes("settle"), false);
      assert.equal(settleCalls, 0);
    } finally {
      for (const socket of hung) socket.destroy();
      await listening.close();
    }
  });

  it("does not settle when the caller disconnects before the handler finishes", async () => {
    reset();
    let release: ((html: string) => void) | undefined;
    const held = createServer((_req, res) => {
      release = (html) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      };
      events.push("verify-fetch");
    });
    const listening = await listenHttp(held);
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map((part) => String(part)).join(" ");
      if (line.includes(PAID_CALL_EVENT)) logs.push(line);
      original(...args);
    };
    try {
      const target = `${listening.origin}/held`;
      const accepted = await readAccept(origin, "/v1/verify", { url: target });
      reset();
      const controller = new AbortController();
      const pending = fetch(`${origin}/v1/verify`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "payment-signature": paymentSignature(accepted),
        },
        body: JSON.stringify({ url: target }),
      });
      const aborted = pending.then(
        () => {
          throw new Error("client request should abort");
        },
        (error: unknown) => {
          assert.equal(error instanceof Error ? error.name : "", "AbortError");
        },
      );
      await waitFor(() => events.includes("verify-fetch"));
      controller.abort();
      await aborted;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(release, "held page did not receive the verify fetch");
      release(LIVE_HTML);
      await waitFor(() => logs.length > 0 || settleCalls > 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(settleCalls, 0);
      assert.equal(events.includes("settle"), false);
      assert.equal(events.includes("verify"), true);
      assert.ok(logs.length > 0, "handler still finished the paid verify after the caller left");
    } finally {
      console.log = original;
      if (release) {
        try {
          release(LIVE_HTML);
        } catch {
          // response may already have been ended
        }
      }
      await listening.close();
    }
  });
});

function listenNet(server: NetServer): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected tcp address");
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, reject) => {
            server.close((error) => (error ? reject(error) : done()));
          }),
      });
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
