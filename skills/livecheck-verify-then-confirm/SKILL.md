---
name: livecheck-verify-then-confirm
description: >-
  Use this when an agent workflow must check a URL is still live with Livecheck
  then independently confirm a lead_submit side effect with Confirm. Verify
  accepts x402 (Base USDC) or MPP (Tempo USDC.e). Confirm is x402 on Base.
  Actor ≠ verifier; thank-you copy alone is never confirmed.
metadata:
  version: "0.2.0"
---

# Livecheck → Confirm

Version 0.2.0.

Default first call is **Verify** (`POST /v1/verify`). Confirm is later, after you have a thank-you or result URL.

## When
You already have a concrete job/product/eBay URL, and later a post-submit thank-you or result URL. Goal: pay Livecheck for availability, then pay Confirm for an independent `lead_submit` check. Do **not** trust the actor’s own `success: true`.

## Install

Create `~/.local/lib` first — the skills CLI can fail with `ENOENT` if that directory is missing.

```bash
mkdir -p ~/.local/lib
npx skills add moyecj-snap/livecheck-skills --all --yes  # maintained package: https://github.com/moyecj-snap/livecheck-skills
```

The `skills` CLI may warn that it wants Node `>=22.20.0`. Node `20.19` still works.

## Endpoints
| Tool | Method | Price | Body |
| --- | --- | --- | --- |
| Livecheck | `POST https://livecheck.fly.dev/v1/verify` | $0.01 exactly: x402 (Base USDC) or MPP (Tempo USDC.e) | `{"url":"<absolute URL>"}` |
| Confirm | `POST https://livecheck.fly.dev/v1/confirm` | $0.10 USDC on Base (x402) | `{"url":"<thank-you or result URL>","intent":"lead_submit"}` |

Verify's unpaid 402 offers both rails. Each charges exactly $0.01. Send one credential. MPP method is tempo/charge: USDC.e on Tempo (chain 4217). Stripe pays Tempo gas. With MPP (Tempo): Paid answers, including the checked link, are kept for 24 hours so retries are safe, then deleted. Confirm is x402 only.

## Starter key (no wallet)

`GET https://livecheck.fly.dev/keys` signs in with GitHub (public profile, no email) and shows `lc_live_…` once. Send `Authorization: Bearer lc_live_…` on `POST /v1/verify`, `/v1/verify/job`, and `/v1/verify/listing` only. 200 checks over 30 days. A real answer spends one check (`unknown` included), including a board found only after the fetch. Errors do not. A Greenhouse, Lever, or Ashby board with no job id is rejected free. Confirm, `/v1/check`, and Sentinel stay wallet-only. The free `/job` page limits are separate. When the free checks are gone, the route returns 402: pay with a wallet on the same route without the key, or reply to get a top-up link at moyecj@gmail.com.

- OpenAPI: https://livecheck.fly.dev/openapi.json
- Stats: https://livecheck.fly.dev/stats
- Discovery: Coinbase x402 Bazaar — search `livecheck` returns **both** tools
- Optional later: `POST /v1/confirm/order` ($0.25) for `order_placed` only — not this skill’s default path

Pasteable tool shapes: see `tools.json` in this folder.

End-to-end paid demo (purl, production fixtures, ~$0.11 USDC): [`docs/DEMO-AGENT-VERIFY-CONFIRM.md`](../../docs/DEMO-AGENT-VERIFY-CONFIRM.md).

## Paid demo (`purl`)

Production URLs. Needs USDC on Base. **Never paste keys.** Install `purl` from the README Verify-first section (Linux + macOS Apple Silicon). MCP without a wallet still returns 402 — for this paid path use `purl` or AgentCore bazaar + payments.

Unpaid 402 (no spend):

```bash
curl -sS -D - -o /tmp/livecheck-verify.402 https://livecheck.fly.dev/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/live-apply-now"}'

curl -sS -D - -o /tmp/livecheck-confirm.402 https://livecheck.fly.dev/v1/confirm \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/demo/thank-you?ref=ABC123","intent":"lead_submit"}'
```

Paid Verify (`$0.01`) — expect `status=live`. `-A` labels this skill's own purl runs (`livecheck-internal/`) on the log and on `/stats`. The label does not remove the call from external. External is the payer wallet.

```bash
purl -A 'livecheck-internal/purl-0.2.8' https://livecheck.fly.dev/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/live-apply-now"}'
```

**Actor:** for the demo, treat form submit as already done. Do not build a form product. Confirm the hosted thank-you page next.

Paid Confirm (`$0.10`) — expect `verdict=confirmed`, Level-2 id `ABC123`:

```bash
purl -A 'livecheck-internal/purl-0.2.8' https://livecheck.fly.dev/v1/confirm \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/demo/thank-you?ref=ABC123","intent":"lead_submit"}'
```

Honesty contrast (thank-you fluff → `unknown`, never confirmed):

```bash
purl -A 'livecheck-internal/purl-0.2.8' https://livecheck.fly.dev/v1/confirm \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/confirm/thank-you-only","intent":"lead_submit"}'
```

The contrast is an extra `$0.10` if paid; skip and still treat fluff as `unknown`. Required path spend is **~$0.11 USDC**.

## Steps
1. **Verify first** — unpaid call expects HTTP 402; pay with x402 (Base USDC) or MPP (Tempo USDC.e); body `{"url":"<absolute job, Shopify/HTML product, or eBay /itm/ URL>"}`. Demo fixture: `https://livecheck.fly.dev/fixtures/live-apply-now`.
2. Parse `status` `live|closed|unknown` + `signals`. If `closed` or `unknown` (and not a known Ashby/Lever unknown), stop or escalate — do not treat as success.
3. Run the agent’s own `lead_submit` action (separate actor). Demo: treat submit as already done; use the hosted thank-you page.
4. **Confirm** — unpaid → 402; pay; body `{"url":"<thank-you or result URL>","intent":"lead_submit"}` (optional `claim` fingerprint). Demo page: `https://livecheck.fly.dev/demo/thank-you?ref=ABC123` (HTTP 200, confirmation number printed).
5. Accept only `verdict=confirmed` with Level-2 evidence: a ref / ticket / lead id printed on the page. A token that appears only in the URL is not proof, and a non-2xx page is never confirmed. Thank-you fluff alone → `unknown` — never treat as confirmed (`https://livecheck.fly.dev/fixtures/confirm/thank-you-only`).
6. On `failed` / `unknown`, prefer abstention over false success.

## Verify signals (production strings)

`signals` on a paid Verify response are these exact strings. Do not expect `in_stock`, `sold_out`, `apply_form`, `ended_banner`, or a 400 `code` of `invalid_url`.

HTML classifier:

- `http_404` and `http_410` only (HTTP 404 and 410)
- `close_language:<phrase>` — phrase is one of: "no longer accepting applications", "this job is closed to new applications", "this job is no longer available", "the job you are trying to apply for has been filled", "this position has been filled", "this job posting is no longer active", "no longer accepting applicants", "this requisition is closed", "sorry, this job is no longer available", "the job you are looking for is no longer available"
- `redirected_to_board`, `ats_empty_state`, `challenge_page`, `loginwalled`, `not_a_specific_posting`, `careers_homepage`, `collection_or_category`
- `apply form present`, `no closure banner` (spaces)
- `sold-out`, `in-stock` (hyphens)
- `ambiguous_html`

eBay adapter, when enabled:

- `ebay-ended`, `sold-out`, `ebay-in-stock`, `ebay_availability_unknown`
- missing item: `http_404` and `ebay-ended`
- `ebay_adapter_disabled`, `ebay_api_error`

## Verify errors

Bodies are `{ "error": "<message>" }`. There is no `code` field and no `invalid_url`.

- 400: `JSON body must include { "url": "https://..." }.`
- 400: `url must be an absolute http(s) URL.`
- 400: `Only http and https URLs are accepted.`
- 400: `Request body must be JSON.`
- 504: `Timed out fetching <url> after 8000ms.`
- 502: `Could not fetch URL: <message>`
- 503: `over_capacity` or `processor_unavailable`, with `message`. Wait for the `Retry-After` header and retry. You were not charged. Do not treat 503 as `closed` or `unknown`.
- 503: MPP `payment_unconfirmed`. The payment could not be confirmed. A possible charge is logged for refund, and retrying with the same credential is safe and never charges twice. Do not treat this as `closed` or `unknown`.

## Capacity
On HTTP 503, wait for `Retry-After` and retry. For a list of URLs, send up to 8 checks at a time.

## Honest limits (do not overclaim)
- Jobs: Ashby JS / Lever Cloudflare often `unknown`.
- Products: do not use Amazon search URLs.
- Confirm: thank-you page alone ≠ confirmed. Not Trust Oracle / L3. Not Firecrawl/Stagehand success detection.
- Local honesty bench: false-confirmed=0 on fixture set — not broad public-web confirmed recall.

## Success
Paid 200 JSON from both calls; Confirm `confirmed` only with Level-2 signals; report both responses. Demo path: Verify `live` on `live-apply-now` + Confirm `confirmed` on `thank-you-id` (~$0.11 USDC). Full copy-paste: [`docs/DEMO-AGENT-VERIFY-CONFIRM.md`](../../docs/DEMO-AGENT-VERIFY-CONFIRM.md).
