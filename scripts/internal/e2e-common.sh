#!/bin/sh
# Shared setup for the in-container e2e runners.

# Environmental X/GL noise repeats once per spec and would swamp the run log, so it is kept
# beside it instead.
noise_base() {
	NOISE="${MMA_E2E_LOG_PATH:-/repo/app/test/logs/e2e-$1-local.txt}"
	NOISE="${NOISE%.txt}"
	mkdir -p "$(dirname "$NOISE")"
}

# Even the web sidecar builds a hidden webview as its IPC host, so GTK needs a display.
start_xvfb() {
	Xvfb :99 -screen 0 1920x1080x24 2>"$NOISE.xvfb.log" &
	export DISPLAY=:99
	sleep 1
}

# The Rust procedure engine fetches Street View outside the webview, so under --mock it is
# pointed at the harness's stub. Must be exported before whatever spawns the app.
export_sv_stub() {
	if [ -n "${MMA_TEST_MOCK_SV:-}" ]; then
		export MMA_E2E_SV_ORIGIN="http://127.0.0.1:${MMA_E2E_SV_PORT:-4599}"
	fi
}

# wait_for_http <url> <what> [tries]
wait_for_http() {
	i=0
	until curl -s -o /dev/null "$1"; do
		i=$((i + 1))
		if [ "$i" -ge "${3:-60}" ]; then
			echo "ERROR: $2 not responding at $1"
			exit 1
		fi
		sleep 0.5
	done
}
