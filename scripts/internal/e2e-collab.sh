#!/bin/sh
# The collab run: the collab Worker under wrangler dev, then three apps (host, alice, bob),
# each behind its own tauri-driver with its own data dir and GitHub login.
set -e
. /repo/scripts/internal/e2e-common.sh

noise_base collab
start_xvfb
export_sv_stub

export MMA_E2E_GG_ORIGIN="http://127.0.0.1:${MMA_E2E_GG_PORT:-4601}"
export MMA_E2E_GG_NCFA="${MMA_E2E_GG_NCFA:-e2e-ncfa-token}"
export MMA_GITHUB_API="http://127.0.0.1:${MMA_E2E_GITHUB_PORT:-4602}"
export MMA_COLLAB_WORKER="http://127.0.0.1:${MMA_E2E_COLLAB_PORT:-8787}"

# The Worker checks GitHub tokens against the stub the wdio launcher starts.
cd /repo/workers/collab
WRANGLER_SEND_METRICS=false npx wrangler dev --ip 127.0.0.1 --port "${MMA_E2E_COLLAB_PORT:-8787}" \
	--persist-to /tmp/collab-worker --var "WORKER_SECRET:e2e-worker-secret" \
	--var "GITHUB_API:$MMA_GITHUB_API" >"$NOISE.worker.log" 2>&1 &
wait_for_http "$MMA_COLLAB_WORKER" "collab worker" 120
echo "collab worker ready at $MMA_COLLAB_WORKER"

# Ports match wdio.collab.conf.ts. Each app also moves the webdriver plugin's own server off
# the native driver's port.
port=4444
for login in host alice bob; do
	MMA_DATA_DIR="/tmp/mma-collab/$login" XDG_DATA_HOME="/tmp/mma-collab/$login/xdg" \
		MMA_E2E_GITHUB_TOKEN="token-$login" TAURI_WEBDRIVER_PORT=$((port + 100)) \
		tauri-driver --port "$port" --native-port $((port + 1)) 2>"$NOISE.driver-$login.log" &
	wait_for_http "http://localhost:$port/status" "tauri-driver for $login"
	echo "tauri-driver for $login ready on :$port"
	port=$((port + 2))
done

# Each app logs into its own XDG_DATA_HOME, which the container discards, so keep the logs.
status=0
cd /repo/app
npx wdio run wdio.collab.conf.ts "$@" || status=$?
for login in host alice bob; do
	cat /tmp/mma-collab/"$login"/xdg/*/logs/*.log >"$NOISE.app-$login.log" 2>/dev/null || true
done
exit "$status"
