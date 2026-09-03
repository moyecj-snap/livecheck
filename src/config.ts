export const PRICE_USD = 0.01;
export const PRICE_LABEL = "$0.01";
/** $0.01 USDC at 6 decimals = 10000 atomic. */
export const PRICE_ATOMIC_USDC = "10000";
export const NETWORK = "eip155:8453";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_EIP712 = { name: "USD Coin", version: "2" } as const;
export const VERIFY_DESCRIPTION =
  "Before you scrape a job, product, or eBay item page, POST the specific URL you already have and Livecheck returns live, closed, or unknown plus title and signals (apply form, in-stock, sold-out, 404); not a search engine.";
export const USER_AGENT =
  "Livecheck/0.1 (+https://livecheck.local; primary-source verification)";
export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_BODY_BYTES = 1_500_000;
export const DEFAULT_PORT = 43127;
export const STRIPE_X402_API_VERSION = "2026-05-27.preview";
export const MOCK_PAY_TO = "0x2222222222222222222222222222222222222222";
export const MOCK_PAYMENT_HEADER = "livecheck-dev";

const requiredLive = [
  "STRIPE_SECRET_KEY",
  "DEPOSIT_ADDRESS",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
] as const;

export type LiveKeys = {
  stripeSecretKey: string;
  depositAddress: string;
  cdpApiKeyId: string;
  cdpApiKeySecret: string;
};

export function readLiveKeys(): LiveKeys | null {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const depositAddress = process.env.DEPOSIT_ADDRESS?.trim();
  const cdpApiKeyId = process.env.CDP_API_KEY_ID?.trim();
  const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET?.trim();
  if (!stripeSecretKey || !depositAddress || !cdpApiKeyId || !cdpApiKeySecret) {
    return null;
  }
  return {
    stripeSecretKey,
    depositAddress: depositAddress.toLowerCase(),
    cdpApiKeyId,
    cdpApiKeySecret,
  };
}

export function missingLiveKeyNames(): string[] {
  return requiredLive.filter((name) => !process.env[name]?.trim());
}

export function isLiveSettlement(): boolean {
  return readLiveKeys() !== null;
}

export function payToAddress(): string {
  return readLiveKeys()?.depositAddress ?? MOCK_PAY_TO;
}

export function port(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}
