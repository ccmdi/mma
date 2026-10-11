#!/bin/sh
# Every CI gate, defined once. CI runs `gates.sh --env <env>` per environment; the pre-push
# hook runs them all. Lanes run in parallel and each runs its gates in order; a gate in lane
# `-` shares nothing and runs on its own. The `fresh` lane regenerates committed artifacts, so
# it runs after every other lane rather than racing a reader. A gate never installs dependencies.
#
#   gates.sh                 all gates
#   gates.sh --env node      one environment's gates
#   gates.sh oxlint vitest   the named gates
#   gates.sh --list
set -u
root=$(cd "$(dirname "$0")/.." && pwd)

# The cargo lane shares app/src-tauri's target directory and Cargo build lock.
GATES='
vitest            node  -       app            npx vitest run
runner            node  -       app            sh ../scripts/gates-fresh.test.sh
oxlint            node  -       app            npx oxlint src/ test/e2e/
check-browser     node  -       app            npm run check:browser-compat
oxfmt             node  -       app            npx oxfmt --check src test procedures
typecheck         node  -       app            npm run typecheck
procedures        node  -       app            npm run test:procedures
check-legacy      node  -       app            node ../plugins/check-legacy.mjs
check-unstable    node  -       app            node ../plugins/check-unstable.mjs
check-floors      node  -       app            node ../plugins/check-floors.mjs
check-tokens      node  -       app            node ../plugins/check-tokens.mjs
check-sidecars    node  -       .              node plugins/check-sidecars.mjs
check-rust-tests  node  -       .              node --test plugins/check-rust-test-layout.test.mjs && node plugins/check-rust-test-layout.mjs
image-dims        node  fresh   app            fresh src/components/manual/manual-img-dims.gen.ts -- npm run gen:image-dims
plugin-types      node  fresh   app            fresh ../plugins/types/mma.d.ts ../plugins/types/API.md -- npm run gen:plugin-types
plugin-build      node  fresh   .              fresh_plugins
cargo-fmt         rust  cargo   app/src-tauri  cargo fmt --all -- --check
clippy            rust  cargo   app/src-tauri  cargo clippy -- -D clippy::correctness
cargo-test        rust  cargo   app/src-tauri  cargo test --lib
mma-geo           rust  cargo   app/src-tauri  cargo test -p mma-geo
mma-algebra       rust  cargo   app/src-tauri  cargo test -p mma-algebra
geocode           rust  -       app/src-tauri  cargo test --manifest-path crates/geocode/Cargo.toml
tz                rust  -       app/src-tauri  cargo test --manifest-path crates/tz/Cargo.toml
bindings          rust  fresh   app            fresh src/bindings.gen.ts src/bindings.consts.ts -- npm run gen:bindings
'

. "$root/scripts/internal/gates-fresh.sh"
tab=$(printf '\t')

table() {
	printf '%s\n' "$GATES" | awk '
		NF == 0 { next }
		{
			name = $1
			env = $2
			lane = $3
			dir = $4
			cmd = $5; for (i = 6; i <= NF; i++) cmd = cmd " " $i
			if (env != "node" && env != "rust") {
				printf "[gates] %s: unknown env %c%s%c\n", name, 39, env, 39 > "/dev/stderr"
				bad = 1
			}
			if (lane != "-" && lane != "cargo" && lane != "fresh") {
				printf "[gates] %s: unknown lane %c%s%c\n", name, 39, lane, 39 > "/dev/stderr"
				bad = 1
			}
			if ((lane == "fresh") != (cmd ~ /^fresh( |_)/)) {
				printf "[gates] %s: the fresh lane holds exactly the fresh commands\n", name > "/dev/stderr"
				bad = 1
			}
			if (name == "" || dir == "" || cmd == "") {
				printf "[gates] malformed gate row\n" > "/dev/stderr"
				bad = 1
			}
			if (lane == "-") lane = name
			printf "%s\t%s\t%s\t%s\t%s\n", name, env, lane, dir, cmd
		}
		END { if (bad) exit 2 }
	'
}

named() {
	for want; do
		line=$(table | awk -F'\t' -v n="$want" '$1 == n')
		[ -n "$line" ] || { echo "[gates] no gate named '$want'" >&2 && exit 2; }
		printf '%s\n' "$line"
	done
}

gate() {
	name=$1
	start=$(date +%s)
	(cd "$root/$2" && eval "$3") >"$tmp/$name.log" 2>&1
	status=$?
	took=$(($(date +%s) - start))s
	if [ -n "${GITHUB_ACTIONS:-}" ]; then
		echo "::group::$name ($took)"
		cat "$tmp/$name.log"
		echo "::endgroup::"
	fi
	if [ "$status" = 0 ]; then
		echo "[gate] $name ok ($took)"
		return
	fi
	echo "$name" >>"$tmp/failed"
	if [ -n "${GITHUB_ACTIONS:-}" ]; then
		echo "::error::gate $name failed"
	else
		echo "[gate] $name FAILED ($took)"
		tail -20 "$tmp/$name.log"
	fi
}

lane() {
	printf '%s\n' "$selection" | awk -F'\t' -v lane="$1" '$3 == lane' |
		while IFS=$tab read -r name _ _ dir cmd; do
			gate "$name" "$dir" "$cmd" </dev/null
		done
}

table >/dev/null || exit 2

case ${1:-} in
--list)
	[ "$#" = 1 ] || { echo "usage: gates.sh --list" >&2; exit 2; }
	table | cut -f1-3
	exit
	;;
--env)
	[ "$#" = 2 ] || { echo "usage: gates.sh --env node|rust" >&2; exit 2; }
	case ${2:-} in
	node | rust) ;;
	*) echo "usage: gates.sh --env node|rust" >&2 && exit 2 ;;
	esac
	selection=$(table | awk -F'\t' -v env="$2" '$2 == env')
	;;
"") selection=$(table) ;;
*) selection=$(named "$@") || exit 2 ;;
esac

tmp=$(mktemp -d)
keep_tmp=0
trap '[ "$keep_tmp" = 1 ] || rm -rf "$tmp"' EXIT

rust_builds=$(printf '%s\n' "$selection" | awk -F'\t' '$2 == "rust" && $1 != "cargo-fmt"')
if [ -n "$rust_builds" ]; then
	if ! (cd "$root/app" && npm run --silent build:procedures) >"$tmp/preflight.log" 2>&1; then
		cat "$tmp/preflight.log" >&2
		keep_tmp=1
		echo "[gates] procedure build failed; full logs: $tmp" >&2
		exit 1
	fi
fi

pids=
for name in $(printf '%s\n' "$selection" | awk -F'\t' '$3 != "fresh" && !seen[$3]++ { print $3 }'); do
	lane "$name" &
	pids="$pids $!"
done
wait_status=0
for pid in $pids; do
	wait "$pid" || wait_status=1
done
lane fresh

if [ -f "$tmp/failed" ]; then
	echo "[gates] FAILED: $(tr '\n' ' ' <"$tmp/failed")"
	keep_tmp=1
	echo "[gates] full logs: $tmp"
	exit 1
fi
if [ "$wait_status" != 0 ]; then
	keep_tmp=1
	echo "[gates] a lane failed; full logs: $tmp"
	exit 1
fi
echo "[gates] all gates green"
