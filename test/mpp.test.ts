import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import type { MiddlewareHandler } from "hono";
import { Challenge, Credential, Errors, Method, Receipt, z } from "mppx";
import { Mppx } from "mppx/server";
import { createApp } from "../src/app.js";
import { hasPaymentAttempt } from "../src/check-capacity.js";
import { MOCK_PAY_TO, NETWORK } from "../src/config.js";
import {
  IDEMPOTENT_REPLAY_HEADER,
  MULTIPLE_CREDENTIALS_MESSAGE,
  POST_PAYMENT_UNKNOWN_SIGNAL,
  REFUND_CANDIDATE_EVENT,
  gatewayFromMppx,
  missingMppKeyNames,
  mppRouteForPath,
  payerFromCredentialSource,
  readMppKeys,
  withMppDispatch,
  type MppGateway,
} from "../src/mpp.js";
import { hasMppPaymentCredential, mppEnabled } from "../src/mpp-flags.js";
import {
  closePaidCallStore,
  initPaidCallStore,
  listPaidCallRowsFromStore,
  listRefundCandidatesFromStore,
} from "../src/paid-call-store.js";
import {
  applyPaymentGate,
  livePaymentMiddlewareFromServer,
  resourceServerFromFacilitator,
  withOptionalMpp,
} from "../src/payments.js";
import { decodePaymentRequired } from "../src/x402-payload.js";

const REALM = "livecheck.fly.dev";
const SECRET = "test-mpp-secret-key-at-least-32-bytes-long!!";
const PAYER = "0x2222222222222222222222222222222222222222";
const BAD_HASH = `0x${"dd".repeat(32)}`;

function stubFacilitator(): FacilitatorClient {
  return {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: ["bazaar"], signers: {} };
    },
    async verify() {
      return { isValid: false, invalidReason: "test-unpaid" };
    },
    async settle() {
      return { success: false, transaction: "", network: NETWORK };
    },
  };
}

function liveX402Gate(): MiddlewareHandler {
  return livePaymentMiddlewareFromServer(resourceServerFromFacilitator(stubFacilitator()), MOCK_PAY_TO);
}

/**
 * Real mppx (challenge HMAC, route binding, Authorization parsing, receipts)
 * with a stand-in Tempo method: verify accepts any hash once, so no chain or
 * Stripe call is made. `verifyCalls` counts every settle attempt.
 */
function fakeTempoGateway() {
  const used = new Set<string>();
  const state = { verifyCalls: 0, challenges: 0 };
  const method = Method.from({
    name: "tempo",
    intent: "charge",
    schema: {
      credential: { payload: z.object({ hash: z.string() }) },
      request: z.object({ amount: z.string() }),
    },
  });
  const server = Method.toServer(method, {
    async verify({ credential }) {
      state.verifyCalls += 1;
      const hash = (credential.payload as { hash: string }).hash;
      if (hash === BAD_HASH || used.has(hash)) {
        throw new Errors.VerificationFailedError({ reason: "rejected by test method" });
      }
      used.add(hash);
      return Receipt.from({ method: "tempo", reference: hash, status: "success", timestamp: new Date().toISOString() });
    },
  });
  const mppx = Mppx.create({ methods: [server], secretKey: SECRET, realm: REALM });
  const gateway = gatewayFromMppx(mppx as never);
  const counted: MppGateway = {
    ...gateway,
    async charge(route, request, scope) {
      if (!request.headers.get("authorization")) state.challenges += 1;
      return gateway.charge(route, request, scope);
    },
  };
  return { gateway: counted, state };
}

function credentialFor(res: Response, hash: string, source = `did:pkh:eip155:4217:${PAYER}`): string {
  const challenge = Challenge.fromResponse(res);
  return Credential.serialize(Credential.from({ challenge, payload: { type: "hash", hash }, source }));
}

function txHash(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

async function startApp(gate: MiddlewareHandler): Promise<{ origin: string; close: () => void }> {
  const app = createApp(gate);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ origin: `http://127.0.0.1:${info.port}`, close: () => server.close() });
    });
  });
}

function headerList(res: Response): Array<[string, string]> {
  return [...res.headers.entries()].filter(([name]) => name !== "date").sort();
}

describe("MPP flags and config", () => {
  it("MPP_ENABLED defaults off; only 1/true/on/yes turn it on", () => {
    assert.equal(mppEnabled({}), false);
    assert.equal(mppEnabled({ MPP_ENABLED: "0" }), false);
    assert.equal(mppEnabled({ MPP_ENABLED: "" }), false);
    assert.equal(mppEnabled({ MPP_ENABLED: "1" }), true);
    assert.equal(mppEnabled({ MPP_ENABLED: "true" }), true);
  });

  it("recognizes only the Payment auth scheme", () => {
    assert.equal(hasMppPaymentCredential("Payment eyJhYmMiOjF9"), true);
    assert.equal(hasMppPaymentCredential("Bearer abc, Payment eyJ"), true);
    assert.equal(hasMppPaymentCredential("Bearer abc"), false);
    assert.equal(hasMppPaymentCredential("Payment"), false);
    assert.equal(hasMppPaymentCredential(undefined), false);
  });

  it("MPP covers only the three verify routes", () => {
    assert.equal(mppRouteForPath("/v1/verify"), "verify");
    assert.equal(mppRouteForPath("/v1/verify/job/"), "verify/job");
    assert.equal(mppRouteForPath("/v1/verify/listing"), "verify/listing");
    for (const path of ["/v1/check", "/v1/confirm", "/v1/confirm/order", "/v1/watch", "/v1/watch/renew"]) {
      assert.equal(mppRouteForPath(path), undefined, path);
    }
  });

  it("missing keys are reported by name only, and a test key with a live profile is refused", () => {
    assert.deepEqual(missingMppKeyNames({}), [
      "MPP_STRIPE_SECRET_KEY",
      "STRIPE_PROFILE_ID",
      "TEMPO_DEPOSIT_ADDRESS",
      "MPP_SECRET_KEY",
    ]);
    const env = {
      MPP_STRIPE_SECRET_KEY: "rk_test_abc123",
      STRIPE_PROFILE_ID: "profile_live_x",
      TEMPO_DEPOSIT_ADDRESS: "0x1111111111111111111111111111111111111111",
      MPP_SECRET_KEY: SECRET,
    };
    assert.deepEqual(missingMppKeyNames(env), ["STRIPE_PROFILE_ID"]);
    const ok = readMppKeys({ ...env, STRIPE_PROFILE_ID: "profile_test_x" });
    assert.ok(ok);
    assert.equal(ok.livemode, false);
    assert.equal(ok.hostedFeePayer, false, "Stripe gas sponsorship is live-mode only");
    assert.equal(ok.stripeKeySource, "MPP_STRIPE_SECRET_KEY");
    const live = readMppKeys({
      STRIPE_SECRET_KEY: "sk_live_abc",
      STRIPE_PROFILE_ID: "profile_abc",
      TEMPO_DEPOSIT_ADDRESS: "0x1111111111111111111111111111111111111111",
      MPP_SECRET_KEY: SECRET,
    });
    assert.ok(live);
    assert.equal(live.livemode, true);
    assert.equal(live.hostedFeePayer, true);
    assert.equal(live.stripeKeySource, "STRIPE_SECRET_KEY");
    assert.equal(missingMppKeyNames({ ...env, STRIPE_PROFILE_ID: "profile_test_x", MPP_SECRET_KEY: "short" })[0], "MPP_SECRET_KEY");
  });

  it("payer comes from a did:pkh source, never from free text", () => {
    assert.equal(payerFromCredentialSource(`did:pkh:eip155:4217:${PAYER.toUpperCase().replace("0X", "0x")}`), PAYER);
    assert.equal(payerFromCredentialSource("did:pkh:solana:abc"), undefined);
    assert.equal(payerFromCredentialSource("someone@example.com"), undefined);
    assert.equal(payerFromCredentialSource(undefined), undefined);
  });

  it("hasPaymentAttempt counts Authorization: Payment only when MPP is on", () => {
    const ctx = (headers: Record<string, string>) =>
      ({ req: { header: (name: string) => headers[name.toLowerCase()] } }) as never;
    const prev = process.env.MPP_ENABLED;
    try {
      delete process.env.MPP_ENABLED;
      assert.equal(hasPaymentAttempt(ctx({ authorization: "Payment eyJ" })), false);
      process.env.MPP_ENABLED = "1";
      assert.equal(hasPaymentAttempt(ctx({ authorization: "Payment eyJ" })), true);
      assert.equal(hasPaymentAttempt(ctx({ authorization: "Bearer x" })), false);
      assert.equal(hasPaymentAttempt(ctx({ "payment-signature": "x" })), true);
    } finally {
      if (prev === undefined) delete process.env.MPP_ENABLED;
      else process.env.MPP_ENABLED = prev;
    }
  });
});

describe("MPP_ENABLED=0 is byte-identical to x402 only", () => {
  const prevPublic = process.env.LIVECHECK_PUBLIC_URL;
  const prevFly = process.env.FLY_APP_NAME;
  const servers: Array<{ origin: string; close: () => void }> = [];

  before(() => {
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    delete process.env.FLY_APP_NAME;
  });
  after(() => {
    for (const s of servers) s.close();
    if (prevPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
    else process.env.LIVECHECK_PUBLIC_URL = prevPublic;
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
  });

  it("returns the x402 gate object itself when the flag is off, unset, or keys are missing", () => {
    const gate = liveX402Gate();
    assert.equal(withOptionalMpp(gate, {}), gate);
    assert.equal(withOptionalMpp(gate, { MPP_ENABLED: "0" }), gate);
    assert.equal(withOptionalMpp(gate, { MPP_ENABLED: "1" }), gate, "missing keys: x402 only");
  });

  it("402s, mock-paid 200s and both-credential requests match x402 only byte for byte", async () => {
    const plain = await startApp(liveX402Gate());
    const flagged = await startApp(withOptionalMpp(liveX402Gate(), { MPP_ENABLED: "0" }));
    servers.push(plain, flagged);
    const cases: Array<{ path: string; body: string; headers?: Record<string, string> }> = [
      { path: "/v1/verify", body: JSON.stringify({ url: "https://example.com/job" }) },
      { path: "/v1/verify/job", body: "{}" },
      { path: "/v1/verify/listing", body: "not json" },
      { path: "/v1/check", body: JSON.stringify({ url: "https://example.com" }) },
      {
        path: "/v1/verify",
        body: JSON.stringify({ url: "https://example.com/job" }),
        headers: { authorization: "Payment eyJub3QiOiJyZWFsIn0" },
      },
    ];
    for (const item of cases) {
      const init = (origin: string) =>
        fetch(`${origin}${item.path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(item.headers ?? {}) },
          body: item.body,
        });
      const [a, b] = await Promise.all([init(plain.origin), init(flagged.origin)]);
      assert.equal(b.status, a.status, item.path);
      assert.deepEqual(headerList(b), headerList(a), item.path);
      assert.equal(await b.text(), await a.text(), item.path);
      assert.equal(b.headers.get("www-authenticate"), null);
    }
  });

  it("applyPaymentGate with MPP unset is the plain x402 gate (health has no mpp field)", async () => {
    const prev = process.env.MPP_ENABLED;
    delete process.env.MPP_ENABLED;
    try {
      const app = await startApp(applyPaymentGate());
      servers.push(app);
      const health = (await (await fetch(`${app.origin}/health`)).json()) as Record<string, unknown>;
      assert.equal("mpp" in health, false);
    } finally {
      if (prev !== undefined) process.env.MPP_ENABLED = prev;
    }
  });
});

describe("MPP dispatcher on the verify routes (real mppx, stand-in Tempo method)", () => {
  const prevPublic = process.env.LIVECHECK_PUBLIC_URL;
  const prevFly = process.env.FLY_APP_NAME;
  const dir = mkdtempSync(join(tmpdir(), "lc-mpp-"));
  const lines: string[] = [];
  let mpp: { origin: string; close: () => void };
  let x402Only: { origin: string; close: () => void };
  let fake: ReturnType<typeof fakeTempoGateway>;

  before(async () => {
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    delete process.env.FLY_APP_NAME;
    initPaidCallStore(join(dir, "paid-calls.sqlite"));
    fake = fakeTempoGateway();
    mpp = await startApp(withMppDispatch(liveX402Gate(), fake.gateway, { writer: (line) => lines.push(line) }));
    x402Only = await startApp(liveX402Gate());
  });

  after(() => {
    mpp.close();
    x402Only.close();
    closePaidCallStore();
    rmSync(dir, { recursive: true, force: true });
    if (prevPublic === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
    else process.env.LIVECHECK_PUBLIC_URL = prevPublic;
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
  });

  const post = (origin: string, path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("a valid unpaid request gets the unchanged x402 402 plus one WWW-Authenticate: Payment challenge", async () => {
    for (const path of ["/v1/verify", "/v1/verify/job", "/v1/verify/listing"]) {
      const body = JSON.stringify({ url: "https://example.com/careers/123" });
      const [withMpp, plain] = await Promise.all([post(mpp.origin, path, body), post(x402Only.origin, path, body)]);
      assert.equal(withMpp.status, 402);
      // x402 untouched: same header (decoded) and same mirrored body.
      assert.equal(withMpp.headers.get("payment-required"), plain.headers.get("payment-required"));
      assert.equal(await withMpp.clone().text(), await plain.text());
      assert.equal(withMpp.headers.get("content-type"), plain.headers.get("content-type"));
      const challenge = Challenge.fromResponse(withMpp);
      assert.equal(challenge.method, "tempo");
      assert.equal(challenge.intent, "charge");
      assert.equal(challenge.realm, REALM);
      assert.equal((challenge.request as { amount: string }).amount, "0.01");
      const decoded = decodePaymentRequired(withMpp.headers.get("payment-required") ?? "");
      const resourceUrl = (decoded.resource as { url: string }).url;
      assert.equal(resourceUrl, `https://livecheck.fly.dev${path}`);
      assert.match(Buffer.from(challenge.opaque ?? "", "base64url").toString("utf8"), new RegExp(resourceUrl.replace(/[/.]/g, "\\$&")));
      assert.ok(withMpp.headers.get("cache-control")?.includes("no-store"));
    }
  });

  it("empty, bodyless and invalid probes get the same x402 402 plus the MPP challenge, and nothing settles", async () => {
    const before = fake.state.verifyCalls;
    const probes: Array<{ body?: string; headers: Record<string, string> }> = [
      { headers: {} },
      { body: "", headers: { "content-type": "application/json" } },
      { body: "{}", headers: { "content-type": "application/json" } },
      { body: "not json", headers: { "content-type": "application/json" } },
      { body: JSON.stringify({ url: "ftp://example.com/x" }), headers: { "content-type": "application/json" } },
    ];
    for (const probe of probes) {
      const init = (origin: string) =>
        fetch(`${origin}/v1/verify/job`, { method: "POST", headers: probe.headers, ...(probe.body !== undefined ? { body: probe.body } : {}) });
      const [withMpp, plain] = await Promise.all([init(mpp.origin), init(x402Only.origin)]);
      assert.equal(withMpp.status, 402, JSON.stringify(probe));
      assert.equal(plain.status, 402);
      assert.equal(withMpp.headers.get("payment-required"), plain.headers.get("payment-required"));
      assert.equal(await withMpp.clone().text(), await plain.text());
      const challenge = Challenge.fromResponse(withMpp);
      assert.equal(challenge.method, "tempo");
      assert.equal(plain.headers.get("www-authenticate"), null);
    }
    assert.equal(fake.state.verifyCalls, before, "a challenge never settles anything");
  });

  it("non-verify paid routes are x402 only", async () => {
    const body = JSON.stringify({ url: "https://example.com", condition: { detector: "status_change" } });
    const [withMpp, plain] = await Promise.all([post(mpp.origin, "/v1/check", body), post(x402Only.origin, "/v1/check", body)]);
    assert.equal(withMpp.status, plain.status);
    assert.equal(withMpp.headers.get("www-authenticate"), null);
    assert.deepEqual(headerList(withMpp), headerList(plain));
  });

  it("both an x402 and an MPP credential on one request is a 400 and nothing is charged", async () => {
    const verifyBefore = fake.state.verifyCalls;
    const rowsBefore = listPaidCallRowsFromStore().length;
    const res = await post(mpp.origin, "/v1/verify", JSON.stringify({ url: "https://example.com/a" }), {
      "payment-signature": "anything",
      authorization: "Payment eyJ4IjoxfQ",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "multiple_payment_credentials");
    assert.equal(body.message, MULTIPLE_CREDENTIALS_MESSAGE);
    assert.equal(fake.state.verifyCalls, verifyBefore);
    assert.equal(listPaidCallRowsFromStore().length, rowsBefore);
  });

  it("an MPP credential on an invalid request is a 400 and is never settled", async () => {
    const unpaid = await post(mpp.origin, "/v1/verify", JSON.stringify({ url: "https://example.com/b" }));
    const auth = credentialFor(unpaid, txHash(900));
    const verifyBefore = fake.state.verifyCalls;
    for (const body of ["{}", "nope", JSON.stringify({ url: "javascript:alert(1)" })]) {
      const res = await post(mpp.origin, "/v1/verify", body, { authorization: auth });
      assert.equal(res.status, 400, body);
      assert.equal(res.headers.get("www-authenticate"), null);
    }
    assert.equal(fake.state.verifyCalls, verifyBefore);
  });

  it("a paid MPP call returns the normal answer, a Payment-Receipt, and a paid_calls row with protocol mpp_tempo", async () => {
    const target = `${mpp.origin}/fixtures/live-apply-now`;
    const body = JSON.stringify({ url: target });
    const unpaid = await post(mpp.origin, "/v1/verify/job", body);
    const hash = txHash(1);
    const res = await post(mpp.origin, "/v1/verify/job", body, {
      authorization: credentialFor(unpaid, hash),
      "user-agent": "mpp-test-agent/1",
    });
    assert.equal(res.status, 200);
    const verdict = (await res.json()) as { status: string; route: string; watch?: unknown; url: string };
    assert.equal(verdict.status, "live");
    assert.equal(verdict.route, "verify/job");
    assert.ok(verdict.watch);
    const receipt = Receipt.fromResponse(res);
    assert.equal(receipt.reference, hash);
    assert.equal(res.headers.get("payment-required"), null);
    const row = listPaidCallRowsFromStore().find((r) => r.tx === hash);
    assert.ok(row, "paid_calls row written");
    assert.equal(row.protocol, "mpp_tempo");
    assert.equal(row.payer, PAYER);
    assert.equal(row.route, "verify/job");
    assert.equal(row.status, "live");
    assert.equal(row.user_agent, "mpp-test-agent/1");
    const logged = lines.filter((l) => l.includes(hash));
    assert.equal(logged.length, 0, "success writes no refund line");
  });

  it("a bad or wrong-route credential is a 402 with both challenges and no row", async () => {
    const body = JSON.stringify({ url: `${mpp.origin}/fixtures/live-apply-now` });
    const unpaid = await post(mpp.origin, "/v1/verify", body);
    const rowsBefore = listPaidCallRowsFromStore().length;
    const bad = await post(mpp.origin, "/v1/verify", body, { authorization: credentialFor(unpaid, BAD_HASH) });
    assert.equal(bad.status, 402);
    assert.ok(bad.headers.get("payment-required"), "x402 fallback header");
    assert.ok(bad.headers.get("www-authenticate")?.startsWith("Payment "));
    // A /v1/verify challenge does not pay for /v1/verify/listing.
    const wrongRoute = await post(mpp.origin, "/v1/verify/listing", body, { authorization: credentialFor(unpaid, txHash(3)) });
    assert.equal(wrongRoute.status, 402);
    // A refused credential can be fixed and sent again (the claim is released).
    const fixed = await post(mpp.origin, "/v1/verify", body, { authorization: credentialFor(unpaid, txHash(5)) });
    assert.equal(fixed.status, 200);
    assert.equal(listPaidCallRowsFromStore().length, rowsBefore + 1);
  });

  it("a retry with the same credential returns the original answer and is never settled twice", async () => {
    const body = JSON.stringify({ url: `${mpp.origin}/fixtures/live-apply-now` });
    const unpaid = await post(mpp.origin, "/v1/verify", body);
    const hash = txHash(2);
    const auth = credentialFor(unpaid, hash);
    const first = await post(mpp.origin, "/v1/verify", body, { authorization: auth });
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const settles = fake.state.verifyCalls;
    const rows = listPaidCallRowsFromStore().length;

    const retry = await post(mpp.origin, "/v1/verify", body, { authorization: auth });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get(IDEMPOTENT_REPLAY_HEADER), "1");
    assert.equal(await retry.text(), firstBody, "byte-identical original answer");
    assert.equal(Receipt.fromResponse(retry).reference, hash);
    assert.equal(fake.state.verifyCalls, settles, "mppx not called again");
    assert.equal(listPaidCallRowsFromStore().length, rows, "no second paid_calls row");

    // Same tx wrapped in a NEW credential (fresh challenge): same answer, no settle.
    const unpaid2 = await post(mpp.origin, "/v1/verify", body);
    const sameTx = await post(mpp.origin, "/v1/verify", body, { authorization: credentialFor(unpaid2, hash) });
    assert.equal(sameTx.status, 200);
    assert.equal(sameTx.headers.get(IDEMPOTENT_REPLAY_HEADER), "1");
    assert.equal(fake.state.verifyCalls, settles);

    // Same credential for a different request: refused, not charged, no free check.
    const other = await post(mpp.origin, "/v1/verify", JSON.stringify({ url: `${mpp.origin}/fixtures/gone-404` }), {
      authorization: auth,
    });
    assert.equal(other.status, 409);
    assert.equal(((await other.json()) as { error: string }).error, "credential_already_used");
    assert.equal(fake.state.verifyCalls, settles);
    assert.equal(listPaidCallRowsFromStore().length, rows);
  });

  it("without the retry row (expired), mppx replay protection still refuses a reused tx: 402, no charge", async () => {
    const body = JSON.stringify({ url: `${mpp.origin}/fixtures/live-apply-now` });
    const unpaid = await post(mpp.origin, "/v1/verify", body);
    const hash = txHash(6);
    assert.equal((await post(mpp.origin, "/v1/verify", body, { authorization: credentialFor(unpaid, hash) })).status, 200);
    // A second dispatcher with an empty retry cache, same mppx store.
    const fresh = await startApp(withMppDispatch(liveX402Gate(), fake.gateway, { writer: () => undefined }));
    try {
      const rows = listPaidCallRowsFromStore().length;
      const res = await post(fresh.origin, "/v1/verify", body, { authorization: credentialFor(unpaid, hash) });
      assert.equal(res.status, 402);
      assert.equal(listPaidCallRowsFromStore().length, rows);
    } finally {
      fresh.close();
    }
  });

  it("two concurrent requests with one credential settle once: one answer, one 409 in progress", async () => {
    const body = JSON.stringify({ url: `${mpp.origin}/fixtures/live-apply-now` });
    const unpaid = await post(mpp.origin, "/v1/verify/job", body);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let charges = 0;
    const slow: MppGateway = {
      ...fake.gateway,
      async charge(route, request, scope) {
        if (request.headers.get("authorization")) {
          charges += 1;
          await gate;
        }
        return fake.gateway.charge(route, request, scope);
      },
    };
    const app = await startApp(withMppDispatch(liveX402Gate(), slow, { writer: () => undefined }));
    try {
      const auth = credentialFor(unpaid, txHash(7));
      const firstP = post(app.origin, "/v1/verify/job", body, { authorization: auth });
      await new Promise((r) => setTimeout(r, 50));
      const second = await post(app.origin, "/v1/verify/job", body, { authorization: auth });
      assert.equal(second.status, 409);
      assert.equal(((await second.json()) as { error: string }).error, "payment_in_progress");
      assert.equal(second.headers.get("retry-after"), "2");
      release();
      assert.equal((await firstP).status, 200);
      assert.equal(charges, 1);
      const third = await post(app.origin, "/v1/verify/job", body, { authorization: auth });
      assert.equal(third.status, 200);
      assert.equal(third.headers.get(IDEMPOTENT_REPLAY_HEADER), "1");
      assert.equal(charges, 1);
    } finally {
      release();
      app.close();
    }
  });

  it("after an MPP payment a handler error becomes 200 status unknown, with a refund candidate", async () => {
    const target = "http://127.0.0.1:1/unreachable-job";
    const body = JSON.stringify({ url: target });
    const unpaid = await post(mpp.origin, "/v1/verify/listing", body);
    const hash = txHash(4);
    const res = await post(mpp.origin, "/v1/verify/listing", body, { authorization: credentialFor(unpaid, hash) });
    assert.equal(res.status, 200);
    const verdict = (await res.json()) as Record<string, unknown>;
    assert.equal(verdict.status, "unknown");
    assert.equal(verdict.route, "verify/listing");
    assert.deepEqual(verdict.signals, [POST_PAYMENT_UNKNOWN_SIGNAL]);
    assert.equal(verdict.confidence, 0);
    assert.equal(verdict.url, target);
    assert.ok(verdict.watch);
    assert.equal(Receipt.fromResponse(res).reference, hash);

    const refundLine = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.payment_id === hash);
    assert.ok(refundLine, "refund candidate logged");
    assert.equal(refundLine.event, REFUND_CANDIDATE_EVENT);
    assert.equal(refundLine.protocol, "mpp_tempo");
    assert.equal(refundLine.route, "verify/listing");
    assert.equal(refundLine.reason, "handler_status_502");
    assert.match(String(refundLine.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(JSON.stringify(refundLine).includes("unreachable-job"), false, "no target URL in the refund line");

    const stored = listRefundCandidatesFromStore().find((r) => r.payment_id === hash);
    assert.ok(stored);
    assert.equal(stored.reason, "handler_status_502");
    assert.equal(stored.payer, PAYER);
    const row = listPaidCallRowsFromStore().find((r) => r.tx === hash);
    assert.ok(row, "the payment still counts as a paid call");
    assert.equal(row.status, "unknown");
    assert.equal(row.protocol, "mpp_tempo");
  });

  it("settle throws: 503 payment_unconfirmed + refund candidate; retries re-check the same payment and never charge twice", async () => {
    const out: string[] = [];
    const mode = { value: "throw" as "throw" | "pass" | "refuse" };
    let settleAttempts = 0;
    const flaky: MppGateway = {
      ...fake.gateway,
      async charge(route, request, scope) {
        if (request.headers.get("authorization")) {
          settleAttempts += 1;
          if (mode.value === "throw") throw new Error("rpc timeout");
          if (mode.value === "refuse") return fake.gateway.charge(route, new Request(request.url, { headers: { authorization: "Payment e30" } }), scope);
        }
        return fake.gateway.charge(route, request, scope);
      },
    };
    const app = await startApp(withMppDispatch(liveX402Gate(), flaky, { writer: (line) => out.push(line) }));
    try {
      const body = JSON.stringify({ url: `${mpp.origin}/fixtures/live-apply-now` });
      const unpaid = await post(app.origin, "/v1/verify", body);
      const hash = txHash(8);
      const auth = credentialFor(unpaid, hash);
      const res = await post(app.origin, "/v1/verify", body, { authorization: auth });
      assert.equal(res.status, 503);
      const original = await res.text();
      assert.equal((JSON.parse(original) as { error: string }).error, "payment_unconfirmed");
      const lines = () => out.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.reason === "charge_outcome_unknown");
      assert.equal(lines().length, 1);
      assert.equal(lines()[0]?.payment_id, hash, "push-mode tx hash recorded for the refund lookup");
      assert.equal(lines()[0]?.route, "verify");

      // Retry while still failing: the same 503, no second refund line.
      const again = await post(app.origin, "/v1/verify", body, { authorization: auth });
      assert.equal(again.status, 503);
      assert.equal(await again.text(), original);
      assert.equal(lines().length, 1);

      // Retry where mppx refuses the credential: still the original 503, never a fresh 402.
      mode.value = "refuse";
      const refused = await post(app.origin, "/v1/verify", body, { authorization: auth });
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get("www-authenticate"), null);

      // Retry once settlement works: verification of the SAME payment, then the answer.
      mode.value = "pass";
      const rows = listPaidCallRowsFromStore().length;
      const ok = await post(app.origin, "/v1/verify", body, { authorization: auth });
      assert.equal(ok.status, 200);
      assert.equal(Receipt.fromResponse(ok).reference, hash);
      assert.equal(listPaidCallRowsFromStore().length, rows + 1);
      const attempts = settleAttempts;
      const after = await post(app.origin, "/v1/verify", body, { authorization: auth });
      assert.equal(after.status, 200);
      assert.equal(after.headers.get(IDEMPOTENT_REPLAY_HEADER), "1");
      assert.equal(settleAttempts, attempts, "done: never settled again");
      assert.equal(listPaidCallRowsFromStore().length, rows + 1);
    } finally {
      app.close();
    }
  });

  it("an x402 payment never reaches mppx (mock-paid x402 with MPP on)", async () => {
    const prev = process.env.MPP_ENABLED;
    delete process.env.MPP_ENABLED;
    const mockGate = applyPaymentGate();
    if (prev !== undefined) process.env.MPP_ENABLED = prev;
    const spy = { calls: 0 };
    const spyGateway: MppGateway = {
      protocol: "mpp_tempo",
      methods: ["tempo/charge"],
      async charge() {
        spy.calls += 1;
        throw new Error("must not be called");
      },
    };
    const app = await startApp(withMppDispatch(mockGate, spyGateway));
    try {
      const res = await post(app.origin, "/v1/verify", JSON.stringify({ url: `${mpp.origin}/fixtures/live-apply-now` }), {
        "payment-signature": "livecheck-dev",
      });
      assert.equal(res.status, 200);
      assert.equal(spy.calls, 0);
      const row = listPaidCallRowsFromStore().at(-1);
      assert.equal(row?.protocol, "x402");
    } finally {
      app.close();
    }
  });
});
