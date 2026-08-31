# Livecheck

A prototype primary-source verification API. You already have a URL. Livecheck fetches that page — not a search index, not an aggregator copy — and returns whether it is still a live, open source.

Agents pay **$0.05 USDC** per `POST /v1/verify` on Base via [Stripe x402](https://docs.stripe.com/payments/machine/x402.md). First vertical: job postings / ATS. The endpoint accepts any `http(s)` URL.

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
  "price_usd": 0.05
}
```

`status` is `live`, `closed`, or `unknown`.

- **closed** — HTTP 404/410, strong close language (“no longer accepting applications”, “this job is closed to new applications”, “this job is no longer available”, “the job you are trying to apply for has been filled”), or a Greenhouse/Lever/Ashby job URL that redirects to a board with no job.
- **live** — HTTP 200, a specific posting (not a search-results page), an apply/submit affordance, and no close language.
- **unknown** — loginwalled, challenge page, or ambiguous. Search-result URLs and generic careers homepages are flagged `not_a_specific_posting` rather than called live.

v1 reads HTML + status only. It does not execute page JavaScript. Redirects are followed; `canonical_url` is the final URL. User-Agent identifies Livecheck.

Free routes: `GET /` (human demo) and `GET /health`. Paid: only `POST /v1/verify`.

## Run locally

```bash
npm install
cp .env.example .env   # optional — omit keys to boot in mock/dev mode
npm start
```

The process binds `0.0.0.0` and uses `process.env.PORT || 43127`. On a Mac that is still `http://127.0.0.1:43127` unless you set `PORT`. Without live keys it prints a banner: settlement is disabled. Unpaid verify still returns a realistic x402 `402` with a `payment-required` header. The verifier still runs against local fixtures.

```bash
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

A stdio MCP in this repo exposes one tool, `verify_listing(url)`. It POSTs `{ "url": "..." }` to `LIVECHECK_URL` (default `http://127.0.0.1:43127/v1/verify`). There is no wallet, no private key, and no x402 spender in the MCP. It does not send `X-Livecheck-Mock` (that header is ignored in live settlement mode anyway).

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

## Fly.io (public HTTPS)

Livecheck is a long-running Node process, not a serverless web app. Fly.io is the intended public deploy: HTTPS in front of `npm start`, so other agents can hit `POST /v1/verify` and pay. Vercel is the wrong shape.

This repo already has `Dockerfile` and `fly.toml` (`app = "livecheck"`, internal port `43127`, HTTPS, `GET /health`, machine kept up). Origin is the source of truth — deploy from this tree. Do not clone the app to GitHub for Fly.

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

Public check (no payment): `curl -sS https://<your-app>.fly.dev/health` should be `200` with `settlement: "stripe-x402"` once secrets are set. Unpaid `POST /v1/verify` must still be HTTP 402 with a `payment-required` header.

## Honest limits

- Prototype. Jobs-first heuristics on HTML. Loginwalls, SPAs, and challenge pages often come back `unknown`.
- No GitHub mirror. This Origin repository is the source of truth. Deploy Fly from this tree.
- New York businesses cannot accept x402 stablecoin payments.
