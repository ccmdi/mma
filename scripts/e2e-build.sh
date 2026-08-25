#!/usr/bin/env bash
# Build the e2e Docker image for this checkout. Images are tagged per commit and
# profile (see scripts/internal/e2e-image.sh), so a clean checkout that already has
# its image is skipped; pass --force to rebuild it anyway. A dirty checkout always
# builds. Output is teed to build-e2e.log with --progress=plain, since BuildKit's TTY
# output does not pipe cleanly.
#
#   scripts/e2e-build.sh                          # debug image for this checkout
#   MMA_E2E_PROFILE=release scripts/e2e-build.sh  # release image (what --bench uses)
#   scripts/e2e-build.sh --force
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/internal/e2e-image.sh

if [ "${1:-}" != "--force" ] && [ "$MMA_E2E_DIRTY" = "0" ] \
	&& docker image inspect "$MMA_E2E_IMAGE" >/dev/null 2>&1; then
	echo "e2e image $MMA_E2E_IMAGE already exists for this commit; --force to rebuild"
	exit 0
fi

LOG=app/test/logs/build-$(date -u +%Y-%m-%dT%H-%M-%S)-${MMA_E2E_IMAGE#*:}.txt
mkdir -p app/test/logs
echo "building $MMA_E2E_IMAGE ($MMA_E2E_PROFILE), log: $LOG"
docker compose -f docker-compose.e2e.yml build --progress=plain e2e 2>&1 | tee "$LOG"
exit "${PIPESTATUS[0]}"
