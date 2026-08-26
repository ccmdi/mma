import type { Tag, VirtualTag } from "@/bindings.gen";
import type { TagSortMode } from "@/types";
import type { TagFolderColorMode } from "@/store/settings";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";

const EXPANDED_KEY = "tagTreeExpanded";

/** The sidebar's persisted expanded-folder set. Other tag-tree surfaces (e.g. the
 *  doclink assign dialog) read it to open matching the sidebar; only the sidebar writes. */
export function loadExpanded(): Set<string> {
	return new Set(getLocal<string[]>(EXPANDED_KEY, []));
}

export function saveExpanded(set: Set<string>) {
	setLocal(EXPANDED_KEY, [...set]);
}

export interface TagTreeNode {
	segment: string;
	fullPath: string;
	/** Structural parent path ("" at root). Never derive this by splitting fullPath on "/" --
	 *  in no-split mode a tag name containing "/" is a single segment. */
	parentPath: string;
	tag: Tag | null;
	inheritedColor: string;
	children: TagTreeNode[];
	descendantTagIds: number[];
	/** Min `order` across descendant tags — used for "default" sort parity with flat mode.
	 *  MAX_SAFE_INTEGER for a subtree with no tags (declared empty folders), sorting it last. */
	sortOrder: number;
	/** A synthetic leaf placing a real tag at a second tree location. Reuses `tag`, but is
	 *  not draggable and never contributes its id to reorder (the real leaf owns that). */
	isAlias: boolean;
}

/** A terminal tag — no children — renders as a flat pill, not a folder row. A childless
 *  tagless node is a declared empty folder (a virtualTags key no tag passes through) and
 *  renders as a folder row; filtering can also leave transient tagless nodes behind. */
export const isLeafTag = (n: TagTreeNode) => n.children.length === 0 && n.tag != null;

/** Every occupied tree path (tags, aliases, declared folders + all their ancestors) --
 *  mirrors buildTagTree's occupancy, so a free slot here is a free slot in the tree. */
export function collectOccupiedPaths(
	tags: Tag[],
	aliases: Record<string, number>,
	virtualTags: Record<string, VirtualTag>,
): Set<string> {
	const set = new Set<string>();
	const addPrefixes = (path: string) => {
		let p = "";
		for (const s of path.split("/")) {
			p = p ? `${p}/${s}` : s;
			set.add(p);
		}
	};
	for (const t of tags) addPrefixes(t.name);
	for (const k of Object.keys(aliases)) addPrefixes(k);
	for (const k of Object.keys(virtualTags)) addPrefixes(k);
	return set;
}

export function sumCounts(node: TagTreeNode, tagCounts: Record<number, number>): number {
	let total = node.tag ? (tagCounts[node.tag.id] ?? 0) : 0;
	for (const child of node.children) total += sumCounts(child, tagCounts);
	return total;
}

/** How a colorless folder row gets its color: `direct` uses `color` as-is; `firstChild`
 *  inherits the first own-colored descendant in display order, `color` as fallback. */
export interface FolderColorOpts {
	mode: TagFolderColorMode;
	color: string;
}
const DEFAULT_FOLDER_COLOR: FolderColorOpts = { mode: "direct", color: "#888888" };

/** Walk/create the node chain for `parts`, returning the leaf node. */
function ensurePath(root: TagTreeNode[], parts: string[]): TagTreeNode {
	let level = root;
	let pathSoFar = "";
	let node!: TagTreeNode;
	for (const segment of parts) {
		const parentPath = pathSoFar;
		pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
		let existing = level.find((n) => n.segment === segment);
		if (!existing) {
			existing = {
				segment,
				fullPath: pathSoFar,
				parentPath,
				tag: null,
				inheritedColor: "",
				children: [],
				descendantTagIds: [],
				sortOrder: 0,
				isAlias: false,
			};
			level.push(existing);
		}
		node = existing;
		level = existing.children;
	}
	return node;
}

/** Build the nested tag tree from `/`-delimited tag names. Within each level, leaf tags
 *  are floated above sub-branches so they render as a flat pill group above folder rows.
 *  `virtualTags` colors folder nodes that have no underlying tag (keyed by full path).
 *  `split: false` renders the flat view: each tag name is a single leaf ("/" is literal
 *  text, no folders), and aliases/virtualTags don't apply. */
export function buildTagTree(
	tags: Tag[],
	sortMode: TagSortMode,
	tagCounts: Record<number, number>,
	virtualTags: Record<string, VirtualTag> = {},
	aliases: Record<string, number> = {},
	split = true,
	folderColor: FolderColorOpts = DEFAULT_FOLDER_COLOR,
): TagTreeNode[] {
	const root: TagTreeNode[] = [];

	for (const tag of tags) {
		const leaf = ensurePath(root, split ? tag.name.split("/") : [tag.name]);
		if (!leaf.tag) leaf.tag = tag;
	}

	// Insert alias leaves: a real tag placed at a second path. Skip a dangling alias
	// (tag deleted) or one whose path is already occupied by any real node - an alias only
	// fills a free leaf slot, never clobbers (and never leaves a stray empty folder).
	if (split) {
		const tagById = new Map(tags.map((t) => [t.id, t]));
		const resolve = (path: string): TagTreeNode | null => {
			let level = root;
			let found: TagTreeNode | null = null;
			for (const segment of path.split("/")) {
				found = level.find((n) => n.segment === segment) ?? null;
				if (!found) return null;
				level = found.children;
			}
			return found;
		};
		for (const [aliasPath, tagId] of Object.entries(aliases)) {
			const tag = tagById.get(tagId);
			if (!tag || resolve(aliasPath)) continue;
			const leaf = ensurePath(root, aliasPath.split("/"));
			leaf.tag = tag;
			leaf.isAlias = true;
		}

		// Seed declared folders: every virtualTags key gets a folder node even when no
		// tag path passes through it, so empty folders exist without scaffolding tags.
		for (const path of Object.keys(virtualTags)) {
			ensurePath(root, path.split("/"));
		}
	}

	const ownColorOf = (node: TagTreeNode) =>
		node.tag?.color ?? virtualTags[node.fullPath]?.color ?? null;

	// First own-colored node in the (sorted) subtree, DFS in display order.
	function firstDescendantColor(node: TagTreeNode): string | null {
		const own = ownColorOf(node);
		if (own) return own;
		for (const child of node.children) {
			const color = firstDescendantColor(child);
			if (color) return color;
		}
		return null;
	}

	// Runs after sortNodes so firstChild mode sees children in display order.
	function propagateColor(nodes: TagTreeNode[], parentColor: string | null) {
		for (const node of nodes) {
			// Real tag color wins; otherwise a virtual-tag color for this path; else derive.
			const ownColor = ownColorOf(node);
			const derived =
				ownColor ?? (folderColor.mode === "firstChild" ? firstDescendantColor(node) : null);
			const effectiveColor = derived ?? parentColor ?? folderColor.color;
			node.inheritedColor = effectiveColor;
			propagateColor(node.children, effectiveColor);
		}
	}

	function collectMeta(node: TagTreeNode): { ids: number[]; minOrder: number } {
		const ids: number[] = [];
		let minOrder = node.tag?.order ?? Number.POSITIVE_INFINITY;
		if (node.tag) ids.push(node.tag.id);
		for (const child of node.children) {
			const c = collectMeta(child);
			ids.push(...c.ids);
			if (c.minOrder < minOrder) minOrder = c.minOrder;
		}
		node.descendantTagIds = ids;
		node.sortOrder = minOrder === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : minOrder;
		return { ids, minOrder: node.sortOrder };
	}

	// Mirror flat-mode ordering (name / amount / default), recursively per level.
	// `segment` is the name tiebreaker so output is deterministic in every mode.
	// Then float leaf tags above sub-branches at each level: leaves render as a flat
	// pill group and branches as folder rows below them (the userscript's structure).
	function sortNodes(nodes: TagTreeNode[]) {
		nodes.sort((a, b) => {
			if (sortMode === "amount") {
				const d = sumCounts(b, tagCounts) - sumCounts(a, tagCounts);
				if (d !== 0) return d;
			} else if (sortMode === "default") {
				const d = a.sortOrder - b.sortOrder;
				if (d !== 0) return d;
			}
			return a.segment.localeCompare(b.segment);
		});
		const leaves = nodes.filter(isLeafTag);
		const branches = nodes.filter((n) => !isLeafTag(n));
		if (leaves.length > 0 && branches.length > 0) {
			nodes.splice(0, nodes.length, ...leaves, ...branches);
		}
		for (const node of nodes) sortNodes(node.children);
	}

	for (const node of root) collectMeta(node);
	sortNodes(root);
	propagateColor(root, null);

	return root;
}

/** Tag ids to toggle for a shift-click range over the tree's visible rows. Unions the
 *  descendant ids of every row in the [anchor, target] span, de-duped, but excludes the
 *  anchor's own descendants — those were selected by the anchor click, and (when the anchor
 *  is an expanded parent) its child rows sit inside the span, so toggling them would undo it. */
export function rangeToggleTagIds(
	rows: { descendantTagIds: number[] }[],
	anchorIdx: number,
	targetIdx: number,
): number[] {
	const lo = Math.min(anchorIdx, targetIdx);
	const hi = Math.max(anchorIdx, targetIdx);
	const exclude = new Set(rows[anchorIdx].descendantTagIds);
	const ids = new Set<number>();
	for (let i = lo; i <= hi; i++) {
		for (const id of rows[i].descendantTagIds) {
			if (!exclude.has(id)) ids.add(id);
		}
	}
	return [...ids];
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

export interface TagNameChange {
	id: number;
	name: string;
}

const leafOf = (name: string) => name.split("/").pop() ?? name;

/** An alias leaf displays its path's last segment, fixed at creation from the tag's leaf
 *  name. When a tag's leaf name changes, rewrite the last segment of every alias key
 *  pointing at it so the alias keeps showing the tag's name. Returns null when no alias
 *  changed. Collisions merge last-write-wins, same as cascadeRename. */
export function syncAliasSegments(
	aliases: Record<string, number>,
	renames: { id: number; oldName: string; newName: string }[],
): Record<string, number> | null {
	const byId = new Map(
		renames.filter((r) => leafOf(r.oldName) !== leafOf(r.newName)).map((r) => [r.id, r]),
	);
	if (byId.size === 0) return null;
	let changed = false;
	const next: Record<string, number> = {};
	for (const [path, id] of Object.entries(aliases)) {
		const r = byId.get(id);
		if (r) {
			const parts = path.split("/");
			parts[parts.length - 1] = leafOf(r.newName);
			next[parts.join("/")] = id;
			changed = true;
		} else {
			next[path] = id;
		}
	}
	return changed ? next : null;
}

/** Rewrite the path prefix `oldPrefix` -> `newPrefix` across every tag and virtual-tag
 *  key whose path is `oldPrefix` itself or sits under it (`oldPrefix/...`). Used to rename
 *  a tag-tree folder and cascade to its descendants. Returns the tag renames plus the
 *  rewritten virtualTags map. Collisions (target path already exists) just merge -- last
 *  write wins -- which is the intended folder-merge behavior. */
export function cascadeRename(
	oldPrefix: string,
	newPrefix: string,
	tags: Tag[],
	virtualTags: Record<string, VirtualTag>,
	aliases: Record<string, number> = {},
): {
	tagRenames: TagNameChange[];
	virtualTags: Record<string, VirtualTag>;
	aliases: Record<string, number>;
} {
	const moved = newPrefix !== oldPrefix;
	const rewrite = (s: string): string | null => {
		if (!moved) return null;
		if (s === oldPrefix) return newPrefix;
		if (s.startsWith(`${oldPrefix}/`)) return newPrefix + s.slice(oldPrefix.length);
		return null;
	};

	const tagRenames: TagNameChange[] = [];
	for (const t of tags) {
		const next = rewrite(t.name);
		if (next !== null && next !== t.name) tagRenames.push({ id: t.id, name: next });
	}

	const nextVirtual: Record<string, VirtualTag> = {};
	for (const [path, cfg] of Object.entries(virtualTags)) {
		nextVirtual[rewrite(path) ?? path] = cfg;
	}

	// Alias keys are tree paths too — move any sitting at or under the renamed folder.
	let nextAliases: Record<string, number> = {};
	for (const [path, id] of Object.entries(aliases)) {
		nextAliases[rewrite(path) ?? path] = id;
	}

	// Only the tag at exactly `oldPrefix` gets a new leaf segment (descendants keep
	// theirs), so aliases pointing at it need their displayed segment synced too.
	const rootTag = moved ? tags.find((t) => t.name === oldPrefix) : undefined;
	if (rootTag) {
		nextAliases =
			syncAliasSegments(nextAliases, [
				{ id: rootTag.id, oldName: oldPrefix, newName: newPrefix },
			]) ?? nextAliases;
	}

	return { tagRenames, virtualTags: nextVirtual, aliases: nextAliases };
}

/** Resolve a split-mode tree node by full path (paths are `/`-joined segments). */
function findByPath(tree: TagTreeNode[], path: string): TagTreeNode | null {
	for (const n of tree) {
		if (n.fullPath === path) return n;
		if (path.startsWith(`${n.fullPath}/`)) return findByPath(n.children, path);
	}
	return null;
}

/** Whether the sibling block `dragPaths` may drop INTO folder `targetPath`: the target is
 *  a folder (branch or declared empty folder) outside the block and its subtrees, isn't
 *  the block's current parent (no-op), and none of its children collide with a dragged
 *  node's segment. */
export function canDropInto(tree: TagTreeNode[], dragPaths: string[], targetPath: string): boolean {
	const targetChildren = targetPath === "" ? tree : findByPath(tree, targetPath)?.children;
	if (!targetChildren) return false;
	if (targetPath !== "") {
		const target = findByPath(tree, targetPath)!;
		if (isLeafTag(target) || target.isAlias) return false;
	}
	const nodes = dragPaths.map((p) => findByPath(tree, p));
	if (nodes.length === 0 || nodes.some((n) => !n || n.isAlias)) return false;
	if (dragPaths.some((p) => targetPath === p || targetPath.startsWith(`${p}/`))) return false;
	if (nodes[0]!.parentPath === targetPath) return false;
	const childSegments = new Set(targetChildren.map((c) => c.segment));
	return !nodes.some((n) => childSegments.has(n!.segment));
}

export interface TagMoveResult {
	tagRenames: TagNameChange[];
	virtualTags: Record<string, VirtualTag>;
	aliases: Record<string, number>;
	/** Full DFS tag-id order with the block appended at the end of the target's children. */
	orderedIds: number[];
	/** Old -> new path for each moved branch, for remapExpanded. */
	pathRemaps: [string, string][];
}

/** Move the sibling block `dragPaths` into folder `targetPath` (`""` is the top level):
 *  cascadeRename each block member to `targetPath/<segment>` (tags, virtualTags, and alias
 *  keys all follow), and rebase the global order so the block lands contiguously at the
 *  end of the target's children, keeping its relative order. Returns null when the drop
 *  isn't allowed. */
export function moveIntoFolder(
	tree: TagTreeNode[],
	dragPaths: string[],
	targetPath: string,
	tags: Tag[],
	virtualTags: Record<string, VirtualTag>,
	aliases: Record<string, number>,
): TagMoveResult | null {
	if (!canDropInto(tree, dragPaths, targetPath)) return null;
	const nodes = dragPaths.map((p) => findByPath(tree, p)!);

	// Block members are siblings (disjoint prefixes), so the cascades never overlap.
	let workingTags = tags;
	let workingVT = virtualTags;
	let workingAliases = aliases;
	const renameById = new Map<number, string>();
	const pathRemaps: [string, string][] = [];
	for (const node of nodes) {
		const newPath = targetPath === "" ? node.segment : `${targetPath}/${node.segment}`;
		const res = cascadeRename(node.fullPath, newPath, workingTags, workingVT, workingAliases);
		for (const r of res.tagRenames) renameById.set(r.id, r.name);
		workingTags = workingTags.map((t) => {
			const next = res.tagRenames.find((r) => r.id === t.id);
			return next ? { ...t, name: next.name } : t;
		});
		workingVT = res.virtualTags;
		workingAliases = res.aliases;
		if (node.children.length > 0) pathRemaps.push([node.fullPath, newPath]);
	}

	const dragSet = new Set(dragPaths);
	const orderedIds: number[] = [];
	const emitSubtree = (n: TagTreeNode) => {
		if (n.tag && !n.isAlias) orderedIds.push(n.tag.id);
		for (const c of n.children) emitSubtree(c);
	};
	const walk = (level: TagTreeNode[]) => {
		for (const n of level) {
			if (dragSet.has(n.fullPath)) continue;
			if (n.tag && !n.isAlias) orderedIds.push(n.tag.id);
			walk(n.children);
			if (n.fullPath === targetPath) for (const b of nodes) emitSubtree(b);
		}
	};
	walk(tree);
	if (targetPath === "") for (const b of nodes) emitSubtree(b);

	return {
		tagRenames: [...renameById].map(([id, name]) => ({ id, name })),
		virtualTags: workingVT,
		aliases: workingAliases,
		orderedIds,
		pathRemaps,
	};
}

interface OrderNode {
	fullPath: string;
	tag: { id: number } | null;
	children: OrderNode[];
	isAlias?: boolean;
}

function siblingsAt<T extends OrderNode>(tree: T[], parent: string): T[] {
	if (parent === "") return tree;
	let result: T[] = tree;
	const find = (arr: T[]): boolean => {
		for (const n of arr) {
			if (n.fullPath === parent) {
				result = n.children as T[];
				return true;
			}
			if (find(n.children as T[])) return true;
		}
		return false;
	};
	find(tree);
	return result;
}

// Mirrors row highlighting: own tag selected, or a branch with every descendant selected.
// The length guard keeps empty folders out ([].every is vacuously true).
const isEffectivelySelected = (n: TagTreeNode, sel: ReadonlySet<number>): boolean =>
	(n.tag != null && sel.has(n.tag.id)) ||
	(n.descendantTagIds.length > 0 && n.descendantTagIds.every((id) => sel.has(id)));

/** The sibling paths a ctrl+drag carries as one block: the grabbed node plus every
 *  effectively-selected sibling of the same kind (pill vs folder row), in sibling order.
 *  Alias leaves never join (the real leaf owns the id). */
export function collectDragBlock(
	tree: TagTreeNode[],
	grabbed: TagTreeNode,
	selectedTagIds: ReadonlySet<number>,
): string[] {
	const grabbedIsLeaf = isLeafTag(grabbed);
	return siblingsAt(tree, grabbed.parentPath)
		.filter(
			(n) =>
				n.fullPath === grabbed.fullPath ||
				(!n.isAlias && isLeafTag(n) === grabbedIsLeaf && isEffectivelySelected(n, selectedTagIds)),
		)
		.map((n) => n.fullPath);
}

/** Full DFS tag-id order reflecting an in-level move of the `dragPaths` block to
 *  before/after `dropPath`. The block keeps its relative sibling order and lands as one
 *  contiguous run. `parent` is the block's structural parentPath ("" at root) -- it can't
 *  be derived from the path string, which may contain literal "/" in no-split mode.
 *  Returns null if the target isn't a sibling under `parent`, is part of the block, or
 *  no block member is found. Every other node keeps its relative order; moved nodes
 *  carry their whole subtrees. */
/** Move one node a single slot among its siblings (-1 up, +1 down). Returns the new flat
 *  DFS tag-id order, or null at either end. Keyboard counterpart to a drag reorder. */
export function stepSiblingFlatOrder<T extends OrderNode>(
	tree: T[],
	path: string,
	parent: string,
	delta: -1 | 1,
): number[] | null {
	const siblings = siblingsAt(tree, parent);
	const from = siblings.findIndex((n) => n.fullPath === path);
	if (from === -1) return null;
	const to = from + delta;
	const neighbour = siblings[to];
	if (!neighbour) return null;
	return reorderSiblingsFlatOrder(
		tree,
		[path],
		neighbour.fullPath,
		delta < 0 ? "before" : "after",
		parent,
	);
}

export function reorderSiblingsFlatOrder<T extends OrderNode>(
	tree: T[],
	dragPaths: string[],
	dropPath: string,
	position: "before" | "after",
	parent: string,
): number[] | null {
	const dragSet = new Set(dragPaths);
	if (dragSet.has(dropPath)) return null;

	const siblings = siblingsAt(tree, parent);
	const block = siblings.filter((n) => dragSet.has(n.fullPath));
	const targetNode = siblings.find((n) => n.fullPath === dropPath);
	if (block.length === 0 || !targetNode) return null;

	const without = siblings.filter((n) => !dragSet.has(n.fullPath));
	let idx = without.indexOf(targetNode);
	if (position === "after") idx++;
	without.splice(idx, 0, ...block);

	const out: number[] = [];
	const dfs = (nodes: OrderNode[], cur: string) => {
		const ordered = cur === parent ? without : nodes;
		for (const n of ordered) {
			if (n.tag && !n.isAlias) out.push(n.tag.id); // alias leaves don't own the id
			dfs(n.children, n.fullPath);
		}
	};
	dfs(tree, "");
	return out;
}
