/** The last `/`-delimited segment of a tag path. */
export const leafSegment = (path: string) => path.split("/").pop() ?? path;

/** Whether `path` is `prefix` itself or sits anywhere under it. */
export const isAtOrUnder = (path: string, prefix: string) =>
	path === prefix || path.startsWith(`${prefix}/`);

/** `path` moved from under `from` to under `to`, or null when it isn't at or under `from`. */
export const rebasePath = (path: string, from: string, to: string): string | null =>
	isAtOrUnder(path, from) ? to + path.slice(from.length) : null;

/** Map each `/`-delimited name to the shortest trailing path-segment run that uniquely
 *  identifies it within `names`. A name with no collision collapses to its last segment;
 *  one whose suffix is shared widens until distinct, falling back to the full path. */
export function shortestUniqueSuffixes(names: string[]): Map<string, string> {
	const parts = names.map((n) => n.split("/"));
	const out = new Map<string, string>();
	for (let i = 0; i < names.length; i++) {
		const p = parts[i];
		let depth = 1;
		let suffix = p.slice(-depth).join("/");
		while (
			depth < p.length &&
			parts.some((other, j) => j !== i && other.slice(-depth).join("/") === suffix)
		) {
			depth++;
			suffix = p.slice(-depth).join("/");
		}
		out.set(names[i], suffix);
	}
	return out;
}
