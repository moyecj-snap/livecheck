# Livecheck

A prototype primary-source verification API. You already have a URL. Livecheck fetches that page — not a search index, not an aggregator copy — and returns whether it is still a live, open source.

Agents pay **$0.01 USDC** per `POST /v1/verify` on Base via [Stripe x402](https://docs.stripe.com/payments/machine/x402.md). First vertical: job postings / ATS. The endpoint accepts any `http(s)` URL.

Before you scrape a job or product page, POST the URL. Livecheck fetches the source and returns live, closed, or unknown plus title and signals (apply form, sold-out, 404). Not a search engine.

This is a per-check agent API, not a platform.

## What you get

```http
POST /v1/verify
Content-Type: application/json

{ "url": "https://boards.greenhouse.io/example/jobs/1842" }
```

After payment verifies and settles:

```json
{
  "url": "https://boards.greenhouse.io/example/jobs/1842",
  "canonical_url": "https://boards.greenhouse.io/example/jobs/1842",
  "status": "live",
  "http_status": 200,
  "checked_at": "2026-08-30T21:00:00Z",
  "title": "Staff Backend Engineer — Northwind Labs",
  "signals": ["apply form present", "no closure banner"],
  "confidence": 0.82,
  "price_usd": 0.01
}
```

`status` is `live`, `closed`, or `unknown`.

- **closed** — HTTP 404/410; job close language (“no longer accepting applications”, “this job is closed to new applications”, …); a Greenhouse/Lever/Ashby job URL that redirects to a board with no job; or a specific product page with sold-out / out of stock / currently unavailable language.
- **live** — HTTP 200 on a specific job posting with an apply/submit affordance and no close language, or a specific product page with add to cart / add to bag / buy now and no sold-out phrase. A recaptcha/hcaptcha widget on that page is not a bot wall.
- **unknown** — loginwalled, a real challenge interstitial (Cloudflare `cf-challenge`, “verify you are human”, “checking your browser”), or ambiguous. Search-result URLs, generic careers homepages, and collection/category pages stay `unknown` even if a template includes add-to-cart.

v1 reads HTML + status only. It does not execute page JavaScript. Redirects are followed; `canonical_url` is the final URL. User-Agent identifies Livecheck.

Free routes: `GET /` (human demo), `GET /health`, `GET /openapi.json`, and `GET /.well-known/x402`. Paid: only `POST /v1/verify`.

Agent crawlers (x402scan, AgentCash, Circle OpenAPI discovery) read the free JSON docs. `GET /openapi.json` is the canonical contract: `POST /v1/verify` with JSON `{ "url": "https://..." }`, `x-payment-info` fixed **$0.01** USD (decimal; runtime 402 `accepts[].amount` stays `"10000"` atomic USDC), and a 200 schema of `live | closed | unknown`. `GET /.well-known/x402` is the compatibility fan-out (`version` + `resources` listing `https://livecheck.fly.dev/v1/verify`). Neither route returns 402.

Unpaid `POST /v1/verify` includes x402 v2 Bazaar discovery metadata (`extensions.bazaar` via `bazaarResourceServerExtension` + `declareDiscoveryExtension`). Listing in [CDP x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar) is free to browse; CDP catalogs this route after a successful paid request that carries the extension. The 402 `resource.description` (and health `description`) is: Before you scrape a job or product page, POST the URL. Livecheck fetches the source and returns live, closed, or unknown plus title and signals (apply form, sold-out, 404). Not a search engine.

The 402 `resource.url` is `https://livecheck.fly.dev/v1/verify` in production. Locally it stays the request origin (`http://127.0.0.1:43127` by default). Set `LIVECHECK_PUBLIC_URL` (public, not a secret) when the process sits behind HTTP and must advertise HTTPS.

`@x402/core` / `@x402/hono` **2.24.0 does put `extensions` on the 402** (`createPaymentRequiredResponse` copies `routeConfig.extensions` into the `payment-required` header; v2 body is `{}`). It also uses `routeConfig.resource` when set, otherwise `c.req.url`. Fly’s proxy speaks HTTP to the app, so the library 402 is `http://livecheck.fly.dev/v1/verify` unless we pin `resource` or rewrite the header. Live settlement uses that Hono middleware, not the mock helper. After the middleware returns 402 we overwrite `resource.url`, `resource.description`, and `extensions.bazaar` from `LIVECHECK_PUBLIC_URL` / `FLY_APP_NAME` / `Host` / the request URL (https for `*.fly.dev`).

**Settle path (what actually goes to CDP):** `@x402/hono` 2.24.0 does **not** copy the 402 `resource` or `extensions.bazaar` onto the client `PAYMENT-SIGNATURE` envelope. `verify()` / `settle()` POST that envelope as-is. CDP catalogs from `paymentPayload.resource` plus an echoed bazaar extension on settle. A paying client that omits those fields settles on-chain and still leaves Bazaar `index: null`. Fly logs `[x402] extension responses: {}` mean the `EXTENSION-RESPONSES` header was present and decoded to an empty object — not `bazaar.status=rejected`, not `processing`. Livecheck now backfills `resource: { url: https://livecheck.fly.dev/v1/verify, … }` and `extensions.bazaar` from the route before facilitator verify/settle, and logs inbound vs outbound resource URL + bazaar echo + decoded EXTENSION-RESPONSES (including `empty {}`) without keys or signatures.

`declareDiscoveryExtension({ bodyType: "json" })` in `@x402/extensions` 2.24.0 omits `info.input.method` and relies on `bazaarResourceServerExtension` to add `method` when building the 402. Settle backfill does not run that enricher. CDP then rejects with `invalid discovery configuration` because AJV fails: `/input: must have required property 'method'` — `schema.properties.input.required` is `["type","method","bodyType","body"]` while `info.input` only had `type`, `bodyType`, and `body`. The 402 looked fine (unpaid CDP validate `valid:true`) because the Hono enricher adds `method: "POST"` there. The declaration now sets `method: "POST"` on the settle-injected object too (same shape as indexed `goodsong.dev/verify/url`: `type`/`method`/`bodyType`/`body`, body schema is `properties.url` + `required: ["url"]` with no wrapper `type`).

A production decode on 2026-08-31 (health 200, `settlement: stripe-x402`) still had the old description `"Primary-source live check"`, `resource.url` `http://…`, and **no** `extensions` key. That health payload also lacked `public_verify_url` / `bazaar` — the running image was the pre-Bazaar commit. Redeploy this tree. Confirm with:

```bash
curl -sS https://livecheck.fly.dev/health
# expect public_verify_url + bazaar: true + the listing description

curl -sI https://livecheck.fly.dev/openapi.json
curl -sI https://livecheck.fly.dev/.well-known/x402
# both must be HTTP 200 application/json, not 402

curl -sS -D - -o /dev/null https://livecheck.fly.dev/v1/verify \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
# decode payment-required: resource.url must be https://livecheck.fly.dev/v1/verify
# and extensions.bazaar must be present
```

## Run locally

```bash
npm install
cp .env.example .env   # optional — omit keys to boot in mock/dev mode
npm start
```

The process binds `0.0.0.0` and uses `process.env.PORT || 43127`. On a Mac that is still `http://127.0.0.1:43127` unless you set `PORT`. Without live keys it prints a banner: settlement is disabled. Unpaid verify still returns a realistic x402 `402` with a `payment-required` header. The verifier still runs against local fixtures.

```bash
# Free discovery docs (no 402)
curl -sI http://127.0.0.1:43127/openapi.json
curl -sI http://127.0.0.1:43127/.well-known/x402

# 402 without payment
curl -iv http://127.0.0.1:43127/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://boards.greenhouse.io/example/jobs/1"}'

# Mock mode: run the verifier (ignored when live keys are set)
curl -s http://127.0.0.1:43127/v1/verify \
  -H 'content-type: application/json' \
  -H 'X-Livecheck-Mock: 1' \
  -d '{"url":"http://127.0.0.1:43127/fixtures/closed-to-new-applications"}'
```

`npm test` runs fixture-based classifier, HTTP, and MCP client tests (closed Greenhouse redirect, two “closed to new applications” pages, 200 + Apply Now, 404).

## Stripe + Coinbase setup (live settlement)

x402 stablecoin payments are available to US businesses except New York. This project’s builder is in California.

1. In the [Stripe Dashboard](https://dashboard.stripe.com/settings/payment_methods), request **Stablecoins and Crypto**. Wait until the method is active (Stripe may review the request).
2. Create a Base deposit address (keep this off the request path):

```bash
curl https://api.stripe.com/v1/crypto/deposit_addresses \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Stripe-Version: 2026-05-27.preview" \
  -d network=base
```

Store the returned address as `DEPOSIT_ADDRESS`.

3. Create [Coinbase Developer Platform](https://portal.cdp.coinbase.com/) API keys. x402 mainnet settlement uses the CDP facilitator (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`).
4. Put all four values in `.env` (never commit them):

```
STRIPE_SECRET_KEY=
DEPOSIT_ADDRESS=
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=
```

When every key is present, Livecheck uses Stripe’s documented stack: Hono `paymentMiddleware`, `@x402/evm` exact scheme on `eip155:8453`, Coinbase facilitator, then a Stripe PaymentIntent in `transaction_verification` mode (idempotency key = tx hash). Atomic USDC (6 decimals) is converted to cents (`$0.01` = 10000 atomic).

## Pay for a real request

Unpaid `curl` must return **HTTP 402** and a `payment-required` header. That is the x402 challenge — not a fake status.

To settle with real USDC on Base, use Stripe’s `purl` client from the [x402 guide](https://docs.stripe.com/payments/machine/x402.md):

```bash
purl http://127.0.0.1:43127/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://boards.greenhouse.io/example/jobs/1"}'
```

`purl` moves real funds because the deposit address is a live-mode Base address.

## Cursor MCP (local agent)

A stdio MCP in this repo exposes one tool, `verify_listing(url)`. It POSTs `{ "url": "..." }` to `LIVECHECK_URL` (default `http://127.0.0.1:43127/v1/verify`). There is no wallet, no private key, and no x402 spender in the MCP. Cursor MCP stdio still does not pay. `verify_listing` reports HTTP 402 and the decoded `payment-required` fields. Paying is x402 — Stripe `purl` or an agent wallet that can settle USDC on Base. The MCP does not send `X-Livecheck-Mock` (that header is ignored in live settlement mode anyway).

- Unpaid API → tool result is structured: `paid: false`, `http: 402`, plus the decoded `payment-required` fields (x402 v2). Not a vague throw.
- HTTP 200 → the verify JSON is returned as-is.

Keep the HTTP server running (`npm start`), then point Cursor at the MCP.

1. Copy the example into the project file Cursor reads, or into your user config:

```bash
# this project
mkdir -p .cursor
cp examples/cursor-mcp.json .cursor/mcp.json

# or all Cursor projects
cp examples/cursor-mcp.json ~/.cursor/mcp.json
```

2. If you paste by hand, use this shape (`command` / `args` / `env`):

```json
{
  "mcpServers": {
    "livecheck": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "${workspaceFolder}/src/mcp.ts"],
      "env": {
        "LIVECHECK_URL": "http://127.0.0.1:43127/v1/verify"
      }
    }
  }
}
```

`${workspaceFolder}` is the repo root (the folder that contains `.cursor/mcp.json`). You can also pass an absolute path to `src/mcp.ts`. After `npm install`, this is equivalent:

```json
{
  "mcpServers": {
    "livecheck": {
      "type": "stdio",
      "command": "${workspaceFolder}/node_modules/.bin/tsx",
      "args": ["${workspaceFolder}/src/mcp.ts"],
      "env": {
        "LIVECHECK_URL": "http://127.0.0.1:43127/v1/verify"
      }
    }
  }
}
```

3. Reload Cursor (or toggle the server under Customize → MCP). Ask the agent to `verify_listing` a job URL. An unpaid call should come back as HTTP 402 with `paid: false` and the Base USDC requirements. A request that the HTTP server has already settled returns the live/closed/unknown verdict.

Do not put Stripe or CDP secrets in `mcp.json`. Those stay in the HTTP server’s local `.env`. The MCP only needs `LIVECHECK_URL`.

### Cursor plugin (Marketplace later)

Packaging for a later Cursor Marketplace submit lives in this repo:

- `.cursor-plugin/plugin.json` — plugin name, author, honest description
- `mcp.json` (repo root; also copied under `.cursor-plugin/`) — stdio MCP pointed at `LIVECHECK_URL=https://livecheck.fly.dev/v1/verify`

No secrets in those files. The plugin does not pay. `verify_listing` against production still reports 402 until a wallet or `purl` settles.

Cursor Marketplace is human distribution. It requires a **public GitHub repository** at submit time. Origin remains the source of truth. Do not create a GitHub repo from this session. When you want Marketplace, publish a public GitHub copy yourself and submit it.

Local agent work stays `examples/cursor-mcp.json` (localhost). The plugin `mcp.json` is the production URL for Marketplace.

## Fly.io (public HTTPS)

Livecheck is a long-running Node process, not a serverless web app. Fly.io is the intended public deploy: HTTPS in front of `npm start`, so other agents can hit `POST /v1/verify` and pay. Vercel is the wrong shape.

This repo already has `Dockerfile` and `fly.toml` (`app = "livecheck"`, internal port `43127`, HTTPS, `GET /health`, machine kept up). `fly.toml` `[env]` sets the public (not secret) origin:

```toml
[env]
  LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev"
```

That value is public and belongs in `fly.toml`, not in git as a secret. If you ever set it outside the file, it is still not a secret:

```bash
# public origin — do not treat this as a Stripe/CDP secret
fly secrets set LIVECHECK_PUBLIC_URL=https://livecheck.fly.dev
```

Prefer the `fly.toml` `[env]` entry already in the repo. Origin is the source of truth — deploy from this tree. Do not clone the app to GitHub for Fly.

On a Mac, with [flyctl](https://fly.io/docs/flyctl/install/) installed:

```bash
fly auth login

# Uses the checked-in fly.toml. If the app name `livecheck` is taken, edit
# `app =` in fly.toml first. --no-deploy creates the app without shipping yet.
fly launch --no-deploy --copy-config --name livecheck --region sjc
```

Set the four live secrets from your local `.env` without printing them. `fly secrets import` reads `KEY=value` lines from stdin; the `grep` only matches those names and does not echo values to the terminal:

```bash
# from the repo root, with a filled-in local .env (never commit that file)
grep -E '^(STRIPE_SECRET_KEY|DEPOSIT_ADDRESS|CDP_API_KEY_ID|CDP_API_KEY_SECRET)=' .env \
  | fly secrets import
```

Do not `cat` `.env`, do not paste values into `fly.toml`, and do not put Stripe/CDP values in README examples. Confirm names only:

```bash
fly secrets list
```

Then deploy:

```bash
fly deploy
```

Fly sets `PORT` to the `http_service.internal_port` (`43127`). The image does not bake secrets.

After the first deploy, Coinbase CDP secret keys are IP-allowlisted. Facilitator `verify`/`settle` calls fail until the Fly machine’s **egress** IP is on that key’s allowlist. Do not guess the address.

1. See allocated addresses: `fly ips` (or `fly ips list`). Inbound Anycast IPs are not the same as outbound egress.
2. Ask the running machine what the public internet sees:

```bash
fly ssh console -C "curl -4 ifconfig.me"
fly ssh console -C "curl -6 ifconfig.me"
```

3. Add that IPv4 (and IPv6 if CDP asks for it) to the Coinbase Developer Platform API key allowlist.

Default Fly egress IPs can change across hosts and deploys. If the allowlist keeps breaking, allocate a static egress pair for the app’s region (`fly ips allocate-egress -r sjc`, then `fly ips list`) and allowlist those addresses instead. Re-check with `fly ssh console` + `curl ifconfig.me` after you allocate.

Public check (no payment): `curl -sS https://livecheck.fly.dev/health` should be `200` with `settlement: "stripe-x402"`, `bazaar: true`, and `public_verify_url: "https://livecheck.fly.dev/v1/verify"` once this commit is what is running. If health has no `public_verify_url`, Fly is still on an older image. Unpaid `POST /v1/verify` must still be HTTP 402 with a `payment-required` header whose `resource.url` is `https://livecheck.fly.dev/v1/verify` (https, not http) and whose `extensions.bazaar` describes the JSON `{ url }` body.

After this ships: `fly deploy` from Origin. Listing the catalog is free; CDP catalogs the route after a successful paid settle (exact, $0.01 USDC on Base). This repo does not trigger that payment.

## How agents find this

- **Wallet-agents:** [CDP x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar) / Agentic.market. They search a free catalog of paid APIs, then pay $0.01 USDC on Base to `POST /v1/verify`.
- **Humans in Cursor:** Cursor Marketplace (later). Needs a public GitHub repository for submit. Do not create one here. Until then, point Cursor at the stdio MCP in this repo. The MCP reports 402; paying is x402.

## Honest limits

- Prototype. HTML + status only. Job apply-form and product in-stock/sold-out phrases are heuristics, not Amazon-quality inventory. Loginwalls, SPAs, and real challenge interstitials often come back `unknown`. Workday boards that render apply UI only in JavaScript stay unknown.
- No GitHub mirror. This Origin repository is the source of truth. Deploy Fly from this tree.
- New York businesses cannot accept x402 stablecoin payments.
