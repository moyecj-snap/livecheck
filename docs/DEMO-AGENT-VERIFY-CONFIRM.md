# Demo: pay Verify, then Confirm

End-to-end paid path for an agent or human with `purl` (or AgentCore bazaar + payments) and **USDC on Base**. Production only: `https://livecheck.fly.dev`. No new product — this is the existing Verify → Confirm bundle.

**Required spend:** **~$0.11 USDC** (`$0.01` Verify + `$0.10` Confirm).  
**Never paste private keys / wallet secrets** into git, chat, or docs.

Actor ≠ verifier. Thank-you copy alone is never `confirmed`. Cursor Marketplace is **not** live.

## 0. Skill (optional)

```bash
mkdir -p ~/.local/lib
npx --yes skills add moyecj-snap/livecheck -y -s livecheck-verify-then-confirm
```

Hardcoded tools: [`skills/livecheck-verify-then-confirm/tools.json`](../skills/livecheck-verify-then-confirm/tools.json). Minimal agent prompt: [`examples/demo-agent/prompt.md`](../examples/demo-agent/prompt.md).

## 1. Health (free)

```bash
curl -sS https://livecheck.fly.dev/health
```

Expect HTTP **200**, `settlement: "stripe-x402"`, `public_verify_url` / `public_confirm_url` on `https://livecheck.fly.dev`.

## 2. Unpaid 402 smoke (no spend)

Same URLs you will pay. Expect HTTP **402** and a `payment-required` header — not a successful settle.

```bash
curl -sS -D - -o /tmp/livecheck-verify.402 https://livecheck.fly.dev/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/live-apply-now"}'
```

```bash
curl -sS -D - -o /tmp/livecheck-confirm.402 https://livecheck.fly.dev/v1/confirm \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/confirm/thank-you-id","intent":"lead_submit"}'
```

Fixture pages (free GET):

- Verify target: https://livecheck.fly.dev/fixtures/live-apply-now
- Confirm L2 id: https://livecheck.fly.dev/fixtures/confirm/thank-you-id
- Confirm fluff: https://livecheck.fly.dev/fixtures/confirm/thank-you-only

## 3. Install `purl`

Linux amd64 + macOS Apple Silicon one-liners, wallet add, and Base USDC balance live in the README: [Verify-first: first paid call](../README.md#verify-first-first-paid-call). Stripe guide: [x402](https://docs.stripe.com/payments/machine/x402.md).

```bash
purl --version
purl wallet list
# interactive — never paste keys here
purl wallet add
# or: purl wallet add --type evm
purl balance --network base
```

Ignore ethereum RPC errors on balance. Paid calls need **USDC on Base**.

## 4. Paid Verify (`$0.01`)

Stable fixture (expected `status=live`, apply form present):

```bash
purl https://livecheck.fly.dev/v1/verify \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/live-apply-now"}'
```

Expect HTTP **200** JSON: `status` **`live`**, `signals` includes `apply form present`, `price_usd` `0.01`. If `closed` or `unknown`, stop — do not treat as success.

Optional public job (same price; listing may go away): `https://job-boards.greenhouse.io/discord/jobs/8806482002` (the README Verify-first URL). Prefer the fixture for this demo.

## 5. Actor (do not build a form product)

For this demo, **treat form submit as already done**. Do not POST a real apply/contact form. The post-submit URL is the Confirm fixture in the next step.

In a real workflow you would run your own `lead_submit` action here (separate actor), then Confirm that actor’s thank-you/result URL.

## 6. Paid Confirm (`$0.10`) — expected `confirmed`

```bash
purl https://livecheck.fly.dev/v1/confirm \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/confirm/thank-you-id","intent":"lead_submit"}'
```

Expect HTTP **200** JSON:

- `verdict`: **`confirmed`**
- `effect.id`: **`ABC123`** (Level-2 confirmation number on the page)
- `evidence_level` / `evidence_strength`: **2**
- `confidence` ≥ **0.90**
- `independent_evidence`: **true**
- `price_usd`: **0.1**
- `id` starts with `cfm_`

Accept **only** `verdict=confirmed` with Level-2 evidence (ref / ticket / lead id, or unique confirmation-URL token).

## 7. Honesty contrast — thank-you fluff → `unknown`

Thank-you copy with **no** id is never confirmed. Optional extra **`$0.10`** if you actually pay this call (not part of the ~$0.11 required path):

```bash
purl https://livecheck.fly.dev/v1/confirm \
  -H 'content-type: application/json' \
  -d '{"url":"https://livecheck.fly.dev/fixtures/confirm/thank-you-only","intent":"lead_submit"}'
```

Expect `verdict` **`unknown`**, `evidence_level` **1**, no `effect.id`. Do **not** treat as success. (`GET /v1/judge` is a 501 stub, not payable.)

Unpaid 402 on the same body is enough to prove the route without the extra spend.

## Success criteria

| Check | Pass |
| --- | --- |
| Health | HTTP 200, live settlement |
| Unpaid Verify + Confirm | HTTP 402 + `payment-required` (no USDC spent) |
| Paid Verify (live-apply-now) | HTTP 200, `status=live` |
| Actor | No new form product; thank-you fixture used as if submit already happened |
| Paid Confirm (thank-you-id) | HTTP 200, `verdict=confirmed`, Level-2 id `ABC123` |
| thank-you-only | `unknown` — never `confirmed` |
| Spend | **~$0.11 USDC** on Base for the required path (`0.01` + `0.10`) |

Report both paid JSON bodies. On `failed` / `unknown`, prefer abstention over false success.

## MCP (402 until a buyer wallet exists)

Stdio MCP (`src/mcp.ts`) has **no wallet**. Unpaid tools return structured `{ "paid": false, "http": 402, … }` plus decoded `payment-required` / x402 accept info. That is payment required — **not** a successful settle. The MCP never sends `X-Livecheck-Mock`.

Add MCP config (production Verify origin; client derives confirm/check/watch):

```bash
mkdir -p .cursor
cp examples/cursor-mcp.json .cursor/mcp.json
# or: cp examples/cursor-mcp.json ~/.cursor/mcp.json
```

Hand-paste shape (`LIVECHECK_URL` = production):

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

Do not put Stripe/CDP secrets or private keys in `mcp.json`. Optional `LIVECHECK_PAYMENT_SIGNATURE` only if a **paying host** already has an envelope.

**For this paid demo, prefer `purl` (above) or AgentCore bazaar + payments** — not unpaid MCP:

- AgentCore: add Coinbase x402 Bazaar Gateway MCP `https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp` **and** a payments plugin; search `livecheck` (returns verify + confirm, plus confirm/order).
- Cursor Marketplace is **not** live (still in review). Do not claim it is.

## Honest limits

- Jobs: Ashby JS / Lever Cloudflare often `unknown`.
- Products: do not use Amazon search URLs.
- Confirm: thank-you page alone ≠ confirmed. Not Trust Oracle / L3. Not Firecrawl/Stagehand success detection.
- Local honesty bench: false-confirmed=0 on fixture set — not broad public-web confirmed recall.
- This demo does not create watchers, pay `confirm/order`, or change prices/intents.
