import { sanitizePayer, sanitizeTx } from "./paid-call.js";
import { retainRefundCandidate, type RefundCandidate } from "./paid-call-store.js";

/**
 * One stdout line per refund candidate (the durable fallback, searchable in
 * Fly logs) plus a best-effort row in refund_candidates (the nightly list).
 * Listing only: nothing here moves money. Craig approves each refund.
 */
export const REFUND_CANDIDATE_EVENT = "livecheck.refund_candidate" as const;

let defaultWriter: (line: string) => void = (line) => console.log(line);

/** Test seam for paths that do not take a writer (x402 guard, disconnect watch). */
export function setRefundCandidateWriterForTests(writer: ((line: string) => void) | null): void {
  defaultWriter = writer ?? ((line) => console.log(line));
}

export function logRefundCandidate(candidate: RefundCandidate, writer: (line: string) => void = defaultWriter): void {
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
  if (candidate.amount_usd !== undefined) line.amount_usd = candidate.amount_usd;
  if (candidate.responded_at !== undefined) line.responded_at = candidate.responded_at;
  if (candidate.settled_at !== undefined) line.settled_at = candidate.settled_at;
  writer(JSON.stringify(line));
  retainRefundCandidate(candidate);
}

/** Atomic token amount to a USD decimal string. USDC on Base and USDC.e on Tempo use 6 decimals. */
export function usdFromAtomic(amount: unknown, decimals = 6): string | undefined {
  const raw = typeof amount === "string" ? amount : typeof amount === "number" ? String(amount) : undefined;
  if (!raw || !/^\d{1,30}$/.test(raw)) return undefined;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const usd = frac ? `${whole}.${frac}` : whole;
  return /^\d{1,9}(\.\d{1,6})?$/.test(usd) ? usd : undefined;
}
