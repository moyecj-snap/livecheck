# Livecheck

Before you scrape a listing, check if it is still there. POST a specific job posting, Shopify or HTML product URL, or eBay item URL. Livecheck returns live, closed, or unknown plus title and signals (apply form, in-stock, sold-out, 404). Product pages are HTML-only (Shopify-class add-to-cart / sold-out); eBay item URLs use Browse availability, not sold comps. Not a search engine. $0.01 USDC per check on Base via x402.

This is a per-check agent API, not a platform. Agents pay **$0.01 USDC** per `POST /v1/verify`, **$0.02 USDC** per `POST /v1/check` (Sentinel one-shot condition), **$2.50 USDC** per `POST /v1/watch` (30-day standard watcher), **$2.50 USDC** per `POST /v1/watch/renew` (extend an active watcher; owner token + payment; `{id}` in the body), **$0.50 USDC** per `POST /v1/watch/{id}/chain/topup` (chain balance; owner token + payment), **$0.10 USDC** per `POST /v1/confirm` (`lead_submit` / `listing_published`), and **$0.25 USDC** per `POST /v1/confirm/order` (`order_placed`) on Base via [Stripe x402](https://docs.stripe.com/payments/machine/x402.md). x402 wants one fixed price per resource — dual pricing on a single path makes facilitator verify fail when settle-time `paymentRequirements` drift from the first 402.

## Verify-first: first paid call

Default first useful call is **Verify** (`POST /v1/verify`, **$0.01 USDC** on Base). Use a URL from your own workflow when you have one.

**We can help with the first Verify settle.**

### 1. Health

```bash
curl -sS https://livecheck.fly.dev/health
```

### 2. Unpaid 402 (no spend)

```bash
curl -sS -D - -o /tmp/v.body https://livecheck.fly.dev/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://job-boards.greenhouse.io/discord/jobs/8806482002"}'
```

Expect HTTP **402** and a `payment-required` header. That proves the endpoint is alive without paying.

### 3. Install `purl` (Linux amd64)

From [stripe/purl](https://github.com/stripe/purl) release **v0.2.9**, asset `purl-linux-amd64` → `~/bin/purl`. See also the [Stripe x402](https://docs.stripe.com/payments/machine/x402.md) guide.

```bash
mkdir -p ~/bin
curl -fsSL -o ~/bin/purl https://github.com/stripe/purl/releases/download/v0.2.9/purl-linux-amd64
chmod +x ~/bin/purl
export PATH="$HOME/bin:$PATH"
purl --version
```

The binary may print `0.2.8` even when downloaded from the v0.2.9 release asset.

Optional macOS (Apple Silicon) one-liner:

```bash
mkdir -p ~/bin && curl -fsSL -o ~/bin/purl https://github.com/stripe/purl/releases/download/v0.2.9/purl-darwin-arm64 && chmod +x ~/bin/purl && export PATH="$HOME/bin:$PATH" && purl --version
```

Wallet (interactive — **never paste keys into git, chat, or this README**):

```bash
purl wallet list
purl wallet add
# or
purl wallet add --type evm
```

Paid Verify needs **USDC on Base**. Check with `purl balance` or `purl balance --network base`. Ignore ethereum RPC errors on balance.

### 4. Paid Verify

```bash
purl https://livecheck.fly.dev/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://job-boards.greenhouse.io/discord/jobs/8806482002"}'
```

Prefer a URL from your own workflow.

### 5. Limits

`status` is `live`, `closed`, or `unknown`. Status ≠ legitimacy, fraud, or payment safety. v1 reads HTML + status only (no JavaScript). Many JS-heavy ATS pages return `unknown`.

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
  "price_usd": 0.01,
  "watch": {
    "suggest": "/v1/watch",
    "detector": "status_change",
    "price_usd": 2.5
  }
}
```

`status` is `live`, `closed`, or `unknown`. Paid 200 Verify (and Confirm / Confirm-order) responses include `watch` — an in-band hint to `POST /v1/watch` at **$2.50** with default detector `status_change`. Unpaid 402 bodies and `payment-required` headers do not include `watch`.

- **closed** — HTTP 404/410; job close language (“no longer accepting applications”, “this job is closed to new applications”, …); a Greenhouse/Lever/Ashby job URL that redirects to a board with no job; or a specific product page with sold-out / out of stock / currently unavailable language.
- **live** — HTTP 200 on a specific job posting with an apply/submit affordance and no close language, or a specific product page with add to cart / add to bag / buy now and no sold-out phrase. A recaptcha/hcaptcha widget on that page is not a bot wall.
- **unknown** — loginwalled, a real challenge interstitial (Cloudflare `cf-challenge`, “verify you are human”, “checking your browser”), or ambiguous. Search-result URLs, generic careers homepages, and collection/category pages stay `unknown` even if a template includes add-to-cart.

v1 reads HTML + status only. It does not execute page JavaScript. Redirects are followed; `canonical_url` is the final URL. User-Agent identifies Livecheck.

Free routes: `GET /` (human demo), `GET /health`, `GET /openapi.json`, `GET /.well-known/x402`, `GET /.well-known/livecheck-keys.json`, `GET /stats`, `GET /v1/receipt/{id}`, `GET /v1/watch/{id}`, `GET /v1/watch/{id}/events`, and `DELETE /v1/watch/{id}` (owner token required). Paid: `POST /v1/verify` ($0.01), `POST /v1/check` ($0.02, one-shot Sentinel condition), `POST /v1/watch` ($2.50, 30-day standard watcher), `POST /v1/watch/renew` ($2.50, extend an active watcher; `{id}` in the body), `POST /v1/watch/{id}/chain/topup` ($0.50, owner token + payment), `POST /v1/confirm` ($0.10, `lead_submit` / `listing_published`), and `POST /v1/confirm/order` ($0.25, `order_placed`). `GET /v1/judge` is a 501 stub. `/v1/watch/fast` and Bazaar GA are not in this phase. Confirm chain (`on_change.run=confirm`) spends watcher chain balance at those same Confirm prices — no new public route.

Agent crawlers (x402scan, AgentCash, Circle OpenAPI discovery) read the free JSON docs. `GET /openapi.json` is the canonical contract: `POST /v1/verify` with JSON `{ "url": "https://..." }`, `x-payment-info` fixed **$0.01** USD (decimal; runtime 402 `accepts[].amount` stays `"10000"` atomic USDC), and a 200 schema of `live | closed | unknown` plus paid-only `watch` (`suggest: "/v1/watch"`, detector `status_change`, `price_usd: 2.5`). It lists `POST /v1/check` at fixed **$0.02** (`"20000"` atomic) for a one-shot condition (no watcher), `POST /v1/watch` at fixed **$2.50** (`"2500000"` atomic) for a 30-day standard watcher, `POST /v1/watch/renew` at the same **$2.50** (`"2500000"` atomic; `{id}` in the JSON body so the well-known URL stays concrete), `POST /v1/watch/{id}/chain/topup` at fixed **$0.50** (`"500000"` atomic; owner token + payment; OpenAPI path-param only — not a crawler resource), `GET /v1/watch/{id}/events` (free, owner token), `POST /v1/confirm` at fixed **$0.10** USD (`"100000"` atomic) for `lead_submit` / `listing_published` (no `intent_prices`), and `POST /v1/confirm/order` at fixed **$0.25** (`"250000"` atomic) for `order_placed`. `GET /.well-known/x402` lists the concrete paid URLs: `https://livecheck.fly.dev/v1/verify`, `https://livecheck.fly.dev/v1/check`, `https://livecheck.fly.dev/v1/watch`, `https://livecheck.fly.dev/v1/watch/renew`, `https://livecheck.fly.dev/v1/confirm`, and `https://livecheck.fly.dev/v1/confirm/order`. It does **not** list `…/v1/watch/{id}/chain/topup` — crawlers would hit that literal `{id}` string and get a 402 with an empty body. Neither discovery route returns 402.

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

## Sentinel check (`POST /v1/check`)

One-shot condition check. **Does not create a watcher.** Fixed **$0.02 USDC** (`"20000"` atomic). One accept on the 402 — never dual-priced.

```http
POST /v1/check
Content-Type: application/json

{
  "target": { "type": "url", "url": "https://boards.greenhouse.io/example/jobs/1842", "render": "never", "selector": null },
  "condition": { "detector": "status_change", "params": {} },
  "baseline_hash": null
}
```

Detectors:

- **status_change** — same fetch/classify path as Verify. `observation.hash` is SHA-256 of `{status, http_class}`. When `baseline_hash` is the prior hash, `fired` is true iff status or HTTP class changed. Omit or null `baseline_hash` on the first call (`fired` is then `null`).
- **keyword** — `params.any` / `all` / `none` string arrays, optional `selector`, `case_sensitive` default false. `fired` is true when the presence set matches.
- **text_diff** — `params.selector` (recommended), `params.ignore` (regex array), `params.min_change_ratio` (default `0.02`). Hashes text after the ignore-by-default list plus any caller `ignore` patterns. Without a selector, `confidence` is capped at **0.6**. With `baseline_hash` (or `baseline_text`), `fired` is true when the remaining text changed enough.
- **numeric_threshold** — `params.selector` or `params.jsonpath` (one required), `params.op` (`lt`, `lte`, `gt`, `gte`, `eq`, `change_pct`), `params.value`, optional `params.currency`. Parses `$1,299.00`, `1 299,00 €`, and `149`. `change_pct` needs `params.baseline_value` (or `baseline_value` on the body) or `fired` is `null`.

Successful JSON includes `observation` (status, signals, http_status, http_class, hash, summary), `fired`, `confidence`, `price_usd: 0.02`, and Confirm-style additive `id` + `receipt`. Check ids use prefix **`chk_`** + ULID. `GET /v1/receipt/{id}` resolves `chk_`, `cfm_`, `wtc_`, and `evt_` from SQLite (`RECEIPT_DB_PATH`) after restart. Same Ed25519 key as Confirm (`CONFIRM_RECEIPT_PRIVATE_KEY`).

Errors: **400** `invalid_target` / `invalid_condition`; **422** `baseline_unreachable` (unusable `baseline_hash` or the target could not be fetched); unpaid → **402**.

The 402 `resource.url` is `https://livecheck.fly.dev/v1/check` in production. Payment description is ASCII-only. `advertisePaymentRequired` does not change `amount` / `asset` / `payTo` / `network` / `scheme` / `extra` / `maxTimeoutSeconds`. `extra` is Verify's USDC domain `{name:"USD Coin", version:"2"}`.

```bash
curl -s http://127.0.0.1:43127/v1/check \
  -H 'content-type: application/json' \
  -H 'X-Livecheck-Mock: 1' \
  -d '{"target":{"type":"url","url":"http://127.0.0.1:43127/fixtures/live-apply-now","render":"never"},"condition":{"detector":"status_change","params":{}}}'
```

Example **text_diff** / **numeric_threshold** bodies:

```json
{
  "target": { "type": "url", "url": "https://shop.example.com/products/wallet", "render": "never" },
  "condition": {
    "detector": "text_diff",
    "params": { "selector": "h1", "ignore": ["sku-\\d+"], "min_change_ratio": 0.02 }
  },
  "baseline_hash": null
}
```

```json
{
  "target": { "type": "url", "url": "https://shop.example.com/products/wallet", "render": "never" },
  "condition": {
    "detector": "numeric_threshold",
    "params": { "selector": ".price", "op": "lt", "value": 1000, "currency": "USD" }
  }
}
```

## Sentinel watch (`POST /v1/watch`)

30-day standard watcher. **Does not include Playwright / `/v1/watch/fast`.** Fixed **$2.50 USDC** (`"2500000"` atomic — same scale as check: `$0.01 = 10000`). One accept on the 402 — never dual-priced.

```http
POST /v1/watch
Content-Type: application/json

{
  "target": { "type": "url", "url": "https://boards.greenhouse.io/example/jobs/1842", "render": "never", "selector": null },
  "condition": { "detector": "status_change", "params": {} },
  "callback": { "url": "https://example.com/hooks/livecheck", "secret": "whsec_example", "deliver": "on_change" },
  "interval_s": 900
}
```

Create semantics:

- Detectors reuse `/v1/check` (`status_change`, `keyword`, `text_diff`, `numeric_threshold`).
- `callback.deliver=on_change` or `every_check` is accepted. Standard still skips `baseline` spam (`every_check` is stored for a later fast tier).
- `on_change.run` is `none` (default), `verify`, or `confirm`. Confirm default `intent` is `lead_submit` ($0.10 internal). Set `on_change.intent` to `listing_published` ($0.10) or `order_placed` ($0.25). Optional `on_change.url` (default `target.url`) and `on_change.claim`.
- `chain_budget_usd` is a **spend cap**, not funding. The $2.50 watch price does not include chain balance. Fund via `POST /v1/watch/{id}/chain/topup` ($0.50).
- HMAC-signed POSTs go to `callback.url`. Failed deliveries retry **1m, 5m, 30m, 2h** (5 attempts). The event row is never dropped.
- `GET /v1/watch/{id}/events` is free (owner token). Last 30 days, paginated (`limit`, `cursor`).
- `render: always` → **400** `render_not_available` with `use: "/v1/watch/fast"` (that route is not shipped yet).
- `interval_s` min **300**, default **900**. Max **2880** checks per 30-day term.
- Baseline is captured synchronously via the existing check/verify fetch path (≤10s). Fetch failure still returns **201** with `baseline.captured=false` (never 422 on watch).
- Response **201**: `id` prefix `wtc_` + Crockford ULID, `tier: standard`, `owner_token` (`owt_…`, returned once, SHA-256 at rest), `expires_at` (+30d), `checks_remaining`, `interval_s`, `first_check_at`, `baseline`, `price_usd: 2.50`, Confirm-style `receipt`. `GET /v1/receipt/{id}` resolves `wtc_` and `evt_` with the same Ed25519 family as Confirm/check.
- `GET /v1/watch/{id}`, `GET /v1/watch/{id}/events`, and `DELETE /v1/watch/{id}` are free. Send `X-Livecheck-Owner-Token` (header only). DELETE stops early with **no refund**. Watcher rows live in `watchers.sqlite`; the signed `wtc_` / `evt_` receipts live in `receipts.sqlite` on the same volume.
- Duplicate active watcher for the same paying wallet + `target.url` + condition → **409** `duplicate_watch` (includes existing `id`). Soft cap **200** active standard watchers per wallet → **429** `rate_limited`.

The 402 `resource.url` is pinned to `https://livecheck.fly.dev/v1/watch`. Payment description is ASCII-only. `advertisePaymentRequired` does not change `amount` / `asset` / `payTo` / `network` / `scheme` / `extra` / `maxTimeoutSeconds`. `extra` is Verify's USDC domain `{name:"USD Coin", version:"2"}`. Bazaar is slim / verify-shaped like check.

```bash
curl -s http://127.0.0.1:43127/v1/watch \
  -H 'content-type: application/json' \
  -H 'X-Livecheck-Mock: 1' \
  -d '{"target":{"type":"url","url":"http://127.0.0.1:43127/fixtures/live-apply-now","render":"never"},"condition":{"detector":"status_change","params":{}},"callback":{"url":"https://example.com/hooks/livecheck","secret":"whsec_example","deliver":"on_change"},"interval_s":900}'
```

Example **201**:

```json
{
  "id": "wtc_01K4…",
  "tier": "standard",
  "status": "active",
  "owner_token": "owt_01K4…",
  "expires_at": "2026-10-10T18:00:00Z",
  "checks_remaining": 2880,
  "interval_s": 900,
  "first_check_at": "2026-09-10T18:00:00Z",
  "baseline": { "captured": true, "hash": "…", "summary": "live 2xx (200); apply form present" },
  "price_usd": 2.5,
  "run": "none",
  "on_change": { "run": "none" },
  "chain_budget_usd": null,
  "chain_balance_usd": 0,
  "receipt": { "hash": "…", "verify_url": "http://127.0.0.1:43127/v1/receipt/wtc_01K4…" }
}
```

### Watch persistence + scheduler (Fly)

No Postgres / `DATABASE_URL` on this Fly app. Watchers persist in **SQLite** on the existing `livecheck_data` volume:

| Process | Path |
| --- | --- |
| Fly | `/data/watchers.sqlite` (`WATCH_DB_PATH` in `fly.toml`) |
| Local | `./data/watchers.sqlite` |

Same volume as `paid-calls.sqlite` and `receipts.sqlite`. State survives machine restarts. If Postgres is added later, dump the `watchers` + `watch_events` tables and point `WATCH_DB_PATH` at a migrator — the row shape is the migration contract.

Opening the store runs an idempotent upgrade for Phase 2 volumes: `ALTER TABLE` adds `watchers.consecutive_failures` / `unreachable` / `expiring_emitted` / `detector_state_json` / `chain_balance_atomic` / `chain_spent_atomic` / `chain_confirm_json` and `watch_events.delivery_attempts` / `next_attempt_at` / `last_error` when missing, `CREATE TABLE IF NOT EXISTS watch_delivery_attempts`, then `CREATE INDEX IF NOT EXISTS idx_watch_events_due` (that index is **not** created until the column exists). Fresh DBs and already-upgraded DBs are no-ops. No index is created on `detector_state_json` or the chain balance columns. **ALTER columns before any index that names them.**

The scheduler is an **in-process** poll (every 15s) started by `npm start` (`src/index.ts`). It runs in the same Fly machine process as HTTP (`processes = ["app"]`). `fly.toml` already keeps that machine up (`auto_stop_machines = "off"`, `min_machines_running = 1`). This is **not** Fly cron and **not** a second `fly machine`. Each tick: (1) emit `expiring` (24h before `expires_at`, once) and `expired` (at/after expiry; watcher status → `expired`); (2) claim due watchers and observe with the `/v1/check` detectors (max **2** concurrent fetches per hostname; **2-of-3 confirmation** on standard — see below); (3) POST any due HMAC callbacks.

#### 2-of-3 confirmation (standard tier)

A `change` event is **not** emitted on the first candidate observation. Standard watchers confirm with 2-of-3:

1. **One check + ~20s re-fetch** — the first candidate stores a pending snapshot and schedules a confirmation fetch ~20 seconds later. If that re-fetch is still a candidate, `change` fires. The confirmation re-fetch does not decrement `checks_remaining`.
2. **Two consecutive checks** — if the ~20s re-fetch fails or is skipped, the next successful candidate check against the last *confirmed* observation confirms the same way.

A flicker (candidate, then back to the last confirmed snapshot) clears pending and does not emit `change`. `unreachable` / `recovered` / `expiring` / `expired` are unchanged.

Opening the store also ALTERs `watchers.detector_state_json` when missing (pending confirmation + last normalized text). Same rule as Phase 2: **ALTER columns before any index that names them**. This column has no extra index.

#### Ignore-by-default (before hashing)

`text_diff` (and any content hash that goes through `normalizeForTextDiff`) strips this noise **before** SHA-256 / `min_change_ratio`:

- timestamps (ISO-8601, common date stamps, “N hours ago”)
- viewers / sold counters
- session IDs (`session_id`, `jsessionid`, `phpsessid`, …)
- CSRF / authenticity tokens
- ad slots (`adsbygoogle`, `data-ad-slot`, `doubleclick`, …)
- cookie banners (“we use cookies”, “accept all cookies”, …)

Caller `condition.params.ignore` regexes run after that list.

Event types stored and delivered:

| type | when |
| --- | --- |
| `change` | detector `fired`, or observation hash/status differs from baseline/last |
| `unreachable` | 3 consecutive fetch failures; once until recovery |
| `recovered` | first success after `unreachable` |
| `expiring` | 24h before `expires_at` (once) |
| `expired` | at/after expiry or `checks_remaining` hits 0 |
| `baseline` | only if `deliver=every_check` — skipped on standard to avoid spam |

Event ids are `evt_` + Crockford ULID. Same Ed25519 receipt family; `GET /v1/receipt/{id}` resolves `evt_`.

### HMAC callback recipe

POST the stored JSON body to `callback.url` (10s timeout). Header:

```http
X-Sentinel-Signature: t=<unix>,v1=<hex>
```

`v1` is **lowercase hex HMAC-SHA256 of the raw body** using `callback.secret`. `t` is the unix time of that delivery attempt and is **not** part of the MAC — receivers should reject stale `t` (for example older than 5 minutes).

Runnable receiver (recipes: check is request/response; watch → this callback): [`examples/sentinel-webhook.ts`](examples/sentinel-webhook.ts).

```bash
LIVECHECK_WEBHOOK_SECRET=whsec_example npx tsx examples/sentinel-webhook.ts
# listens on http://127.0.0.1:8788
```

```js
import { createHmac } from "node:crypto";

function verify(secret, rawBody, header) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=")));
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return parts.v1 === expected;
}
```

### Renew (`POST /v1/watch/renew`)

Same **$2.50 USDC** product as create (`"2500000"` atomic). One accept. Body is `{ "id" }` so `/.well-known/x402` can list a concrete URL (no `{id}` template). Auth is **owner token + payment** — send `X-Livecheck-Owner-Token` (same header as GET/DELETE and chain topup). Extends an **active** watcher's prepaid window (Confirm continuity): `expires_at` += 30 days from the later of now and the current expiry, and one more term of `checks_remaining`. Same watcher id, condition, callback, and chain balance. Does not add detectors or lifecycle event types, recapture baseline, or return `owner_token` again. Stopped or expired → **409** `not_renewable`.

```http
POST /v1/watch/renew
X-Livecheck-Owner-Token: owt_01K4…
Content-Type: application/json

{ "id": "wtc_01K4…" }
```

Example **200** (create-shaped minus `owner_token`; receipt id is `wrn_`):

```json
{
  "id": "wtc_01K4…",
  "tier": "standard",
  "status": "active",
  "expires_at": "2026-11-09T18:00:00Z",
  "checks_remaining": 5760,
  "interval_s": 900,
  "price_usd": 2.5,
  "receipt": { "hash": "…", "verify_url": "https://livecheck.fly.dev/v1/receipt/wrn_01K4…" }
}
```

### Chain top-up + `on_change.verify` / `on_change.confirm`

`POST /v1/watch/{id}/chain/topup` is a separate paid route at **$0.50 USDC** (`"500000"` atomic). One accept. Resource URL is pinned to that watcher (`https://livecheck.fly.dev/v1/watch/{id}/chain/topup`). Auth is **owner token + payment**: send `X-Livecheck-Owner-Token` in addition to the x402 settlement. The $2.50 watch create does not include chain funds.

When `on_change.run=verify` and a confirmed `change` fires:

- If chain balance ≥ **$0.01**, Livecheck runs Verify **internally** (same `verifyUrl` path as `POST /v1/verify`; no public x402, no facilitator fee to self), debits $0.01, and attaches `chain.result` + `chain.receipt` to the event/callback.
- If balance (or remaining `chain_budget_usd` cap) is too low: `chain: { "skipped": "insufficient_balance" }` and the diff is still delivered.

When `on_change.run=confirm` and a confirmed `change` fires:

- Default `intent` is `lead_submit` ($0.10). Set `on_change.intent` to `listing_published` ($0.10) or `order_placed` ($0.25) — same prices as `POST /v1/confirm` and `POST /v1/confirm/order`. No new public x402 price; chain Confirm never dual-accepts.
- Optional `on_change.url` (default `target.url`) and `on_change.claim` are forwarded to the same `confirmUrl` internals.
- If chain balance (and remaining `chain_budget_usd`) covers the debit, Livecheck runs Confirm **internally**, writes a `cfm_` receipt to **receipts.sqlite** (not paid-calls), and attaches `chain.result` + `chain.receipt` (`verify_url` → `GET /v1/receipt/{cfm_…}`).
- Insufficient balance → `chain: { "skipped": "insufficient_balance" }`. Receipt persist failure refunds the debit → `chain: { "skipped": "receipt_persist_failed" }`.

```http
POST /v1/watch/wtc_01K4…/chain/topup
X-Livecheck-Owner-Token: owt_01K4…
```

Example **200**:

```json
{
  "id": "wtc_01K4…",
  "added_usd": 0.5,
  "chain_balance_usd": 0.5,
  "chain_budget_usd": 5,
  "price_usd": 0.5,
  "run": "verify"
}
```

Example callback JSON (`on_change.run=none` stays `{ "run": "none" }`):

```json
{
  "id": "evt_01K4…",
  "type": "change",
  "watcher_id": "wtc_01K4…",
  "created_at": "2026-09-10T18:00:00Z",
  "previous": { "hash": "…", "status": "live", "http_status": 200, "http_class": "2xx", "summary": "live 2xx (200)" },
  "current": { "hash": "…", "status": "closed", "http_status": 404, "http_class": "4xx", "summary": "closed 4xx (404)" },
  "diff": { "fired": true, "changed": ["status", "http_class", "hash"] },
  "confidence": 0.82,
  "checks_remaining": 2879,
  "expires_at": "2026-10-10T18:00:00Z",
  "receipt": { "hash": "…", "verify_url": "https://livecheck.fly.dev/v1/receipt/evt_01K4…" },
  "context": { "listing_id": "job-1" },
  "chain": {
    "run": "verify",
    "result": {
      "url": "https://boards.greenhouse.io/example/jobs/1842",
      "canonical_url": "https://boards.greenhouse.io/example/jobs/1842",
      "status": "closed",
      "http_status": 404,
      "checked_at": "2026-09-10T18:00:00Z",
      "signals": ["http 404"],
      "confidence": 0.9,
      "price_usd": 0.01
    },
    "receipt": { "hash": "…", "verify_url": "https://livecheck.fly.dev/v1/receipt/evt_01K4…" },
    "debit_usd": 0.01
  }
}
```

Retries live on the same in-process worker. After a failed POST (network, timeout, or non-2xx) the event stays in `watch_events` with `delivery_attempts` incremented and `next_attempt_at = now + delay`. Delays after attempts 1–4 are **1m, 5m, 30m, 2h**. The fifth failure marks the delivery exhausted (`next_attempt_at` null) — the event is kept. Each try is also written to `watch_delivery_attempts`. The 15s poll drains any row whose `next_attempt_at` is due.

Health reports `watch: true`, `watch_price_usd: 2.5`, `public_watch_url`, `chain_topup: true`, `chain_topup_price_usd: 0.5`, and `public_chain_topup_url` (`/v1/watch/{id}/chain/topup`). Paid Verify and Confirm 200 responses include a `watch` suggest (`/v1/watch`, detector `status_change`, `$2.50`) so agents can create a watcher after a one-shot check.

## Confirm (`POST /v1/confirm`)

Livecheck Confirm — use after your agent submits a lead/contact form (intent=lead_submit): POST {url, intent} where url is the thank-you or result page. Returns confirmed|failed|unknown with Level-2+ evidence (confirmation/ref/ticket id required for confirmed). Independent cookieless verifier — actor ≠ verifier. Also accepts intent=listing_published ($0.10) for listing go-live checks — see OpenAPI. Signed receipts + GET /stats. Not URL/stock liveness (use /v1/verify). Not Trust Oracle / L3.

Payable Confirm intents are **`lead_submit`** ($0.10) and **`listing_published`** ($0.10) on `POST /v1/confirm`, and **`order_placed`** ($0.25) on `POST /v1/confirm/order`. `/v1/verify` stays **$0.01**. Bazaar 402 copy stays lead_submit-primary on `/v1/confirm`. Do not treat OpenAPI/x402 listing `order_placed` as a Bazaar marketing ad.

```http
POST /v1/confirm
Content-Type: application/json

{ "url": "https://example.com/thank-you", "intent": "lead_submit", "claim": {} }
```

```http
POST /v1/confirm/order
Content-Type: application/json

{ "url": "https://shop.example.com/thank-you", "intent": "order_placed", "claim": {} }
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

Paid 200 Confirm and Confirm-order JSON also includes the same `watch` suggest as Verify (`/v1/watch`, detector `status_change`, `price_usd: 2.5`). It is not present on unpaid 402.

Successful JSON is additive on the v0 fields (`verdict`, `effect`, `signals`, `evidence_strength`, `evidence_id`, …):

- `id` — stable `cfm_` + ULID
- `evidence_level` — 0–4 (lead_submit, listing_published, and order_placed confirmed stay L2)
- `confidence` — 0–1
- `receipt` — `{ hash, verify_url }` always; `signature` + `signer` when `CONFIRM_RECEIPT_PRIVATE_KEY` is set

Unknown intents return HTTP **400** `{ "error": "unsupported_intent" }` after pay. `order_placed` on `POST /v1/confirm` is **400** `{ "error": "unsupported_intent", "use": "/v1/confirm/order" }`. Do not treat Bazaar marketing copy as a GA order_placed ad.

**Payment (one fixed price per resource):** `@x402/hono` prices the *route*, not the JSON `intent`. Unpaid `POST /v1/confirm` 402s with exactly one accept at **$0.10 / 100000 atomic**. Unpaid `POST /v1/confirm/order` 402s with exactly one accept at **$0.25 / 250000 atomic**. Dual/dynamic `accepts[]` on one path made purl report "Payment was not accepted" because facilitator verify failed when settle-time `paymentRequirements` drifted from the first 402. `advertisePaymentRequired` must not change matching fields (`amount`, `asset`, `payTo`, `network`, `scheme`, `extra`, `maxTimeoutSeconds`). `extra` stays Verify's USDC domain `{name, version}`. Route config pins `resource` URL + ASCII description to the public values so that rewrite is a no-op for signing fields. Mock pay (`X-Livecheck-Mock: 1`) still bypasses the gate. Successful JSON still returns `price_usd: 0.25` for `order_placed`.

Free Confirm extras: `GET /v1/receipt/{id}`, `GET /.well-known/livecheck-keys.json`, `GET /stats` (JSON; HTML if `Accept: text/html`). Public landing source of truth is **`GET https://livecheck.fly.dev/stats?format=json`** (same document locally at `/stats?format=json`). The human demo (`GET /`) fetches that JSON; Gil's locked drafts are [`docs/gap7/recipes.md`](docs/gap7/recipes.md) and [`docs/gap7/landing-copy.md`](docs/gap7/landing-copy.md). `GET /stats` publishes lead_submit, listing_published, and order_placed rolling counts plus **CI/local** Confirm honesty benches (`benches.{lead_submit,listing_published,order_placed}` with `false_confirmed_rate` + `n` — not a live dispute rate), plus a **Sentinel** section (below). `paid_calls` are confirm-route SQLite rows **with that intent stored** on **this machine's** `livecheck_data` volume (`store.scope=this_machine_volume`). Confirm rows written before the intent column stay in `store.confirm_unscoped_paid_calls` and are **not** counted as `lead_submit`. Two Fly machines with two volumes are not summed — see CoS below. Local honesty benches: `npm run bench:lead-submit`, `npm run bench:listing-published`, and `npm run bench:order-placed` (gate: `false_confirmed = 0`). Reports: [`docs/confirm-benches.md`](docs/confirm-benches.md). Sentinel honesty + latency (CI/local, not a 1000-watcher soak): `npm run bench:sentinel` — report at [`docs/sentinel-benches.md`](docs/sentinel-benches.md).

### Confirm benches on `GET /stats`

JSON and HTML include `benches` next to live Confirm intent windows. These are **CI/local honesty** numbers, not a live dispute rate, and are **not** derived from `paid_calls`:

| Field | Source |
| --- | --- |
| `benches.lead_submit` | `bench/lead-submit-report.json` (fallback: N=77, FC=0). `false_confirmed_rate`, `n`, `false_confirmed`. |
| `benches.listing_published` | `bench/listing-published-report.json` (fallback: main `b10322b`, N=102, FC=0). |
| `benches.order_placed` | `bench/order-placed-report.json` (fallback: main `0e9faa1`, N=100, FC=0). |

Gate: `false_confirmed = 0`. Report: [`docs/confirm-benches.md`](docs/confirm-benches.md). Missing a report file uses the hardcoded fallback — missing is not a live rate of 0.

### Sentinel on `GET /stats`

JSON and HTML include `sentinel` next to Confirm intents. Counts come from `watchers.sqlite` (plus one-shot `chk_` receipts):

| Field | Source |
| --- | --- |
| `active_watchers` | `watchers` rows with `status=active` |
| `checks_run` | one-shot `POST /v1/check` receipts + scheduled observations (`term quota − checks_remaining`) |
| `change_events` | `watch_events` rows with `kind=change` |
| `by_detector.{status_change,keyword,text_diff,numeric_threshold}` | watcher counts and change-event counts per detector |
| `benches.false_positive_rate` | CI/local gate rates from `bench/sentinel-report.json` (fallback: main `590627c`). `status_change` 0/198, `text_diff` 0/198, `n_checks` 198, gate `status_change=0; text_diff<=0.02`. Not a live dispute rate. |
| `benches.median_latency_ms` | 162500 (p50). Also `latency_p95_ms` 315250, `interval_s` 300, HMAC 20/20, chain Verify pass. Report: `docs/sentinel-benches.md`. |

Prices on that object stay `$0.02` / `$2.50` / `$0.50`. `status` is `payable` (Bazaar GA held). Missing is not zero.

### Signed receipts

Set `CONFIRM_RECEIPT_PRIVATE_KEY` to an Ed25519 **PKCS#8 PEM** (recommended) or a **32-byte seed** as hex (64 chars) or base64. Generate PEM:

```bash
node --input-type=module -e "import { generateKeyPairSync } from 'node:crypto'; process.stdout.write(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())"
```

The signature is Ed25519 over canonical JSON `{id,intent,verdict,confidence,evidence_level,evidence_summary_or_hash,observed_at,url_hash,claim_hash}` (that key order). `evidence_summary_or_hash` is a SHA-256 of signals/verdict (not the raw confirmation id). Receipts persist in **SQLite** on the same Fly volume as watchers (`livecheck_data` → `/data`). Live settlement (`@x402/hono`) runs the handler first and settles only when the handler status is below 400. If `receipts.sqlite` does not persist the row, live Confirm returns **503** `receipt_persist_failed` so the facilitator does **not** settle — no orphan `paid_call` without a durable receipt. Mock/dev still 200s from process memory.

Pre-`26c702e` bound `confirm_receipts` into **`paid-calls.sqlite`** (`bindReceiptSqlite`). `26c702e` started a separate `receipts.sqlite` but did not copy those rows. Patty already ran a one-shot on both live machines with **node:sqlite `DatabaseSync`** (the Fly image has no better-sqlite3): `node /data/migrate-receipts-v5.mjs`. Do not redo that blindly. Boot and `npm run receipt:rescue` (also `DatabaseSync`) remain as an **idempotent** leftover copy (`INSERT OR REPLACE` by id) plus **DROP** of the misplaced table so receipts are never written into the paid-call DB again. `found=0` means that volume is already migrated. The Sep 8 confirm paid_call (`839744b76061e8` id 2, `pi_3UDUC1QOrQ8LEBMA1ZXJlcqF`) has **no** receipt in either file — refund candidate, not reconstructable.

Receipts persist at:

| Process | Path |
| --- | --- |
| Fly | `/data/receipts.sqlite` (`RECEIPT_DB_PATH` in `fly.toml`) |
| Local | `./data/receipts.sqlite` |

Table `confirm_receipts` holds every signed (or unsigned-stub) receipt: Confirm `cfm_`, Sentinel check `chk_`, watcher `wtc_`, and watch event `evt_`. Opening the store is idempotent: `CREATE TABLE IF NOT EXISTS`, then `ALTER TABLE` for any missing columns, **then** indexes on `created_at` (ALTER columns before any index that names them). Fresh DBs and already-upgraded DBs are no-ops. `GET /v1/receipt/{id}` reads this file after a Fly redeploy — receipts are not process-memory only. If the key is unset, Confirm still returns `id` plus an unsigned receipt stub (`hash` + `verify_url`); the paid path does not crash. The stub is still written to SQLite so GET resolves after restart.

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

`npm test` runs fixture-based classifier, HTTP, MCP (tool registration + 402-without-payment), discovery, mocked eBay Browse, webhook-sample HMAC, and Sentinel bench-gate tests. Unit tests never call the live eBay network. `npm run bench:sentinel` writes `docs/sentinel-benches.md` and `bench/sentinel-report.json` (false-positive rates, latency p50/p95 vs `interval_s + 60s` / `2×interval_s`, HMAC recipe, chain Verify). No real $2.50 spends.

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

Default first settle is **production Verify**. Install `purl` and add a wallet as in [Verify-first: first paid call](#verify-first-first-paid-call). To settle with real USDC on Base, use Stripe’s `purl` client from the [x402 guide](https://docs.stripe.com/payments/machine/x402.md):

```bash
purl https://livecheck.fly.dev/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://job-boards.greenhouse.io/discord/jobs/8806482002"}'
```

Local-dev override only when this repo is running (`npm start`): `purl http://127.0.0.1:43127/v1/verify …`

`purl` moves real funds because the deposit address is a live-mode Base address.

### Skill install (Verify first)

```bash
mkdir -p ~/.local/lib
npx --yes skills add moyecj-snap/livecheck -y -s livecheck-verify-then-confirm
```

Create `~/.local/lib` first or the CLI can fail with `ENOENT`. The `skills` package may warn that it wants Node `>=22.20.0`; Node `20.19` still works. The skill’s default first call is Verify.

## Cursor MCP (local agent)

Stdio MCP (`src/mcp.ts` / `npm run mcp`). **No wallet, no private key, no x402 spender.** Cursor stdio still does not pay. If Fly (or local) returns **402**, the tool result is structured: `paid: false`, `http: 402`, plus decoded `payment-required` / x402 accept info. That is payment required — not a successful settle.

Paid path only when the caller already has an envelope and supplies it as tool arg `payment_signature` or env `LIVECHECK_PAYMENT_SIGNATURE` (forwarded as `PAYMENT-SIGNATURE` / `X-PAYMENT`). The MCP never sends `X-Livecheck-Mock`.

`LIVECHECK_URL` defaults to production Verify (`https://livecheck.fly.dev/v1/verify`) in `examples/cursor-mcp.json`. The client strips `/v1/verify` so check / confirm / watch hit the same origin. Override to `http://127.0.0.1:43127/v1/verify` only when you are running `npm start` locally. There is no remote MCP transport in this repo; Cursor uses stdio. **MCP does not settle payment.**

Locked drafts for Gil: [`docs/gap7/recipes.md`](docs/gap7/recipes.md) (3 copy-paste recipes) and [`docs/gap7/landing-copy.md`](docs/gap7/landing-copy.md) (landing /stats copy).

### Tool names + input shapes (Gil recipes)

Canonical paid tools:

| Tool | Fly route | Price | Input |
| --- | --- | --- | --- |
| **`verify`** | `POST /v1/verify` | $0.01 | `{ url, payment_signature? }` |
| **`check`** | `POST /v1/check` | $0.02 | `{ target, condition, baseline_hash?, baseline_text?, baseline_value?, payment_signature? }` |
| **`confirm`** | `POST /v1/confirm` or `POST /v1/confirm/order` | $0.10 / $0.25 | `{ url, intent, claim?, payment_signature? }` |
| **`watch`** | `POST /v1/watch` | $2.50 | `{ target, condition, callback, interval_s?, label?, context?, on_change?, chain_budget_usd?, payment_signature? }` |

`intent=lead_submit` / `listing_published` → `/v1/confirm` ($0.10). `intent=order_placed` → `/v1/confirm/order` ($0.25). One price per route.

Compatibility (keep existing Cursor plugin / `mcp.json` working):

- **`verify_listing`** — same as `verify` (`{ url, payment_signature? }`)

Owner-token follow-ups (token returned once on `watch` create; send as `X-Livecheck-Owner-Token`):

| Tool | Fly route | Auth |
| --- | --- | --- |
| **`watch_get`** | `GET /v1/watch/{id}` | `{ id, owner_token }` (free) |
| **`watch_events`** | `GET /v1/watch/{id}/events` | `{ id, owner_token, limit?, cursor? }` (free) |
| **`watch_stop`** | `DELETE /v1/watch/{id}` | `{ id, owner_token }` (free, no refund) |
| **`watch_chain_topup`** | `POST /v1/watch/{id}/chain/topup` | `{ id, owner_token, payment_signature? }` ($0.50; unpaid → 402) |

Shapes:

```json
// verify / verify_listing
{ "url": "https://boards.greenhouse.io/example/jobs/1842" }

// check
{
  "target": { "type": "url", "url": "https://boards.greenhouse.io/example/jobs/1842", "render": "never", "selector": null },
  "condition": { "detector": "status_change", "params": {} },
  "baseline_hash": null
}

// confirm
{ "url": "https://example.com/thank-you", "intent": "lead_submit", "claim": {} }

// watch
{
  "target": { "type": "url", "url": "https://boards.greenhouse.io/example/jobs/1842", "render": "never", "selector": null },
  "condition": { "detector": "status_change", "params": {} },
  "callback": { "url": "https://example.com/hooks/livecheck", "secret": "whsec_example", "deliver": "on_change" },
  "interval_s": 900
}
```

`target.render` is HTML-only (`never`). Detectors: `status_change`, `keyword`, `text_diff`, `numeric_threshold`. Watch HMAC receiver: [`examples/sentinel-webhook.ts`](examples/sentinel-webhook.ts). Landing stats: `GET https://livecheck.fly.dev/stats?format=json`.

Unpaid tool result: `{ "paid": false, "http": 402, ...decoded payment-required }`. HTTP 200/201 returns the Fly JSON as-is.

`examples/cursor-mcp.json` points at production by default, so you do **not** need a local `npm start` for first-use MCP. Unpaid tools still return structured 402. Use localhost only as a local-dev override while `npm start` is running.

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
        "LIVECHECK_URL": "https://livecheck.fly.dev/v1/verify"
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
        "LIVECHECK_URL": "https://livecheck.fly.dev/v1/verify"
      }
    }
  }
}
```

Local-dev override (only with `npm start`): set `LIVECHECK_URL` to `http://127.0.0.1:43127/v1/verify`.

3. Reload Cursor (or toggle the server under Customize → MCP). Ask the agent to `verify` (or `verify_listing`) a job URL, or `check` / `confirm` / `watch`. An unpaid call should come back as HTTP 402 with `paid: false` and the Base USDC requirements for that route. A request that the HTTP server has already settled returns the Fly JSON as-is.

Do not put Stripe or CDP secrets in `mcp.json`. Those stay in the HTTP server’s local `.env`. The MCP only needs `LIVECHECK_URL` (optional `LIVECHECK_PAYMENT_SIGNATURE` if a paying host already has an envelope).

### Cursor plugin (Marketplace later)

Packaging for a later Cursor Marketplace submit lives in this repo:

- `.cursor-plugin/plugin.json` — plugin name, author, honest description
- `mcp.json` (repo root; also copied under `.cursor-plugin/`) — stdio MCP pointed at `LIVECHECK_URL=https://livecheck.fly.dev/v1/verify`

Existing `LIVECHECK_URL=…/v1/verify` stays valid. The client derives the origin for check / confirm / watch. No secrets in those files. The plugin does not pay. `verify` / `check` / `confirm` / `watch` against production still report 402 until a wallet or `purl` settles.

Cursor Marketplace is human distribution. It requires a **public GitHub repository** at submit time. Origin remains the source of truth. Do not create a GitHub repo from this session. When you want Marketplace, publish a public GitHub copy yourself and submit it.

`examples/cursor-mcp.json` defaults to production Verify. Override `LIVECHECK_URL` to `http://127.0.0.1:43127/v1/verify` only for local `npm start`. Root `mcp.json` and `.cursor-plugin/mcp.json` already use production.

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

Each successful paid `POST /v1/verify`, `POST /v1/confirm`, and `POST /v1/confirm/order` writes **one** structured JSON line to stdout **and** a row in a small SQLite table (when the Fly volume is mounted). Confirm/order still records `route: "confirm"` plus `intent: "order_placed"`. Stripe PaymentIntent recording is unchanged. The stdout line is stable — do not change the `event` name or field set; `fly logs | grep livecheck.paid_call` must keep working.

```json
{"event":"livecheck.paid_call","route":"verify","status":"live","host":"boards.greenhouse.io","url_hash":"…","payer":"0x…","tx":"0x…","payment_intent":"pi_…","ts":"2026-09-06T20:34:00Z"}
```

Confirm lines add `intent` (`lead_submit`, `listing_published`, or `order_placed`) and `verdict` instead of `status`. Privacy rule: **never** log or store raw query strings, emails, or full URLs — hostname + SHA-256 of the full URL only. `payer` / `tx` / `payment_intent` are omitted when missing (mock/dev).

Retained columns (SQLite `paid_calls` at `PAID_CALL_DB_PATH`, default `/data/paid-calls.sqlite` on Fly): `ts`, `route` (`verify` | `confirm`), `payer`, `tx`, `payment_intent`, `host`, `url_sha256` (same digest as log `url_hash`).

CoS pull — L7d / L30d **row counts only** (calls = rows; unique_payers = distinct non-null wallet). No other KPIs. Confirm rows now also print **intent-scoped** counts (`lead_submit` / `listing_published` / `order_placed` / `unscoped`).

**Dual-volume:** two machines, each with its own `livecheck_data`. `GET /stats` and a single `fly ssh` are **one volume**. Do not add the two reports into a new KPI.

| Machine | Name | What it holds (after Patty v5) |
| --- | --- | --- |
| `839744b76061e8` | summer-voice | Confirm paid_calls (3 confirm + 1 verify). `cfm_01M23ZJJGNHQ15N4DGQ7QS50KP` and `cfm_01M240J5SCC7XYY1S865XW0FDR` are in `receipts.sqlite`. Live `/stats` on this volume: lead 3 paid / 1 receipt confirmed; order 1/1 unknown. |
| `860792be4622e8` | sparkling-violet | Mostly verify/check. Stray `wtc_` is in `receipts.sqlite`. |

```bash
# which machines / ssh each volume
npm run paid-call:cos -- --machines-help
npm run receipt:rescue -- --machines-help

# Leftover check only (node:sqlite). found=0 = already migrated. Do not invent a second copy.
# Patty already ran: node /data/migrate-receipts-v5.mjs
fly ssh console -a livecheck --machine 839744b76061e8 -C "npm run receipt:rescue -- --json"
fly ssh console -a livecheck --machine 860792be4622e8 -C "npm run receipt:rescue -- --json"

fly ssh console -a livecheck --machine 839744b76061e8 -C "npm run paid-call:cos -- --json"
fly ssh console -a livecheck --machine 860792be4622e8 -C "npm run paid-call:cos -- --json"

# JSON for agents
npm run paid-call:cos -- --json
```

`npm run receipt:rescue` and process boot use **node:sqlite `DatabaseSync`** (no better-sqlite3). They copy any leftover `confirm_receipts` rows from `paid-calls.sqlite` → `receipts.sqlite` (`INSERT OR REPLACE` by id) and drop the misplaced table. `initReceiptStore` refuses a `paid-calls.sqlite` path. Live GET `/v1/receipt/cfm_01M23ZJJGNHQ15N4DGQ7QS50KP` already 200s on summer-voice after v5.

`npm run receipt:backfill` reports intent-scoped paid_calls vs receipt counts on this volume. With `--from-logs` / `--log-file` it copies `intent` + `verdict` from `livecheck.paid_call` lines onto matching unscoped paid_calls (`ts` + `url_sha256`). It does **not** invent stub receipts.

**Sep 8 orphan (refund candidate):** summer-voice `paid_calls` id 2, `2026-09-08T18:56:30Z`, route=confirm, `payment_intent=pi_3UDUC1QOrQ8LEBMA1ZXJlcqF`, `tx=0xd932eeba…`. Still no `confirm_receipts` row in either DB after v5. Unreconstructable. Manual Stripe refund is an ops decision — this process does not refund.

Interim if the volume is missing or the file is empty — parse the existing stdout lines (same column shape, same counts):

```bash
fly logs -a livecheck | grep livecheck.paid_call
fly logs -a livecheck | npm run paid-call:cos -- --from-logs
```

TODO: after the `livecheck_data` volume is attached and `/data/paid-calls.sqlite` is writable, production CoS pulls should use the sqlite command, not `--from-logs`.

#### Patty — Fly volume (required before first deploy of this mount)

`fly.toml` now has `[[mounts]]` `livecheck_data` → `/data`. `fly deploy` fails until the volume exists. Single writer (`min_machines_running = 1`); do not scale out without a **shared** store. A second machine creates a second volume and splits `/stats` (the P0 3/0 vs 0/0 split). Prefer one machine until then.

```bash
# once, region must match primary_region (sjc)
fly volumes create livecheck_data --region sjc --size 1 -a livecheck

fly deploy

# SSH is root; the process user is `node`. One-time so SQLite can create the file:
fly ssh console -a livecheck -C "chown node:node /data"

# confirm retention
fly ssh console -a livecheck -C "ls -l /data/paid-calls.sqlite"
fly ssh console -a livecheck -C "ls -l /data/receipts.sqlite"
fly ssh console -a livecheck -C "npm run paid-call:cos"
```

No new secrets. `PAID_CALL_DB_PATH`, `WATCH_DB_PATH`, and `RECEIPT_DB_PATH` are public/path config (`/data/paid-calls.sqlite`, `/data/watchers.sqlite`, `/data/receipts.sqlite` in `fly.toml` `[env]`). Local defaults are `./data/*.sqlite`.

## How agents find this

- **Wallet-agents:** [CDP x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar) / Agentic.market. They search a free catalog of paid APIs, then pay $0.01 USDC on Base to `POST /v1/verify`.
- **Humans in Cursor:** Cursor Marketplace (later). Needs a public GitHub repository for submit. Do not create one here. Until then, point Cursor at the stdio MCP in this repo (`verify`, `check`, `confirm`, `watch`; `verify_listing` remains). The MCP reports 402; paying is x402.

## Honest limits

- Product pages on this path are HTML-only. Amazon, TikTok, and Alibaba listings stay `unknown`. Loginwalls, SPAs, and real challenge interstitials often come back `unknown`. Workday boards that render apply UI only in JavaScript stay unknown.
- No GitHub mirror. This Origin repository is the source of truth. Deploy Fly from this tree.
- New York businesses cannot accept x402 stablecoin payments.

## Non-goals (this phase)

Spec §8 — not in this slice. Do not treat these as shipped or priced:

- Playwright / `POST /v1/watch/fast` / JS render (`render: always` stays `400 render_not_available`)
- Confirm chain is live (`on_change.run=confirm`; default `intent=lead_submit`). Watcher renew is live (`POST /v1/watch/renew`)
- Dispute endpoint or a live-route Sentinel false-positive rate (CI/local benches are published on `GET /stats` `sentinel.benches` from `bench/sentinel-report.json`)
- Bazaar GA listing push (402 bazaar metadata on Verify stays; do not treat catalog index as GA)
- Dual accepts or dynamic pricing on one 402
- Postgres watcher spine (SQLite on the Fly volume)
- Price changes
- Fly deploy or GitHub mirror from this tree (Origin remains SoT)

## License

See [LICENSE](./LICENSE). Hosted API use is also subject to the Livecheck API Terms (pay per call; no resale as your own trust layer).
