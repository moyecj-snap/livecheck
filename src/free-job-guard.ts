import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";

/**
 * Outbound fetch for the free /job page. Anyone can make the server fetch a
 * link for free, so every hop is:
 *
 * 1. Parsed: http(s) only, no credentials, port 80/443 only.
 * 2. Resolved ONCE, and every returned address vetted (private, loopback,
 *    link-local incl. metadata 169.254.169.254 / fd00:ec2::254, CGNAT,
 *    Fly 6PN fdaa::/16, IPv4-mapped / NAT64 forms, multicast, reserved).
 * 3. Connected to that vetted address only: the socket's `lookup` returns
 *    the pinned IP, so DNS cannot rebind between the check and the connect.
 *    Host header and TLS SNI stay the real hostname.
 * 4. Capped: body bytes (after decompression), a per-hop timeout covering
 *    connect + headers + body, and a maximum number of redirects. Redirects
 *    are followed by hand so each hop repeats 1–3.
 */
export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

export type FetchPolicy = {
  resolver: Resolver;
  isBlocked: (ip: string) => boolean;
  allowedPorts: ReadonlySet<string>;
  maxBodyBytes: number;
  hopTimeoutMs: number;
  maxRedirects: number;
};

export const FREE_FETCH_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const FREE_FETCH_HOP_TIMEOUT_MS = 8_000;
export const FREE_FETCH_MAX_REDIRECTS = 5;

const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local", ".flycast", ".lan", ".home.arpa", ".intranet", ".corp"];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function expandV6(ip: string): number[] | undefined {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  const v4Tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail?.[1]) {
    const n = v4ToInt(v4Tail[1]);
    addr = addr.slice(0, -v4Tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const hasGap = addr.includes("::");
  const [head, tail] = addr.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (hasGap ? missing < 0 : headParts.length !== 8) return undefined;
  const parts = [...headParts, ...Array(hasGap ? missing : 0).fill("0"), ...tailParts];
  const out = parts.map((part) => parseInt(part || "0", 16));
  return out.length === 8 && out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : undefined;
}

export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return V4_BLOCKED.some(([base, bits]) => inV4(ip, base, bits));
  if (kind !== 6) return true;
  const g = expandV6(ip);
  if (!g) return true;
  if (g.every((n) => n === 0)) return true; // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  const v4 = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96): judge the IPv4 inside.
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return isBlockedAddress(v4);
  if (g[0] === 0x64 && g[1] === 0xff9b) return isBlockedAddress(v4);
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local: Fly 6PN fdaa::/16, AWS metadata fd00:ec2::254
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return isBlockedAddress(`${g[1]! >>> 8}.${g[1]! & 0xff}.${g[2]! >>> 8}.${g[2]! & 0xff}`); // 6to4
  return false;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = {
  resolver: defaultResolver,
  isBlocked: isBlockedAddress,
  allowedPorts: new Set(["", "80", "443"]),
  maxBodyBytes: FREE_FETCH_MAX_BODY_BYTES,
  hopTimeoutMs: FREE_FETCH_HOP_TIMEOUT_MS,
  maxRedirects: FREE_FETCH_MAX_REDIRECTS,
};

export type VettedTarget = { url: URL; hostname: string; address: string; family: 4 | 6 };

/**
 * Parse, resolve once, and vet. Returns the single address the connection
 * will use. Throws BlockedTargetError for anything not public.
 */
export async function vetTarget(raw: string, policy: FetchPolicy = DEFAULT_FETCH_POLICY): Promise<VettedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError("not a valid link");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedTargetError("only http and https links");
  if (url.username || url.password) throw new BlockedTargetError("links with a username or password are not checked");
  if (!policy.allowedPorts.has(url.port)) throw new BlockedTargetError("only standard web ports");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new BlockedTargetError("not a public website");
  }
  const literal = isIP(hostname);
  if (literal) {
    if (policy.isBlocked(hostname)) throw new BlockedTargetError("not a public website");
    return { url, hostname, address: hostname, family: literal as 4 | 6 };
  }
  if (!hostname.includes(".")) throw new BlockedTargetError("not a public website");
  let addresses: string[];
  try {
    addresses = await policy.resolver(hostname);
  } catch {
    throw new BlockedTargetError("could not resolve that site");
  }
  if (!addresses.length) throw new BlockedTargetError("could not resolve that site");
  if (addresses.some((address) => policy.isBlocked(address))) throw new BlockedTargetError("not a public website");
  const address = addresses[0]!;
  return { url, hostname, address, family: isIP(address) === 6 ? 6 : 4 };
}

/** Back-compat helper used by the page before any fetch. */
export async function assertPublicTarget(raw: string, policy: FetchPolicy = DEFAULT_FETCH_POLICY): Promise<void> {
  await vetTarget(raw, policy);
}

function pinnedLookup(target: VettedTarget): LookupFunction {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    if (all) cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  }) as LookupFunction;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function decoded(res: IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(createGunzip());
  if (encoding === "deflate") return res.pipe(createInflate());
  if (encoding === "br") return res.pipe(createBrotliDecompress());
  return res;
}

export type HopStats = { bytes: number; truncated: boolean };

/** One hop to a vetted target. Exported for tests. */
export function requestOnce(
  target: VettedTarget,
  init: { method: string; headers: Headers; signal?: AbortSignal | null },
  policy: FetchPolicy,
  onDone?: (stats: HopStats) => void,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const isHttps = target.url.protocol === "https:";
    const headers: Record<string, string> = {};
    init.headers.forEach((value, key) => {
      headers[key] = value;
    });
    headers["accept-encoding"] = "gzip, deflate, br";
    let settled = false;
    let finished = false;
    let stats: HopStats = { bytes: 0, truncated: false };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
      onDone?.(stats);
    };
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        finish();
        reject(error);
      }
    };
    const req = (isHttps ? httpsRequest : httpRequest)({
      protocol: target.url.protocol,
      hostname: target.hostname,
      port: target.url.port || (isHttps ? 443 : 80),
      path: `${target.url.pathname}${target.url.search}`,
      method: init.method,
      headers,
      agent: false,
      lookup: pinnedLookup(target),
      servername: isIP(target.hostname) ? undefined : target.hostname,
    });
    const timer = setTimeout(() => {
      const error = new Error(`timed out after ${policy.hopTimeoutMs}ms`);
      error.name = "TimeoutError";
      req.destroy(error);
    }, policy.hopTimeoutMs);
    const onAbort = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      req.destroy(error);
    };
    if (init.signal?.aborted) {
      onAbort();
    } else {
      init.signal?.addEventListener("abort", onAbort, { once: true });
    }
    req.on("error", (error) => fail(error));
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) {
        req.destroy();
        fail(new Error(`unsupported HTTP status ${status}`));
        return;
      }
      const outHeaders = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        const name = res.rawHeaders[i]!.toLowerCase();
        if (name === "content-encoding" || name === "content-length" || name === "transfer-encoding") continue;
        try {
          outHeaders.append(name, res.rawHeaders[i + 1]!);
        } catch {
          // skip invalid header values
        }
      }
      if (NULL_BODY_STATUS.has(status) || init.method === "HEAD") {
        res.resume();
        res.on("end", finish);
        res.on("error", finish);
        settled = true;
        resolve(new Response(null, { status, statusText: res.statusMessage, headers: outHeaders }));
        return;
      }
      const source = decoded(res);
      let closed = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const close = () => {
            if (closed) return;
            closed = true;
            finish();
            controller.close();
          };
          source.on("data", (chunk: Buffer) => {
            if (closed) return;
            const remaining = policy.maxBodyBytes - stats.bytes;
            if (chunk.length >= remaining) {
              if (remaining > 0) controller.enqueue(new Uint8Array(chunk.subarray(0, remaining)));
              stats = { bytes: stats.bytes + Math.max(0, remaining), truncated: true };
              close();
              req.destroy();
              return;
            }
            stats = { bytes: stats.bytes + chunk.length, truncated: false };
            controller.enqueue(new Uint8Array(chunk));
          });
          source.on("end", close);
          const onError = (error: Error) => {
            if (closed) return;
            closed = true;
            finish();
            controller.error(error);
          };
          source.on("error", onError);
          if (source !== res) res.on("error", onError);
          req.on("error", onError);
          // A destroyed socket mid-body ends the response without 'end'.
          res.on("aborted", () => onError(new Error("connection closed before the body finished")));
        },
        cancel() {
          closed = true;
          finish();
          req.destroy();
        },
      });
      settled = true;
      resolve(new Response(body, { status, statusText: res.statusMessage, headers: outHeaders }));
    });
    req.end();
  });
}

/**
 * fetch-compatible function for the free page. GET/HEAD only. Redirects are
 * followed by hand (max `maxRedirects`), each hop vetted, resolved once, and
 * pinned. The final Response reports the final URL as `response.url`, like
 * `redirect: "follow"`, so the shared classifier judges redirects the same way.
 */
export function guardedFetch(policy: FetchPolicy = DEFAULT_FETCH_POLICY): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let current = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new TypeError(`free page fetch is GET/HEAD only, got ${method}`);
    const headers = new Headers(init?.headers ?? {});
    for (let hop = 0; hop <= policy.maxRedirects; hop++) {
      const target = await vetTarget(current, policy);
      const res = await requestOnce(target, { method, headers, signal: init?.signal }, policy);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        current = new URL(location, current).href;
        continue;
      }
      Object.defineProperty(res, "url", { value: current });
      return res;
    }
    throw new TypeError(`more than ${policy.maxRedirects} redirects`);
  }) as typeof fetch;
}
