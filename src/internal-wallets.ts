import { sanitizePayer } from "./paid-call.js";

/**
 * Team wallets omitted from `traffic.external`. One list, one entry per wallet.
 * Add a wallet by appending one object. Addresses stay lowercase.
 * Labels are the reason and are not published on `/stats`.
 *
 * `LIVECHECK_INTERNAL_WALLETS` is additive (comma-separated 0x addresses).
 * `off` drops the list.
 * A paid_calls user_agent that starts with `livecheck-internal/` is internal
 * the same way, even when the payer is not in this list.
 */
export type InternalWallet = {
  address: string;
  label: string;
};

export const INTERNAL_USER_AGENT_PREFIX = "livecheck-internal/";

export const INTERNAL_WALLETS: readonly InternalWallet[] = [
  { address: "0xb78226fc84f02da1b69f5e10f595067e4f1987d1", label: "purl" },
  { address: "0x0561f30a23cf47ba6b9acf7bc22fac1144e64fae", label: "base-payer" },
  { address: "0xe54ef7a1b90bc18d5a68e9092b64a4b6812e407d", label: "Craig" },
  { address: "0xe4a34fb0f642778f612793accdf1fad8ae358ee8", label: "bazaar connect" },
  { address: "0x5016cfc01db6ec359465bda316404947a5b5893a", label: "AgentCash seed" },
];

export const DEFAULT_INTERNAL_WALLETS = INTERNAL_WALLETS.map((wallet) => wallet.address);

export function isInternalUserAgent(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLowerCase().startsWith(INTERNAL_USER_AGENT_PREFIX);
}

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
