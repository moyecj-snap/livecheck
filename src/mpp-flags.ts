/**
 * MPP switches with no payment-library imports, so x402-only modules
 * (burst protection, health) can read them without loading mppx.
 */

const TRUTHY = new Set(["1", "true", "on", "yes"]);

/** MPP_ENABLED=1 turns the MPP dispatcher on. Anything else (including unset) is off. */
export function mppEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has(env.MPP_ENABLED?.trim().toLowerCase() ?? "");
}

const PAYMENT_SCHEME_RE = /(^|,)\s*payment\s+\S/i;

/** True when Authorization carries the MPP `Payment` scheme (not Bearer etc.). */
export function hasMppPaymentCredential(authorization: string | undefined | null): boolean {
  return typeof authorization === "string" && PAYMENT_SCHEME_RE.test(authorization);
}
