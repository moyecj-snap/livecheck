import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import { Credential, Receipt } from "mppx";
import { Mppx, stripe } from "mppx/server";
import StripeClient from "stripe";
import { hasMppPaymentCredential } from "./mpp-flags.js";
import { openMppResultCache, type MppResultCache, type StoredResponse } from "./mpp-idempotency.js";
import { openMppStore } from "./mpp-store.js";
import { PRICE_USD, VERIFY_DESCRIPTION } from "./config.js";
import {
  deferPaidCallEmit,
  emitPaidCall,
  hasRememberedPaidCall,
  isoTs,
  rememberPaidCall,
  sanitizePayer,
  sanitizeTx,
  type PaidCallRoute,
  type PaymentProtocol,
} from "./paid-call.js";
import { retainRefundCandidate, type RefundCandidate } from "./paid-call-store.js";
import { publicOrigin, publicVerifyJobUrl, publicVerifyListingUrl, publicVerifyUrl } from "./public-url.js";
import { VerifyError, parseTargetUrl, timeoutUnknownVerdict } from "./verify.js";
import { withWatchHint } from "./watch-hint.js";

/**
 * MPP (Machine Payments Protocol, Stripe + Tempo) next to x402.
 *
 * Scope of this slice: the three $0.01 verify routes, Tempo stablecoin only
 * (no cards), behind MPP_ENABLED (default off). With the flag off nothing in
 * this file is installed and every response is what x402 alone returns.
 *
 * With the flag on, a custom dispatcher sits where the x402 gate sat:
 *   - x402 credential (PAYMENT-SIGNATURE / X-PAYMENT): straight to the x402
 *     gate, unchanged. mppx is never called.
 *   - both an x402 credential and `Authorization: Payment`: 400, nothing charged.
 *   - no credential: the x402 402 (same PAYMENT-REQUIRED header, same mirrored
 *     body) with the MPP `WWW-Authenticate: Payment` challenge appended. Empty
 *     and bodyless probes get it too, so MPP discovery tools see Tempo.
 *   - `Authorization: Payment`: validate the request before SETTLING (400,
 *     not charged). A retry with the same credential or tx never settles
 *     twice (see mpp-idempotency.ts).
 *     Then mppx verifies and settles the Tempo payment. After that the caller
 *     always gets 200 with the normal verify shape: a handler error becomes
 *     status "unknown" and a refund candidate is logged.
 *
 * mppx's own x402 wrapper (`mppx/x402/hono`) is not used: in 0.13.3 it skips
 * every route whose x402 requirement carries extensions, and every Livecheck
 * route carries the bazaar extension.
 */

export const MPP_PROTOCOL: PaymentProtocol = "mpp_tempo";

export type MppRoute = Extract<PaidCallRoute, "verify" | "verify/job" | "verify/listing">;

const MPP_ROUTE_BY_PATH: Readonly<Record<string, MppRoute>> = {
  "/v1/verify": "verify",
  "/v1/verify/job": "verify/job",
  "/v1/verify/listing": "verify/listing",
};

export const MPP_ROUTES: readonly MppRoute[] = ["verify", "verify/job", "verify/listing"];

/** Two-decimal USD string mppx expects. Same constant as the x402 $0.01 accept. */
export const MPP_VERIFY_AMOUNT = PRICE_USD.toFixed(2);

export function mppRouteForPath(path: string): MppRoute | undefined {
  const normalized = path.replace(/\/+$/, "") || "/";
  return MPP_ROUTE_BY_PATH[normalized];
}

export function mppScopeUrl(route: MppRoute, requestUrl?: string, host?: string): string {
  if (route === "verify/job") return publicVerifyJobUrl(requestUrl, host);
  if (route === "verify/listing") return publicVerifyListingUrl(requestUrl, host);
  return publicVerifyUrl(requestUrl, host);
}

export { mppEnabled, hasMppPaymentCredential } from "./mpp-flags.js";

export type MppKeys = {
  stripeSecretKey: string;
  /** Which env name supplied the Stripe key. The value is never logged. */
  stripeKeySource: "MPP_STRIPE_SECRET_KEY" | "STRIPE_SECRET_KEY";
  profileId: string;
  tempoDepositAddress: string;
  secretKey: string;
  livemode: boolean;
  realm?: string;
  hostedFeePayer: boolean;
};

const PROFILE_RE = /^profile_[A-Za-z0-9_]+$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Names of MPP settings that are missing or malformed. Values are never
 * returned or logged. The Stripe key may come from MPP_STRIPE_SECRET_KEY (a
 * restricted key just for MPP) or fall back to STRIPE_SECRET_KEY.
 */
export function missingMppKeyNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  const key = env.MPP_STRIPE_SECRET_KEY?.trim() || env.STRIPE_SECRET_KEY?.trim() || "";
  if (!/^(sk|rk)_(test|live)_/.test(key)) missing.push("MPP_STRIPE_SECRET_KEY");
  const profile = env.STRIPE_PROFILE_ID?.trim() ?? "";
  if (!PROFILE_RE.test(profile)) missing.push("STRIPE_PROFILE_ID");
  else if (key && key.includes("_test_") !== profile.startsWith("profile_test_")) {
    // A sandbox key with a live profile (or the reverse) cannot record payments.
    missing.push("STRIPE_PROFILE_ID");
  }
  if (!ADDRESS_RE.test(env.TEMPO_DEPOSIT_ADDRESS?.trim() ?? "")) missing.push("TEMPO_DEPOSIT_ADDRESS");
  if (Buffer.byteLength(env.MPP_SECRET_KEY?.trim() ?? "", "utf8") < 32) missing.push("MPP_SECRET_KEY");
  return missing;
}

export function readMppKeys(env: NodeJS.ProcessEnv = process.env): MppKeys | null {
  if (missingMppKeyNames(env).length > 0) return null;
  const fromMpp = env.MPP_STRIPE_SECRET_KEY?.trim();
  const stripeSecretKey = (fromMpp || env.STRIPE_SECRET_KEY?.trim()) as string;
  const livemode = !stripeSecretKey.includes("_test_");
  const realm = env.MPP_REALM?.trim() || undefined;
  return {
    stripeSecretKey,
    stripeKeySource: fromMpp ? "MPP_STRIPE_SECRET_KEY" : "STRIPE_SECRET_KEY",
    profileId: (env.STRIPE_PROFILE_ID as string).trim(),
    tempoDepositAddress: (env.TEMPO_DEPOSIT_ADDRESS as string).trim(),
    secretKey: (env.MPP_SECRET_KEY as string).trim(),
    livemode,
    ...(realm ? { realm } : {}),
    // Stripe pays Tempo gas in live mode. MPP_HOSTED_FEE_PAYER=0 turns it off
    // (the agent then pays its own gas, under $0.001).
    hostedFeePayer: livemode && env.MPP_HOSTED_FEE_PAYER?.trim() !== "0",
  };
}

/** Realm the challenge is bound to: MPP_REALM, else the public host. */
export function mppRealm(keys: Pick<MppKeys, "realm">): string {
  if (keys.realm) return keys.realm;
  try {
    return new URL(publicOrigin()).host;
  } catch {
    return "livecheck";
  }
}

export type MppStatus = {
  enabled: boolean;
  active: boolean;
  livemode?: boolean;
  methods?: string[];
  missing_keys?: string[];
  error?: string;
};

let mppStatus: MppStatus = { enabled: false, active: false };

export function setMppStatus(status: MppStatus): void {
  mppStatus = status;
}

/** For /health when MPP_ENABLED=1. Key names only, never values. */
export function currentMppStatus(): MppStatus {
  return { ...mppStatus };
}

// ---------------------------------------------------------------------------
// Gateway: the only thing the dispatcher needs from mppx.

export type MppChargeOutcome =
  | { status: 402; challenge: Response }
  | {
      status: 200;
      /** Verified Tempo source account (lowercase 0x), when the credential named one. */
      payer?: string;
      /** On-chain reference from the receipt (Tempo tx hash). */
      reference?: string;
      withReceipt: (response: Response) => Response;
    };

export type MppGateway = {
  protocol: PaymentProtocol;
  /** Issue a challenge (no credential) or verify + settle the credential on `request`. */
  charge: (route: MppRoute, request: Request, scope: string) => Promise<MppChargeOutcome>;
  /** Names for /health, e.g. `tempo/charge`. */
  methods: readonly string[];
};

type MppxLike = {
  charge: (options: { amount: string; scope?: string; description?: string }) => (
    request: Request,
  ) => Promise<{ status: 402; challenge: Response } | { status: 200; withReceipt: (response?: unknown) => unknown }>;
};

/** `did:pkh:eip155:4217:0xabc…` → `0xabc…`. Anything else → undefined. */
export function payerFromCredentialSource(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  const match = source.trim().match(/^did:pkh:eip155:\d+:(0x[a-fA-F0-9]{40})$/);
  return match ? sanitizePayer(match[1]) : sanitizePayer(source);
}

function credentialSource(request: Request): string | undefined {
  try {
    return Credential.fromRequest(request).source;
  } catch {
    return undefined;
  }
}

function receiptReference(withReceipt: (response?: unknown) => unknown): string | undefined {
  try {
    const probe = withReceipt(new Response(null)) as Response;
    return Receipt.fromResponse(probe).reference;
  } catch {
    return undefined;
  }
}

/** Wrap a configured Mppx instance (real Stripe Tempo, or a test method). */
export function gatewayFromMppx(mppx: MppxLike, methods: readonly string[] = ["tempo/charge"]): MppGateway {
  const handlers = new Map<string, (request: Request) => ReturnType<ReturnType<MppxLike["charge"]>>>();
  const handlerFor = (scope: string) => {
    let handler = handlers.get(scope);
    if (!handler) {
      handler = mppx.charge({ amount: MPP_VERIFY_AMOUNT, scope, description: VERIFY_DESCRIPTION });
      handlers.set(scope, handler);
    }
    return handler;
  };
  return {
    protocol: MPP_PROTOCOL,
    methods,
    async charge(_route, request, scope) {
      const result = await handlerFor(scope)(request);
      if (result.status === 402) return { status: 402, challenge: result.challenge };
      const withReceipt = result.withReceipt;
      const out: MppChargeOutcome = {
        status: 200,
        withReceipt: (response: Response) => withReceipt(response) as Response,
      };
      const payer = payerFromCredentialSource(credentialSource(request));
      if (payer) out.payer = payer;
      const reference = receiptReference(withReceipt);
      if (reference) out.reference = reference;
      return out;
    },
  };
}

/**
 * Real gateway: Stripe Tempo deposit address via mppx `stripe.create`, cards
 * excluded. Built only when MPP_ENABLED=1 and every MPP key is present.
 */
export function createLiveMppGateway(keys: MppKeys, storePath?: string): MppGateway {
  const client = new StripeClient(keys.stripeSecretKey);
  const store = openMppStore(storePath);
  const machinePayments = stripe.create({
    client: client as never,
    networkId: keys.profileId,
    livemode: keys.livemode,
    hostedFeePayer: keys.hostedFeePayer,
    depositAddresses: { tempo: keys.tempoDepositAddress },
    store: store as never,
    metadata: { service: "livecheck" },
  });
  // Tempo only. Cards (SPT) are on hold, and $0.01 is below the $0.50 card minimum anyway.
  const methods = machinePayments.defaultMethods({ exclude: ["spt"] }) as unknown as never[];
  const mppx = Mppx.create({ methods, secretKey: keys.secretKey, realm: mppRealm(keys) });
  return gatewayFromMppx(mppx as unknown as MppxLike, ["tempo/charge"]);
}

// ---------------------------------------------------------------------------
// Dispatcher


function hasX402Credential(c: Context): boolean {
  return Boolean(c.req.header("payment-signature") || c.req.header("x-payment"));
}

type ValidRequest = { ok: true; url: string } | { ok: false; status: 400; body: { error: string } };

/**
 * Same checks the verify handler runs before it fetches anything: JSON body
 * and an absolute http(s) url. Hono caches the parsed body, so the handler
 * and the x402 middleware read the same body afterwards.
 */
export async function validateVerifyRequest(c: Context): Promise<ValidRequest> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, status: 400, body: { error: "Request body must be JSON." } };
  }
  const raw = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
  try {
    return { ok: true, url: parseTargetUrl(raw) };
  } catch (error) {
    if (error instanceof VerifyError) return { ok: false, status: 400, body: { error: error.message } };
    return { ok: false, status: 400, body: { error: "url must be an absolute http(s) URL." } };
  }
}

/** Headers-only copy for mppx. mppx never needs the body, and Hono already read it. */
function mppRequest(c: Context): Request {
  return new Request(c.req.url, { method: c.req.method, headers: c.req.raw.headers });
}

function wwwAuthenticateLines(headers: Headers): string[] {
  const getSetLike = (headers as Headers & { getAll?: (name: string) => string[] }).getAll;
  if (typeof getSetLike === "function") return getSetLike.call(headers, "www-authenticate");
  const lines: string[] = [];
  headers.forEach((value, name) => {
    if (name.toLowerCase() === "www-authenticate" && value) lines.push(value);
  });
  return lines;
}

/** New mutable Response with every original header, plus the MPP challenge lines appended. */
function appendChallenge(response: Response, lines: readonly string[]): Response {
  const headers = new Headers(response.headers);
  for (const line of lines) headers.append("www-authenticate", line);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function current402(result: Response | void, c: Context): Response | undefined {
  const candidate = result instanceof Response ? result : c.res;
  return candidate && candidate.status === 402 ? candidate : undefined;
}

export const MULTIPLE_CREDENTIALS_MESSAGE =
  "Send one payment credential: x402 (PAYMENT-SIGNATURE) or MPP (Authorization: Payment), not both. You were not charged.";

export const REFUND_CANDIDATE_EVENT = "livecheck.refund_candidate" as const;

export const POST_PAYMENT_UNKNOWN_SIGNAL = "post_payment_error";

export type MppDispatchOptions = {
  /** stdout writer for the refund-candidate line (tests capture it). */
  writer?: (line: string) => void;
  now?: () => Date;
  /** Retry/idempotency rows. Default: a private in-memory SQLite. */
  results?: MppResultCache;
};

export const IDEMPOTENT_REPLAY_HEADER = "livecheck-idempotent-replay";

export const PAYMENT_UNCONFIRMED_MESSAGE =
  "The MPP payment could not be confirmed. If your wallet shows a charge for this request, it is logged for refund. Retrying with the same credential is safe: it is never charged twice.";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Tx hash when the client already broadcast (push mode). Pull-mode credentials carry a signed tx instead. */
function credentialTxHash(request: Request): string | undefined {
  try {
    const payload = Credential.fromRequest(request).payload as { type?: string; hash?: unknown } | undefined;
    if (payload?.type === "hash" && typeof payload.hash === "string") return sanitizeTx(payload.hash.toLowerCase());
  } catch {
    // unparsable: mppx will refuse it
  }
  return undefined;
}

const STORED_HEADERS = ["content-type", "payment-receipt", "cache-control"];

async function storableResponse(response: Response): Promise<StoredResponse> {
  const headers: Record<string, string> = {};
  for (const name of STORED_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return { status: response.status, headers, body: await response.clone().text() };
}

function replayStored(stored: StoredResponse): Response {
  const headers = new Headers(stored.headers);
  headers.set(IDEMPOTENT_REPLAY_HEADER, "1");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(stored.body, { status: stored.status, headers });
}

function conflict(error: string, message: string, retryAfter?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
  return new Response(JSON.stringify({ error, message }), { status: 409, headers });
}

function logRefundCandidate(candidate: RefundCandidate, writer: (line: string) => void): void {
  const line: Record<string, unknown> = {
    event: REFUND_CANDIDATE_EVENT,
    protocol: candidate.protocol,
    payment_id: sanitizeTx(candidate.payment_id) ?? null,
    route: candidate.route,
    reason: candidate.reason,
    ts: candidate.ts,
  };
  const payer = sanitizePayer(candidate.payer);
  if (payer) line.payer = payer;
  if (candidate.http_status !== undefined) line.http_status = candidate.http_status;
  writer(JSON.stringify(line));
  retainRefundCandidate(candidate);
}

export function withMppDispatch(
  x402Gate: MiddlewareHandler,
  gateway: MppGateway,
  options: MppDispatchOptions = {},
): MiddlewareHandler {
  const writer = options.writer ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const results = options.results ?? openMppResultCache(":memory:");

  return async (c: Context, next: Next) => {
    const route = c.req.method === "POST" ? mppRouteForPath(c.req.path) : undefined;
    if (!route) return x402Gate(c, next);

    const x402Credential = hasX402Credential(c);
    const mppCredential = hasMppPaymentCredential(c.req.header("authorization"));

    if (x402Credential && mppCredential) {
      return c.json({ error: "multiple_payment_credentials", message: MULTIPLE_CREDENTIALS_MESSAGE }, 400, {
        "cache-control": "no-store",
      });
    }

    // x402 payment: untouched.
    if (x402Credential) return x402Gate(c, next);

    const scope = mppScopeUrl(route, c.req.url, c.req.header("host"));

    if (!mppCredential) {
      const result = await x402Gate(c, next);
      const unpaid = current402(result, c);
      if (!unpaid) return result;
      // Challenge every unpaid 402 on these routes, empty probes included,
      // so MPP discovery sees Tempo. Validation happens before settlement.
      let outcome: MppChargeOutcome;
      try {
        outcome = await gateway.charge(route, mppRequest(c), scope);
      } catch (error) {
        console.warn(`[mpp] challenge failed, serving x402 only: ${error instanceof Error ? error.message : String(error)}`);
        return result;
      }
      if (outcome.status !== 402) return result;
      const lines = wwwAuthenticateLines(outcome.challenge.headers);
      if (lines.length === 0) return result;
      return appendChallenge(unpaid, lines);
    }

    // MPP payment attempt. Validate before settling: an invalid request is never charged.
    const valid = await validateVerifyRequest(c);
    if (!valid.ok) {
      return c.json(valid.body, valid.status, { "cache-control": "no-store" });
    }

    // Retry safety: one settlement per credential / tx, ever.
    const request = mppRequest(c);
    const credentialKey = sha256Hex(c.req.header("authorization") ?? "");
    const credentialTx = credentialTxHash(request);
    const requestKey = sha256Hex(`${route}\n${await c.req.text().catch(() => "")}`);
    const claim = results.claim({
      credential_sha256: credentialKey,
      ...(credentialTx ? { tx: credentialTx } : {}),
      route,
      request_sha256: requestKey,
      ts: isoTs(now()),
    });
    if (claim.kind === "existing") {
      const { existing } = claim;
      if (existing.request_sha256 !== requestKey) {
        return conflict(
          "credential_already_used",
          "This MPP payment already paid for a different request. It was not charged again. Request a new challenge to pay for this one.",
        );
      }
      if (existing.state === "pending") {
        return conflict(
          "payment_in_progress",
          "This MPP payment is being settled by another request. Retry shortly with the same credential; it will not be charged twice.",
          2,
        );
      }
      if (existing.response) return replayStored(existing.response);
      return conflict("payment_in_progress", "Retry shortly with the same credential.", 2);
    }
    const retrying = claim.kind === "retry_unconfirmed" ? claim.original : undefined;

    let outcome: MppChargeOutcome;
    try {
      outcome = await gateway.charge(route, request, scope);
    } catch (error) {
      console.error(`[mpp] charge threw: ${error instanceof Error ? error.message : String(error)}`);
      if (retrying?.response) {
        results.restoreUnconfirmed(credentialKey);
        return replayStored(retrying.response);
      }
      // We cannot tell whether the transfer landed. Do not answer as paid,
      // and keep a record so a charge can be found and refunded.
      logRefundCandidate(
        {
          ts: isoTs(now()),
          protocol: gateway.protocol,
          ...(credentialTx ? { payment_id: credentialTx } : {}),
          route,
          reason: "charge_outcome_unknown",
        },
        writer,
      );
      const unconfirmed = c.json(
        { error: "payment_unconfirmed", message: PAYMENT_UNCONFIRMED_MESSAGE },
        503,
        { "cache-control": "no-store" },
      );
      results.complete(credentialKey, { state: "unconfirmed", response: await storableResponse(unconfirmed) });
      return unconfirmed;
    }

    if (outcome.status === 402) {
      if (retrying?.response) {
        // Never answer a retry of a possibly-paid credential with a fresh 402:
        // that invites a second payment. Same 503 as before.
        results.restoreUnconfirmed(credentialKey);
        return replayStored(retrying.response);
      }
      results.release(credentialKey);
      // Bad, expired, replayed, or wrong-route credential. mppx's problem body
      // and fresh challenge, plus the x402 header so an x402 fallback works.
      const x402Result = await x402Gate(c, async () => undefined);
      const x402Unpaid = current402(x402Result, c);
      const headers = new Headers(outcome.challenge.headers);
      const paymentRequired = x402Unpaid?.headers.get("payment-required");
      if (paymentRequired) headers.set("payment-required", paymentRequired);
      if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
      return new Response(outcome.challenge.body, { status: 402, headers });
    }

    // Paid. From here the caller always gets a 200 answer.
    deferPaidCallEmit();
    let threw: unknown;
    try {
      await next();
    } catch (error) {
      threw = error;
    }
    const handled = c.res;
    const settlement = { payer: outcome.payer, tx: outcome.reference, protocol: gateway.protocol };

    if (threw !== undefined || !handled || handled.status >= 400) {
      const status = handled?.status;
      const reason = threw !== undefined ? "handler_threw" : `handler_status_${status ?? "none"}`;
      if (threw !== undefined) {
        console.error(`[mpp] paid handler threw: ${threw instanceof Error ? threw.message : String(threw)}`);
      }
      const verdict = { ...timeoutUnknownVerdict(valid.url, now()), signals: [POST_PAYMENT_UNKNOWN_SIGNAL] };
      rememberPaidCall({ route, url: valid.url, status: "unknown", user_agent: c.req.header("user-agent") });
      emitPaidCall(settlement);
      logRefundCandidate(
        {
          ts: isoTs(now()),
          protocol: gateway.protocol,
          payment_id: outcome.reference,
          route,
          reason,
          payer: outcome.payer,
          ...(threw === undefined && status !== undefined ? { http_status: status } : {}),
        },
        writer,
      );
      const body = withWatchHint({ ...verdict, route });
      const replacement = outcome.withReceipt(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
      );
      results.complete(credentialKey, {
        state: "done",
        ...(outcome.reference ? { tx: sanitizeTx(outcome.reference) } : {}),
        response: await storableResponse(replacement),
      });
      c.res = undefined;
      c.res = replacement;
      return c.res;
    }

    if (!hasRememberedPaidCall()) {
      // The handler answered 200 without remembering a call. Money was
      // collected, so the row still has to exist for /stats revenue.
      rememberPaidCall({ route, url: valid.url, user_agent: c.req.header("user-agent") });
    }
    emitPaidCall(settlement);
    const withReceipt = outcome.withReceipt(handled);
    results.complete(credentialKey, {
      state: "done",
      ...(outcome.reference ? { tx: sanitizeTx(outcome.reference) } : {}),
      response: await storableResponse(withReceipt),
    });
    c.res = undefined;
    c.res = withReceipt;
    return c.res;
  };
}
