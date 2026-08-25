#!/usr/bin/env bash
# Run the Linux e2e suite in Docker against the prebuilt image, no rebuild needed
# for test-only changes (specs/config/scripts are live-mounted via the dev overlay).
#
# Usage:
#   scripts/e2e.sh                                  # full suite, single container
#   scripts/e2e.sh test/e2e/foo.test.ts [more...]   # only the given spec files
#   scripts/e2e.sh --shard [N]                      # full suite split across N containers (default 3)
#   scripts/e2e.sh --mock [...]                     # add --mock (any position before specs) to
#                                                   #   monkey-patch Street View (deterministic, no network)
#   scripts/e2e.sh --web [...]                      # run the same specs against the web-serve
#                                                   #   build in Chrome instead of the native shell
#   scripts/e2e.sh --bench                          # the performance suite only, one container,
#                                                   #   never sharded. Results land in
#                                                   #   app/test/perf/results (live-mounted).
#                                                   #   Tune with MMA_BENCH_SCALES / _SAMPLES /
#                                                   #   _WARMUPS / _ROUTES / _SEED / _LABEL / _GPU.
#
# Images are tagged per commit and profile (scripts/internal/e2e-image.sh) and built on
# demand: a clean checkout builds once and is reused; a dirty one is rebuilt by
# scripts/e2e-build.sh. --bench selects the release profile.
set -uo pipefail
# Git Bash (Windows) rewrites args that look like absolute paths (e.g. /repo/...) into
# Windows paths before they reach docker. Disable that; harmless on Linux hosts.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."

# Leading flags, any order: --mock enables the test-side Street View monkey-patch,
# --web swaps the native-shell runner for the web-serve one (Chrome over HTTP IPC).
MOCK_ENV=()
BENCH=0
RUNNER="sh /repo/scripts/internal/e2e-native.sh"
while :; do
	case "${1:-}" in
	--mock)
		MOCK_ENV=(-e MMA_TEST_MOCK_SV=1)
		# Port of the in-container Street View stub that serves the Rust procedure engine.
		if [ -n "${MMA_E2E_SV_PORT:-}" ]; then MOCK_ENV+=(-e "MMA_E2E_SV_PORT=$MMA_E2E_SV_PORT"); fi
		# Mock latency.
		if [ -n "${MMA_E2E_SV_LATENCY_MS:-}" ]; then
			MOCK_ENV+=(-e "MMA_E2E_SV_LATENCY_MS=$MMA_E2E_SV_LATENCY_MS")
		fi
		shift
		;;
	--web)
		RUNNER="sh /repo/scripts/internal/e2e-web.sh"
		shift
		;;
	--bench)
		BENCH=1
		shift
		;;
	*) break ;;
	esac
done

# A benchmark measures the release binary: a debug build handicaps only the Rust side.
if [ "$BENCH" = "1" ]; then export MMA_E2E_PROFILE="${MMA_E2E_PROFILE:-release}"; fi
. scripts/internal/e2e-image.sh

COMPOSE="docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.dev.yml"

if ! docker image inspect "$MMA_E2E_IMAGE" >/dev/null 2>&1; then
	echo "no e2e image $MMA_E2E_IMAGE for this checkout; building it" >&2
	bash scripts/e2e-build.sh || exit 1
fi

# A clean tag is correct by construction. A dirty one can go stale under edits, so
# warn when a baked source is newer than the image. Test specs, wdio config, and
# scripts/ are live-mounted; anything else baked needs scripts/e2e-build.sh.
CREATED=$(docker image inspect --format '{{.Created}}' "$MMA_E2E_IMAGE" 2>/dev/null)
if [ "$MMA_E2E_DIRTY" = "1" ] && [ -n "$CREATED" ]; then
	stamp=$(mktemp)
	if touch -d "$CREATED" "$stamp" 2>/dev/null; then
		stale=$(find app/src app/src-tauri/src app/src-tauri/Cargo.toml \
			app/src-tauri/tauri.conf.json app/package.json app/public plugins \
			-type f -newer "$stamp" -print -quit 2>/dev/null)
		if [ -n "$stale" ]; then
			echo "WARNING: the e2e image is STALE - $stale changed after it was built." >&2
			echo "         Rebuild with: bash scripts/e2e-build.sh (test-only edits are live-mounted)." >&2
		fi
	fi
	rm -f "$stamp"
fi

# Every run writes one file to app/test/logs/: everything the container printed, under a
# name that says what ran, when, and against which checkout. wdio's own log writer stands
# down when the path is handed in (MMA_E2E_LOG_PATH), so the file is the single record.
LOG_DIR=app/test/logs
mkdir -p "$LOG_DIR"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%S)
MODE=native
[ "$RUNNER" = "sh /repo/scripts/internal/e2e-web.sh" ] && MODE=web
[ "$BENCH" = "1" ] && MODE=bench
log_name() { echo "e2e-$MODE-$STAMP-$MMA_E2E_REVISION${1:+-$1}.txt"; }
# NO_COLOR keeps the spec reporter's colour codes out of the file.
run_logged() {
	local name=$1
	shift
	$COMPOSE run -e NO_COLOR=1 -e "MMA_E2E_LOG_PATH=/repo/$LOG_DIR/$name" "$@" 2>&1 | tee "$LOG_DIR/$name"
	local rc=${PIPESTATUS[0]}
	echo "log: $LOG_DIR/$name"
	return "$rc"
}

if [ "$BENCH" = "1" ]; then
	if [ "${1:-}" = "--shard" ]; then
		echo "--bench is never sharded: benchmark numbers must be comparable run to run." >&2
		exit 1
	fi
	# Stamped into the result JSON so two runs can be told apart by commit, and by the
	# profile the image was actually built at (read off the image, never assumed).
	PROFILE_LABEL=$(docker image inspect --format '{{index .Config.Labels "mma.profile"}}' "$MMA_E2E_IMAGE" 2>/dev/null)
	BENCH_ENV=(-e "MMA_BENCH_REVISION=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
		-e "MMA_BENCH_BUILD_PROFILE=${PROFILE_LABEL:-unknown}")
	for var in MMA_BENCH_SCALES MMA_BENCH_SAMPLES MMA_BENCH_WARMUPS MMA_BENCH_ROUTES \
		MMA_BENCH_SEED MMA_BENCH_LABEL MMA_BENCH_GPU; do
		if [ -n "${!var:-}" ]; then BENCH_ENV+=(-e "$var=${!var}"); fi
	done
	# --exclude overrides the config's exclude list, which otherwise also blocks --spec.
	run_logged "$(log_name)" "${MOCK_ENV[@]}" "${BENCH_ENV[@]}" --rm e2e $RUNNER \
		--spec ./test/e2e/performance.test.ts --exclude ./test/e2e/scratch.test.ts
	exit $?
fi

if [ "${1:-}" = "--shard" ]; then
	N="${2:-3}"
	echo "Running e2e suite across $N parallel containers..."
	pids=()
	names=()
	for i in $(seq 1 "$N"); do
		name=$(log_name "shard${i}of${N}")
		names+=("$name")
		$COMPOSE run -e NO_COLOR=1 -e "MMA_E2E_LOG_PATH=/repo/$LOG_DIR/$name" "${MOCK_ENV[@]}" \
			--rm e2e $RUNNER --shard "$i/$N" >"$LOG_DIR/$name" 2>&1 &
		pids+=("$!")
	done
	rc=0
	for idx in "${!pids[@]}"; do
		i=$((idx + 1))
		if wait "${pids[$idx]}"; then
			echo "shard $i/$N: PASS"
		else
			echo "shard $i/$N: FAIL"
			rc=1
		fi
		grep -E "Spec Files:" "$LOG_DIR/${names[$idx]}" | tail -1
		echo "log: $LOG_DIR/${names[$idx]}"
	done
	exit $rc
fi

# Subset: prefix each spec file with --spec. No args => full suite.
args=()
for s in "$@"; do args+=(--spec "$s"); done
run_logged "$(log_name)" "${MOCK_ENV[@]}" --rm e2e $RUNNER "${args[@]}"
