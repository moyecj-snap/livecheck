/**
 * nohumans.directory proof-of-control for claiming our listings.
 * nohumans fetches GET /.well-known/nohumans-claim and expects the one-time
 * challenge token as plain text, nothing else.
 *
 * The token comes from the Fly secret NOHUMANS_CLAIM_TOKEN, set only on claim
 * day and unset afterwards. Unset or blank -> 404. Never log the value.
 */
export const NOHUMANS_CLAIM_PATH = "/.well-known/nohumans-claim";
export const NOHUMANS_CLAIM_TOKEN_ENV = "NOHUMANS_CLAIM_TOKEN";

/** The token to serve, or null when the route should 404. Surrounding whitespace (e.g. a pasted newline) is dropped. */
export function nohumansClaimToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env[NOHUMANS_CLAIM_TOKEN_ENV]?.trim();
  return token ? token : null;
}

export function nohumansClaimResponse(env: NodeJS.ProcessEnv = process.env): Response {
  const token = nohumansClaimToken(env);
  if (!token) {
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(token, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
