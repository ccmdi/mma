#!/bin/sh
# Every CI gate, defined once. CI runs `gates.sh --env <env>` per environment; the pre-push
# hook runs them all. Lanes run in parallel and each runs its gates in order; a gate in lane
# `-` shares nothing and runs on its own. The `fresh` lane regenerates committed artifacts, so
# it runs after every other lane rather than racing a reader. Every dependency is installed
# before the lanes start; a gate never installs.
#
#   gates.sh                 all gates
#   gates.sh --env node      one environment's gates
#   gates.sh oxlint vitest   the named gates
#   gates.sh --list
set -u
root=$(cd "$(dirname "$0")/.." && pwd)

# The cargo lane shares app/src-tauri's target directory, and with it Cargo's build lock.
GATES='
vitest            node  -       app            npx vitest run
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
plugin-types      node  fresh   app            fresh ../plugins/types/mma.d.ts -- npm run gen:plugin-types
plugin-build      node  fresh   .              fresh plugins -- node plugins/build-all.mjs
cargo-fmt         rust  cargo   app/src-tauri  cargo fmt --all -- --check
clippy            rust  cargo   app/src-tauri  cargo clippy -- -D clippy::correctness
cargo-test        rust  cargo   app/src-tauri  cargo test --lib
mma-geo           rust  cargo   app/src-tauri  cargo test -p mma-geo
mma-algebra       rust  cargo   app/src-tauri  cargo test -p mma-algebra
geocode           rust  -       app/src-tauri  cargo test --manifest-path crates/geocode/Cargo.toml
tz                rust  -       app/src-tauri  cargo test --manifest-path crates/tz/Cargo.toml
bindings          rust  fresh   app            fresh src/bindings.gen.ts src/bindings.consts.ts -- npm run gen:bindings
'

fresh() {
	paths=
	while [ "$1" != -- ]; do
		paths="$paths $1"
		shift
	done
	shift
	"$@" && git diff --exit-code -- $paths
}

tab=$(printf '\t')

table() {
	printf '%s\n' "$GATES" | while read -r name env lane dir cmd; do
		[ -n "$name" ] || continue
		case $env in
		node | rust) ;;
		*) echo "[gates] $name: unknown env '$env'" >&2 && exit 2 ;;
		esac
		case $lane/$cmd in
		fresh/fresh\ *) ;;
		fresh/* | */fresh\ *) echo "[gates] $name: the fresh lane holds exactly the fresh commands" >&2 && exit 2 ;;
		esac
		[ "$lane" != - ] || lane=$name
		printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$env" "$lane" "$dir" "$cmd"
	done
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
	table | cut -f1-3
	exit
	;;
--env)
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
trap 'rm -rf "$tmp"' EXIT

# The crate bundles procedures/*.js as resources and fails to build without them.
(cd "$root/app" && npm run --silent build:procedures >/dev/null) || exit 1
case $selection in
*"${tab}node${tab}"*) node "$root/plugins/build-all.mjs" --install || exit 1 ;;
esac

for name in $(printf '%s\n' "$selection" | awk -F'\t' '$3 != "fresh" && !seen[$3]++ { print $3 }'); do
	lane "$name" &
done
wait
lane fresh

if [ -f "$tmp/failed" ]; then
	echo "[gates] FAILED: $(tr '\n' ' ' <"$tmp/failed")"
	exit 1
fi
echo "[gates] all gates green"
