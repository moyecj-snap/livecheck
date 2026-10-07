import { hashUrl } from "./paid-call.js";

/**
 * Public docs / OpenAPI / Bazaar example posting.
 * A paid call to this URL is test traffic, not an outside customer.
 *
 * paid_calls does not store the raw URL. It stores `host` plus `url_sha256`,
 * and `url_sha256` is `hashUrl` of the URL string recorded at settle time
 * (`parseTargetUrl` returns `URL.href`). Match that hash. Do not match
 * `host` alone: `boards.greenhouse.io` is also a real customer ATS.
 */
export const DOCS_EXAMPLE_HOST = "boards.greenhouse.io";
export const DOCS_EXAMPLE_PATH = "/example/jobs/1842";
export const DOCS_EXAMPLE_URL = `https://${DOCS_EXAMPLE_HOST}${DOCS_EXAMPLE_PATH}`;

/** Bazaar / OpenAPI confirm example. Test traffic regardless of payer. */
export const CONFIRM_DOCS_EXAMPLE_HOST = "example.com";
export const CONFIRM_DOCS_EXAMPLE_PATH = "/thank-you";
export const CONFIRM_DOCS_EXAMPLE_REF = "ABC123";
export const CONFIRM_DOCS_EXAMPLE_URL = `https://${CONFIRM_DOCS_EXAMPLE_HOST}${CONFIRM_DOCS_EXAMPLE_PATH}?ref=${CONFIRM_DOCS_EXAMPLE_REF}`;

export const DOCS_EXAMPLE_URLS = [DOCS_EXAMPLE_URL, CONFIRM_DOCS_EXAMPLE_URL] as const;

/**
 * `paid_calls.url_sha256` already seen in prod on verify/job.
 * Equals `hashUrl(DOCS_EXAMPLE_URL)`. The literal stays in the exclusion
 * set so a later change to URL formatting cannot let this historical row
 * count as an outside payer again.
 */
export const DOCS_EXAMPLE_URL_SHA256 =
  "6c2d36fc55d201f5a2908a45aa21c73f318a79d352be6a0c8a9710bc3966843a";

/** http(s) and optional trailing slash. These are the hrefs `parseTargetUrl` stores. */
const DOCS_EXAMPLE_URL_FORMS = [
  DOCS_EXAMPLE_URL,
  `${DOCS_EXAMPLE_URL}/`,
  `http://${DOCS_EXAMPLE_HOST}${DOCS_EXAMPLE_PATH}`,
  `http://${DOCS_EXAMPLE_HOST}${DOCS_EXAMPLE_PATH}/`,
  CONFIRM_DOCS_EXAMPLE_URL,
  `https://${CONFIRM_DOCS_EXAMPLE_HOST}${CONFIRM_DOCS_EXAMPLE_PATH}/?ref=${CONFIRM_DOCS_EXAMPLE_REF}`,
  `http://${CONFIRM_DOCS_EXAMPLE_HOST}${CONFIRM_DOCS_EXAMPLE_PATH}?ref=${CONFIRM_DOCS_EXAMPLE_REF}`,
  `http://${CONFIRM_DOCS_EXAMPLE_HOST}${CONFIRM_DOCS_EXAMPLE_PATH}/?ref=${CONFIRM_DOCS_EXAMPLE_REF}`,
] as const;

/**
 * Host and path are the docs example. Scheme, query, and fragment do not
 * change the classification. paid_calls cannot apply the query case: only
 * the full-URL hash is stored, so `docsExampleUrlHashes` covers the
 * no-query forms above plus the known prod hash.
 */
export function isDocsExampleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (host === DOCS_EXAMPLE_HOST && path === DOCS_EXAMPLE_PATH) return true;
  if (host === CONFIRM_DOCS_EXAMPLE_HOST && path === CONFIRM_DOCS_EXAMPLE_PATH) {
    return parsed.searchParams.get("ref") === CONFIRM_DOCS_EXAMPLE_REF;
  }
  return false;
}

/** Values matched against `paid_calls.url_sha256` when building traffic.external. */
export function docsExampleUrlHashes(): string[] {
  const hashes = new Set<string>([DOCS_EXAMPLE_URL_SHA256]);
  for (const url of DOCS_EXAMPLE_URL_FORMS) {
    hashes.add(hashUrl(new URL(url).href));
  }
  return [...hashes];
}

export function isDocsExampleUrlHash(hash: string): boolean {
  return docsExampleUrlHashes().includes(hash.trim().toLowerCase());
}
