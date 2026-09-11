# Gap #7 — Landing page copy (DRAFT) + live `/stats` wire-up
**Fri 11 Sep 2026 · Gil** · for Patty to land on `GET /` or `/trust`  
**MCP branch:** `cursor/sentinel-gap7-mcp-expansion` @ `8fe7c35` · tools verify/check/confirm/watch · webhook `examples/sentinel-webhook.ts` · stats `?format=json`  
**Data:** client-fetch `GET https://livecheck.fly.dev/stats` every 60s (or SSR on request)

---

## Hero
**Livecheck Trust APIs** — pay-per-call URL truth for agents on Base (x402).

Before you scrape. After you act. While you sleep.

| Tool | Route | Price | One line |
| --- | --- | --- | --- |
| **Verify** | `POST /v1/verify` | $0.01 | Is this job/product/eBay URL still live? |
| **Confirm** | `POST /v1/confirm` | $0.10 | Did the `lead_submit` / listing side effect land? (actor ≠ verifier) |
| **Confirm order** | `POST /v1/confirm/order` | $0.25 | Did `order_placed` land? |
| **Sentinel check** | `POST /v1/check` | $0.02 | One-shot condition (no watcher) |
| **Sentinel watch** | `POST /v1/watch` | $2.50 | 30-day prepaid watcher → signed webhook |

OpenAPI · skill: `npx skills add moyecj-snap/livecheck` · Bazaar search `livecheck`

---

## Live stats panel (wire to `/stats`)
Label clearly **live from API** — never invent numbers.

**Confirm (per intent)** — from `intents.*.l7d` / `l30d`:
- paid_calls, receipts, by_verdict (confirmed / failed / unknown)
- status badge: `ga` / payable

**Sentinel** — from `sentinel`:
- active_watchers, checks_run, change_events
- prices: check / watch / chain_topup
- benches: false_positive_rate (per detector), median_latency_ms, latency_p95_ms  
  (Render whatever `/stats` returns; if null, show “not published” not 0.)

**Notes** — from `notes` / honesty: thank-you alone never confirmed; missing bench ≠ zero.

CTA buttons: OpenAPI · Stats JSON (`/stats?format=json`) · x402scan · skill `npx skills add moyecj-snap/livecheck`

---

## Must not claim
- Cursor Marketplace live (still pending)
- Trust Oracle / L3
- Broad Confirm public-web accuracy beyond benches
- `/v1/watch/fast` until shipped
- Competitor displacement vs Visualping/Browse AI as “partners”

---

## Minimal HTML sketch (Patty)
```html
<section id="live-stats" data-src="/stats?format=json">
  <h2>Live usage</h2>
  <p class="muted">Updated <time id="stats-generated"></time></p>
  <div id="confirm-intents"></div>
  <div id="sentinel-panel"></div>
</section>
<script>
async function refresh() {
  const s = await fetch('/stats?format=json').then(r => r.json());
  // render intents + sentinel.benches; never hardcode
}
refresh(); setInterval(refresh, 60000);
</script>
```
