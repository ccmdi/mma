import type { VirtualTag } from "@/bindings.gen";
import { useMemo } from "react";
import type { TagSortMode } from "@/types";
import { Store } from "@/store/store";
import { Tag } from "@/store/tag";
import { Query } from "@/store/query";
import { any, tagSelector } from "@/store/selections";
import { useSetting } from "@/store/settings";
import { useAsyncSticky } from "@/lib/hooks/useAsync";
import { rgbToHex } from "@/lib/util/color";
import type { TagFolderColorMode } from "@/store/settings";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { toggleInSet } from "@/lib/util/util";
import {
	ensurePathNode,
	findPathNode,
	isAtOrUnder,
	leafSegment,
	rebasePath,
} from "@/lib/data/tagPaths";

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
	/** This node's own tag and every tag under it, aliases included. */
	subtreeTagIds: number[];
	/** Locations holding any of `subtreeTagIds`, each counted once; null while a folder's
	 *  count is unknown. */
	count: number | null;
	/** Min `order` across descendant tags — used for "default" sort parity with flat mode.
	 *  A subtree with no tags (declared empty folders) sorts by its own stored order, else last. */
	sortOrder: number;
	/** A synthetic leaf placing a real tag at a second tree location. Reuses `tag`, but is
	 *  not draggable and never contributes its id to reorder (the real leaf owns that). */
	isAlias: boolean;
}

/** A terminal tag — no children — renders as a flat pill, not a folder row. A childless
 *  tagless node is a declared empty folder (a virtualTags key no tag passes through) and
 *  renders as a folder row; filtering can also leave transient tagless nodes behind. */
export const isLeafTag = (n: TagTreeNode) => n.children.length === 0 && n.tag != null;

export type TagTreeExpansionIntent =
	| { kind: "toggle"; path: string }
	| { kind: "toggle-subtree"; path: string }
	| { kind: "isolate"; path: string; parentPath: string };

export function resolveExpandedPaths(
	tree: TagTreeNode[],
	expanded: ReadonlySet<string>,
	intent: TagTreeExpansionIntent,
): Set<string> {
	if (intent.kind === "toggle") return toggleInSet(expanded, intent.path);

	const next = new Set(expanded);
	if (intent.kind === "toggle-subtree") {
		if (expanded.has(intent.path)) {
			for (const path of next) {
				if (isAtOrUnder(path, intent.path)) next.delete(path);
			}
		} else {
			const addSubtree = (nodes: TagTreeNode[]) => {
				for (const node of nodes) {
					if (node.children.length > 0 && isAtOrUnder(node.fullPath, intent.path)) {
						next.add(node.fullPath);
					}
					addSubtree(node.children);
				}
			};
			addSubtree(tree);
		}
		return next;
	}

	const closeSiblings = (nodes: TagTreeNode[]) => {
		for (const node of nodes) {
			if (node.parentPath === intent.parentPath && node.fullPath !== intent.path) {
				next.delete(node.fullPath);
			}
			closeSiblings(node.children);
		}
	};
	closeSiblings(tree);
	next.add(intent.path);
	return next;
}

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

/** Location counts a tree is built with: each tag's own, and each folder's by path. */
export interface TagTreeCounts {
	tags: Record<number, number>;
	folders: ReadonlyMap<string, number>;
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
	return ensurePathNode(root, parts, (segment, fullPath, parentPath) => ({
		segment,
		fullPath,
		parentPath,
		tag: null,
		inheritedColor: "",
		children: [],
		subtreeTagIds: [],
		count: null,
		sortOrder: 0,
		isAlias: false,
	}));
}

/** Build the nested tag tree from `/`-delimited tag names. Within each level, leaf tags
 *  are floated above sub-branches so they render as a flat pill group above folder rows.
 *  `virtualTags` colors folder nodes that have no underlying tag (keyed by full path).
 *  `split: false` renders the flat view: each tag name is a single leaf ("/" is literal
 *  text, no folders), and aliases/virtualTags don't apply. */
export function buildTagTree(
	tags: Tag[],
	sortMode: TagSortMode,
	counts: TagTreeCounts,
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
		for (const [aliasPath, tagId] of Object.entries(aliases)) {
			const tag = tagById.get(tagId);
			if (!tag || findByPath(root, aliasPath)) continue;
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
		node.subtreeTagIds = ids;
		node.count =
			node.children.length > 0
				? (counts.folders.get(node.fullPath) ?? null)
				: node.tag
					? (counts.tags[node.tag.id] ?? 0)
					: 0;
		if (ids.length === 0) minOrder = virtualTags[node.fullPath]?.order ?? minOrder;
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
				const d = (b.count ?? 0) - (a.count ?? 0);
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

/** What a tag tree is built from. */
export interface TagTreeSource {
	tags: Tag[];
	/** false = flat view: every tag name is a single leaf pill, no folders. */
	split: boolean;
	sortMode: TagSortMode;
	virtualTags: Record<string, VirtualTag>;
	aliases: Record<string, number>;
}

const NO_FOLDER_COUNTS: ReadonlyMap<string, number> = new Map();

const foldersOf = (nodes: TagTreeNode[]): TagTreeNode[] =>
	nodes.flatMap((node) => (node.children.length > 0 ? [node, ...foldersOf(node.children)] : []));

/** The tag tree as the sidebar shows it, each node carrying its location count. A folder's
 *  count comes from the store, so a location holding several of its tags counts once. */
export function useTagTree({
	tags,
	split,
	sortMode,
	virtualTags,
	aliases,
}: TagTreeSource): TagTreeNode[] {
	const folderColorMode = useSetting("tagFolderColorMode");
	const folderColorRgb = useSetting("tagFolderColor");
	const tagCounts = Store.use(() => Tag.counts());
	const folderCounts =
		useAsyncSticky(async () => {
			const tree = buildTagTree(
				tags,
				"name",
				{ tags: tagCounts, folders: NO_FOLDER_COUNTS },
				virtualTags,
				aliases,
				split,
			);
			const folders = foldersOf(tree);
			const counts = await Query.read(
				folders.map((folder) => any(...folder.subtreeTagIds.map(tagSelector))),
				{ kind: "count" },
			);
			return new Map(folders.map((folder, i) => [folder.fullPath, counts[i]]));
		}, [tags, virtualTags, aliases, split, tagCounts]).ok() ?? NO_FOLDER_COUNTS;
	return useMemo(
		() =>
			buildTagTree(
				tags,
				sortMode,
				{ tags: tagCounts, folders: folderCounts },
				virtualTags,
				aliases,
				split,
				{
					mode: folderColorMode,
					color: rgbToHex(folderColorRgb),
				},
			),
		[
			tags,
			sortMode,
			tagCounts,
			folderCounts,
			virtualTags,
			aliases,
			split,
			folderColorMode,
			folderColorRgb,
		],
	);
}

/** Tag ids to toggle for a shift-click range over the tree's visible rows. Unions the
 *  subtree ids of every row in the [anchor, target] span, de-duped, but excludes the
 *  anchor's own subtree — those were selected by the anchor click, and (when the anchor
 *  is an expanded parent) its child rows sit inside the span, so toggling them would undo it. */
export function rangeToggleTagIds(
	rows: TagTreeNode[],
	anchorIdx: number,
	targetIdx: number,
): number[] {
	const lo = Math.min(anchorIdx, targetIdx);
	const hi = Math.max(anchorIdx, targetIdx);
	const exclude = new Set(rows[anchorIdx].subtreeTagIds);
	const ids = new Set<number>();
	for (let i = lo; i <= hi; i++) {
		for (const id of rows[i].subtreeTagIds) {
			if (!exclude.has(id)) ids.add(id);
		}
	}
	return [...ids];
}

/** Tags a context menu on `node` acts on: every selected tag when the row reads as selected,
 *  otherwise just the node's subtree. A selected folder always brings its subtree. */
export function menuTargetTagIds(node: TagTreeNode, selectedTagIds: ReadonlySet<number>): number[] {
	if (!isEffectivelySelected(node, selectedTagIds)) return [...new Set(node.subtreeTagIds)];
	return [...new Set([...selectedTagIds, ...node.subtreeTagIds])];
}

export interface TagNameChange {
	id: number;
	name: string;
}

/** An alias leaf displays its path's last segment, fixed at creation from the tag's leaf
 *  name. When a tag's leaf name changes, rewrite the last segment of every alias key
 *  pointing at it so the alias keeps showing the tag's name. Returns null when no alias
 *  changed. Collisions merge last-write-wins, same as cascadeRename. */
export function syncAliasSegments(
	aliases: Record<string, number>,
	renames: { id: number; oldName: string; newName: string }[],
): Record<string, number> | null {
	const byId = new Map(
		renames.filter((r) => leafSegment(r.oldName) !== leafSegment(r.newName)).map((r) => [r.id, r]),
	);
	if (byId.size === 0) return null;
	let changed = false;
	const next: Record<string, number> = {};
	for (const [path, id] of Object.entries(aliases)) {
		const r = byId.get(id);
		if (r) {
			const parts = path.split("/");
			parts[parts.length - 1] = leafSegment(r.newName);
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
	const rewrite = (s: string) => (moved ? rebasePath(s, oldPrefix, newPrefix) : null);

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
const findByPath = (tree: TagTreeNode[], path: string): TagTreeNode | null =>
	findPathNode(tree, path);

/** Whether the sibling block `dragPaths` may land among the children of `targetPath`: the
 *  target is the top level or a folder (branch or declared empty folder) outside the block
 *  and its subtrees. A name already taken in the target is allowed -- the rename that
 *  follows merges the two tags, as typing the same path in the rename dialog does. */
function canLandIn(tree: TagTreeNode[], dragPaths: string[], targetPath: string): boolean {
	if (targetPath !== "") {
		const target = findByPath(tree, targetPath);
		if (!target || isLeafTag(target) || target.isAlias) return false;
	}
	const nodes = dragPaths.map((p) => findByPath(tree, p));
	if (nodes.length === 0 || nodes.some((n) => !n || n.isAlias)) return false;
	return !dragPaths.some((p) => isAtOrUnder(targetPath, p));
}

/** Whether the sibling block `dragPaths` may drop INTO folder `targetPath`: it may land
 *  there, and the target isn't the block's current parent (no-op). */
export const canDropInto = (tree: TagTreeNode[], dragPaths: string[], targetPath: string) =>
	canLandIn(tree, dragPaths, targetPath) &&
	findByPath(tree, dragPaths[0])!.parentPath !== targetPath;

/** Into a folder, or beside a node under `parent`. */
export type DropTarget =
	| { path: string; position: "into" }
	| { path: string; position: "before" | "after"; parent: string };

/** Where a drag of the block grabbed at `src` lands when the pointer is over `node`, `at`
 *  of the way along it. The middle half of a folder row drops into it, and its edges, like
 *  either half of a pill, place the block beside it, moving it to that level when it comes
 *  from another. Null when `node` is no target. */
export function hoverDrop(
	tree: TagTreeNode[],
	block: ReadonlySet<string>,
	src: TagTreeNode,
	node: TagTreeNode,
	at: number,
	reorder: boolean,
): DropTarget | null {
	if (node.isAlias || block.has(node.fullPath)) return null;
	const paths = [...block];
	const into = !isLeafTag(node) && canDropInto(tree, paths, node.fullPath);
	if (into && at > 0.25 && at < 0.75) return { path: node.fullPath, position: "into" };
	const sameKind = isLeafTag(src) === isLeafTag(node);
	if (sameKind || !isLeafTag(node)) {
		const parent = node.parentPath;
		const position = at < 0.5 ? "before" : "after";
		if (parent === src.parentPath) {
			if (reorder && sameKind) return { path: node.fullPath, position, parent };
		} else if (canDropInto(tree, paths, parent)) {
			return reorder
				? { path: node.fullPath, position, parent }
				: { path: parent, position: "into" };
		}
	}
	return into ? { path: node.fullPath, position: "into" } : null;
}

/** The full tag order, and the declared empty folders re-placed among it. */
export interface FlatOrder {
	orderedIds: number[];
	virtualTags: Record<string, VirtualTag>;
}

/** A tag, or a folder with no tags, in display order. */
type FlatItem = { tagId: number } | { folder: string };

/** One DFS step: a node's own tag, or the node itself when its subtree holds no tags. */
function flatItem(
	n: TagTreeNode,
	path = n.fullPath,
	empty = n.subtreeTagIds.length === 0,
): FlatItem | null {
	if (n.tag && !n.isAlias) return { tagId: n.tag.id }; // alias leaves don't own the id
	return empty ? { folder: path } : null;
}

/** The tag ids in order, and every declared empty folder among them placed on the same scale:
 *  a reorder gives the tag at position k order k, so folders just before it sit between k-1 and k. */
function flatten(items: FlatItem[], virtualTags: Record<string, VirtualTag>): FlatOrder {
	const orderedIds: number[] = [];
	const next = { ...virtualTags };
	let pending: string[] = [];
	const place = () => {
		const k = orderedIds.length;
		pending.forEach((path, j) => {
			next[path] = { ...next[path], order: k - 1 + (j + 1) / (pending.length + 1) };
		});
		pending = [];
	};
	for (const item of items) {
		if ("tagId" in item) {
			place();
			orderedIds.push(item.tagId);
		} else if (item.folder in virtualTags) {
			pending.push(item.folder);
		}
	}
	place();
	return { orderedIds, virtualTags: next };
}

export interface TagMoveResult extends FlatOrder {
	tagRenames: TagNameChange[];
	aliases: Record<string, number>;
	/** Old -> new path for each moved branch, for remapExpanded. */
	pathRemaps: [string, string][];
}

/** Move the sibling block `dragPaths` to `drop`: into a folder (`""` is the top level), or
 *  beside a node, on the block's own level or another. cascadeRename each block member to
 *  `<target>/<segment>` (tags, virtualTags, and alias keys all follow), and rebase the
 *  global order so the block lands contiguously beside the anchor, or at the end of the
 *  target's children, keeping its relative order. Returns null when the drop isn't allowed. */
export function moveBlock(
	tree: TagTreeNode[],
	dragPaths: string[],
	drop: DropTarget,
	tags: Tag[],
	virtualTags: Record<string, VirtualTag>,
	aliases: Record<string, number>,
): TagMoveResult | null {
	const anchor = drop.position === "into" ? null : drop;
	const targetPath = anchor ? anchor.parent : drop.path;
	const allowed = anchor
		? canLandIn(tree, dragPaths, targetPath) &&
			!dragPaths.includes(anchor.path) &&
			findByPath(tree, anchor.path)?.parentPath === targetPath
		: canDropInto(tree, dragPaths, targetPath);
	if (!allowed) return null;
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
		if (node.children.length > 0 && newPath !== node.fullPath)
			pathRemaps.push([node.fullPath, newPath]);
	}

	const dragSet = new Set(dragPaths);
	const movedIds = new Set(nodes.flatMap((b) => b.subtreeTagIds));
	// Whether a node that stays put holds no tags once the block has left it and landed.
	const emptyAfterMove = (n: TagTreeNode) =>
		n.subtreeTagIds.every((id) => movedIds.has(id)) &&
		!(movedIds.size > 0 && isAtOrUnder(targetPath, n.fullPath));
	const items: FlatItem[] = [];
	const push = (item: FlatItem | null) => item && items.push(item);
	// A moved node's folders are keyed by their new path in `workingVT`.
	const emitSubtree = (n: TagTreeNode, oldRoot: string, newRoot: string) => {
		push(flatItem(n, newRoot + n.fullPath.slice(oldRoot.length)));
		for (const c of n.children) emitSubtree(c, oldRoot, newRoot);
	};
	const emitBlock = () => {
		for (const b of nodes) {
			const newPath = targetPath === "" ? b.segment : `${targetPath}/${b.segment}`;
			emitSubtree(b, b.fullPath, newPath);
		}
	};
	const before = anchor?.position === "before" ? anchor.path : null;
	const after = anchor ? (anchor.position === "after" ? anchor.path : null) : targetPath;
	const walk = (level: TagTreeNode[]) => {
		for (const n of level) {
			if (dragSet.has(n.fullPath)) continue;
			if (n.fullPath === before) emitBlock();
			push(flatItem(n, n.fullPath, emptyAfterMove(n)));
			walk(n.children);
			if (n.fullPath === after) emitBlock();
		}
	};
	walk(tree);
	if (after === "") emitBlock();
	const flat = flatten(items, workingVT);

	return {
		tagRenames: [...renameById].map(([id, name]) => ({ id, name })),
		virtualTags: flat.virtualTags,
		aliases: workingAliases,
		orderedIds: flat.orderedIds,
		pathRemaps,
	};
}

function siblingsAt(tree: TagTreeNode[], parent: string): TagTreeNode[] {
	return parent === "" ? tree : (findByPath(tree, parent)?.children ?? tree);
}

/** Whether a row reads as selected: its own tag is, or every tag in its subtree is. A subtree
 *  with no tags (an empty folder) never is. */
export const isEffectivelySelected = (n: TagTreeNode, sel: ReadonlySet<number>): boolean =>
	(n.tag != null && sel.has(n.tag.id)) ||
	(n.subtreeTagIds.length > 0 && n.subtreeTagIds.every((id) => sel.has(id)));

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

/** Where `node` lands moved a single slot among its siblings (-1 up, +1 down), or null at
 *  either end. Keyboard counterpart to a drag reorder. */
export function stepDrop(tree: TagTreeNode[], node: TagTreeNode, delta: -1 | 1): DropTarget | null {
	const siblings = siblingsAt(tree, node.parentPath);
	const from = siblings.findIndex((n) => n.fullPath === node.fullPath);
	const neighbour = from === -1 ? undefined : siblings[from + delta];
	if (!neighbour) return null;
	return {
		path: neighbour.fullPath,
		position: delta < 0 ? "before" : "after",
		parent: node.parentPath,
	};
}
