export const DEFAULT_LIVECHECK_URL = "http://127.0.0.1:43127/v1/verify";

export type PaymentRequiredChallenge = {
  paid: false;
  http: 402;
  [field: string]: unknown;
};

export function livecheckVerifyUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIVECHECK_URL?.trim() || DEFAULT_LIVECHECK_URL;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodePaymentRequiredHeader(header: string | null): Record<string, unknown> | null {
  if (!header?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function paymentRequiredResult(
  header: string | null,
  bodyText: string,
): PaymentRequiredChallenge {
  const decoded = decodePaymentRequiredHeader(header) ?? parseJsonObject(bodyText) ?? {};
  return { ...decoded, paid: false, http: 402 };
}

export async function verifyListing(
  url: string,
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const endpoint = options.endpoint ?? livecheckVerifyUrl();
  const fetcher = options.fetchImpl ?? fetch;

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ url }),
  });

  const text = await response.text();

  if (response.status === 402) {
    return paymentRequiredResult(response.headers.get("payment-required"), text);
  }

  if (response.status === 200) {
    const verdict = parseJsonObject(text);
    if (!verdict) {
      throw new Error("Livecheck returned HTTP 200 with a non-JSON body.");
    }
    return verdict;
  }

  const body = parseJsonObject(text);
  const error = new Error(`Livecheck returned HTTP ${response.status}.`);
  (error as Error & { http: number; body: unknown }).http = response.status;
  (error as Error & { http: number; body: unknown }).body = body ?? text;
  throw error;
}
