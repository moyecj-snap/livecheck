import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { newCheckId, newConfirmId, newWatchId } from "./confirm-id.js";
import { hashUrl } from "./paid-call.js";
import { getConfirmReceipt, rememberConfirmReceipt, type ConfirmReceiptRow } from "./receipt-store.js";
import { publicOrigin } from "./public-url.js";
import type { CheckObservation, CheckResult, ConfirmReceipt, ConfirmResult, EvidenceLevel, WatchCreateResult } from "./types.js";

export const RECEIPT_SIGNER_KID = "livecheck-confirm-v1" as const;
export const RECEIPT_ALG = "Ed25519" as const;

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type ReceiptCanonical = {
  id: string;
  intent: string;
  verdict: string;
  confidence: number;
  evidence_level: EvidenceLevel;
  evidence_summary_or_hash: string;
  observed_at: string;
  url_hash: string;
  claim_hash: string;
};

export type ReceiptSigner = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
};

let cachedSigner: { env: string; signer: ReceiptSigner } | null | undefined;

/** Test hook — drop the cached key after changing CONFIRM_RECEIPT_PRIVATE_KEY. */
export function resetReceiptSignerCache(): void {
  cachedSigner = undefined;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic JSON for claim hashing (sorted object keys). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function hashClaim(claim: unknown): string {
  if (claim === undefined || claim === null) return sha256Hex("{}");
  return sha256Hex(stableJson(claim));
}

export function evidenceSummaryHash(result: Pick<ConfirmResult, "signals" | "independent_evidence" | "evidence_strength" | "verdict">): string {
  return sha256Hex(
    stableJson({
      verdict: result.verdict,
      evidence_strength: result.evidence_strength,
      independent_evidence: result.independent_evidence,
      signals: [...result.signals].sort(),
    }),
  );
}

/**
 * Canonical bytes signed by Ed25519. Key order is the v1.0 Confirm contract:
 * id, intent, verdict, confidence, evidence_level, evidence_summary_or_hash,
 * observed_at, url_hash, claim_hash.
 */
export function canonicalizeReceiptPayload(payload: ReceiptCanonical): string {
  return JSON.stringify({
    id: payload.id,
    intent: payload.intent,
    verdict: payload.verdict,
    confidence: payload.confidence,
    evidence_level: payload.evidence_level,
    evidence_summary_or_hash: payload.evidence_summary_or_hash,
    observed_at: payload.observed_at,
    url_hash: payload.url_hash,
    claim_hash: payload.claim_hash,
  });
}

export function generateReceiptPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function privateKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) {
    throw new Error("Ed25519 seed must be 32 bytes");
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function decodeRawKey(raw: string): Buffer | undefined {
  const compact = raw.replace(/\s+/g, "");
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) {
    const buf = Buffer.from(compact, "hex");
    if (buf.length === 32 || buf.length === 64) return buf.subarray(0, 32);
  }
  try {
    const buf = Buffer.from(compact, "base64");
    if (buf.length === 32 || buf.length === 64) return buf.subarray(0, 32);
  } catch {
    return undefined;
  }
  return undefined;
}

export function parseReceiptPrivateKey(raw: string): KeyObject {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("CONFIRM_RECEIPT_PRIVATE_KEY is empty");
  }
  if (trimmed.includes("BEGIN")) {
    return createPrivateKey(trimmed);
  }
  const seed = decodeRawKey(trimmed);
  if (seed) return privateKeyFromSeed(seed);
  throw new Error("CONFIRM_RECEIPT_PRIVATE_KEY must be PKCS#8 PEM or a 32-byte seed (hex or base64)");
}

export function loadReceiptSigner(envValue = process.env.CONFIRM_RECEIPT_PRIVATE_KEY): ReceiptSigner | null {
  const raw = envValue?.trim() ?? "";
  if (!raw) {
    cachedSigner = null;
    return null;
  }
  if (cachedSigner && cachedSigner.env === raw) return cachedSigner.signer;
  try {
    const privateKey = parseReceiptPrivateKey(raw);
    const publicKey = createPublicKey(privateKey);
    const signer: ReceiptSigner = { privateKey, publicKey, kid: RECEIPT_SIGNER_KID };
    cachedSigner = { env: raw, signer };
    return signer;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[confirm_receipt] ignoring CONFIRM_RECEIPT_PRIVATE_KEY: ${reason}`);
    cachedSigner = null;
    return null;
  }
}

export function receiptSigningEnabled(): boolean {
  return loadReceiptSigner() !== null;
}

function spkiRaw(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32);
}

export function publicKeyJwk(publicKey: KeyObject, kid: string = RECEIPT_SIGNER_KID): Record<string, unknown> {
  return {
    kid,
    kty: "OKP",
    crv: "Ed25519",
    x: spkiRaw(publicKey).toString("base64url"),
    use: "sig",
    alg: "EdDSA",
  };
}

export function livecheckKeysDocument(): Record<string, unknown> {
  const signer = loadReceiptSigner();
  if (!signer) {
    return {
      keys: [],
      signing: false,
      note: "CONFIRM_RECEIPT_PRIVATE_KEY is unset; Confirm, check, and watch receipts are unsigned stubs.",
    };
  }
  return {
    keys: [publicKeyJwk(signer.publicKey, signer.kid)],
    signing: true,
    alg: RECEIPT_ALG,
    kid: signer.kid,
  };
}

export function signCanonical(canonical: string, signer: ReceiptSigner): string {
  return sign(null, Buffer.from(canonical, "utf8"), signer.privateKey).toString("base64");
}

export function verifyCanonical(canonical: string, signatureB64: string, publicKey: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(canonical, "utf8"), publicKey, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export function publicReceiptUrl(id: string, requestUrl?: string, host?: string): string {
  return `${publicOrigin(requestUrl, host)}/v1/receipt/${encodeURIComponent(id)}`;
}

export function publicKeysUrl(requestUrl?: string, host?: string): string {
  return `${publicOrigin(requestUrl, host)}/.well-known/livecheck-keys.json`;
}

export function buildCanonicalPayload(input: {
  id: string;
  intent: string;
  result: ConfirmResult;
  url: string;
  claim?: unknown;
}): ReceiptCanonical {
  return {
    id: input.id,
    intent: input.intent,
    verdict: input.result.verdict,
    confidence: input.result.confidence,
    evidence_level: input.result.evidence_level,
    evidence_summary_or_hash: evidenceSummaryHash(input.result),
    observed_at: input.result.fetched_at,
    url_hash: hashUrl(input.url),
    claim_hash: hashClaim(input.claim),
  };
}

export function sealConfirmResult(
  result: ConfirmResult,
  input: {
    intent: string;
    url: string;
    claim?: unknown;
    requestUrl?: string;
    host?: string;
    now?: Date;
  },
): ConfirmResult {
  const id = result.id ?? newConfirmId(input.now?.getTime());
  const canonicalPayload = buildCanonicalPayload({
    id,
    intent: input.intent,
    result: { ...result, id },
    url: input.url,
    claim: input.claim,
  });
  const canonical = canonicalizeReceiptPayload(canonicalPayload);
  const hash = sha256Hex(canonical);
  const signer = loadReceiptSigner();
  const signature = signer ? signCanonical(canonical, signer) : undefined;
  const verifyUrl = publicReceiptUrl(id, input.requestUrl, input.host);
  const receipt: ConfirmReceipt = { hash, verify_url: verifyUrl };
  if (signature && signer) {
    receipt.signature = signature;
    receipt.signer = signer.kid;
  }

  const row: ConfirmReceiptRow = {
    id,
    intent: input.intent,
    verdict: result.verdict,
    confidence: result.confidence,
    evidence_level: result.evidence_level,
    canonical_json: canonical,
    payload_hash: hash,
    signature: signature ?? null,
    signer: signer?.kid ?? null,
    observed_at: result.fetched_at,
    url_hash: canonicalPayload.url_hash,
    claim_hash: canonicalPayload.claim_hash,
    created_at: result.fetched_at,
  };
  rememberConfirmReceipt(row);

  const sealed: ConfirmResult = { ...result, id, receipt };
  return sealed;
}

function checkReceiptVerdict(fired: boolean | null): string {
  if (fired === true) return "fired";
  if (fired === false) return "unfired";
  return "observed";
}

/** Confirm-style additive id + Ed25519 receipt. Same key family; id prefix is chk_. */
export function sealCheckResult(
  result: Omit<CheckResult, "id" | "receipt">,
  input: {
    url: string;
    requestUrl?: string;
    host?: string;
    now?: Date;
  },
): CheckResult {
  const id = newCheckId(input.now?.getTime());
  const evidenceSummary = sha256Hex(
    stableJson({
      status: result.observation.status,
      http_class: result.observation.http_class,
      hash: result.observation.hash,
      fired: result.fired,
      signals: [...result.observation.signals].sort(),
    }),
  );
  const observedAt = result.observation.checked_at;
  const canonicalPayload: ReceiptCanonical = {
    id,
    intent: "check",
    verdict: checkReceiptVerdict(result.fired),
    confidence: result.confidence,
    evidence_level: 1,
    evidence_summary_or_hash: evidenceSummary,
    observed_at: observedAt,
    url_hash: hashUrl(input.url),
    claim_hash: hashClaim({
      detector: result.condition.detector,
      params: result.condition.params,
      baseline_comparable: result.fired !== null,
    }),
  };
  const canonical = canonicalizeReceiptPayload(canonicalPayload);
  const hash = sha256Hex(canonical);
  const signer = loadReceiptSigner();
  const signature = signer ? signCanonical(canonical, signer) : undefined;
  const verifyUrl = publicReceiptUrl(id, input.requestUrl, input.host);
  const receipt: ConfirmReceipt = { hash, verify_url: verifyUrl };
  if (signature && signer) {
    receipt.signature = signature;
    receipt.signer = signer.kid;
  }

  const row: ConfirmReceiptRow = {
    id,
    intent: "check",
    verdict: canonicalPayload.verdict,
    confidence: result.confidence,
    evidence_level: 1,
    canonical_json: canonical,
    payload_hash: hash,
    signature: signature ?? null,
    signer: signer?.kid ?? null,
    observed_at: observedAt,
    url_hash: canonicalPayload.url_hash,
    claim_hash: canonicalPayload.claim_hash,
    created_at: observedAt,
  };
  rememberConfirmReceipt(row);

  return { ...result, id, receipt };
}

/** Confirm-style additive id + Ed25519 receipt. Same key family; id prefix is wtc_. */
export function sealWatchResult(
  result: Omit<WatchCreateResult, "receipt">,
  input: {
    url: string;
    requestUrl?: string;
    host?: string;
    observation?: CheckObservation | null;
    now?: Date;
  },
): WatchCreateResult {
  const id = result.id || newWatchId(input.now?.getTime());
  const observedAt = input.observation?.checked_at ?? result.first_check_at;
  const evidenceSummary = sha256Hex(
    stableJson({
      captured: result.baseline.captured,
      hash: result.baseline.hash ?? null,
      summary: result.baseline.summary ?? null,
      interval_s: result.interval_s,
      checks_remaining: result.checks_remaining,
    }),
  );
  const canonicalPayload: ReceiptCanonical = {
    id,
    intent: "watch",
    verdict: "created",
    confidence: result.baseline.captured ? 0.85 : 0.2,
    evidence_level: result.baseline.captured ? 1 : 0,
    evidence_summary_or_hash: evidenceSummary,
    observed_at: observedAt,
    url_hash: hashUrl(input.url),
    claim_hash: hashClaim({
      detector: result.condition.detector,
      params: result.condition.params,
      interval_s: result.interval_s,
      run: "none",
    }),
  };
  const canonical = canonicalizeReceiptPayload(canonicalPayload);
  const hash = sha256Hex(canonical);
  const signer = loadReceiptSigner();
  const signature = signer ? signCanonical(canonical, signer) : undefined;
  const verifyUrl = publicReceiptUrl(id, input.requestUrl, input.host);
  const receipt: ConfirmReceipt = { hash, verify_url: verifyUrl };
  if (signature && signer) {
    receipt.signature = signature;
    receipt.signer = signer.kid;
  }

  const row: ConfirmReceiptRow = {
    id,
    intent: "watch",
    verdict: "created",
    confidence: canonicalPayload.confidence,
    evidence_level: canonicalPayload.evidence_level,
    canonical_json: canonical,
    payload_hash: hash,
    signature: signature ?? null,
    signer: signer?.kid ?? null,
    observed_at: observedAt,
    url_hash: canonicalPayload.url_hash,
    claim_hash: canonicalPayload.claim_hash,
    created_at: result.first_check_at,
  };
  rememberConfirmReceipt(row);

  return { ...result, id, receipt };
}

export function receiptRecordToResponse(
  row: ConfirmReceiptRow,
  requestUrl?: string,
  host?: string,
): Record<string, unknown> {
  const verifyUrl = publicReceiptUrl(row.id, requestUrl, host);
  const receipt: ConfirmReceipt = {
    hash: row.payload_hash,
    verify_url: verifyUrl,
  };
  if (row.signature) receipt.signature = row.signature;
  if (row.signer) receipt.signer = row.signer;

  let payload: unknown;
  try {
    payload = JSON.parse(row.canonical_json);
  } catch {
    payload = null;
  }

  const signer = loadReceiptSigner();
  const signed = Boolean(row.signature);
  let valid: boolean | null = null;
  if (signed && row.signature && signer) {
    valid = verifyCanonical(row.canonical_json, row.signature, signer.publicKey);
  } else if (signed && row.signature && !signer) {
    valid = null;
  }

  return {
    id: row.id,
    intent: row.intent,
    verdict: row.verdict,
    confidence: row.confidence,
    evidence_level: row.evidence_level,
    observed_at: row.observed_at,
    payload,
    canonical: row.canonical_json,
    receipt,
    verify: {
      alg: RECEIPT_ALG,
      signed,
      valid,
      keys_url: publicKeysUrl(requestUrl, host),
      kid: row.signer ?? null,
    },
  };
}

export function lookupReceiptResponse(
  id: string,
  requestUrl?: string,
  host?: string,
): Record<string, unknown> | undefined {
  const row = getConfirmReceipt(id);
  if (!row) return undefined;
  return receiptRecordToResponse(row, requestUrl, host);
}
