/**
 * MPP staging smoke test (Tempo TESTNET only). Not part of `npm test`.
 *
 *   MPP_SMOKE_URL=https://livecheck-mpp-staging.fly.dev npx tsx scripts/mpp-testnet-smoke.ts
 *
 * Uses the testnet smoke wallet (key file MPP_SMOKE_KEY_FILE, created 0600 if
 * missing; its address is on the internal list), tops it up from the public
 * Tempo Moderato faucet, pays one $0.01 challenge, then:
 *   - retries the same credential + body  -> original answer, no second charge
 *   - same credential, different body     -> 409 credential_already_used
 * Refuses any challenge that is not on the testnet chain (42431). Prints the
 * address and tx hashes only; the private key is never printed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import { Actions } from "viem/tempo";
import { tempoModerato } from "viem/tempo/chains";
import { Challenge, Receipt } from "mppx";
import { Mppx, tempo } from "mppx/client";

const base = (process.env.MPP_SMOKE_URL ?? "https://livecheck-mpp-staging.fly.dev").replace(/\/$/, "");
const path = process.env.MPP_SMOKE_PATH ?? "/v1/verify/job";
const target = process.env.MPP_SMOKE_TARGET ?? `${base}/fixtures/live-apply-now`;
const body = JSON.stringify({ url: target });
const headers = { "content-type": "application/json", "user-agent": "livecheck-internal/mpp-smoke" };

function log(step: string, data: unknown) {
  console.log(`${step}: ${JSON.stringify(data)}`);
}

const unpaid = await fetch(`${base}${path}`, { method: "POST", headers, body });
const challenge = Challenge.fromResponse(unpaid);
const chainId = (challenge.request as { methodDetails?: { chainId?: number } }).methodDetails?.chainId;
log("challenge", {
  status: unpaid.status,
  method: challenge.method,
  intent: challenge.intent,
  realm: challenge.realm,
  amount: (challenge.request as { amount: string }).amount,
  currency: (challenge.request as { currency: string }).currency,
  recipient: (challenge.request as { recipient?: string }).recipient,
  chainId,
  expires: challenge.expires,
});
if (chainId !== tempoModerato.id) {
  console.error(`Refusing: challenge chainId ${chainId} is not Tempo testnet ${tempoModerato.id}.`);
  process.exit(2);
}

const keyFile = process.env.MPP_SMOKE_KEY_FILE ?? `${process.env.HOME}/.livecheck/mpp-testnet-smoke.key`;
if (!existsSync(keyFile)) writeFileSync(keyFile, generatePrivateKey(), { mode: 0o600 });
const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as `0x${string}`);
const client = createClient({ chain: tempoModerato, transport: http() });
const fundHashes = await Actions.faucet.fund(client, { account });
await Promise.all(fundHashes.map((hash) => waitForTransactionReceipt(client, { hash })));
const currency = (challenge.request as { currency: string }).currency as `0x${string}`;
for (let i = 0; i < 20; i++) {
  const bal = await Actions.token.getBalance(client, { account: account.address, token: currency }).catch(() => undefined);
  if (bal && bal.amount > 0n) {
    log("funded", { payer: account.address, balance: bal.amount.toString(), faucet_txs: fundHashes });
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}

const mppx = Mppx.create({ methods: [tempo({ account })], polyfill: false });
const credential = await mppx.createCredential(unpaid);
const paid = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, authorization: credential }, body });
const paidText = await paid.text();
let receipt: unknown = null;
try {
  receipt = Receipt.fromResponse(paid);
} catch (error) {
  receipt = { error: (error as Error).message };
}
log("paid", {
  status: paid.status,
  receipt,
  cache_control: paid.headers.get("cache-control"),
  body: paidText.slice(0, 600),
});

const replay = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, authorization: credential }, body });
const replayText = await replay.text();
log("retry_same_credential", {
  status: replay.status,
  idempotent_replay: replay.headers.get("livecheck-idempotent-replay"),
  same_body: replayText === paidText,
  receipt_reference: (() => {
    try {
      return Receipt.fromResponse(replay).reference;
    } catch {
      return null;
    }
  })(),
});

const otherBody = JSON.stringify({ url: `${base}/fixtures/gone-404` });
const reuse = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, authorization: credential }, body: otherBody });
log("reuse_other_body", { status: reuse.status, body: (await reuse.text()).slice(0, 300) });

const ok = paid.status === 200 && replay.status === 200 && replayText === paidText && reuse.status === 409;
process.exit(ok ? 0 : 1);
