# AgentCash / Bazaar short description

Copy for Gil. Do not spray this on the homepage. The landing hero is the "Is it still there?" section in `src/demo-page.ts`.

> Live status of any listing, product, or job posting — $0.01. Send one URL; get live, closed, or unknown, read from the page right now, with title and evidence. Use it before your agent recommends, buys, or applies. Also: one-shot page checks ($0.02), 30-day watchers ($2.50), and signed confirmation of form submissions and orders.

`iconUrl` is omitted from OpenAPI `info` until a 256×256 HTTPS PNG exists. A placeholder URL that 404s is worse than leaving the field off.

OpenAPI `info` title, description, `x-guidance`, and `x-tags` are the AgentCash service metadata. `POST /v1/verify` summary, description, `x-guidance`, and tags are the route copy. The unpaid 402 `resource.description` stays the short `VERIFY_DESCRIPTION`. The route description is longer than CDP's 500-character cap.

`/llms.txt` follows the agent-first listing text. The watch line says the HTTPS callback is optional and events can be pulled with `GET /v1/watch/{id}/events` plus the owner token. That is the only deviation from the brief's watch parenthetical ("requires HTTPS callback"). `POST /v1/watch/renew` is listed next to watch. The skill URL is `https://github.com/moyecj-snap/livecheck-skills`.

## Re-crawl (agentic.market still showing 4 endpoints)

The origin already publishes watch and renew. A stale catalog will keep showing four endpoints until it fetches these again. No new route is required.

Ping, in order:

1. `GET https://livecheck.fly.dev/.well-known/x402` — `resources` includes `https://livecheck.fly.dev/v1/watch` and `https://livecheck.fly.dev/v1/watch/renew` (plus verify, check, confirm, confirm/order). Chain topup stays off this list because its URL has a path parameter.
2. `GET https://livecheck.fly.dev/openapi.json` — `paths` includes `POST /v1/watch` and `POST /v1/watch/renew`, each with `x-payment-info` amount `2.50`. `info.x-guidance` names both.
3. `GET https://livecheck.fly.dev/llms.txt` — watch (callback optional) and watch/renew.
4. Unpaid `POST https://livecheck.fly.dev/v1/watch` and `POST https://livecheck.fly.dev/v1/watch/renew` — HTTP 402 with `extensions.bazaar` (input schema, output schema, example). That is the Bazaar discovery metadata. Do not treat a 402 as a missing route.

If Agentic.market or CDP Bazaar indexed an older document, re-crawl those four URLs. This repo cannot push their index.

## Canonical Verify `signals`

These are the strings production emits. The kit's `in_stock`, `sold_out`, `apply_form`, `ended_banner` are wrong. `http_404` is real, and only for HTTP 404 (plus `http_410`). Marketing examples in the Verify OpenAPI description ("in stock", "sold out", "apply form present", "404") are not a second signal vocabulary. `apply form present` is a real signal; "in stock" / "sold out" in that sentence are colloquial.

HTML (`src/classify.ts`):

- `http_404`, `http_410`
- `close_language:<phrase>` where `<phrase>` is one of:
  - `no longer accepting applications`
  - `this job is closed to new applications`
  - `this job is no longer available`
  - `the job you are trying to apply for has been filled`
  - `this position has been filled`
  - `this job posting is no longer active`
  - `no longer accepting applicants`
  - `this requisition is closed`
  - `sorry, this job is no longer available`
  - `the job you are looking for is no longer available`
- `redirected_to_board`
- `ats_empty_state`
- `challenge_page`
- `loginwalled`
- `not_a_specific_posting`
- `careers_homepage`
- `collection_or_category`
- `apply form present`
- `no closure banner`
- `sold-out`
- `in-stock`
- `ambiguous_html`

eBay (`src/ebay.ts`), when the adapter runs:

- `ebay-ended`
- `sold-out`
- `ebay-in-stock`
- `ebay_availability_unknown`
- missing item: `http_404` and `ebay-ended`
- `ebay_adapter_disabled`
- `ebay_api_error`

## Verify 400 / 502 / 504

There is no `code` field and no `invalid_url`. The body is `{ "error": "<message>" }`.

| Status | `error` |
| --- | --- |
| 400 | `JSON body must include { "url": "https://..." }.` |
| 400 | `url must be an absolute http(s) URL.` |
| 400 | `Only http and https URLs are accepted.` |
| 400 | `Request body must be JSON.` |
| 504 | `Timed out fetching <url> after 8000ms.` |
| 502 | `Could not fetch URL: <message>` |
