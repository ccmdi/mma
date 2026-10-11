#!/bin/sh
# Readies a linked worktree to build: shared node_modules, submodules, and procedure bundles.
# Runs from the post-checkout hook on `git worktree add`; safe to rerun.
set -eu

[ "$(git rev-parse --absolute-git-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)" ] && exit 0

tree=$(git rev-parse --show-toplevel)
common=$(git rev-parse --path-format=absolute --git-common-dir)
main=${common%/.git}

link() {
	if command -v cygpath >/dev/null 2>&1; then
		MSYS_NO_PATHCONV=1 cmd /c mklink /J "$(cygpath -w "$1")" "$(cygpath -w "$2")" >/dev/null
	else
		ln -s "$2" "$1"
	fi
}

echo "[worktree-init] linking node_modules from $main"
git -C "$tree" ls-files '*package.json' | while read -r pkg; do
	dir=$(dirname "$pkg")
	if [ -d "$main/$dir/node_modules" ] && [ ! -e "$tree/$dir/node_modules" ]; then
		link "$tree/$dir/node_modules" "$main/$dir/node_modules"
	fi
done

echo "[worktree-init] submodules"
git -C "$tree" submodule update --init

if [ -d "$tree/app/node_modules" ]; then
	echo "[worktree-init] procedures"
	(cd "$tree/app" && npm run --silent build:procedures)
fi
