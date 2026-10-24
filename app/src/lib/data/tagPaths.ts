/** Normalize a `/`-delimited path: trim outer whitespace and slashes, and collapse `//`. */
export const normalizePath = (path: string) =>
	path
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");

/** The last `/`-delimited segment of a path. */
export const leafSegment = (path: string) => path.split("/").pop() ?? path;

/** Whether `path` is `prefix` itself or sits anywhere under it. */
export const isAtOrUnder = (path: string, prefix: string) =>
	path === prefix || path.startsWith(`${prefix}/`);

/** `path` moved from under `from` to under `to`, or null when it isn't at or under `from`. */
export const rebasePath = (path: string, from: string, to: string): string | null =>
	isAtOrUnder(path, from) ? to + path.slice(from.length) : null;

/** A node in a `/`-delimited path tree. */
export interface PathTreeNode<N extends PathTreeNode<N>> {
	segment: string;
	fullPath: string;
	parentPath: string;
	children: N[];
}

/** Walk or create the node chain for `parts` in `root`, returning the terminal node. */
export function ensurePathNode<N extends PathTreeNode<N>>(
	root: N[],
	parts: readonly string[],
	make: (segment: string, fullPath: string, parentPath: string) => N,
): N {
	let level = root;
	let pathSoFar = "";
	let node!: N;
	for (const segment of parts) {
		const parentPath = pathSoFar;
		pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
		let existing = level.find((n) => n.segment === segment);
		if (!existing) {
			existing = make(segment, pathSoFar, parentPath);
			level.push(existing);
		}
		node = existing;
		level = existing.children;
	}
	return node;
}

/** Find the node at `path` in a `/`-delimited tree, or null. */
export function findPathNode<N extends PathTreeNode<N>>(
	tree: readonly N[],
	path: string,
): N | null {
	for (const n of tree) {
		if (isAtOrUnder(path, n.fullPath))
			return n.fullPath === path ? n : findPathNode(n.children, path);
	}
	return null;
}

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
