/**
 * Tracking params stripped before a live check and by audit tooling.
 * Only `utm_*` and `ref`. ID params (`gh_jid`, `jobId`, `lever-source`, and
 * every other key) stay. Confirm URLs keep `ref` because that route reads it
 * as a confirmation token; this helper is not applied there.
 */
const TRACKING_KEY = /^(?:utm_.+|ref)$/i;

export function stripTrackingParams(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const drop: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (TRACKING_KEY.test(key) && !drop.includes(key)) drop.push(key);
  }
  if (drop.length === 0) return raw;
  for (const key of drop) url.searchParams.delete(key);
  return url.href;
}
