# Internal calls: test mode by default, one real paid call per route

## Rule
Every internal smoke test, bench, accuracy/latency run, monitor and seed run uses
**test mode**: header `x-livecheck-test-mode: $LIVECHECK_TEST_MODE_SECRET`.
Test mode runs the full check on every paid route (verify, verify/job,
verify/listing, confirm, confirm/order, check, watch, watch/renew,
watch/:id/chain/topup) with no x402 and no charge. It never writes a
paid_calls row, never stores a receipt or watcher (watch, renew and topup are
dry runs), and never moves /stats. The response carries `x-livecheck-test-mode: 1`.

Never print, commit or save the secret to a file. Read it in-machine
(`fly ssh console -a livecheck`) or pipe it into an env var. Free smoke of all routes:
`scripts/test-mode-smoke.sh` (see header for usage).

Do not use `npx agentcash fetch`, `purl`, or any funded wallet for internal runs.

## Post-deploy paid checks (the only real paid calls)
One real call per route, from Craig's internal Livecheck wallet 0xb782 (purl),
so each lands in the **internal** bucket on /stats. Run on Craig's Mac; purl
prompts for the keystore password. Do **not** pass `--network base`.

Core set, every deploy ($0.16 total):
```
W=~/.purl/keystores/Livecheck.json; UA='livecheck-internal/purl-0.2.8'; B=https://livecheck.fly.dev
JOB='https://stripe.com/jobs/search?gh_jid=8172508'
purl --wallet $W -A "$UA" --max-amount 10000 -X POST -H 'content-type: application/json' -d "{\"url\":\"$JOB\"}" $B/v1/verify
purl --wallet $W -A "$UA" --max-amount 10000 -X POST -H 'content-type: application/json' -d "{\"url\":\"$JOB\"}" $B/v1/verify/job
purl --wallet $W -A "$UA" --max-amount 10000 -X POST -H 'content-type: application/json' -d "{\"url\":\"$B/demo/thank-you?ref=ABC123\"}" $B/v1/verify/listing
purl --wallet $W -A "$UA" --max-amount 100000 -X POST -H 'content-type: application/json' -d "{\"url\":\"$B/demo/thank-you?ref=ABC123\",\"intent\":\"lead_submit\"}" $B/v1/confirm
purl --wallet $W -A "$UA" --max-amount 20000 -X POST -H 'content-type: application/json' -d "{\"target\":{\"type\":\"url\",\"url\":\"$JOB\"},\"condition\":{\"detector\":\"status_change\",\"params\":{}}}" $B/v1/check
```

Only when the deploy touches that route ($5.75 if all run):
```
# confirm/order ($0.25). Skip entirely if the route is retired.
purl --wallet $W -A "$UA" --max-amount 250000 -X POST -H 'content-type: application/json' -d "{\"url\":\"$B/demo/thank-you?ref=ABC123\",\"intent\":\"order_placed\"}" $B/v1/confirm/order
# watch ($2.50). Save id + owner_token from the reply for the next two.
purl --wallet $W -A "$UA" --max-amount 2500000 -X POST -H 'content-type: application/json' -d "{\"target\":{\"type\":\"url\",\"url\":\"$JOB\",\"render\":\"never\",\"selector\":null},\"condition\":{\"detector\":\"status_change\",\"params\":{}},\"interval_s\":900}" $B/v1/watch
# watch/renew ($2.50)
purl --wallet $W -A "$UA" --max-amount 2500000 -X POST -H 'content-type: application/json' -H "x-livecheck-owner-token: $OWNER" -d "{\"id\":\"$WID\"}" $B/v1/watch/renew
# chain topup ($0.50)
purl --wallet $W -A "$UA" --max-amount 500000 -X POST -H "x-livecheck-owner-token: $OWNER" $B/v1/watch/$WID/chain/topup
```
After: `/stats` traffic.internal goes up by exactly the calls made, external is unchanged.
