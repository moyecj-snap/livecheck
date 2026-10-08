import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The free /job page fetches a stranger's link with no payment, so it only
 * fetches public web hosts: no localhost, private / link-local / Fly 6PN
 * (fdaa::/16) addresses, internal names, or odd ports. Every redirect hop is
 * checked too (see `guardedFetch`).
 */
export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local", ".flycast", ".lan", ".home.arpa", ".intranet", ".corp"];
const ALLOWED_PORTS = new Set(["", "80", "443"]);

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
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
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
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const v4Tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail?.[1]) {
    const n = v4ToInt(v4Tail[1]);
    addr = addr.slice(0, -v4Tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (addr.includes("::") ? missing < 0 : headParts.length !== 8) return undefined;
  const parts = [...headParts, ...Array(addr.includes("::") ? missing : 0).fill("0"), ...tailParts];
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
  // IPv4-mapped / -compatible / NAT64: judge the IPv4 inside.
  const v4 = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return isBlockedAddress(v4);
  if (g[0] === 0x64 && g[1] === 0xff9b) return isBlockedAddress(v4);
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (incl. Fly 6PN fdaa::/16)
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** Throws BlockedTargetError unless `raw` is an http(s) URL on a public host and a normal port. */
export async function assertPublicTarget(raw: string, resolver: Resolver = defaultResolver): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError("not a valid link");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedTargetError("only http and https links");
  if (url.username || url.password) throw new BlockedTargetError("links with a username or password are not checked");
  if (!ALLOWED_PORTS.has(url.port)) throw new BlockedTargetError("only standard web ports");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new BlockedTargetError("not a public website");
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new BlockedTargetError("not a public website");
    return;
  }
  if (!host.includes(".")) throw new BlockedTargetError("not a public website");
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    // Unknown host: let the fetch fail normally (reported as Can't tell).
    return;
  }
  if (addresses.some(isBlockedAddress)) throw new BlockedTargetError("not a public website");
}

const MAX_REDIRECTS = 5;

/**
 * fetch with redirects followed by hand so each hop passes `assertPublicTarget`.
 * The returned Response reports the final URL as `response.url`, like
 * `redirect: "follow"`, so the shared classifier judges redirects the same way.
 */
export function guardedFetch(inner: typeof fetch, resolver: Resolver = defaultResolver): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let current = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let method = (init?.method ?? "GET").toUpperCase();
    let body = init?.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicTarget(current, resolver);
      const res = await inner(current, { ...init, method, body, redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        current = new URL(location, current).href;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      if (res.url === current) return res;
      const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
      Object.defineProperty(out, "url", { value: current });
      return out;
    }
    throw new TypeError("too many redirects");
  }) as typeof fetch;
}
