# Demo agent prompt — Livecheck Verify then Confirm

Follow [`docs/DEMO-AGENT-VERIFY-CONFIRM.md`](../../docs/DEMO-AGENT-VERIFY-CONFIRM.md). Production origin: `https://livecheck.fly.dev`. Hardcode **only** the two tools in [`tools.json`](./tools.json) (same shapes as [`skills/livecheck-verify-then-confirm/tools.json`](../../skills/livecheck-verify-then-confirm/tools.json)).

Actor ≠ verifier. Default first call is **Verify**. Do not trust your own `success: true`.

1. **Verify first** — `POST /v1/verify` with `https://livecheck.fly.dev/fixtures/live-apply-now`. Unpaid → HTTP 402. Pay **$0.01** USDC on Base (x402). Accept only `status=live`. Stop on `closed` / `unknown`.
2. **Actor** — for this demo, treat form submit as **already done**. Do not build or POST a form. Next URL is the thank-you fixture.
3. **Confirm** — `POST /v1/confirm` with `https://livecheck.fly.dev/fixtures/confirm/thank-you-id` and `intent: "lead_submit"`. Unpaid → 402. Pay **$0.10** USDC. Accept **only** `verdict=confirmed` with Level-2 evidence (`effect.id` `ABC123`).
4. **Honesty** — `https://livecheck.fly.dev/fixtures/confirm/thank-you-only` is `unknown`. Never treat thank-you fluff as confirmed.
5. **Pay how** — use `purl` or AgentCore (Bazaar Gateway + payments plugin). Stdio MCP has **no wallet**; a 402 tool result is not success. Never paste private keys. Do not claim Cursor Marketplace is live.

Required spend for the path: **~$0.11 USDC** on Base. Report both paid JSON bodies.
