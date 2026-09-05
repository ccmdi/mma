#!/bin/sh
# In-container runner for the web-serve e2e suite: boot the HTTP sidecar, then drive it with
# Chrome. Counterpart to e2e-native.sh (native shell via tauri-driver).
set -e
. /repo/scripts/internal/e2e-common.sh

noise_base web
start_xvfb
export_sv_stub

ADDR="${MMA_SERVE_ADDR:-127.0.0.1:1430}"
export MMA_SERVE_ADDR
export MMA_TEST_DB=1
export CHROMEDRIVER_PATH="${CHROMEDRIVER_PATH:-/usr/local/bin/chromedriver}"

map-making-app --serve 2>"$NOISE.sidecar.log" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

wait_for_http "http://$ADDR/" "web sidecar"
echo "web sidecar ready on http://$ADDR"

cd /repo/app
MMA_WEB_URL="http://$ADDR" npx wdio run wdio.web.conf.ts "$@"
