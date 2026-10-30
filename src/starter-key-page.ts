import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { apiKeyDb, issueStarterKey, starterKeyLimits } from "./api-key-store.js";
import { publicOrigin } from "./public-url.js";
import {
  EMERGENCY_STOP_MESSAGE,
  STARTER_KEY_CALLBACK_PATH,
  STARTER_KEY_CONTACT_LABEL,
  STARTER_KEY_PAGE_PATH,
  STARTER_KEY_PRIVACY_LINE,
  WIND_DOWN_MESSAGE,
  githubOauthConfig,
  starterKeyIpSubject,
  starterKeyNow,
} from "./starter-key.js";

/**
 * GET /keys, GitHub OAuth, and the one-time key page.
 * The authorize URL sends no scope, so GitHub does not grant `user` or
 * `user:email`. We keep id, login, and (briefly) created_at, and drop every
 * other field including email.
 */

const COOKIE = "lc_starter_oauth";
const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";

let githubFetch: typeof fetch = globalThis.fetch;

export function setGithubFetchForTests(fn: typeof fetch | null): void {
  githubFetch = fn ?? globalThis.fetch;
}

export function starterKeyCallbackUrl(requestUrl?: string, host?: string): string {
  return `${publicOrigin(requestUrl, host)}${STARTER_KEY_CALLBACK_PATH}`;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function clientIp(c: Context): string {
  const fly = c.req.header("fly-client-ip")?.trim();
  if (fly) return fly;
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return "local";
}

const SECURITY: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function page(c: Context, html: string, status: 200 | 400 | 403 | 429 | 503 = 200): Response {
  for (const [name, value] of Object.entries(SECURITY)) c.header(name, value);
  return c.html(html, status);
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>${esc(title)}</title>
  <style>
    :root { --ink: #14211a; --paper: #f4efe4; --rule: #c9c0ae; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: var(--paper); font-family: "Iowan Old Style", Palatino, serif; line-height: 1.5; }
    main { max-width: 40rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    h1 { font-size: 2rem; letter-spacing: -0.02em; margin: 0 0 0.6rem; }
    a { color: var(--ink); }
    label { display: block; margin: 1rem 0; }
    button { appearance: none; border: 1px solid var(--ink); background: #fff; color: var(--ink); padding: 0.5rem 0.8rem; font: inherit; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    pre { background: #1b241e; color: #e8efe8; padding: 1rem; overflow: auto; font-size: 0.85rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .muted { color: #5b645c; }
    .note { border: 1px solid var(--rule); padding: 0.8rem 1rem; background: #fff; }
  </style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  ${body}
</main>
</body>
</html>`;
}

function formBody(options: { oauth: boolean; closed?: string }): string {
  const reasons: string[] = [];
  if (options.closed) reasons.push(options.closed);
  if (!options.oauth) reasons.push("GitHub sign-in is not configured on this server yet.");
  const disabled = reasons.length > 0 ? " disabled" : "";
  const extra = reasons.length ? `<p class="note">${reasons.map((line) => esc(line)).join(" ")}</p>` : "";
  return `<p>A starter key calls <code>POST /v1/verify</code>, <code>/v1/verify/job</code>, and <code>/v1/verify/listing</code>. 200 checks over 30 days. Confirm, Sentinel, and <code>/check</code> stay on a wallet. The free <a href="/job">/job</a> page has its own limits.</p>
<p>${esc(STARTER_KEY_PRIVACY_LINE)}</p>
<form method="post" action="${STARTER_KEY_PAGE_PATH}/start">
  <label><input type="checkbox" name="contact" value="yes"> ${esc(STARTER_KEY_CONTACT_LABEL)}</label>
  <button type="submit"${disabled}>Continue with GitHub</button>
</form>
${extra}
<p class="muted">Sign-in uses GitHub's public profile only. We do not ask for your email. One key per GitHub account. Accounts under 7 days old cannot get a key. The key is shown once.</p>`;
}

function cookieOptions(c: Context, maxAge: number): {
  httpOnly: true;
  sameSite: "Lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:" || Boolean(process.env.FLY_APP_NAME),
    path: STARTER_KEY_PAGE_PATH,
    maxAge,
  };
}

type OauthState = { s: string; c: 0 | 1; e: number };

function signState(payload: OauthState, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function readState(cookie: string | undefined, secret: string, now: number): OauthState | undefined {
  if (!cookie) return undefined;
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = cookie.slice(0, dot);
  const mac = cookie.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<OauthState>;
    if (typeof parsed.s !== "string" || (parsed.c !== 0 && parsed.c !== 1) || typeof parsed.e !== "number") return undefined;
    if (parsed.e < now) return undefined;
    return { s: parsed.s, c: parsed.c, e: parsed.e };
  } catch {
    return undefined;
  }
}

function statesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function exchangeCode(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<string | undefined> {
  const response = await githubFetch(GITHUB_TOKEN, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "livecheck" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { access_token?: unknown };
  return typeof body.access_token === "string" && body.access_token ? body.access_token : undefined;
}

type GithubProfile = { id: string; login: string; createdAt: string };

async function fetchProfile(token: string): Promise<GithubProfile | undefined> {
  const response = await githubFetch(GITHUB_USER, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "livecheck",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { id?: unknown; login?: unknown; created_at?: unknown };
  if (typeof body.id !== "number" || typeof body.login !== "string" || typeof body.created_at !== "string") return undefined;
  return { id: String(body.id), login: body.login, createdAt: body.created_at };
}

/** Emergency stop wins. Otherwise wind-down closes sign-up only. */
function signupClosedMessage(): string | undefined {
  const db = apiKeyDb();
  if (!db) return undefined;
  try {
    const limits = starterKeyLimits(db);
    if (limits.emergencyStop) return EMERGENCY_STOP_MESSAGE;
    if (limits.windDown) return WIND_DOWN_MESSAGE;
    return undefined;
  } catch {
    return undefined;
  }
}

export function registerStarterKeyRoutes(app: Hono): void {
  app.get(STARTER_KEY_PAGE_PATH, (c) => {
    return page(c, shell("Starter key", formBody({ oauth: Boolean(githubOauthConfig()), closed: signupClosedMessage() })));
  });

  app.post(`${STARTER_KEY_PAGE_PATH}/start`, async (c) => {
    const oauth = githubOauthConfig();
    if (!oauth) {
      return page(c, shell("Starter key", `<p class="note">GitHub sign-in is not configured on this server yet.</p>`), 503);
    }
    const db = apiKeyDb();
    if (!db) return page(c, shell("Starter key", `<p class="note">Starter keys are not available on this process.</p>`), 503);
    const closed = signupClosedMessage();
    if (closed) return page(c, shell("Starter key", `<p class="note">${esc(closed)}</p>`), 403);
    const body = await c.req.parseBody();
    const opted = body.contact === "yes";
    const state = randomBytes(32).toString("base64url");
    const exp = starterKeyNow().getTime() + 10 * 60 * 1000;
    setCookie(c, COOKIE, signState({ s: state, c: opted ? 1 : 0, e: exp }, oauth.clientSecret), cookieOptions(c, 600));
    const redirectUri = starterKeyCallbackUrl(c.req.url, c.req.header("host"));
    const params = new URLSearchParams({ client_id: oauth.clientId, redirect_uri: redirectUri, state });
    return c.redirect(`${GITHUB_AUTHORIZE}?${params.toString()}`);
  });

  app.get(STARTER_KEY_CALLBACK_PATH, async (c) => {
    const oauth = githubOauthConfig();
    if (!oauth) {
      return page(c, shell("Starter key", `<p class="note">GitHub sign-in is not configured on this server yet.</p>`), 503);
    }
    const db = apiKeyDb();
    if (!db) return page(c, shell("Starter key", `<p class="note">Starter keys are not available on this process.</p>`), 503);
    const saved = readState(getCookie(c, COOKIE), oauth.clientSecret, starterKeyNow().getTime());
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    setCookie(c, COOKIE, "", cookieOptions(c, 0));
    if (!saved || !code || !statesMatch(saved.s, state)) {
      return page(
        c,
        shell("Starter key", `<p class="note">Sign-in expired. <a href="${STARTER_KEY_PAGE_PATH}">Start again</a>.</p>`),
        400,
      );
    }
    const redirectUri = starterKeyCallbackUrl(c.req.url, c.req.header("host"));
    let profile: GithubProfile | undefined;
    try {
      const token = await exchangeCode(code, oauth.clientId, oauth.clientSecret, redirectUri);
      if (token) profile = await fetchProfile(token);
    } catch {
      profile = undefined;
    }
    if (!profile) {
      return page(
        c,
        shell("Starter key", `<p class="note">GitHub sign-in did not complete. <a href="${STARTER_KEY_PAGE_PATH}">Start again</a>.</p>`),
        400,
      );
    }
    const issued = issueStarterKey(
      db,
      {
        githubId: profile.id,
        githubLogin: profile.login,
        accountCreatedAt: profile.createdAt,
        contactOptIn: saved.c === 1,
        ipSubject: starterKeyIpSubject(clientIp(c), oauth.clientSecret),
      },
      starterKeyNow(),
    );
    if (!issued.ok) {
      const status =
        issued.error === "account_too_young" || issued.error === "emergency_stop" || issued.error === "wind_down"
          ? 403
          : issued.error === "ip_limited" || issued.error === "global_limited"
            ? 429
            : 400;
      return page(
        c,
        shell("Starter key", `<p class="note">${esc(issued.message)}</p><p><a href="${STARTER_KEY_PAGE_PATH}">Back</a></p>`),
        status,
      );
    }
    return page(
      c,
      shell(
        "Your starter key",
        `<p>This is the only time the key is shown.</p>
<pre><code>${esc(issued.plaintext)}</code></pre>
<p>Send it as <code>Authorization: Bearer</code> on <code>POST /v1/verify</code>, <code>/v1/verify/job</code>, and <code>/v1/verify/listing</code>. It expires ${esc(issued.expiresAt)}. Confirm, Sentinel, and <code>/check</code> stay on a wallet.</p>
<p>${esc(STARTER_KEY_PRIVACY_LINE)}</p>`,
      ),
    );
  });
}
