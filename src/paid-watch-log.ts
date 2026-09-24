import type { MiddlewareHandler } from "hono";
import { shortPublicReason } from "./catalog-payload.js";
import { MOCK_PAYMENT_HEADER } from "./config.js";
import { decodePaymentRequired } from "./x402-payload.js";

const HEADER_NAMES = ["payment-signature", "PAYMENT-SIGNATURE", "x-payment", "X-PAYMENT"] as const;

export type InboundPaymentSummary = {
  header: string;
  header_len: number;
  amount: string | null;
  resource_url: string | null;
  desc_len: number | null;
  extension_keys: string[];
  has_bazaar: boolean;
  decode: "ok" | "undecodable";
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function pickAmount(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const amount = record.amount;
  if (typeof amount === "string" && amount.trim()) return amount.trim();
  if (typeof amount === "number" && Number.isFinite(amount)) return String(Math.trunc(amount));
  return null;
}

function decodeEnvelope(raw: string): unknown {
  const text = raw.trim();
  if (text.startsWith("{")) return JSON.parse(text) as unknown;
  return JSON.parse(Buffer.from(text, "base64").toString("utf8")) as unknown;
}

/** Safe fields from a PAYMENT-SIGNATURE. Never includes payload, signature, or authorization. */
export function summarizeInboundPayment(headerName: string, raw: string): InboundPaymentSummary {
  const base: InboundPaymentSummary = {
    header: headerName.toLowerCase(),
    header_len: Buffer.byteLength(raw, "utf8"),
    amount: null,
    resource_url: null,
    desc_len: null,
    extension_keys: [],
    has_bazaar: false,
    decode: "undecodable",
  };
  try {
    const decoded = asRecord(decodeEnvelope(raw));
    if (!decoded) return base;
    const resource = asRecord(decoded.resource);
    const extensions = asRecord(decoded.extensions);
    const url = resource && typeof resource.url === "string" ? resource.url : null;
    const description = resource && typeof resource.description === "string" ? resource.description : null;
    return {
      ...base,
      amount: pickAmount(decoded.accepted) ?? pickAmount(decoded),
      resource_url: url,
      desc_len: description == null ? null : description.length,
      extension_keys: extensions ? Object.keys(extensions) : [],
      has_bazaar: Boolean(extensions && "bazaar" in extensions),
      decode: "ok",
    };
  } catch {
    return base;
  }
}

export function paidWatchPaymentHeader(headers: {
  get(name: string): string | undefined | null;
}): { name: string; raw: string } | null {
  for (const name of HEADER_NAMES) {
    const raw = headers.get(name);
    if (!raw || !raw.trim() || raw.trim() === MOCK_PAYMENT_HEADER) continue;
    return { name, raw };
  }
  return null;
}

export function formatPaidWatchInboundLog(summary: InboundPaymentSummary): string {
  return `[livecheck] paid watch inbound ${JSON.stringify(summary)}`;
}

export function formatPaidWatchRejectedLog(status: number, reason: string): string {
  return `[livecheck] paid watch rejected ${JSON.stringify({
    status,
    reason: shortPublicReason(reason),
  })}`;
}

function isWatchCreatePath(path: string): boolean {
  return path === "/v1/watch" || path === "/v1/watch/";
}

function reasonFromResponse(res: Response): Promise<string> {
  const paymentRequired = res.headers.get("payment-required") ?? res.headers.get("PAYMENT-REQUIRED");
  if (paymentRequired) {
    try {
      const decoded = decodePaymentRequired(paymentRequired);
      if (typeof decoded.error === "string" && decoded.error.trim()) {
        return Promise.resolve(decoded.error);
      }
    } catch {
      return Promise.resolve("payment-required undecodable");
    }
  }
  return res
    .clone()
    .text()
    .then((text) => {
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
        if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
      } catch {
        // fall through
      }
      const compact = text.replace(/\s+/g, " ").trim();
      return compact || `HTTP ${res.status}`;
    })
    .catch(() => `HTTP ${res.status}`);
}

/**
 * Log a paid POST /v1/watch before the x402 middleware calls the facilitator,
 * and log a short reject reason when that attempt does not return 2xx.
 * Mock header `livecheck-dev` is ignored. No signatures.
 */
export function withPaidWatchAttemptLog(inner: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    const paid =
      c.req.method === "POST" && isWatchCreatePath(c.req.path)
        ? paidWatchPaymentHeader({ get: (name) => c.req.header(name) })
        : null;
    if (paid) {
      console.log(formatPaidWatchInboundLog(summarizeInboundPayment(paid.name, paid.raw)));
    }
    try {
      const result = await inner(c, next);
      if (!paid) return result;
      const res = result instanceof Response ? result : c.res;
      if (res && res.status >= 400) {
        const reason = await reasonFromResponse(res);
        console.log(formatPaidWatchRejectedLog(res.status, reason));
      }
      return result;
    } catch (error) {
      if (paid) {
        const message = error instanceof Error ? error.message : "paid watch failed";
        console.log(formatPaidWatchRejectedLog(500, message));
      }
      throw error;
    }
  };
}
