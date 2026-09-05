#!/bin/sh
set -e

# Xvfb's xkbcomp keysym warnings and the app's libEGL software-fallback warnings are
# environmental, repeat once per spec, and would otherwise be most of the run log. They are
# kept, beside it: <run log>.xvfb.log and <run log>.driver.log (the app inherits
# tauri-driver's stderr, so its panics land there too).
NOISE="${MMA_E2E_LOG_PATH:-/repo/app/test/logs/e2e-native-local.txt}"
NOISE="${NOISE%.txt}"
mkdir -p "$(dirname "$NOISE")"

# Start virtual display
Xvfb :99 -screen 0 1920x1080x24 2>"$NOISE.xvfb.log" &
export DISPLAY=:99
sleep 1

# The Rust procedure engine fetches Street View outside the webview, so under --mock it is
# pointed at the harness's local stub (wdio onPrepare serves this port). tauri-driver
# passes its environment to the app it spawns, so this must be exported before it starts.
if [ -n "${MMA_TEST_MOCK_SV:-}" ]; then
    export MMA_E2E_SV_ORIGIN="http://127.0.0.1:${MMA_E2E_SV_PORT:-4599}"
fi

# Start tauri-driver (WebDriver bridge on :4444)
tauri-driver 2>"$NOISE.driver.log" &
sleep 3

# Verify tauri-driver is listening
if ! curl -s http://localhost:4444/status > /dev/null 2>&1; then
    echo "ERROR: tauri-driver not responding on :4444"
    exit 1
fi

echo "tauri-driver ready on :4444"

# Run tests. Extra args (e.g. --spec <file>, --shard <i>/<n>) pass straight to wdio;
# no args runs the full suite.
cd /repo/app
npx wdio run wdio.conf.ts "$@"
