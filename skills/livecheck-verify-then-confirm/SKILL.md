---
name: livecheck-verify-then-confirm
description: >-
  Use this when an agent workflow must check a URL is still live with Livecheck
  then independently confirm a lead_submit side effect with Confirm (x402 on
  Base). Actor ≠ verifier; thank-you copy alone is never confirmed.
---

# Livecheck → Confirm (x402)

Default first call is **Verify** (`POST /v1/verify`). Confirm is later, after you have a thank-you or result URL.

## When
You already have a concrete job/product/eBay URL, and later a post-submit thank-you or result URL. Goal: pay Livecheck for availability, then pay Confirm for an independent `lead_submit` check. Do **not** trust the actor’s own `success: true`.

## Install

Create `~/.local/lib` first — the skills CLI can fail with `ENOENT` if that directory is missing.

```bash
mkdir -p ~/.local/lib
npx --yes skills add moyecj-snap/livecheck -y -s livecheck-verify-then-confirm
```

The `skills` CLI may warn that it wants Node `>=22.20.0`. Node `20.19` still works.

## Endpoints
| Tool | Method | Price | Body |
| --- | --- | --- | --- |
| Livecheck | `POST https://livecheck.fly.dev/v1/verify` | $0.01 USDC on Base (x402) | `{"url":"<absolute URL>"}` |
| Confirm | `POST https://livecheck.fly.dev/v1/confirm` | $0.10 USDC on Base (x402) | `{"url":"<thank-you or result URL>","intent":"lead_submit"}` |

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
  -d '{"url":"https://livecheck.fly.dev/fixtures/confirm/thank-you-id","intent":"lead_submit"}'
```

Paid Verify (`$0.01`) — expect `status=live`:

```bash
purl https://livecheck.fly.dev/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/live-apply-now"}'
```

**Actor:** for the demo, treat form submit as already done. Do not build a form product. Confirm the thank-you fixture next.

Paid Confirm (`$0.10`) — expect `verdict=confirmed`, Level-2 id `ABC123`:

```bash
purl https://livecheck.fly.dev/v1/confirm \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/confirm/thank-you-id","intent":"lead_submit"}'
```

Honesty contrast (thank-you fluff → `unknown`, never confirmed):

```bash
purl https://livecheck.fly.dev/v1/confirm \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/confirm/thank-you-only","intent":"lead_submit"}'
```

The contrast is an extra `$0.10` if paid; skip and still treat fluff as `unknown`. Required path spend is **~$0.11 USDC**.

## Steps
1. **Verify first** — unpaid call expects HTTP 402; complete x402 payment; body `{"url":"<absolute job, Shopify/HTML product, or eBay /itm/ URL>"}`. Demo fixture: `https://livecheck.fly.dev/fixtures/live-apply-now`.
2. Parse `status` `live|closed|unknown` + `signals`. If `closed` or `unknown` (and not a known Ashby/Lever unknown), stop or escalate — do not treat as success.
3. Run the agent’s own `lead_submit` action (separate actor). Demo: treat submit as already done; use the thank-you fixture.
4. **Confirm** — unpaid → 402; pay; body `{"url":"<thank-you or result URL>","intent":"lead_submit"}` (optional `claim` fingerprint). Demo fixture: `https://livecheck.fly.dev/fixtures/confirm/thank-you-id`.
5. Accept only `verdict=confirmed` with Level-2 evidence (ref / ticket / lead id, or unique confirmation-URL token). Thank-you fluff alone → `unknown` — never treat as confirmed (`https://livecheck.fly.dev/fixtures/confirm/thank-you-only`).
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

## Capacity
On HTTP 503, wait for `Retry-After` and retry. For a list of URLs, send up to 8 checks at a time.

## Honest limits (do not overclaim)
- Jobs: Ashby JS / Lever Cloudflare often `unknown`.
- Products: do not use Amazon search URLs.
- Confirm: thank-you page alone ≠ confirmed. Not Trust Oracle / L3. Not Firecrawl/Stagehand success detection.
- Local honesty bench: false-confirmed=0 on fixture set — not broad public-web confirmed recall.

## Success
Paid 200 JSON from both calls; Confirm `confirmed` only with Level-2 signals; report both responses. Demo path: Verify `live` on `live-apply-now` + Confirm `confirmed` on `thank-you-id` (~$0.11 USDC). Full copy-paste: [`docs/DEMO-AGENT-VERIFY-CONFIRM.md`](../../docs/DEMO-AGENT-VERIFY-CONFIRM.md).
