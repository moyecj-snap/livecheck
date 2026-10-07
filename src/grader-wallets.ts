import { sanitizePayer } from "./paid-call.js";

/**
 * Public grader / auditor wallets. Their paid calls are test traffic.
 * `traffic.external` omits this list. Addresses stay off the public /stats
 * document; only the count is published.
 *
 * Stored lowercase. Add more at runtime with LIVECHECK_GRADER_WALLETS
 * (comma-separated). That env is additive. Set it to `off` to disable the list.
 */
export const DEFAULT_GRADER_WALLETS = [
  "0xec2abd3eda89bed90124736e317e847d5fb6d034", // Lumière paycheck prober
  "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670", // vet402 observatory
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
 * Wallets treated as grader/auditor traffic on this process.
 * Unset or blank env: the built-in list.
 * `off` / `none` / `false` / `0`: no grader filter.
 * Any other value: built-in list plus valid 0x addresses. Invalid tokens are ignored.
 */
export function graderWallets(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.LIVECHECK_GRADER_WALLETS;
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_GRADER_WALLETS];
  const trimmed = raw.trim();
  if (FILTER_OFF.has(trimmed.toLowerCase())) return [];
  const extra: string[] = [];
  for (const part of trimmed.split(/[\s,]+/)) {
    const payer = sanitizePayer(part);
    if (payer) extra.push(payer);
  }
  return deduped([...DEFAULT_GRADER_WALLETS, ...extra]);
}
