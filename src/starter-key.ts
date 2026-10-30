import { createHash, createHmac, randomBytes } from "node:crypto";
import { CHECK_TIMEOUT_SIGNAL } from "./config.js";

/**
 * Phase 1 starter keys. GitHub OAuth, no email, no card top-up.
 *
 * A free check spends one credit only for a real verify answer. Errors,
 * timeouts, and board-URL messages do not. Free checks write no paid_calls
 * row. Phase 2 (not built) would add paid_left and a paid_calls row with
 * payer `key:<id>`, which traffic-buckets treats as external.
 */

export const GITHUB_OAUTH_CLIENT_ID_ENV = "GITHUB_OAUTH_CLIENT_ID";
export const GITHUB_OAUTH_CLIENT_SECRET_ENV = "GITHUB_OAUTH_CLIENT_SECRET";

/** Same address as the free /job page and the OpenAPI contact. */
export const STARTER_KEY_CONTACT_EMAIL = "moyecj@gmail.com";

export const EMERGENCY_STOP_MESSAGE =
  "Starter keys are stopped. This is an emergency stop: every key is off until it is turned back on.";

export const WIND_DOWN_MESSAGE =
  "Starter key sign-up is closed. Existing keys keep working until they expire.";

export const OUT_OF_CHECKS_MESSAGE = `This starter key has used its free checks. Pay with a wallet (x402 on Base or MPP on Tempo) by calling this route without the key, or reply to get a top-up link: ${STARTER_KEY_CONTACT_EMAIL}.`;

export const STARTER_KEY_CALLBACK_PATH = "/keys/callback";
export const STARTER_KEY_PAGE_PATH = "/keys";

/** Shown once. Stored only as SHA-256. */
export const STARTER_KEY_PREFIX = "lc_live_";

export const STARTER_KEY_MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const STARTER_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const STARTER_KEY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const STARTER_KEY_PRIVACY_LINE = "We store your GitHub username to run your key. Nothing is shared.";
export const STARTER_KEY_CONTACT_LABEL = "OK to contact me about my experience";

export const CARD_FUNDED_PAYER_PREFIX = "key:";
const KEY_ID_RE = /^k_[a-f0-9]{16}$/;
const BEARER_RE = /^Bearer\s+(lc_live_[A-Za-z0-9_-]{40,90})$/i;

export const STARTER_KEY_SETTINGS = {
  /**
   * 1 stops every key immediately, including ones that have not expired.
   * For abuse, a cost spike, or a bug. Overrides wind_down. Default off.
   * Live: `keys:set emergency_stop 1`. No env var and no redeploy.
   */
  emergency_stop: { min: 0, max: 1, fallback: 0 },
  /**
   * 1 closes /keys sign-up. Unexpired keys keep their remaining checks
   * until they expire. Default off. Live: `keys:set wind_down 1`.
   */
  wind_down: { min: 0, max: 1, fallback: 0 },
  /** Free answers per UTC day, all keys. Operator-adjustable. Never raised by code. */
  daily_check_cap: { min: 0, max: 1_000_000, fallback: 2_000 },
  per_key_daily_checks: { min: 1, max: 100_000, fallback: 200 },
  per_key_per_minute: { min: 1, max: 10_000, fallback: 60 },
  issuance_per_ip: { min: 0, max: 1_000, fallback: 3 },
  issuance_per_day: { min: 0, max: 100_000, fallback: 50 },
  /** Allowance copied onto a key at issue. Later changes do not rewrite old keys. */
  free_allowance: { min: 1, max: 1_000_000, fallback: 200 },
  /**
   * Auto-suspend only after this many completed target outcomes in the hour,
   * and only when blocked outcomes are more than half of them.
   */
  abuse_min_samples: { min: 1, max: 10_000, fallback: 10 },
} as const;

export type StarterSettingKey = keyof typeof STARTER_KEY_SETTINGS;

export type StarterKeySettings = Partial<Record<StarterSettingKey, number>>;

export type StarterKeyLimits = {
  /** Every key stops immediately. Overrides wind-down. */
  emergencyStop: boolean;
  /** No new keys. Existing unexpired keys still run. */
  windDown: boolean;
  dailyCheckCap: number;
  perKeyDailyChecks: number;
  perKeyPerMinute: number;
  issuancePerIp: number;
  issuancePerDay: number;
  freeAllowance: number;
  abuseMinSamples: number;
};

export function githubOauthConfig(
  env: NodeJS.ProcessEnv = process.env,
): { clientId: string; clientSecret: string } | undefined {
  const clientId = env[GITHUB_OAUTH_CLIENT_ID_ENV]?.trim() ?? "";
  const clientSecret = env[GITHUB_OAUTH_CLIENT_SECRET_ENV]?.trim() ?? "";
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

export function isStarterSettingKey(value: unknown): value is StarterSettingKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STARTER_KEY_SETTINGS, value);
}

export function parseStarterKeySetting(key: unknown, raw: unknown): { key: StarterSettingKey; value: number } {
  if (!isStarterSettingKey(key)) {
    throw new Error(`unknown setting ${String(key)}; use one of: ${Object.keys(STARTER_KEY_SETTINGS).join(", ")}`);
  }
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim().toLowerCase();
  const flag = STARTER_KEY_SETTINGS[key].min === 0 && STARTER_KEY_SETTINGS[key].max === 1;
  const value =
    flag && (text === "on" || text === "true") ? 1 : flag && (text === "off" || text === "false") ? 0 : Number(text);
  const { min, max } = STARTER_KEY_SETTINGS[key];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be a whole number from ${min} to ${max}, got ${String(raw)}`);
  }
  return { key, value };
}

export function resolveStarterKeyLimits(settings: StarterKeySettings): StarterKeyLimits {
  const pick = (key: StarterSettingKey): number => {
    const value = settings[key];
    const spec = STARTER_KEY_SETTINGS[key];
    if (value === undefined || !Number.isInteger(value) || value < spec.min || value > spec.max) return spec.fallback;
    return value;
  };
  return {
    emergencyStop: pick("emergency_stop") === 1,
    windDown: pick("wind_down") === 1,
    dailyCheckCap: pick("daily_check_cap"),
    perKeyDailyChecks: pick("per_key_daily_checks"),
    perKeyPerMinute: pick("per_key_per_minute"),
    issuancePerIp: pick("issuance_per_ip"),
    issuancePerDay: pick("issuance_per_day"),
    freeAllowance: pick("free_allowance"),
    abuseMinSamples: pick("abuse_min_samples"),
  };
}

/** Missing or unparseable GitHub `created_at` fails closed (treated as too young). */
export function githubAccountTooYoung(createdAt: string, now: Date): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return true;
  return now.getTime() - created < STARTER_KEY_MIN_ACCOUNT_AGE_MS;
}

export function isoStamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function newStarterKeyId(): string {
  return `k_${randomBytes(8).toString("hex")}`;
}

export function newStarterKeySecret(): string {
  return `${STARTER_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashStarterKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A starter-key credential. Anything else (including MPP `Payment`) is not a key. */
export function parseStarterBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = BEARER_RE.exec(authorization.trim());
  return match?.[1];
}

/** HMAC of the client IP. The raw address is not stored. */
export function starterKeyIpSubject(ip: string, pepper: string): string {
  const mac = createHmac("sha256", pepper).update(`starter-key-ip:${ip}`).digest("hex");
  return `ip:${mac}`;
}

/**
 * Phase 2 payer. Free checks never write this. The id is the pseudonymous
 * key id, never a GitHub login.
 */
export function cardFundedPayer(keyId: string): string {
  if (!KEY_ID_RE.test(keyId)) throw new Error("starter key id is not a pseudonymous id");
  return `${CARD_FUNDED_PAYER_PREFIX}${keyId}`;
}

export function isCardFundedPayer(payer: string | null | undefined): boolean {
  const value = payer?.trim().toLowerCase() ?? "";
  return /^key:k_[a-f0-9]{16}$/.test(value);
}

export type StarterSpend = { charge: boolean; blocked: boolean };

/**
 * Charge only a real answer: HTTP 200 with live, closed, or unknown
 * ("can't tell"). Our errors, check timeouts, and board-URL messages
 * (not a specific posting / a collection) do not spend a credit.
 *
 * Blocked, for auto-suspend, is a challenge, a login wall, or target
 * HTTP 401/403/429. A 404/410 closed posting is a real answer, not abuse.
 * Board-URL messages are not abuse.
 */
export function classifyStarterSpend(status: number, body: unknown): StarterSpend {
  if (status !== 200 || body === null || typeof body !== "object") return { charge: false, blocked: false };
  const record = body as { status?: unknown; signals?: unknown; http_status?: unknown };
  const signals = Array.isArray(record.signals) ? record.signals.filter((item): item is string => typeof item === "string") : [];
  const httpStatus = typeof record.http_status === "number" ? record.http_status : 0;
  const board = signals.includes("not_a_specific_posting") || signals.includes("collection_or_category");
  const timeout = signals.includes(CHECK_TIMEOUT_SIGNAL);
  const verdict = record.status;
  const real = verdict === "live" || verdict === "closed" || verdict === "unknown";
  const blocked =
    !board &&
    (signals.includes("challenge_page") ||
      signals.includes("loginwalled") ||
      httpStatus === 401 ||
      httpStatus === 403 ||
      httpStatus === 429);
  return { charge: real && !board && !timeout, blocked };
}

let clock: () => Date = () => new Date();

export function starterKeyNow(): Date {
  return clock();
}

export function setStarterKeyClockForTests(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date());
}
