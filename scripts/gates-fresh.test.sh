#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
. "$root/scripts/internal/gates-fresh.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q
git config core.autocrlf false
git config core.hooksPath ""
git config user.email gates-test@example.invalid
git config user.name gates-test
git config commit.gpgsign false
mkdir -p "generated dir/nested"
printf 'baseline\n' >"generated dir/nested/output.ts"
git add .
git commit -qm baseline

expect_fail() {
	if fresh "$@"; then
		echo "expected fresh check to fail: $*" >&2
		exit 1
	fi
}

fresh "generated dir" -- :
if fresh "generated dir" -- false; then
	echo "failed generator returned success" >&2
	exit 1
fi

printf 'unstaged\n' >"generated dir/nested/output.ts"
expect_fail "generated dir" -- :
git checkout -- "generated dir/nested/output.ts"

printf 'staged\n' >"generated dir/nested/output.ts"
git add "generated dir/nested/output.ts"
expect_fail "generated dir" -- :
git reset -q --hard HEAD

printf 'new\n' >"generated dir/nested/new output.ts"
expect_fail "generated dir" -- :
rm "generated dir/nested/new output.ts"

printf 'partial path\n' >"generated dir/nested/partial.ts"
expect_fail "generated dir/nested" -- :
rm "generated dir/nested/partial.ts"

mkdir -p "ignored dir"
printf 'ignored output\n' >"ignored dir/output.ts"
printf 'ignored dir/\n' >>.git/info/exclude
git check-ignore -q "ignored dir/output.ts"
fresh "ignored dir" -- :
expect_fail "ignored dir/output.ts" -- :

expect_fail "generated dir" -- sh -c 'printf "generated drift\n" >"generated dir/nested/output.ts"'
git reset -q --hard HEAD
expect_fail "generated dir" -- sh -c 'printf "new generated output\n" >"generated dir/new.ts"'
rm "generated dir/new.ts"

echo "gates fresh checks passed"
