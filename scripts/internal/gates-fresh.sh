fresh_generate() {
	while [ "$1" != -- ]; do shift; done
	shift
	"$@"

}

fresh() {
	fresh_generate "$@" || return $?
	while [ "$1" != -- ]; do
		path=$1
		if ! git diff --quiet HEAD -- "$path"; then
			echo "[fresh] tracked output changed: $path" >&2
			return 1
		fi
		if [ -d "$path" ]; then
			untracked=$(git ls-files --others --exclude-standard -- "$path") || return 1
		else
			untracked=$(git ls-files --others -- "$path") || return 1
		fi
		if [ -n "$untracked" ]; then
			echo "[fresh] untracked output exists: $untracked" >&2
			return 1
		fi
		shift
	done

}

fresh_plugins() (
	outputs=$(node plugins/build-all.mjs --list-outputs) || exit $?
	# Only newline separates paths; preserve spaces and literal glob characters.
	IFS='
'
	set -f
	set -- $outputs
	fresh "$@" -- node plugins/build-all.mjs --check
)