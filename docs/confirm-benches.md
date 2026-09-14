# Confirm honesty benches (CI/local)

Local/CI fixture benches — **not** a live dispute rate. Do not infer `false_confirmed_rate` from `GET /stats` `paid_calls` / receipts. No Fly deploy. Confirm chain (`on_change.run=confirm`) and `POST /v1/watch/renew` are live on main and unchanged by this publish.

`GET /stats` `benches` publishes per-intent `false_confirmed_rate` + `n` from the JSON reports below (hardcoded fallback if a file is missing from the image).

## Commands

```bash
npm run bench:lead-submit
npm run bench:listing-published
npm run bench:order-placed
npm test -- test/lead-submit-bench.test.ts test/listing-published-bench.test.ts test/order-placed-bench.test.ts
```

## Gate results

| Intent | N | false_confirmed | FC rate | Report | Recorded |
| --- | ---: | ---: | ---: | --- | --- |
| `lead_submit` | 77 | 0 | 0 | `bench/lead-submit-report.json` | `9906a99` |
| `listing_published` | 102 | 0 | 0 | `bench/listing-published-report.json` | main `b10322b` |
| `order_placed` | 100 | 0 | 0 | `bench/order-placed-report.json` | main `0e9faa1` |

Gate: `false_confirmed = 0` and `N ≥ 50` (true-positive / true-negative / trap coverage).

## Honesty bar

- Prefer unknown over a false confirmed.
- Thank-you / listing / order fluff alone is never confirmed.
- Never invent confirmation / listing / order ids.
- Cookie-bound fetches are not independent evidence (`lead_submit`).

## Held

- Live dispute rate on `/stats`
- Inventing FC from paid_calls counts
- Fly deploy
- Changing renew or `on_change.run=confirm` chain logic
