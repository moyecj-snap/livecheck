import { DEFAULT_PORT } from "./config.js";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function originOnly(value: string): string {
  return stripTrailingSlash(value).replace(/\/v1\/verify$/i, "");
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

/** Public origin for 402 resource URLs. Not a secret. */
export function publicOrigin(requestUrl?: string): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  if (!requestUrl) return `http://127.0.0.1:${DEFAULT_PORT}`;
  return httpsIfFly(new URL(requestUrl).origin);
}

export function publicVerifyUrl(requestUrl?: string): string {
  return `${publicOrigin(requestUrl)}/v1/verify`;
}
