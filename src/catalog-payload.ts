import {
  chainTopupBazaarExtensions,
  checkBazaarExtensions,
  confirmBazaarExtensions,
  orderConfirmBazaarExtensions,
  verifyBazaarExtensions,
  watchRenewBazaarExtensions,
} from "./bazaar.js";
import {
  CHAIN_TOPUP_PAYMENT_DESCRIPTION,
  CHECK_PAYMENT_DESCRIPTION,
  CONFIRM_DESCRIPTION,
  CONFIRM_RESOURCE_TAGS,
  CONFIRM_SERVICE_NAME,
  ORDER_PAYMENT_DESCRIPTION,
  VERIFY_DESCRIPTION,
  WATCH_PAYMENT_DESCRIPTION,
  WATCH_RENEW_PAYMENT_DESCRIPTION,
} from "./config.js";
import {
  parseWatchChainTopupId,
  publicCheckUrl,
  publicConfirmOrderUrl,
  publicConfirmUrl,
  publicVerifyUrl,
  publicWatchChainTopupUrl,
  publicWatchRenewUrl,
  publicWatchUrl,
} from "./public-url.js";

export type CatalogResourceInfo = {
  url: string;
  description: string;
  mimeType: string;
  serviceName?: string;
  tags?: string[];
};

export type PaymentEnvelope = {
  x402Version?: number;
  resource?: unknown;
  extensions?: Record<string, unknown>;
  accepted?: unknown;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
};

export function advertisedResourceInfo(
  kind: "verify" | "confirm" | "confirm_order" | "check" | "watch" | "watch_renew" | "chain_topup" = "verify",
  inboundUrl?: string,
): CatalogResourceInfo {
  if (kind === "confirm_order") {
    return {
      url: publicConfirmOrderUrl(),
      description: ORDER_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
    };
  }
  if (kind === "confirm") {
    return {
      url: publicConfirmUrl(),
      description: CONFIRM_DESCRIPTION,
      mimeType: "application/json",
      serviceName: CONFIRM_SERVICE_NAME,
      tags: [...CONFIRM_RESOURCE_TAGS],
    };
  }
  if (kind === "check") {
    return {
      url: publicCheckUrl(),
      description: CHECK_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
    };
  }
  if (kind === "watch_renew") {
    return {
      url: publicWatchRenewUrl(),
      description: WATCH_RENEW_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
    };
  }
  if (kind === "watch") {
    return {
      url: publicWatchUrl(),
      description: WATCH_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
    };
  }
  if (kind === "chain_topup") {
    let watcherId: string | undefined;
    if (inboundUrl) {
      try {
        watcherId = parseWatchChainTopupId(new URL(inboundUrl).pathname);
      } catch {
        watcherId = undefined;
      }
    }
    return {
      url: publicWatchChainTopupUrl(inboundUrl, undefined, watcherId),
      description: CHAIN_TOPUP_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
    };
  }
  return {
    url: publicVerifyUrl(),
    description: VERIFY_DESCRIPTION,
    mimeType: "application/json",
  };
}

function resourceKindFromUrl(url: string | undefined): "verify" | "confirm" | "confirm_order" | "check" | "watch" | "watch_renew" | "chain_topup" {
  if (url && /\/v1\/confirm\/order\/?(\?|$)/i.test(url)) return "confirm_order";
  if (url && /\/v1\/confirm\/?(\?|$)/i.test(url)) return "confirm";
  if (url && /\/v1\/watch\/[^/?#]+\/chain\/topup\/?(\?|$)/i.test(url)) return "chain_topup";
  if (url && /\/v1\/watch\/renew\/?(\?|$)/i.test(url)) return "watch_renew";
  if (url && /\/v1\/watch\/?(\?|$)/i.test(url)) return "watch";
  if (url && /\/v1\/check\/?(\?|$)/i.test(url)) return "check";
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

/** CDP x402V2PaymentPayload schema: resource.description max 500 chars. */
export const CDP_RESOURCE_DESCRIPTION_MAX = 500;

function resourceDescription(resource: unknown): string | undefined {
  if (!resource || typeof resource !== "object" || !("description" in resource)) return undefined;
  const description = (resource as { description?: unknown }).description;
  return typeof description === "string" ? description : undefined;
}

/**
 * purl echoes the 402 resource onto paymentPayload. A description over 500
 * chars makes CDP /verify return 400 before it looks at the signature.
 * The field sits outside the EIP-3009 authorization, same as the URL backfill.
 */
function clampResourceDescription(
  resource: unknown,
  advertisedDescription: string,
): { resource: unknown; clamped: boolean } {
  const description = resourceDescription(resource);
  if (description == null || description.length <= CDP_RESOURCE_DESCRIPTION_MAX) {
    return { resource, clamped: false };
  }
  if (!resource || typeof resource !== "object") return { resource, clamped: false };
  const replacement =
    advertisedDescription.length <= CDP_RESOURCE_DESCRIPTION_MAX
      ? advertisedDescription
      : advertisedDescription.slice(0, CDP_RESOURCE_DESCRIPTION_MAX);
  return {
    resource: { ...(resource as Record<string, unknown>), description: replacement },
    clamped: true,
  };
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
  descriptionClamped: boolean;
} {
  const inboundUrl = paymentPayloadResourceUrl(payload);
  const kind = resourceKindFromUrl(inboundUrl);
  const advertised = advertisedResourceInfo(kind, inboundUrl);
  const resourceFilled = needsAdvertisedResource(inboundUrl, advertised.url);
  // Watch: do not inject (or forward) the fat bazaar. It is byte-identical to
  // the 402 extension that purl echoes, so backfill would hand CDP the schema
  // that fails verify. Other routes keep the Confirm-era catalog backfill.
  const omitWatchBazaar = kind === "watch";
  let bazaarFilled = !omitWatchBazaar && !paymentPayloadHasBazaar(payload);

  const next: PaymentEnvelope = { ...payload };
  if (resourceFilled) {
    next.resource = advertised;
  } else if (typeof payload.resource === "string") {
    next.resource = { ...advertised, url: inboundUrl };
  }
  const clamped = clampResourceDescription(next.resource, advertised.description);
  next.resource = clamped.resource as PaymentEnvelope["resource"];

  if (omitWatchBazaar) {
    if (next.extensions && typeof next.extensions === "object" && "bazaar" in next.extensions) {
      const rest = { ...next.extensions };
      delete rest.bazaar;
      next.extensions = rest;
    }
  } else if (bazaarFilled) {
    const bazaar =
      kind === "confirm_order"
        ? orderConfirmBazaarExtensions()
        : kind === "confirm"
          ? confirmBazaarExtensions()
          : kind === "check"
            ? checkBazaarExtensions()
            : kind === "watch_renew"
              ? watchRenewBazaarExtensions()
              : kind === "chain_topup"
                ? chainTopupBazaarExtensions()
                : verifyBazaarExtensions();
    next.extensions = {
      ...bazaar,
      ...(payload.extensions && typeof payload.extensions === "object" ? payload.extensions : {}),
    };
  }

  return { payload: next, resourceFilled, bazaarFilled, descriptionClamped: clamped.clamped };
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

/** Fly-safe reason: one line, no long hex (signatures), capped. */
export function shortPublicReason(value: string, limit = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const redacted = compact.replace(/0x[a-fA-F0-9]{16,}/g, "0x…");
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit - 3)}...`;
}

export function facilitatorErrorParts(error: unknown): { error_status: number | null; error_reason: string } {
  const message = error instanceof Error ? error.message : "facilitator error";
  const statusMatch = message.match(/\((\d{3})\)/);
  return {
    error_status: statusMatch ? Number(statusMatch[1]) : null,
    error_reason: shortPublicReason(message),
  };
}

export function resourceDescriptionLength(resource: unknown): number | null {
  if (!resource || typeof resource !== "object" || !("description" in resource)) return null;
  const description = (resource as { description?: unknown }).description;
  return typeof description === "string" ? description.length : null;
}
