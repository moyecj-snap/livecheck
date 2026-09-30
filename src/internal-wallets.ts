import { sanitizePayer } from "./paid-call.js";

/**
 * Team / seed wallets whose Verify, Confirm, Check, and Watch traffic is
 * internal. Public /stats still publishes all-wallet headlines and labels
 * them as internal test traffic. `traffic.external` omits this list.
 *
 * Stored lowercase. `sanitizePayer` accepts checksummed input.
 * Add more at runtime with LIVECHECK_INTERNAL_WALLETS (comma-separated).
 * That env is additive. Set it to `off` to disable the wallet split.
 */
export const DEFAULT_INTERNAL_WALLETS = [
  "0xb78226fc84f02da1b69f5e10f595067e4f1987d1", // purl
  "0x0561f30a23cf47ba6b9acf7bc22fac1144e64fae", // base-payer
  "0xe54ef7a1b90bc18d5a68e9092b64a4b6812e407d", // AgentCash W0 seed
  "0xe4a34fb0f642778f612793accdf1fad8ae358ee8", // bazaar connect
  "0x5016cfc01db6ec359465bda316404947a5b5893a", // Patty box / AgentCash W1 seeding wallet
] as const;

const FILTER_OFF = new Set(["off", "none", "false", "0"]);

function deduped(wallets: readonly string[]): string[] {
  const out: string[] = [];
  for (const wallet of wallets) {
    if (!out.includes(wallet)) out.push(wallet);
  }
  return out;
}

/**
 * Wallets treated as internal on this process.
 * Unset or blank env: the built-in list.
 * `off` / `none` / `false` / `0`: no wallet filter (external matches all).
 * Any other value: built-in list plus valid 0x addresses. Invalid tokens are ignored.
 */
export function internalWallets(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.LIVECHECK_INTERNAL_WALLETS;
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_INTERNAL_WALLETS];
  const trimmed = raw.trim();
  if (FILTER_OFF.has(trimmed.toLowerCase())) return [];
  const extra: string[] = [];
  for (const part of trimmed.split(/[\s,]+/)) {
    const payer = sanitizePayer(part);
    if (payer) extra.push(payer);
  }
  return deduped([...DEFAULT_INTERNAL_WALLETS, ...extra]);
}
