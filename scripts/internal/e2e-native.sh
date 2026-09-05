#!/bin/sh
set -e
. /repo/scripts/internal/e2e-common.sh

noise_base native
start_xvfb
export_sv_stub

# The app inherits tauri-driver's stderr, so its panics land in the driver log too.
tauri-driver 2>"$NOISE.driver.log" &
wait_for_http http://localhost:4444/status tauri-driver
echo "tauri-driver ready on :4444"

# Extra args (e.g. --spec <file>, --shard <i>/<n>) pass straight to wdio; no args runs the
# full suite.
cd /repo/app
npx wdio run wdio.conf.ts "$@"
