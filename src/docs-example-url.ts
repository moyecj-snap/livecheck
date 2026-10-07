import { hashUrl } from "./paid-call.js";
import { TEST_TRAFFIC_URLS, testTrafficUrlHref, type TestTrafficUrl } from "./test-traffic.js";

/**
 * Docs / demo URLs are test traffic. The list lives in `src/test-traffic.ts`.
 * paid_calls stores `url_sha256` of the href recorded at settle time
 * (`parseTargetUrl` returns `URL.href`). Match that hash. Do not match
 * `host` alone: `boards.greenhouse.io` is also a real customer ATS.
 */
function entryByHost(host: string): TestTrafficUrl | undefined {
  return TEST_TRAFFIC_URLS.find((entry) => entry.host === host);
}

const GREENHOUSE = entryByHost("boards.greenhouse.io");
const EXAMPLE_CONFIRM = entryByHost("example.com");
const DEMO_CONFIRM = entryByHost("livecheck.fly.dev");

if (!GREENHOUSE || !EXAMPLE_CONFIRM || !DEMO_CONFIRM) {
  throw new Error("test-traffic URL list is missing a docs or demo entry");
}

export const DOCS_EXAMPLE_HOST = GREENHOUSE.host;
export const DOCS_EXAMPLE_PATH = GREENHOUSE.path;
export const DOCS_EXAMPLE_URL = testTrafficUrlHref(GREENHOUSE);

export const CONFIRM_DOCS_EXAMPLE_HOST = EXAMPLE_CONFIRM.host;
export const CONFIRM_DOCS_EXAMPLE_PATH = EXAMPLE_CONFIRM.path;
export const CONFIRM_DOCS_EXAMPLE_REF = EXAMPLE_CONFIRM.ref ?? "";
export const CONFIRM_DOCS_EXAMPLE_URL = testTrafficUrlHref(EXAMPLE_CONFIRM);

export const CONFIRM_DEMO_HOST = DEMO_CONFIRM.host;
export const CONFIRM_DEMO_PATH = DEMO_CONFIRM.path;
export const CONFIRM_DEMO_REF = DEMO_CONFIRM.ref ?? "";
export const CONFIRM_DEMO_URL = testTrafficUrlHref(DEMO_CONFIRM);

export const DOCS_EXAMPLE_URLS = TEST_TRAFFIC_URLS.map((entry) => testTrafficUrlHref(entry));

/**
 * `paid_calls.url_sha256` already seen in prod on verify/job.
 * Equals `hashUrl(DOCS_EXAMPLE_URL)`. The literal stays in the exclusion
 * set so a later change to URL formatting cannot let this historical row
 * count as an outside payer again.
 */
export const DOCS_EXAMPLE_URL_SHA256 =
  GREENHOUSE.sha256 ?? "6c2d36fc55d201f5a2908a45aa21c73f318a79d352be6a0c8a9710bc3966843a";

function hrefForms(entry: TestTrafficUrl): string[] {
  const query = entry.ref ? `?ref=${entry.ref}` : "";
  const paths = [entry.path, `${entry.path}/`];
  const out: string[] = [];
  for (const scheme of ["https", "http"] as const) {
    for (const path of paths) {
      out.push(`${scheme}://${entry.host}${path}${query}`);
    }
  }
  return out;
}

function matchesEntry(parsed: URL, entry: TestTrafficUrl): boolean {
  if (parsed.hostname.toLowerCase() !== entry.host) return false;
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (path !== entry.path) return false;
  if (entry.ref === undefined) return true;
  return parsed.searchParams.get("ref") === entry.ref;
}

/** Host and path (and ref, when the entry has one) match a test-traffic URL. */
export function isDocsExampleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return TEST_TRAFFIC_URLS.some((entry) => matchesEntry(parsed, entry));
}

/** Values matched against `paid_calls.url_sha256` when building traffic.external. */
export function docsExampleUrlHashes(): string[] {
  const hashes = new Set<string>();
  for (const entry of TEST_TRAFFIC_URLS) {
    if (entry.sha256) hashes.add(entry.sha256);
    for (const url of hrefForms(entry)) {
      hashes.add(hashUrl(new URL(url).href));
    }
  }
  return [...hashes];
}

export function isDocsExampleUrlHash(hash: string): boolean {
  return docsExampleUrlHashes().includes(hash.trim().toLowerCase());
}
