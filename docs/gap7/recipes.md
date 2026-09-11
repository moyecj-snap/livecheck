# Gap #7 — 3 copy-paste recipes (LOCKED to MCP)
**Fri 11 Sep 2026 · Gil**  
**MCP:** branch `cursor/sentinel-gap7-mcp-expansion` · SHA `8fe7c35`  
**Tools:** `verify` · `check` · `confirm` · `watch` (+ `watch_get` / `watch_events` / `watch_stop` free; `watch_chain_topup` $0.50)  
**Compat:** `verify_listing` = `verify`  
**Unpaid:** `{ paid:false, http:402, … }` — no wallet in MCP  
**Webhook sample:** `examples/sentinel-webhook.ts`  
**Stats:** `GET https://livecheck.fly.dev/stats?format=json`

**Prices (Base USDC x402):** verify $0.01 · check $0.02 · confirm $0.10 · confirm/order $0.25 · watch $2.50 · chain topup $0.50

Honest limits: thank-you alone ≠ confirmed; Ashby/Lever often unknown; no Amazon search URLs; watch is read-only; standard watch uses 2-of-3 before change emit.

---

## Recipe 1 — Verify → Watch (stay awake for me)

**When:** Agent has a concrete URL, checks it’s live, then needs a wake-up if it changes while the agent sleeps.

**MCP:** `verify` then `watch`

```http
POST https://livecheck.fly.dev/v1/verify
{"url":"https://boards.greenhouse.io/example/jobs/1842"}
```

If `status=live`, register a watcher (paid Verify/Confirm 200s also include `watch.suggest=/v1/watch`):

```http
POST https://livecheck.fly.dev/v1/watch
{
  "target": {"type":"url","url":"https://boards.greenhouse.io/example/jobs/1842","render":"never"},
  "condition": {"detector":"status_change","params":{}},
  "callback": {
    "url":"https://YOUR_HOST/hooks/sentinel",
    "secret":"whsec_…",
    "deliver":"on_change"
  },
  "interval_s": 300,
  "label": "job-1842"
}
```

Save `id` + `owner_token`. On webhook (see `examples/sentinel-webhook.ts`): re-run your task or call `verify` again. Inspect with `watch_get` / `watch_events`; stop with `watch_stop`.

---

## Recipe 2 — Check → Webhook (one-shot then stand up watch)

**When:** Cheap condition probe first ($0.02), then only pay $2.50 if you need standing watch.

**MCP:** `check` → optional `watch`

```http
POST https://livecheck.fly.dev/v1/check
{
  "target": {"type":"url","url":"https://shop.example.com/p/sku","render":"never"},
  "condition": {"detector":"keyword","params":{"any":["Add to Cart"],"none":["Notify Me"]}}
}
```

If `fired=true` (or you need ongoing): same `watch` body as Recipe 1 with matching detector. Point `callback.url` at `examples/sentinel-webhook.ts` (HMAC via `X-Sentinel-Signature`).

Optional later: `watch_chain_topup` ($0.50) if `on_change.run=verify` needs chain balance.

---

## Recipe 3 — Confirm + Watch hint (after the side effect)

**When:** Agent submitted a lead (or listing); needs independent Confirm, then optional standing watch on the result page.

**MCP:** `confirm` → read `watch` hint → `watch`

```http
POST https://livecheck.fly.dev/v1/confirm
{"url":"https://example.com/thanks?ref=ABC123","intent":"lead_submit"}
```

Accept only `verdict=confirmed` with Level-2 evidence (ref/ticket/lead id). Thank-you fluff → `unknown` — never treat as success.

For `order_placed` use intent on `/v1/confirm/order` ($0.25) — same `confirm` MCP tool routes by intent.

Paid 200 includes:

```json
"watch": {"suggest":"/v1/watch","detector":"status_change","price_usd":2.5}
```

Follow the hint with `watch` if the thank-you/result URL should be watched later.

**Skill install (already on main):**
```bash
npx skills add moyecj-snap/livecheck
```

---

## Install blurb (docs / Wave 1)
```
npx skills add moyecj-snap/livecheck
# MCP: branch cursor/sentinel-gap7-mcp-expansion @ 8fe7c35
# Tools: verify | check | confirm | watch
# Webhook: examples/sentinel-webhook.ts
# Stats: https://livecheck.fly.dev/stats?format=json
```
