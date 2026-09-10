# Sentinel benches (acceptance checklist light)

Local/CI scale — not a 1000-watcher 24h soak. No Fly deploy, no Bazaar GA push, no price changes, no real $2.50 spends. Confirm chain (`on_change.run=confirm`) stays deferred.

Generated: `2026-09-10T21:21:18Z`

## Commands

```bash
npm run bench:sentinel
npm test -- test/sentinel-bench.test.ts
```

## Scale

| Knob | Value |
| --- | --- |
| honesty repeats / noise kind | 20 |
| honesty checks / detector | 198 |
| watch honesty ticks | 12 |
| latency samples | 20 |
| interval_s | 300 |

CI/local scale — not a 1000-watcher 24h soak. Virtual time for latency; no Fly deploy; no real $2.50 spends.

Fixtures rotate timestamps, view/sold counters, session/CSRF tokens, ad slots, cookie banners, and promo copy. `text_diff` uses selector `.listing-title`. `GET /stats` Sentinel bench fields stay structured **null** (no dispute endpoint / no published live rate).

## Gate results

| Result | Id | Gate | Detail |
| --- | --- | --- | --- |
| PASS | status_change_fp | status_change false fires = 0 and watch change events = 0 on noisy fixtures | fires=0/198 watch_change_events=0 |
| PASS | text_diff_fp | text_diff with selector .listing-title false-fire rate ≤ 0.02 | rate=0.0000 fires=0/198 |
| PASS | true_positive | injected live→closed and title rewrite still fire | status_change=true text_diff=true |
| PASS | latency_p50 | p50 ≤ interval_s + 60s (360s) | p50=162500ms n=20 |
| PASS | latency_p95 | p95 ≤ 2×interval_s (600s) | p95=315250ms n=20 |
| PASS | hmac | X-Sentinel-Signature: t=<unix>,v1=<hex> — v1 is lowercase hex HMAC-SHA256 of the raw UTF-8 body with callback.secret; t is not part of the MAC | unit=true delivered_verified=20/20 |
| PASS | chain_verify | on_change.verify + balance attaches result; insufficient → skipped | funded_attached=true skipped=insufficient_balance |
| PASS | on_change_confirm_deferred | on_change.run=confirm stays rejected (Confirm chain deferred) | parseWatchRequest throws invalid_target |

**Overall: PASS**

## Honesty

| Detector | Checks | Fires | FP rate | Gate | Pass |
| --- | ---: | ---: | ---: | --- | --- |
| status_change | 198 | 0 | 0.0000 | 0 fires + 0 watch `change` events | PASS |
| text_diff + selector | 198 | 0 | 0.0000 | ≤ 2% | PASS |

Watch `change` events on noisy-only ticks: **0**

True-positive sanity: status_change live→closed **true**; text_diff title rewrite **true**.

## Latency (virtual time)

Detection + HMAC callback delivery after an injected fixture change. Standard 2-of-3 (~20s confirm re-fetch) is included.

| Metric | Value | Gate |
| --- | ---: | ---: |
| n | 20 | 20 samples |
| p50 | 162500 ms | ≤ 360000 ms (`interval_s + 60s`) |
| p95 | 315250 ms | ≤ 600000 ms (`2×interval_s`) |

Pass: **PASS**

## HMAC

Recipe: `X-Sentinel-Signature: t=<unix>,v1=<hex> — v1 is lowercase hex HMAC-SHA256 of the raw UTF-8 body with callback.secret; t is not part of the MAC`

Unit assertion (same as `test/watch-callback.test.ts`): **PASS**. Delivered latency callbacks verified: **20/20**.

## Chain Verify

Mock/internal only — `resolveChangeChain` via the scheduler; no public `POST /v1/verify`, no facilitator fee.

| Path | Result |
| --- | --- |
| `on_change.run=verify` + $0.50 balance | attached=true status=live debit=0.01 |
| insufficient balance | skipped=true reason=insufficient_balance |

`on_change.run=confirm` deferred: **true**

## Held

- Bazaar GA listing push
- Fly deploy
- GitHub moyecj-snap mirror
- Price changes
- Real $2.50 watch spends

