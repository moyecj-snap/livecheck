# Livecheck

Before you scrape a listing, check if it is still there. POST a specific job posting, Shopify or HTML product URL, or eBay item URL. Livecheck returns live, closed, or unknown plus title and signals (apply form, in-stock, sold-out, 404). Product pages are HTML-only (Shopify-class add-to-cart / sold-out); eBay item URLs use Browse availability, not sold comps. Not a search engine. $0.01 USDC per check on Base via x402.

This is a per-check agent API, not a platform. Agents pay **$0.01 USDC** per `POST /v1/verify` and **$0.10 USDC** per `POST /v1/confirm` (`lead_submit` / `listing_published`) or **$0.25 USDC** for `intent=order_placed` on Base via [Stripe x402](https://docs.stripe.com/payments/machine/x402.md).

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

Free routes: `GET /` (human demo), `GET /health`, `GET /openapi.json`, `GET /.well-known/x402`, `GET /.well-known/livecheck-keys.json`, `GET /stats`, and `GET /v1/receipt/{id}`. Paid: `POST /v1/verify` ($0.01) and `POST /v1/confirm` ($0.10 for lead_submit / listing_published; $0.25 for order_placed). `GET /v1/judge` is a 501 stub.

Agent crawlers (x402scan, AgentCash, Circle OpenAPI discovery) read the free JSON docs. `GET /openapi.json` is the canonical contract: `POST /v1/verify` with JSON `{ "url": "https://..." }`, `x-payment-info` fixed **$0.01** USD (decimal; runtime 402 `accepts[].amount` stays `"10000"` atomic USDC), and a 200 schema of `live | closed | unknown`. It also lists `POST /v1/confirm` at **$0.10** USD (`"100000"` atomic) for `lead_submit` / `listing_published`, and documents `order_placed` at **$0.25** (`"250000"` atomic) via `x-payment-info.intent_prices`. `GET /.well-known/x402` lists both `https://livecheck.fly.dev/v1/verify` and `https://livecheck.fly.dev/v1/confirm`. Neither discovery route returns 402.

Unpaid `POST /v1/verify` includes x402 v2 Bazaar discovery metadata (`extensions.bazaar` via `bazaarResourceServerExtension` + `declareDiscoveryExtension`). Listing in [CDP x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar) is free to browse; CDP catalogs this route after a successful paid request that carries the extension. The 402 `resource.description` (and health `description`) is: Before you scrape a job posting, Shopify or HTML product page, or eBay item, POST the specific URL you already have and Livecheck returns live, closed, or unknown plus title and signals (apply form, in-stock, sold-out, 404); not a search engine.

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

## Confirm (`POST /v1/confirm`)

Livecheck Confirm — use after your agent submits a lead/contact form (intent=lead_submit): POST {url, intent} where url is the thank-you or result page. Returns confirmed|failed|unknown with Level-2+ evidence (confirmation/ref/ticket id required for confirmed). Independent cookieless verifier — actor ≠ verifier — so you do not grade your own homework before the next paid or irreversible step. Not URL/stock liveness (use /v1/verify), not payment/tx settlement, not a thank-you-page classifier.

Payable Confirm intents are **`lead_submit`** ($0.10), **`listing_published`** ($0.10), and **`order_placed`** ($0.25). `/v1/verify` stays **$0.01**. Bazaar 402 copy stays lead_submit-primary until CoS publishes a false-confirmed rate. Do not treat OpenAPI/x402 listing `order_placed` as a Bazaar marketing ad.

```http
POST /v1/confirm
Content-Type: application/json

{ "url": "https://example.com/thank-you", "intent": "lead_submit", "claim": {} }
```

`claim` is optional (not required). After payment:

- **lead_submit confirmed** — Level 2 only: extractable confirmation/ref/ticket/lead id, or a unique token in the confirmation URL. Thank-you copy alone is never confirmed. `evidence_level` is 2 and `confidence` is ≥ 0.90 (lead_submit L2 uses 0.92).
- **order_placed** — caller claims an order was placed; `url` is typically a thank-you / confirmation / order-status page after checkout. Optional `claim.order_id` / `claim.total` / `claim.email_domain` may match or veto; they are never invented. Mapping:
  - Independent order / confirmation / receipt / ref / ticket id on the page or confirmation URL → `confirmed` only if `evidence_level≥2` and `confidence≥0.90`
  - Explicit payment failed / declined / cancelled banners → `failed`
  - Thank-you fluff only, login walls, challenge pages, cookies, or ambiguous status → `unknown` (`next_step` → `/v1/judge` stub)
  - Honesty: prefer unknown over a false confirmed. Never invent order ids.
- **listing_published** — caller claims a specific job, product, or eBay item URL is still published/live. Reuses the Verify pipeline (cookieless HTML / Shopify-class stock / ATS / eBay Browse). Mapping:
  - Verify `live` with a strong independent signal (`in-stock`, `apply form present`, or `ebay-in-stock`) on a specific listing URL → `confirmed` only if `evidence_level≥2` and `confidence≥0.90`
  - Explicitly closed / sold-out / ATS empty / 404 → `failed`
  - Ambiguous / unknown / soft signals → `unknown` (may include `next_step` → `/v1/judge` stub)
  - Honesty: never confirm from thank-you-page fluff alone; never invent listing ids. Prefer unknown over a false confirmed. Optional `claim.title` / `claim.sku` / `claim.id` can match or veto; they are not required if Verify alone reaches L2.
- **unknown** — Level 1 only (thank-you copy, no id; or soft/ambiguous listing signals). May include `next_step: { action: "human_review", endpoint: "/v1/judge", est_price_usd: 1.00 }` (`GET /v1/judge` is a 501 stub, not payable).
- **failed** — clear error/reject banner, or Verify closed for `listing_published`.
- Fetch is cookieless. `independent_evidence` is true only then; cookies never produce `confirmed`.

Successful JSON is additive on the v0 fields (`verdict`, `effect`, `signals`, `evidence_strength`, `evidence_id`, …):

- `id` — stable `cfm_` + ULID
- `evidence_level` — 0–4 (lead_submit, listing_published, and order_placed confirmed stay L2)
- `confidence` — 0–1
- `receipt` — `{ hash, verify_url }` always; `signature` + `signer` when `CONFIRM_RECEIPT_PRIVATE_KEY` is set

Unknown intents return HTTP **400** `{ "error": "unsupported_intent" }` after pay. OpenAPI / x402 document `order_placed` as payable at $0.25 once the handler is live. Do not treat Bazaar marketing copy as a GA order_placed ad.

**Payment caveat (multi-price on one route):** `@x402/hono` prices the *route*, not the JSON `intent`. Unpaid `POST /v1/confirm` therefore 402s before intent validation. The 402 `accepts[]` lists **$0.10 first** (lead_submit / listing_published) and **$0.25 second** (order_placed). A client that pays $0.10 can still send `order_placed` after settle; this phase does not re-check the settled amount against intent. Mock pay (`X-Livecheck-Mock: 1`) bypasses amount entirely. Successful JSON still returns `price_usd: 0.25` for `order_placed`.

Free Confirm extras: `GET /v1/receipt/{id}`, `GET /.well-known/livecheck-keys.json`, `GET /stats` (JSON; HTML if `Accept: text/html`). `GET /stats` publishes lead_submit, listing_published, and order_placed rolling counts and explicitly **null** false-confirmed rate (no published bench number on the live route). Local honesty benches: `npm run bench:listing-published` and `npm run bench:order-placed` (gate: `false_confirmed = 0`).

### Signed receipts

Set `CONFIRM_RECEIPT_PRIVATE_KEY` to an Ed25519 **PKCS#8 PEM** (recommended) or a **32-byte seed** as hex (64 chars) or base64. Generate PEM:

```bash
node --input-type=module -e "import { generateKeyPairSync } from 'node:crypto'; process.stdout.write(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())"
```

The signature is Ed25519 over canonical JSON `{id,intent,verdict,confidence,evidence_level,evidence_summary_or_hash,observed_at,url_hash,claim_hash}` (that key order). `evidence_summary_or_hash` is a SHA-256 of signals/verdict (not the raw confirmation id). Receipts persist on the same SQLite volume as paid_calls (`PAID_CALL_DB_PATH`). If the key is unset, Confirm still returns `id` plus an unsigned receipt stub (`hash` + `verify_url`); the paid path does not crash.

Verify: `GET /v1/receipt/{id}` and `GET /.well-known/livecheck-keys.json` (`kid` `livecheck-confirm-v1`).

## Run locally

```bash
npm install
cp .env.example .env   # optional — omit keys to boot in mock/dev mode
npm start
```

The process binds `0.0.0.0` and uses `process.env.PORT || 43127`. On a Mac that is still `http://127.0.0.1:43127` unless you set `PORT`. Without live keys it prints a banner: settlement is disabled. Unpaid verify still returns a realistic x402 `402` with a `payment-required` header. The verifier still runs against local fixtures. Successful mock-paid checks write `livecheck.paid_call` to stdout and a row in `./data/paid-calls.sqlite` (`npm run paid-call:cos` to count L7d/L30d).

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

`npm test` runs fixture-based classifier, HTTP, MCP, discovery, and mocked eBay Browse tests. Unit tests never call the live eBay network.

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

## eBay item URLs (Browse availability)

`POST /v1/verify` still costs **$0.01 USDC** and still returns HTTP 402 until paid. After payment, `ebay.com` / `ebay.co.uk` / `ebay.de` / `ebay.ca` / `ebay.com.au` (and similar) **item** URLs (`/itm/{id}` or `/itm/{slug}/{id}`) use eBay **Browse** availability, not sold/completed prices and not eBay HTML.

Set these in `.env` (never commit them):

```
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
```

Optional: `EBAY_DEV_ID` (unused by Browse; kept for the same keyset SnapPrice uses), `EBAY_MARKETPLACE_ID` (default inferred from the host, else `EBAY_US`).

The server mints an application OAuth token (`grant_type=client_credentials`, scope `https://api.ebay.com/oauth/api_scope`) and calls Browse `getItemByLegacyId`. A 400/404 from that call is not treated as missing: it then tries `GET /buy/browse/v1/item/{v1|{legacy}|0}` and any `var=` / `varid` / `vti` suffixes from the item URL. `IN_STOCK` / `LIMITED_STOCK` and a listing that has not ended → `live` (`ebay-in-stock`). `OUT_OF_STOCK` or an ended listing → `closed`. Only a true missing item after those fallbacks → `closed`. API errors → `unknown` (never HTTP 500). If the two required env vars are missing, the process still boots; eBay URLs fall back to the HTML classifier and health reports `ebay: false`.

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

### Paid-call analytics (`livecheck.paid_call`)

Each successful paid `POST /v1/verify` and `POST /v1/confirm` writes **one** structured JSON line to stdout **and** a row in a small SQLite table (when the Fly volume is mounted). Stripe PaymentIntent recording is unchanged. The stdout line is stable — do not change the `event` name or field set; `fly logs | grep livecheck.paid_call` must keep working.

```json
{"event":"livecheck.paid_call","route":"verify","status":"live","host":"boards.greenhouse.io","url_hash":"…","payer":"0x…","tx":"0x…","payment_intent":"pi_…","ts":"2026-09-06T20:34:00Z"}
```

Confirm lines add `intent` (`lead_submit`, `listing_published`, or `order_placed`) and `verdict` instead of `status`. Privacy rule: **never** log or store raw query strings, emails, or full URLs — hostname + SHA-256 of the full URL only. `payer` / `tx` / `payment_intent` are omitted when missing (mock/dev).

Retained columns (SQLite `paid_calls` at `PAID_CALL_DB_PATH`, default `/data/paid-calls.sqlite` on Fly): `ts`, `route` (`verify` | `confirm`), `payer`, `tx`, `payment_intent`, `host`, `url_sha256` (same digest as log `url_hash`).

CoS pull — L7d / L30d **row counts only** (calls = rows; unique_payers = distinct non-null wallet). No other KPIs:

```bash
# local (after paid mock/live calls have written ./data/paid-calls.sqlite)
npm run paid-call:cos

# production, from the machine that holds the volume
fly ssh console -a livecheck -C "npm run paid-call:cos"

# JSON for agents
npm run paid-call:cos -- --json
```

Interim if the volume is missing or the file is empty — parse the existing stdout lines (same column shape, same counts):

```bash
fly logs -a livecheck | grep livecheck.paid_call
fly logs -a livecheck | npm run paid-call:cos -- --from-logs
```

TODO: after the `livecheck_data` volume is attached and `/data/paid-calls.sqlite` is writable, production CoS pulls should use the sqlite command, not `--from-logs`.

#### Patty — Fly volume (required before first deploy of this mount)

`fly.toml` now has `[[mounts]]` `livecheck_data` → `/data`. `fly deploy` fails until the volume exists. Single machine only (`min_machines_running = 1`); do not scale out without another volume.

```bash
# once, region must match primary_region (sjc)
fly volumes create livecheck_data --region sjc --size 1 -a livecheck

fly deploy

# SSH is root; the process user is `node`. One-time so SQLite can create the file:
fly ssh console -a livecheck -C "chown node:node /data"

# confirm retention
fly ssh console -a livecheck -C "ls -l /data/paid-calls.sqlite"
fly ssh console -a livecheck -C "npm run paid-call:cos"
```

No new secrets. `PAID_CALL_DB_PATH` is public/path config (`/data/paid-calls.sqlite` in `fly.toml` `[env]`). Local default is `./data/paid-calls.sqlite`.

## How agents find this

- **Wallet-agents:** [CDP x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar) / Agentic.market. They search a free catalog of paid APIs, then pay $0.01 USDC on Base to `POST /v1/verify`.
- **Humans in Cursor:** Cursor Marketplace (later). Needs a public GitHub repository for submit. Do not create one here. Until then, point Cursor at the stdio MCP in this repo. The MCP reports 402; paying is x402.

## Honest limits

- Product pages on this path are HTML-only. Amazon, TikTok, and Alibaba listings stay `unknown`. Loginwalls, SPAs, and real challenge interstitials often come back `unknown`. Workday boards that render apply UI only in JavaScript stay unknown.
- No GitHub mirror. This Origin repository is the source of truth. Deploy Fly from this tree.
- New York businesses cannot accept x402 stablecoin payments.
