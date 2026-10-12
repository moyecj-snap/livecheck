#!/usr/bin/env bash
# Free smoke test of every paid route in test mode. No x402, no charge,
# no paid_calls row, no stored receipt or watcher, /stats unchanged.
#
# The secret is never printed or written to disk. Run it in-machine:
#   fly ssh console -a livecheck -C "bash /app/scripts/test-mode-smoke.sh http://127.0.0.1:8080"
# or pipe it from Fly into this script's env without echoing it:
#   LIVECHECK_TEST_MODE_SECRET="$(fly ssh console -q -a livecheck -C 'printenv LIVECHECK_TEST_MODE_SECRET')" \
#     bash scripts/test-mode-smoke.sh https://livecheck.fly.dev
set -euo pipefail
BASE="${1:-https://livecheck.fly.dev}"
: "${LIVECHECK_TEST_MODE_SECRET:?set LIVECHECK_TEST_MODE_SECRET (never paste it in chat)}"
UA="livecheck-internal/test-mode-smoke"
fail=0

post() { # path json [extra header]
  local path="$1" body="$2" extra="${3:-}"
  local args=(-sS -o /tmp/lc-smoke.out -D /tmp/lc-smoke.hdr -w '%{http_code}' -X POST "$BASE$path"
    -A "$UA" -H 'content-type: application/json' -H @- --data "$body")
  [[ -n "$extra" ]] && args+=(-H "$extra")
  printf 'x-livecheck-test-mode: %s\n' "$LIVECHECK_TEST_MODE_SECRET" | curl "${args[@]}"
}
check() { # label code expected
  local tm; tm=$(grep -i '^x-livecheck-test-mode:' /tmp/lc-smoke.hdr | tr -d '\r' | awk '{print $2}')
  if [[ "$2" == "$3" && "$tm" == "1" ]]; then echo "PASS $1 ($2)"; else echo "FAIL $1 (http $2, test-mode=${tm:-missing})"; fail=1; fi
}

JOB='https://stripe.com/jobs/search?gh_jid=8172508'
c=$(post /v1/verify "{\"url\":\"$JOB\"}"); check verify "$c" 200
c=$(post /v1/verify/job "{\"url\":\"$JOB\"}"); check verify/job "$c" 200
c=$(post /v1/verify/listing "{\"url\":\"$BASE/demo/thank-you?ref=ABC123\"}"); check verify/listing "$c" 200
c=$(post /v1/confirm "{\"url\":\"$BASE/demo/thank-you?ref=ABC123\",\"intent\":\"lead_submit\"}"); check confirm "$c" 200
c=$(post /v1/confirm/order "{\"url\":\"$BASE/demo/thank-you?ref=ABC123\",\"intent\":\"order_placed\"}"); check confirm/order "$c" 200
c=$(post /v1/check "{\"target\":{\"type\":\"url\",\"url\":\"$JOB\"},\"condition\":{\"detector\":\"status_change\",\"params\":{}}}"); check check "$c" 200
c=$(post /v1/watch "{\"target\":{\"type\":\"url\",\"url\":\"$JOB\",\"render\":\"never\",\"selector\":null},\"condition\":{\"detector\":\"status_change\",\"params\":{}},\"interval_s\":900}"); check "watch (dry run)" "$c" 201
# renew / topup need a real watcher id + owner token; pass them to cover those routes.
if [[ -n "${WATCH_ID:-}" && -n "${WATCH_OWNER_TOKEN:-}" ]]; then
  c=$(post /v1/watch/renew "{\"id\":\"$WATCH_ID\"}" "x-livecheck-owner-token: $WATCH_OWNER_TOKEN"); check "watch/renew (dry run)" "$c" 200
  c=$(post "/v1/watch/$WATCH_ID/chain/topup" '{}' "x-livecheck-owner-token: $WATCH_OWNER_TOKEN"); check "chain/topup (dry run)" "$c" 200
else
  echo "SKIP watch/renew + chain/topup (set WATCH_ID and WATCH_OWNER_TOKEN)"
fi
rm -f /tmp/lc-smoke.out /tmp/lc-smoke.hdr
exit $fail
