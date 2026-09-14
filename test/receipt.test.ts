import assert from "node:assert/strict";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { isCheckId, isConfirmId, isEventId, isReceiptId, isWatchId, isWatchRenewId, newCheckId, newConfirmId, newEventId, newWatchId, newWatchRenewId } from "../src/confirm-id.js";
import {
  canonicalizeReceiptPayload,
  generateReceiptPrivateKeyPem,
  livecheckKeysDocument,
  parseReceiptPrivateKey,
  resetReceiptSignerCache,
  sha256Hex,
  signCanonical,
  verifyCanonical,
  sealConfirmResultDetailed,
  type ReceiptCanonical,
} from "../src/receipt.js";

describe("confirm ids", () => {
  it("emits cfm_ + 26-char Crockford ULID", () => {
    const id = newConfirmId();
    assert.equal(isConfirmId(id), true);
    assert.match(id, /^cfm_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("emits chk_ + 26-char Crockford ULID for Sentinel checks", () => {
    const id = newCheckId();
    assert.equal(isCheckId(id), true);
    assert.equal(isConfirmId(id), false);
    assert.equal(isReceiptId(id), true);
    assert.match(id, /^chk_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("emits wtc_ + 26-char Crockford ULID for Sentinel watchers", () => {
    const id = newWatchId();
    assert.equal(isWatchId(id), true);
    assert.equal(isCheckId(id), false);
    assert.equal(isReceiptId(id), true);
    assert.match(id, /^wtc_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("emits wrn_ + 26-char Crockford ULID for watch renew receipts", () => {
    const id = newWatchRenewId();
    assert.equal(isWatchRenewId(id), true);
    assert.equal(isWatchId(id), false);
    assert.equal(isReceiptId(id), true);
    assert.match(id, /^wrn_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("emits evt_ + 26-char Crockford ULID for watch events", () => {
    const id = newEventId();
    assert.equal(isEventId(id), true);
    assert.equal(isWatchId(id), false);
    assert.equal(isReceiptId(id), true);
    assert.match(id, /^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("receipt signing unit", () => {
  it("round-trips Ed25519 over canonical payload", () => {
    const pem = generateReceiptPrivateKeyPem();
    const privateKey = parseReceiptPrivateKey(pem);
    const publicKey = createPublicKey(privateKey);
    const payload: ReceiptCanonical = {
      id: "cfm_01J8Z0K3N4P5Q6R7S8T9V0WXYZ",
      intent: "lead_submit",
      verdict: "confirmed",
      confidence: 0.92,
      evidence_level: 2,
      evidence_summary_or_hash: "ab".repeat(32),
      observed_at: "2026-09-09T00:00:00Z",
      url_hash: "cd".repeat(32),
      claim_hash: "ef".repeat(32),
    };
    const canonical = canonicalizeReceiptPayload(payload);
    const signature = signCanonical(canonical, {
      privateKey,
      publicKey,
      kid: "livecheck-confirm-v1",
    });
    assert.equal(verifyCanonical(canonical, signature, publicKey), true);
    assert.equal(sha256Hex(canonical).length, 64);
  });

  it("accepts a 32-byte hex seed", () => {
    const seed = randomBytes(32).toString("hex");
    const key = parseReceiptPrivateKey(seed);
    assert.equal(key.asymmetricKeyType, "ed25519");
  });
});

describe("GET /v1/receipt round-trip with key", () => {
  const pem = generateReceiptPrivateKeyPem();
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};
  let previous: string | undefined;

  before(async () => {
    previous = process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    process.env.CONFIRM_RECEIPT_PRIVATE_KEY = pem;
    resetReceiptSignerCache();
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
    if (previous === undefined) delete process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    else process.env.CONFIRM_RECEIPT_PRIVATE_KEY = previous;
    resetReceiptSignerCache();
  });

  it("signs confirm JSON and verifies via GET /v1/receipt/{id} + well-known keys", async () => {
    const keysDoc = livecheckKeysDocument() as { signing?: boolean; keys?: Array<{ x?: string; kid?: string }> };
    assert.equal(keysDoc.signing, true);
    assert.ok(keysDoc.keys?.[0]?.x);

    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/thank-you-id`,
        intent: "lead_submit",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      verdict: string;
      evidence_level: number;
      confidence: number;
      receipt: { hash: string; signature?: string; signer?: string; verify_url: string };
    };
    assert.equal(body.verdict, "confirmed");
    assert.equal(body.evidence_level, 2);
    assert.ok(body.confidence >= 0.9);
    assert.equal(isConfirmId(body.id), true);
    assert.ok(body.receipt.signature);
    assert.equal(body.receipt.signer, "livecheck-confirm-v1");
    assert.ok(body.receipt.verify_url.includes(body.id));
    assert.equal(body.receipt.hash.length, 64);

    const keysRes = await fetch(`${origin}/.well-known/livecheck-keys.json`);
    assert.equal(keysRes.status, 200);
    const keys = (await keysRes.json()) as { keys: Array<{ x: string; crv: string; kty: string }>; signing: boolean };
    assert.equal(keys.signing, true);
    assert.equal(keys.keys[0].crv, "Ed25519");

    const receiptRes = await fetch(`${origin}/v1/receipt/${body.id}`);
    assert.equal(receiptRes.status, 200);
    const receipt = (await receiptRes.json()) as {
      id: string;
      canonical: string;
      receipt: { hash: string; signature: string };
      verify: { signed: boolean; valid: boolean | null; alg: string };
    };
    assert.equal(receipt.id, body.id);
    assert.equal(receipt.verify.signed, true);
    assert.equal(receipt.verify.valid, true);
    assert.equal(receipt.verify.alg, "Ed25519");
    assert.equal(sha256Hex(receipt.canonical), body.receipt.hash);
    assert.equal(receipt.canonical.includes("ABC123"), false);

    const publicKey = createPublicKey(parseReceiptPrivateKey(pem));
    assert.equal(
      verify(null, Buffer.from(receipt.canonical, "utf8"), publicKey, Buffer.from(receipt.receipt.signature, "base64")),
      true,
    );
  });

  it("persists the receipt on the receipts sqlite volume", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { clearConfirmReceiptMemory, closeReceiptStore, getConfirmReceipt, initReceiptStore } =
      await import("../src/receipt-store.js");
    const dir = mkdtempSync(join(tmpdir(), "livecheck-receipt-"));
    initReceiptStore(join(dir, "receipts.sqlite"));
    try {
      const res = await fetch(`${origin}/v1/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
        body: JSON.stringify({
          url: `${origin}/fixtures/confirm/thank-you-id`,
          intent: "lead_submit",
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { id: string };
      clearConfirmReceiptMemory();
      const row = getConfirmReceipt(body.id);
      assert.ok(row);
      assert.equal(row.id, body.id);
      assert.equal(row.intent, "lead_submit");
      assert.ok(row.signature);
    } finally {
      closeReceiptStore();
    }
  });

  it("sealConfirmResultDetailed.durable is false without sqlite and true after init", async () => {
    const { closeReceiptStore, initReceiptStore } = await import("../src/receipt-store.js");
    closeReceiptStore();
    const classified = {
      verdict: "unknown" as const,
      effect: { type: "lead_submit" as const },
      evidence_strength: 1 as const,
      signals: ["thank-you copy"],
      independent_signals: 1,
      independent_evidence: true,
      evidence_id: "",
      http_status: 200,
      fetched_at: "2026-09-11T19:00:00Z",
      url: "https://example.com/thanks",
      canonical_url: "https://example.com/thanks",
      price_usd: 0.1,
      evidence_level: 1 as const,
      confidence: 0.4,
    };
    const memoryOnly = sealConfirmResultDetailed(classified, {
      intent: "lead_submit",
      url: "https://example.com/thanks",
    });
    assert.equal(memoryOnly.durable, false);
    assert.ok(memoryOnly.result.id);
    initReceiptStore(":memory:");
    try {
      const durable = sealConfirmResultDetailed(classified, {
        intent: "lead_submit",
        url: "https://example.com/thanks",
      });
      assert.equal(durable.durable, true);
    } finally {
      closeReceiptStore();
    }
  });
});

describe("unsigned receipt stub without key", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};
  let previous: string | undefined;

  before(async () => {
    previous = process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    delete process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    resetReceiptSignerCache();
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
    if (previous === undefined) delete process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    else process.env.CONFIRM_RECEIPT_PRIVATE_KEY = previous;
    resetReceiptSignerCache();
  });

  it("returns id + hash + verify_url without signature", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm/thank-you-id`,
        intent: "lead_submit",
        claim: {},
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      receipt: { hash: string; verify_url: string; signature?: string };
    };
    assert.equal(isConfirmId(body.id), true);
    assert.ok(body.receipt.hash);
    assert.ok(body.receipt.verify_url.includes(`/v1/receipt/${body.id}`));
    assert.equal(body.receipt.signature, undefined);

    const receiptRes = await fetch(body.receipt.verify_url.replace(/^https?:\/\/[^/]+/, origin));
    assert.equal(receiptRes.status, 200);
    const receipt = (await receiptRes.json()) as { verify: { signed: boolean } };
    assert.equal(receipt.verify.signed, false);
  });
});
