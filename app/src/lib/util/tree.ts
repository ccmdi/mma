/** A tree node: whatever it holds, and the subtrees under it. */
export interface TreeNode<N> {
	children: N[];
}

/** Operations on a forest of nodes that know nothing about what the nodes hold. */
export const Tree = {
	/** Every node, each before its children, skipping the children of a node `descend` rejects. */
	walk: <N extends TreeNode<N>>(
		nodes: readonly N[],
		descend: (node: N) => boolean = () => true,
	): N[] =>
		nodes.flatMap((node) => [node, ...(descend(node) ? Tree.walk(node.children, descend) : [])]),

	/** The first node `is` accepts, looking inside only the nodes `inside` lets it. */
	find: <N extends TreeNode<N>>(
		nodes: readonly N[],
		is: (node: N) => boolean,
		inside: (node: N) => boolean = () => true,
	): N | null => {
		for (const node of nodes) {
			if (is(node)) return node;
			const hit = inside(node) ? Tree.find(node.children, is, inside) : null;
			if (hit) return hit;
		}
		return null;
	},

	/** Each node's result from its children's results, deepest first; the roots' results. */
	fold: <N extends TreeNode<N>, R>(nodes: readonly N[], f: (node: N, children: R[]) => R): R[] =>
		nodes.map((node) => f(node, Tree.fold(node.children, f))),

	/** Each node's value from the one its parent passed down, starting from `root`. */
	inherit: <N extends TreeNode<N>, R>(
		nodes: readonly N[],
		f: (node: N, parent: R) => R,
		root: R,
	): void => {
		for (const node of nodes) Tree.inherit(node.children, f, f(node, root));
	},

	/** The nodes `keep` accepts, with every node on the way to one, as a new tree. */
	prune: <N extends TreeNode<N>>(nodes: readonly N[], keep: (node: N) => boolean): N[] =>
		nodes.flatMap((node) => {
			const children = Tree.prune(node.children, keep);
			return keep(node) || children.length > 0 ? [{ ...node, children }] : [];
		}),

	/** Sort every sibling list in place. */
	sortLevels: <N extends TreeNode<N>>(nodes: N[], compare: (a: N, b: N) => number): void => {
		nodes.sort(compare);
		for (const node of nodes) Tree.sortLevels(node.children, compare);
	},
};
