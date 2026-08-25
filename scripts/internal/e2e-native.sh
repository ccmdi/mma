#!/bin/sh
set -e

# Start virtual display
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
sleep 1

# The Rust procedure engine fetches Street View outside the webview, so under --mock it is
# pointed at the harness's local stub (wdio onPrepare serves this port). tauri-driver
# passes its environment to the app it spawns, so this must be exported before it starts.
if [ -n "${MMA_TEST_MOCK_SV:-}" ]; then
    export MMA_E2E_SV_ORIGIN="http://127.0.0.1:${MMA_E2E_SV_PORT:-4599}"
fi

# Start tauri-driver (WebDriver bridge on :4444)
tauri-driver &
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
