import { DEFAULT_PORT } from "./config.js";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function originOnly(value: string): string {
  return stripTrailingSlash(value).replace(/\/v1\/(verify|check|watch|confirm(\/order)?)$/i, "");
}

/** Force https for Fly public hostnames. 402 resource.url must not be http in production. */
function httpsIfFly(origin: string): string {
  try {
    const url = new URL(origin.includes("://") ? origin : `https://${origin}`);
    if (url.hostname === "livecheck.fly.dev" || url.hostname.endsWith(".fly.dev")) {
      url.protocol = "https:";
    }
    return url.origin;
  } catch {
    return origin;
  }
}

/**
 * Public origin when explicitly configured (not a secret).
 * LIVECHECK_PUBLIC_URL is the intended override; Fly also sets FLY_APP_NAME.
 */
export function configuredPublicOrigin(): string | undefined {
  const configured = process.env.LIVECHECK_PUBLIC_URL?.trim();
  if (configured) {
    return httpsIfFly(originOnly(configured));
  }
  const flyApp = process.env.FLY_APP_NAME?.trim();
  if (flyApp) {
    return `https://${flyApp}.fly.dev`;
  }
  return undefined;
}

function flyHost(host?: string): string | undefined {
  const name = host?.trim().split(":")[0];
  if (!name) return undefined;
  if (name === "livecheck.fly.dev" || name.endsWith(".fly.dev")) return name;
  return undefined;
}

/** Public origin for 402 resource URLs. Not a secret. */
export function publicOrigin(requestUrl?: string, host?: string): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  const fromHost = flyHost(host);
  if (fromHost) return `https://${fromHost}`;
  if (!requestUrl) return `http://127.0.0.1:${DEFAULT_PORT}`;
  try {
    return httpsIfFly(new URL(requestUrl).origin);
  } catch {
    return `http://127.0.0.1:${DEFAULT_PORT}`;
  }
}

export function publicVerifyUrl(requestUrl?: string, host?: string): string {
  return `${publicOrigin(requestUrl, host)}/v1/verify`;
}

export function publicConfirmUrl(requestUrl?: string, host?: string): string {
  return `${publicOrigin(requestUrl, host)}/v1/confirm`;
}

export function publicConfirmOrderUrl(requestUrl?: string, host?: string): string {
  return `${publicOrigin(requestUrl, host)}/v1/confirm/order`;
}

export function publicCheckUrl(requestUrl?: string, host?: string): string {
  return `${publicOrigin(requestUrl, host)}/v1/check`;
}

export function publicWatchUrl(requestUrl?: string, host?: string): string {
  return `${publicOrigin(requestUrl, host)}/v1/watch`;
}

export type PaidResourceKind = "verify" | "confirm" | "confirm_order" | "check" | "watch";

function pathnameOf(requestUrl?: string): string | undefined {
  if (!requestUrl) return undefined;
  try {
    return new URL(requestUrl).pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function isConfirmOrderRequestPath(requestUrl?: string): boolean {
  const pathname = pathnameOf(requestUrl);
  if (pathname) return pathname.endsWith("/v1/confirm/order");
  return Boolean(requestUrl && /\/v1\/confirm\/order\/?(\?|$)/i.test(requestUrl));
}

export function isConfirmRequestPath(requestUrl?: string): boolean {
  if (isConfirmOrderRequestPath(requestUrl)) return false;
  const pathname = pathnameOf(requestUrl);
  if (pathname) return pathname.endsWith("/v1/confirm");
  return Boolean(requestUrl && /\/v1\/confirm\/?(\?|$)/i.test(requestUrl));
}

export function isCheckRequestPath(requestUrl?: string): boolean {
  const pathname = pathnameOf(requestUrl);
  if (pathname) return pathname.endsWith("/v1/check");
  return Boolean(requestUrl && /\/v1\/check\/?(\?|$)/i.test(requestUrl));
}

export function isWatchRequestPath(requestUrl?: string): boolean {
  const pathname = pathnameOf(requestUrl);
  if (pathname) return pathname.endsWith("/v1/watch");
  return Boolean(requestUrl && /\/v1\/watch\/?(\?|$)/i.test(requestUrl));
}

export function paidResourceKind(requestUrl?: string): PaidResourceKind {
  if (isConfirmOrderRequestPath(requestUrl)) return "confirm_order";
  if (isConfirmRequestPath(requestUrl)) return "confirm";
  if (isWatchRequestPath(requestUrl)) return "watch";
  if (isCheckRequestPath(requestUrl)) return "check";
  return "verify";
}

export function isPaidPostPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "") || "/";
  return (
    normalized === "/v1/verify" ||
    normalized === "/v1/check" ||
    normalized === "/v1/watch" ||
    normalized === "/v1/confirm" ||
    normalized === "/v1/confirm/order"
  );
}
