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

The server listens on `http://127.0.0.1:43127` (or `$PORT`). Without live keys it prints a banner: settlement is disabled. Unpaid verify still returns a realistic x402 `402` with a `payment-required` header. The verifier still runs against local fixtures.

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

`npm test` runs fixture-based classifier and HTTP tests (closed Greenhouse redirect, two “closed to new applications” pages, 200 + Apply Now, 404).

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

## Honest limits

- Prototype. Jobs-first heuristics on HTML. Loginwalls, SPAs, and challenge pages often come back `unknown`.
- No GitHub mirror. This Origin repository is the source of truth.
- New York businesses cannot accept x402 stablecoin payments.
