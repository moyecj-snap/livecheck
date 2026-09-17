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

## Steps
1. **Verify first** — unpaid call expects HTTP 402; complete x402 payment; body `{"url":"<absolute job, Shopify/HTML product, or eBay /itm/ URL>"}`.
2. Parse `status` `live|closed|unknown` + `signals`. If `closed` or `unknown` (and not a known Ashby/Lever unknown), stop or escalate — do not treat as success.
3. Run the agent’s own `lead_submit` action (separate actor).
4. **Confirm** — unpaid → 402; pay; body `{"url":"<thank-you or result URL>","intent":"lead_submit"}` (optional `claim` fingerprint).
5. Accept only `verdict=confirmed` with Level-2 evidence (ref / ticket / lead id, or unique confirmation-URL token). Thank-you fluff alone → `unknown` — never treat as confirmed.
6. On `failed` / `unknown`, prefer abstention over false success.

## Honest limits (do not overclaim)
- Jobs: Ashby JS / Lever Cloudflare often `unknown`.
- Products: do not use Amazon search URLs.
- Confirm: thank-you page alone ≠ confirmed. Not Trust Oracle / L3. Not Firecrawl/Stagehand success detection.
- Local honesty bench: false-confirmed=0 on fixture set — not broad public-web confirmed recall.

## Success
Paid 200 JSON from both calls; Confirm `confirmed` only with Level-2 signals; report both responses.
