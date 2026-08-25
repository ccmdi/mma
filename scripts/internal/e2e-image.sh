# Sourced by scripts/e2e.sh and scripts/e2e-build.sh: names the e2e image for the
# checkout as it stands, so one commit builds once per profile and is reused.
#
#   MMA_E2E_PROFILE  debug (default) or release; --bench selects release
#   MMA_E2E_IMAGE    mma-e2e:<sha>-<profile>, or <sha>-dirty-<profile> when a baked
#                    input has uncommitted changes (those always rebuild; layer cache
#                    keeps it cheap)
#   MMA_E2E_DIRTY    1 when the tag carries -dirty
#
# Baked inputs are everything the Dockerfile copies that changes the binary or the
# bundled procedures. Test specs, wdio config and scripts/ are live-mounted, so they
# never enter the tag.
MMA_E2E_PROFILE="${MMA_E2E_PROFILE:-debug}"
case "$MMA_E2E_PROFILE" in
debug | release) ;;
*)
	echo "MMA_E2E_PROFILE must be debug or release, got '$MMA_E2E_PROFILE'" >&2
	exit 1
	;;
esac

E2E_BAKED_PATHS=(
	app/src app/src-tauri/src app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
	app/src-tauri/tauri.conf.json app/src-tauri/build.rs app/package.json
	app/package-lock.json app/public app/procedures app/scripts app/index.html
	app/vite.config.ts app/tsconfig.json app/tsconfig.app.json app/tsconfig.node.json
	plugins .nvmrc Dockerfile.e2e docker-compose.e2e.yml .dockerignore
)

sha=$(git rev-parse --short=12 HEAD 2>/dev/null || echo nogit)
if [ -n "$(git status --porcelain -- "${E2E_BAKED_PATHS[@]}" 2>/dev/null)" ]; then
	MMA_E2E_DIRTY=1
	MMA_E2E_IMAGE="${MMA_E2E_IMAGE:-mma-e2e:${sha}-dirty-${MMA_E2E_PROFILE}}"
else
	MMA_E2E_DIRTY=0
	MMA_E2E_IMAGE="${MMA_E2E_IMAGE:-mma-e2e:${sha}-${MMA_E2E_PROFILE}}"
fi
# The checkout as a log-file stamp: the same sha and dirtiness the image tag carries.
MMA_E2E_REVISION="${sha}$([ "$MMA_E2E_DIRTY" = 1 ] && echo -dirty)"
export MMA_E2E_PROFILE MMA_E2E_IMAGE MMA_E2E_DIRTY MMA_E2E_REVISION
