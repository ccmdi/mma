#!/bin/sh
# In-container runner for the web-serve e2e suite: boot the HTTP sidecar, then drive it
# with Chrome. Counterpart to e2e-native.sh (native shell via tauri-driver).
set -e

# The sidecar is still a Tauri app: it builds a hidden webview as the IPC dispatch
# host, so GTK needs a display even though nothing is shown.
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
sleep 1

ADDR="${MMA_SERVE_ADDR:-127.0.0.1:1430}"
export MMA_SERVE_ADDR
export MMA_TEST_DB=1
export CHROMEDRIVER_PATH="${CHROMEDRIVER_PATH:-/usr/local/bin/chromedriver}"

# Same stub as the native runner: the procedure engine's fetches are Rust-side either way.
if [ -n "${MMA_TEST_MOCK_SV:-}" ]; then
    export MMA_E2E_SV_ORIGIN="http://127.0.0.1:${MMA_E2E_SV_PORT:-4599}"
fi

map-making-app --serve &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

i=0
until curl -s -o /dev/null "http://$ADDR/"; do
    i=$((i + 1))
    if [ $i -ge 60 ]; then
        echo "ERROR: web sidecar not responding on $ADDR"
        exit 1
    fi
    sleep 0.5
done

echo "web sidecar ready on http://$ADDR"

# Extra args (e.g. --spec <file>, --shard <i>/<n>) pass straight to wdio.
cd /repo/app
MMA_WEB_URL="http://$ADDR" npx wdio run wdio.web.conf.ts "$@"
