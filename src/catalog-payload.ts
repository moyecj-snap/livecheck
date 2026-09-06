import { confirmBazaarExtensions, verifyBazaarExtensions } from "./bazaar.js";
import { CONFIRM_DESCRIPTION, VERIFY_DESCRIPTION } from "./config.js";
import { publicConfirmUrl, publicVerifyUrl } from "./public-url.js";

export type CatalogResourceInfo = {
  url: string;
  description: string;
  mimeType: string;
};

export type PaymentEnvelope = {
  x402Version?: number;
  resource?: unknown;
  extensions?: Record<string, unknown>;
  accepted?: unknown;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
};

export function advertisedResourceInfo(kind: "verify" | "confirm" = "verify"): CatalogResourceInfo {
  if (kind === "confirm") {
    return {
      url: publicConfirmUrl(),
      description: CONFIRM_DESCRIPTION,
      mimeType: "application/json",
    };
  }
  return {
    url: publicVerifyUrl(),
    description: VERIFY_DESCRIPTION,
    mimeType: "application/json",
  };
}

function resourceKindFromUrl(url: string | undefined): "verify" | "confirm" {
  if (url && /\/v1\/confirm\/?(\?|$)/i.test(url)) return "confirm";
  return "verify";
}

/** URL on a v2 PaymentPayload.resource (object or string). Never logs the signed payload. */
export function paymentPayloadResourceUrl(payload: PaymentEnvelope): string | undefined {
  const resource = payload.resource;
  if (typeof resource === "string") {
    const trimmed = resource.trim();
    return trimmed || undefined;
  }
  if (resource && typeof resource === "object" && "url" in resource) {
    const url = (resource as { url?: unknown }).url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  return undefined;
}

export function paymentPayloadHasBazaar(payload: PaymentEnvelope): boolean {
  const extensions = payload.extensions;
  if (!extensions || typeof extensions !== "object") return false;
  return extensions.bazaar !== undefined && extensions.bazaar !== null;
}

function needsAdvertisedResource(url: string | undefined, advertisedUrl: string): boolean {
  return url !== advertisedUrl;
}

/**
 * @x402/hono passes the client PAYMENT-SIGNATURE envelope to /verify and /settle
 * unchanged. Route resource + bazaar live on the 402, not on that envelope.
 * CDP catalogs from paymentPayload.resource + echoed bazaar on settle.
 */
export function fillCatalogPaymentPayload(payload: PaymentEnvelope): {
  payload: PaymentEnvelope;
  resourceFilled: boolean;
  bazaarFilled: boolean;
} {
  const inboundUrl = paymentPayloadResourceUrl(payload);
  const kind = resourceKindFromUrl(inboundUrl);
  const advertised = advertisedResourceInfo(kind);
  const resourceFilled = needsAdvertisedResource(inboundUrl, advertised.url);
  const bazaarFilled = !paymentPayloadHasBazaar(payload);

  const next: PaymentEnvelope = { ...payload };
  if (resourceFilled) {
    next.resource = advertised;
  } else if (typeof payload.resource === "string") {
    next.resource = { ...advertised, url: inboundUrl };
  }

  if (bazaarFilled) {
    const bazaar = kind === "confirm" ? confirmBazaarExtensions() : verifyBazaarExtensions();
    next.extensions = {
      ...bazaar,
      ...(payload.extensions && typeof payload.extensions === "object" ? payload.extensions : {}),
    };
  }

  return { payload: next, resourceFilled, bazaarFilled };
}

export function summarizeCatalogPayload(payload: PaymentEnvelope): {
  resource_present: boolean;
  resource_url: string | null;
  bazaar_echo: boolean;
  extension_keys: string[];
} {
  const url = paymentPayloadResourceUrl(payload);
  const extensions =
    payload.extensions && typeof payload.extensions === "object" ? payload.extensions : {};
  return {
    resource_present: Boolean(url),
    resource_url: url ?? null,
    bazaar_echo: paymentPayloadHasBazaar(payload),
    extension_keys: Object.keys(extensions),
  };
}

export type ExtensionResponsesLog = {
  present: boolean;
  empty: boolean;
  header_names: string[];
  bazaar_status: string | null;
  rejected_reason: string | null;
  keys: string[];
};

export function decodeExtensionResponsesHeader(
  raw: string | null | undefined,
  headerNames: string[] = [],
): ExtensionResponsesLog {
  if (!raw || !String(raw).trim()) {
    return {
      present: false,
      empty: true,
      header_names: headerNames,
      bazaar_status: null,
      rejected_reason: null,
      keys: [],
    };
  }
  let decoded: unknown;
  try {
    const text = String(raw).trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      decoded = JSON.parse(text);
    } else {
      decoded = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
    }
  } catch {
    return {
      present: true,
      empty: true,
      header_names: headerNames,
      bazaar_status: null,
      rejected_reason: null,
      keys: ["<undecodable>"],
    };
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return {
      present: true,
      empty: true,
      header_names: headerNames,
      bazaar_status: null,
      rejected_reason: null,
      keys: [],
    };
  }
  const record = decoded as Record<string, unknown>;
  const keys = Object.keys(record);
  const bazaar = record.bazaar;
  const bazaarObj = bazaar && typeof bazaar === "object" && !Array.isArray(bazaar) ? (bazaar as Record<string, unknown>) : null;
  const status = bazaarObj && typeof bazaarObj.status === "string" ? bazaarObj.status : null;
  const rejected =
    bazaarObj && typeof bazaarObj.rejectedReason === "string"
      ? bazaarObj.rejectedReason
      : bazaarObj && typeof bazaarObj.reason === "string"
        ? bazaarObj.reason
        : null;
  return {
    present: true,
    empty: keys.length === 0,
    header_names: headerNames,
    bazaar_status: status,
    rejected_reason: rejected,
    keys,
  };
}

export function formatFacilitatorLog(phase: "verify" | "settle", parts: Record<string, unknown>): string {
  return `[livecheck] facilitator ${phase} ${JSON.stringify(parts)}`;
}
