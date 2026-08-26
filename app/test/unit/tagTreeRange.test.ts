import { describe, it, expect } from "vitest";
import {
	rangeToggleTagIds,
	reorderSiblingsFlatOrder,
	stepSiblingFlatOrder,
	collectDragBlock,
	canDropInto,
	moveIntoFolder,
	buildTagTree,
	cascadeRename,
	syncAliasSegments,
	isLeafTag,
	sumCounts,
	shortestUniqueSuffixes,
	type TagTreeNode,
	type FolderColorOpts,
} from "@/components/editor/tags/tagTreeRange";
import type { Tag, VirtualTag } from "@/bindings.gen";
import { findNode, mkTag, segs } from "./fixtures/tagFixtures";

interface N {
	fullPath: string;
	tag: { id: number } | null;
	children: N[];
	isAlias?: boolean;
}
const leaf = (path: string, id: number): N => ({ fullPath: path, tag: { id }, children: [] });

const rows = [
	{ descendantTagIds: [1] },
	{ descendantTagIds: [2] },
	{ descendantTagIds: [3] },
	{ descendantTagIds: [4] },
];

describe("shortestUniqueSuffixes", () => {
	it("collapses a unique name to its last segment", () => {
		const m = shortestUniqueSuffixes(["europe/france/paris", "usa/texas/austin"]);
		expect(m.get("usa/texas/austin")).toBe("austin");
	});

	it("widens colliding suffixes until unique", () => {
		const m = shortestUniqueSuffixes([
			"europe/france/paris",
			"usa/texas/paris",
			"usa/texas/austin",
		]);
		expect(m.get("europe/france/paris")).toBe("france/paris");
		expect(m.get("usa/texas/paris")).toBe("texas/paris");
		expect(m.get("usa/texas/austin")).toBe("austin");
	});

	it("falls back to the full path when even that collides ancestrally", () => {
		const m = shortestUniqueSuffixes(["a/b/c", "b/c"]);
		expect(m.get("b/c")).toBe("b/c");
		expect(m.get("a/b/c")).toBe("a/b/c");
	});

	it("leaves single-segment names untouched", () => {
		const m = shortestUniqueSuffixes(["red", "blue"]);
		expect(m.get("red")).toBe("red");
	});
});

describe("rangeToggleTagIds", () => {
	it("collects rows between anchor and target, excluding the anchor", () => {
		expect(rangeToggleTagIds(rows, 0, 2)).toEqual([2, 3]);
	});

	it("is direction-agnostic (anchor below target)", () => {
		expect(rangeToggleTagIds(rows, 3, 1)).toEqual([2, 3]);
	});

	it("returns empty when anchor equals target", () => {
		expect(rangeToggleTagIds(rows, 1, 1)).toEqual([]);
	});

	it("unions and de-dupes descendant ids across rows (parent + child overlap)", () => {
		const nested = [
			{ descendantTagIds: [10] },
			{ descendantTagIds: [20, 21, 22] }, // a collapsed parent
			{ descendantTagIds: [21] }, // child also visible elsewhere
		];
		expect(rangeToggleTagIds(nested, 0, 2)).toEqual([20, 21, 22]);
	});

	it("does not re-toggle the anchor's descendants when it's an expanded parent", () => {
		// idx0 parent P selects 1,2,3; its child rows sit inside the range to idx3.
		const rows = [
			{ descendantTagIds: [1, 2, 3] }, // P (anchor)
			{ descendantTagIds: [2] }, // P's child
			{ descendantTagIds: [3] }, // P's child
			{ descendantTagIds: [9] }, // unrelated node below
		];
		expect(rangeToggleTagIds(rows, 0, 3)).toEqual([9]);
	});
});

describe("reorderSiblingsFlatOrder", () => {
	const tree: N[] = [leaf("a", 1), leaf("b", 2), leaf("c", 3)];

	it("moves a root sibling after another", () => {
		expect(reorderSiblingsFlatOrder(tree, ["a"], "c", "after", "")).toEqual([2, 3, 1]);
	});

	it("moves a root sibling before another", () => {
		expect(reorderSiblingsFlatOrder(tree, ["c"], "a", "before", "")).toEqual([3, 1, 2]);
	});

	it("reorders within a parent and preserves other subtrees + relative order", () => {
		const nested: N[] = [
			{
				fullPath: "p",
				tag: null,
				children: [leaf("p/x", 10), leaf("p/y", 11), leaf("p/z", 12)],
			},
			leaf("q", 20),
		];
		// move p/z before p/x -> z,x,y under p; q untouched
		expect(reorderSiblingsFlatOrder(nested, ["p/z"], "p/x", "before", "p")).toEqual([
			12, 10, 11, 20,
		]);
	});

	it("returns null when the target isn't a sibling under the given parent", () => {
		const nested: N[] = [{ fullPath: "p", tag: null, children: [leaf("p/x", 10)] }, leaf("q", 20)];
		expect(reorderSiblingsFlatOrder(nested, ["p/x"], "q", "after", "p")).toBeNull();
	});

	it("returns null when source equals target", () => {
		expect(reorderSiblingsFlatOrder(tree, ["a"], "a", "after", "")).toBeNull();
	});

	it("does not emit an alias leaf's id (the real leaf owns it)", () => {
		const withAlias: N[] = [
			leaf("a", 1),
			{ fullPath: "b", tag: { id: 1 }, children: [], isAlias: true },
			leaf("c", 3),
		];
		// Reordering real siblings must not duplicate/emit the alias's id 1.
		expect(reorderSiblingsFlatOrder(withAlias, ["a"], "c", "after", "")).toEqual([3, 1]);
	});

	it("treats a root leaf whose name contains '/' as a root sibling (no-split flat view)", () => {
		// Flat view: "Europe/France" is one leaf at root, not a child of "Europe".
		const flat: N[] = [leaf("Europe/France", 1), leaf("Red", 2), leaf("Blue", 3)];
		expect(reorderSiblingsFlatOrder(flat, ["Europe/France"], "Blue", "after", "")).toEqual([
			2, 3, 1,
		]);
	});

	it("moves a non-contiguous block after a target, preserving relative order", () => {
		const five: N[] = [leaf("a", 1), leaf("b", 2), leaf("c", 3), leaf("d", 4), leaf("e", 5)];
		expect(reorderSiblingsFlatOrder(five, ["b", "d"], "e", "after", "")).toEqual([1, 3, 5, 2, 4]);
	});

	it("moves a block before the first sibling", () => {
		const five: N[] = [leaf("a", 1), leaf("b", 2), leaf("c", 3), leaf("d", 4), leaf("e", 5)];
		expect(reorderSiblingsFlatOrder(five, ["c", "e"], "a", "before", "")).toEqual([3, 5, 1, 2, 4]);
	});

	it("returns null when the target is part of the block", () => {
		expect(reorderSiblingsFlatOrder(tree, ["a", "c"], "c", "after", "")).toBeNull();
	});

	it("ignores block paths outside the sibling group", () => {
		const nested: N[] = [
			{ fullPath: "p", tag: null, children: [leaf("p/x", 10), leaf("p/y", 11)] },
			leaf("q", 20),
			leaf("r", 30),
		];
		// p/x isn't a root sibling; only q moves.
		expect(reorderSiblingsFlatOrder(nested, ["q", "p/x"], "r", "after", "")).toEqual([
			10, 11, 30, 20,
		]);
	});
});

describe("collectDragBlock", () => {
	it("carries the grabbed pill plus selected sibling pills, in sibling order", () => {
		const tree = buildTagTree(
			[mkTag(1, "a"), mkTag(2, "b"), mkTag(3, "c"), mkTag(4, "d")],
			"default",
			{},
		);
		expect(collectDragBlock(tree, findNode(tree, "d")!, new Set([1, 3]))).toEqual(["a", "c", "d"]);
	});

	it("keeps the block single when nothing else is selected", () => {
		const tree = buildTagTree([mkTag(1, "a"), mkTag(2, "b")], "default", {});
		expect(collectDragBlock(tree, findNode(tree, "a")!, new Set())).toEqual(["a"]);
	});

	it("excludes selected folder rows from a pill block (kind mismatch)", () => {
		const tags = [mkTag(1, "a"), mkTag(2, "F/u"), mkTag(3, "F/v"), mkTag(4, "b")];
		const tree = buildTagTree(tags, "default", {});
		// F is fully selected but is a folder row; the pill block takes only a.
		expect(collectDragBlock(tree, findNode(tree, "b")!, new Set([1, 2, 3]))).toEqual(["a", "b"]);
	});

	it("joins fully-selected sibling folder rows to a row block", () => {
		const tags = [mkTag(1, "F/u"), mkTag(2, "G/v"), mkTag(3, "H/w")];
		const tree = buildTagTree(tags, "default", {});
		expect(collectDragBlock(tree, findNode(tree, "G")!, new Set([1]))).toEqual(["F", "G"]);
	});

	it("joins a branch whose own tag is selected, even with unselected children", () => {
		const tags = [mkTag(1, "F"), mkTag(2, "F/u"), mkTag(3, "G/x")];
		const tree = buildTagTree(tags, "default", {});
		expect(collectDragBlock(tree, findNode(tree, "G")!, new Set([1]))).toEqual(["F", "G"]);
	});

	it("excludes alias leaves and non-siblings", () => {
		const tags = [mkTag(1, "a"), mkTag(2, "b"), mkTag(3, "F/u")];
		// Alias "c" points at tag 2 (selected) but never joins; F/u is not a root sibling.
		const tree = buildTagTree(tags, "default", {}, {}, { c: 2 });
		expect(collectDragBlock(tree, findNode(tree, "a")!, new Set([2, 3]))).toEqual(["a", "b"]);
	});
});

describe("buildTagTree", () => {
	it("floats leaf tags above sub-branches at the root (default sort)", () => {
		// 'Europe' becomes a branch (has France); Red/Blue are plain leaves.
		const tags = [mkTag(1, "Europe/France"), mkTag(2, "Red"), mkTag(3, "Blue")];
		const tree = buildTagTree(tags, "default", {});
		expect(segs(tree)).toEqual(["Red", "Blue", "Europe"]);
		expect(tree[2].tag).toBeNull(); // pure folder node, no bare 'Europe' tag
		expect(segs(tree[2].children)).toEqual(["France"]);
	});

	it("floats leaf tags above sub-branches within a nested folder", () => {
		const tags = [mkTag(1, "A/m"), mkTag(2, "A/Z/q"), mkTag(3, "A/b")];
		const a = buildTagTree(tags, "default", {})[0];
		expect(segs(a.children)).toEqual(["m", "b", "Z"]); // leaves m,b before branch Z
		expect(isLeafTag(a.children[0])).toBe(true);
		expect(isLeafTag(a.children[1])).toBe(true);
		expect(isLeafTag(a.children[2])).toBe(false); // Z is a branch
	});

	it("keeps leaves first under name and amount sort too", () => {
		const tags = [mkTag(1, "Europe/France"), mkTag(2, "Red"), mkTag(3, "Blue")];
		expect(segs(buildTagTree(tags, "name", {}))).toEqual(["Blue", "Red", "Europe"]);
		expect(segs(buildTagTree(tags, "amount", { 1: 5, 2: 10, 3: 1 }))).toEqual([
			"Red",
			"Blue",
			"Europe",
		]);
	});

	it("every childless node carries a tag, so leaf pills are always tag-backed", () => {
		const tags = [mkTag(1, "A/B"), mkTag(2, "A/C/D"), mkTag(3, "E"), mkTag(4, "A")];
		const tree = buildTagTree(tags, "default", {});
		const walk = (nodes: TagTreeNode[]) => {
			for (const n of nodes) {
				if (n.children.length === 0) expect(n.tag).not.toBeNull();
				walk(n.children);
			}
		};
		walk(tree);
	});

	it("sumCounts totals a node's whole subtree", () => {
		const tree = buildTagTree([mkTag(1, "A/B"), mkTag(2, "A/C")], "default", { 1: 3, 2: 4 });
		expect(sumCounts(tree[0], { 1: 3, 2: 4 })).toBe(7);
	});

	it("colors a virtual folder node from virtualTags and propagates to tagless descendants", () => {
		const tree = buildTagTree([mkTag(1, "a/b/x")], "default", {}, { a: { color: "#ff0000" } });
		const a = tree[0];
		expect(a.tag).toBeNull();
		expect(a.inheritedColor).toBe("#ff0000");
		const ab = a.children[0]; // 'a/b' is virtual too — inherits a's color
		expect(ab.tag).toBeNull();
		expect(ab.inheritedColor).toBe("#ff0000");
	});

	it("leaves a virtual folder node gray when unconfigured", () => {
		const tree = buildTagTree([mkTag(1, "a/b")], "default", {});
		expect(tree[0].tag).toBeNull();
		expect(tree[0].inheritedColor).toBe("#888888");
	});

	it("inserts an alias leaf at a second path carrying the real tag", () => {
		const tags = [mkTag(1, "a/b/c")];
		const tree = buildTagTree(tags, "default", {}, {}, { "d/e/c": 1 });
		// 'd' folder created for the alias; its leaf reuses tag id 1 and is marked isAlias.
		const d = tree.find((n) => n.segment === "d")!;
		const e = d.children[0];
		const c = e.children[0];
		expect(c.segment).toBe("c");
		expect(c.tag?.id).toBe(1);
		expect(c.isAlias).toBe(true);
		// The real leaf is not an alias.
		const realC = tree.find((n) => n.segment === "a")!.children[0].children[0];
		expect(realC.isAlias).toBe(false);
	});

	it("drops a dangling alias whose tag no longer exists", () => {
		const tree = buildTagTree([mkTag(1, "a/b")], "default", {}, {}, { "z/b": 999 });
		expect(tree.find((n) => n.segment === "z")).toBeUndefined();
	});

	it("does not clobber an occupied path (no stray folders)", () => {
		const tags = [mkTag(1, "a/b"), mkTag(2, "d")];
		// Aliasing tag 1 onto 'd' (an existing real tag) must be skipped entirely.
		const tree = buildTagTree(tags, "default", {}, {}, { d: 1 });
		const d = tree.find((n) => n.segment === "d")!;
		expect(d.tag?.id).toBe(2); // still the real tag, not the alias
		expect(d.isAlias).toBe(false);
		expect(d.children).toHaveLength(0);
	});

	it("sets structural parentPath on every node", () => {
		const tree = buildTagTree([mkTag(1, "a/b/c"), mkTag(2, "d")], "default", {});
		const a = tree.find((n) => n.segment === "a")!;
		expect(a.parentPath).toBe("");
		expect(a.children[0].parentPath).toBe("a");
		expect(a.children[0].children[0].parentPath).toBe("a/b");
		expect(tree.find((n) => n.segment === "d")!.parentPath).toBe("");
	});

	it("split=false keeps '/' names as single root leaves and ignores aliases", () => {
		const tags = [mkTag(1, "Europe/France"), mkTag(2, "Red")];
		const tree = buildTagTree(tags, "default", {}, {}, { "Fav/France": 1 }, false);
		expect(tree).toHaveLength(2);
		for (const n of tree) {
			expect(n.children).toHaveLength(0);
			expect(n.parentPath).toBe("");
			expect(n.isAlias).toBe(false);
		}
		const france = tree.find((n) => n.tag?.id === 1)!;
		expect(france.segment).toBe("Europe/France");
		expect(france.fullPath).toBe("Europe/France");
		expect(france.descendantTagIds).toEqual([1]);
	});

	it("split=false matches flat default sort (order, then name)", () => {
		const tags = [
			mkTag(1, "b", "#888888", 2),
			mkTag(2, "a", "#888888", 2),
			mkTag(3, "c", "#888888", 1),
		];
		const tree = buildTagTree(tags, "default", {}, {}, {}, false);
		expect(segs(tree)).toEqual(["c", "a", "b"]);
	});
});

describe("folder colors", () => {
	const build = (
		tags: Tag[],
		folderColor: FolderColorOpts,
		virtualTags: Record<string, VirtualTag> = {},
	) => buildTagTree(tags, "default", {}, virtualTags, {}, true, folderColor);

	it("direct mode paints colorless folders with the configured color", () => {
		const tree = build([mkTag(1, "F/x", "#ff0000")], { mode: "direct", color: "#123456" });
		expect(tree[0].inheritedColor).toBe("#123456");
		expect(tree[0].children[0].inheritedColor).toBe("#ff0000");
	});

	it("firstChild mode takes the first displayed child's color", () => {
		// Display order at each level: leaf pills float above branch rows, so the
		// pill's color wins even though the branch's subtree holds the lower order.
		const tags = [
			mkTag(1, "F/Sub/deep", "#0000ff", 1),
			mkTag(2, "F/pill", "#00ff00", 2),
			mkTag(3, "F/pill2", "#ff0000", 3),
		];
		const tree = build(tags, { mode: "firstChild", color: "#888888" });
		expect(tree[0].inheritedColor).toBe("#00ff00");
	});

	it("firstChild mode follows display order under each sort mode", () => {
		const tags = [mkTag(1, "F/b", "#0000ff", 1), mkTag(2, "F/a", "#ff0000", 2)];
		const byOrder = buildTagTree(tags, "default", {}, {}, {}, true, {
			mode: "firstChild",
			color: "#888888",
		});
		expect(byOrder[0].inheritedColor).toBe("#0000ff"); // b first by order
		const byName = buildTagTree(tags, "name", {}, {}, {}, true, {
			mode: "firstChild",
			color: "#888888",
		});
		expect(byName[0].inheritedColor).toBe("#ff0000"); // a first by name
	});

	it("firstChild mode recurses through colorless subfolders", () => {
		const tree = build([mkTag(1, "F/Sub/x", "#ff0000")], { mode: "firstChild", color: "#888888" });
		expect(tree[0].inheritedColor).toBe("#ff0000");
		expect(tree[0].children[0].inheritedColor).toBe("#ff0000");
	});

	it("firstChild mode: an own virtual color still wins over the first child", () => {
		const tree = build(
			[mkTag(1, "F/x", "#ff0000")],
			{ mode: "firstChild", color: "#888888" },
			{
				F: { color: "#00ff00" },
			},
		);
		expect(tree[0].inheritedColor).toBe("#00ff00");
	});

	it("firstChild mode: declared empty folders fall back to the configured color", () => {
		const tree = build([], { mode: "firstChild", color: "#123456" }, { Empty: {} });
		expect(tree[0].inheritedColor).toBe("#123456");
	});

	it("defaults preserve the original gray fallback", () => {
		const tree = buildTagTree([mkTag(1, "F/x", "#ff0000")], "default", {});
		expect(tree[0].inheritedColor).toBe("#888888");
	});
});

describe("cascadeRename", () => {
	it("renames the folder tag and all descendants, leaving unrelated tags", () => {
		const tags = [
			mkTag(1, "Europe"),
			mkTag(2, "Europe/France"),
			mkTag(3, "Europe/France/Paris"),
			mkTag(4, "Asia"),
		];
		const { tagRenames } = cascadeRename("Europe", "EU", tags, {});
		const byId = Object.fromEntries(tagRenames.map((r) => [r.id, r.name]));
		expect(byId).toEqual({ 1: "EU", 2: "EU/France", 3: "EU/France/Paris" });
	});

	it("rewrites a nested prefix without touching siblings", () => {
		const tags = [
			mkTag(1, "Europe/France"),
			mkTag(2, "Europe/France/Paris"),
			mkTag(3, "Europe/Spain"),
		];
		const { tagRenames } = cascadeRename("Europe/France", "Europe/Iberia", tags, {});
		const byId = Object.fromEntries(tagRenames.map((r) => [r.id, r.name]));
		expect(byId).toEqual({ 1: "Europe/Iberia", 2: "Europe/Iberia/Paris" });
	});

	it("moves virtualTags color keys under the renamed prefix", () => {
		const vt = {
			Europe: { color: "#111" },
			"Europe/France": { color: "#222" },
			Asia: { color: "#333" },
		};
		const { virtualTags } = cascadeRename("Europe", "EU", [], vt);
		expect(virtualTags).toEqual({
			EU: { color: "#111" },
			"EU/France": { color: "#222" },
			Asia: { color: "#333" },
		});
	});

	it("merges on collision (renamed name matches an existing tag)", () => {
		const tags = [mkTag(1, "A/x"), mkTag(2, "B/x")];
		const { tagRenames } = cascadeRename("A", "B", tags, {});
		expect(tagRenames).toEqual([{ id: 1, name: "B/x" }]);
	});

	it("no-ops when the prefix is unchanged", () => {
		const tags = [mkTag(1, "A/b")];
		const { tagRenames, virtualTags } = cascadeRename("A", "A", tags, { A: { color: "#1" } });
		expect(tagRenames).toEqual([]);
		expect(virtualTags).toEqual({ A: { color: "#1" } });
	});

	it("moves alias keys sitting under the renamed prefix", () => {
		const aliases = { "Europe/x": 5, "Europe/France/y": 6, "Asia/z": 7 };
		const { aliases: next } = cascadeRename("Europe", "EU", [], {}, aliases);
		expect(next).toEqual({ "EU/x": 5, "EU/France/y": 6, "Asia/z": 7 });
	});

	it("syncs the leaf segment of aliases pointing at the renamed root tag", () => {
		const tags = [mkTag(1, "a"), mkTag(2, "a/b")];
		const aliases = { "Fav/a": 1, "Fav/b": 2 };
		const { aliases: next } = cascadeRename("a", "x", tags, {}, aliases);
		// Root tag a -> x renames the alias segment; descendant a/b -> x/b keeps leaf "b".
		expect(next).toEqual({ "Fav/x": 1, "Fav/b": 2 });
	});

	it("renames descendants of a tagless folder and moves its color key", () => {
		const tags = [mkTag(1, "a/b"), mkTag(2, "a/c")];
		const { tagRenames, virtualTags } = cascadeRename("a", "x", tags, { a: { color: "#aaa" } });
		expect(tagRenames).toEqual([
			{ id: 1, name: "x/b" },
			{ id: 2, name: "x/c" },
		]);
		expect(virtualTags).toEqual({ x: { color: "#aaa" } });
	});
});

describe("syncAliasSegments", () => {
	it("rewrites the alias leaf segment when the tag's leaf name changes", () => {
		const aliases = { "d/e/c": 1, "Fav/c": 1, "Asia/z": 7 };
		const next = syncAliasSegments(aliases, [{ id: 1, oldName: "a/b/c", newName: "a/b/q" }]);
		expect(next).toEqual({ "d/e/q": 1, "Fav/q": 1, "Asia/z": 7 });
	});

	it("returns null when only the folder part of the name changed", () => {
		const aliases = { "Fav/c": 1 };
		expect(syncAliasSegments(aliases, [{ id: 1, oldName: "a/c", newName: "b/c" }])).toBeNull();
	});

	it("returns null when no alias points at a renamed tag", () => {
		const aliases = { "Fav/c": 1 };
		expect(syncAliasSegments(aliases, [{ id: 2, oldName: "x", newName: "y" }])).toBeNull();
	});
});

describe("canDropInto / moveIntoFolder", () => {
	// Root pills Red(1), Blue(2); folder Cars { a(3), b(4), Old { c(5) } }.
	const baseTags = [
		mkTag(1, "Red"),
		mkTag(2, "Blue"),
		mkTag(3, "Cars/a"),
		mkTag(4, "Cars/b"),
		mkTag(5, "Cars/Old/c"),
	];
	const tree = (tags = baseTags, aliases = {}) => buildTagTree(tags, "default", {}, {}, aliases);

	it("allows a pill into a folder, rejects its own parent and block members", () => {
		expect(canDropInto(tree(), ["Red"], "Cars")).toBe(true);
		expect(canDropInto(tree(), ["Cars/a"], "Cars")).toBe(false); // no-op: already there
		expect(canDropInto(tree(), ["Cars"], "Cars")).toBe(false); // itself
		expect(canDropInto(tree(), ["Cars"], "Cars/Old")).toBe(false); // own descendant
	});

	it("rejects a segment collision with the target's children", () => {
		const tags = [...baseTags, mkTag(6, "Cars/Red")];
		expect(canDropInto(tree(tags), ["Red"], "Cars")).toBe(false);
	});

	it("rejects pills as targets", () => {
		expect(canDropInto(tree(), ["Red"], "Blue")).toBe(false);
	});

	it("the top level is a target for anything inside a folder, never for what is already there", () => {
		expect(canDropInto(tree(), ["Cars/a"], "")).toBe(true);
		expect(canDropInto(tree(), ["Cars/Old"], "")).toBe(true);
		expect(canDropInto(tree(), ["Red"], "")).toBe(false); // no-op: already top level
		expect(canDropInto(tree(), ["Cars"], "")).toBe(false);
		// A top-level segment collision is refused like any other.
		const tags = [...baseTags, mkTag(6, "Cars/Red")];
		expect(canDropInto(tree(tags), ["Cars/Red"], "")).toBe(false);
	});

	it("moves a folder's tag to the top level: bare name, ordered after the last root node", () => {
		const move = moveIntoFolder(tree(), ["Cars/a"], "", baseTags, {}, {});
		expect(move!.tagRenames).toEqual([{ id: 3, name: "a" }]);
		expect(move!.orderedIds).toEqual([1, 2, 4, 5, 3]);
	});

	it("moves a nested folder to the top level: cascades and remaps its path", () => {
		const move = moveIntoFolder(tree(), ["Cars/Old"], "", baseTags, {}, {});
		expect(move!.tagRenames).toEqual([{ id: 5, name: "Old/c" }]);
		expect(move!.pathRemaps).toEqual([["Cars/Old", "Old"]]);
		expect(move!.orderedIds).toEqual([1, 2, 3, 4, 5]);
	});

	it("moves a pill into a folder: rename + order appended at the end of the folder", () => {
		const move = moveIntoFolder(tree(), ["Red"], "Cars", baseTags, {}, {});
		expect(move).not.toBeNull();
		expect(move!.tagRenames).toEqual([{ id: 1, name: "Cars/Red" }]);
		expect(move!.orderedIds).toEqual([2, 3, 4, 5, 1]);
		expect(move!.pathRemaps).toEqual([]);
	});

	it("moves a block of pills keeping relative order", () => {
		const move = moveIntoFolder(tree(), ["Red", "Blue"], "Cars", baseTags, {}, {});
		expect(move!.tagRenames).toEqual([
			{ id: 1, name: "Cars/Red" },
			{ id: 2, name: "Cars/Blue" },
		]);
		expect(move!.orderedIds).toEqual([3, 4, 5, 1, 2]);
	});

	it("moves a folder: cascades descendants, remaps the path, rewrites settings keys", () => {
		const tags = [...baseTags, mkTag(6, "Misc/x")];
		const aliases = { "Misc/redAlias": 1 };
		const move = moveIntoFolder(
			tree(tags, aliases),
			["Misc"],
			"Cars",
			tags,
			{ Misc: { color: "#aaa" } },
			aliases,
		);
		expect(move!.tagRenames).toEqual([{ id: 6, name: "Cars/Misc/x" }]);
		expect(move!.pathRemaps).toEqual([["Misc", "Cars/Misc"]]);
		expect(move!.virtualTags).toEqual({ "Cars/Misc": { color: "#aaa" } });
		expect(move!.aliases).toEqual({ "Cars/Misc/redAlias": 1 });
		// Alias leaf never contributes its id: Red's id appears exactly once.
		expect(move!.orderedIds.filter((id) => id === 1)).toEqual([1]);
		expect(move!.orderedIds).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("returns null on an invalid drop", () => {
		expect(moveIntoFolder(tree(), ["Cars"], "Cars/Old", baseTags, {}, {})).toBeNull();
	});
});

describe("declared empty folders (virtualTags)", () => {
	it("seeds a tagless folder node from a virtualTags key no tag passes through", () => {
		const tree = buildTagTree([mkTag(1, "a")], "default", {}, { F: {} });
		const f = findNode(tree, "F")!;
		expect(f.tag).toBeNull();
		expect(f.children).toEqual([]);
		expect(isLeafTag(f)).toBe(false); // renders as a folder row, not a pill
	});

	it("seeds the whole chain for a nested key", () => {
		const tree = buildTagTree([], "default", {}, { "F/Sub": {} });
		expect(segs(tree)).toEqual(["F"]);
		expect(segs(tree[0].children)).toEqual(["Sub"]);
		expect(tree[0].tag).toBeNull();
	});

	it("does not duplicate nodes when the key path already exists via tags", () => {
		const tree = buildTagTree([mkTag(1, "F/x")], "default", {}, { F: {} });
		expect(tree).toHaveLength(1);
		expect(segs(tree[0].children)).toEqual(["x"]);
	});

	it("sorts empty folders after tag-derived branches in default mode", () => {
		const tree = buildTagTree([mkTag(1, "G/x")], "default", {}, { A: {} });
		expect(segs(tree)).toEqual(["G", "A"]); // A is alphabetically first but empty
		expect(findNode(tree, "A")!.sortOrder).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("keeps empty folders out of the leaf pill float (they group with branches)", () => {
		const tree = buildTagTree([mkTag(1, "a"), mkTag(2, "G/x")], "default", {}, { E: {} });
		expect(segs(tree)).toEqual(["a", "G", "E"]); // pill first, then branches, empty last
	});

	it("does not seed folders in flat view", () => {
		const tree = buildTagTree([mkTag(1, "a")], "default", {}, { F: {} }, {}, false);
		expect(segs(tree)).toEqual(["a"]);
	});

	it("ctrl+drag block never sweeps empty sibling folders ([].every footgun)", () => {
		const tags = [mkTag(1, "F/u"), mkTag(2, "G/v")];
		const tree = buildTagTree(tags, "default", {}, { E: {} });
		const g = findNode(tree, "G")!;
		expect(collectDragBlock(tree, g, new Set([1]))).toEqual(["F", "G"]);
	});

	it("canDropInto allows an empty folder as target but not a leaf tag", () => {
		const tree = buildTagTree([mkTag(1, "x"), mkTag(2, "y")], "default", {}, { E: {} });
		expect(canDropInto(tree, ["x"], "E")).toBe(true);
		expect(canDropInto(tree, ["x"], "y")).toBe(false);
	});

	it("moveIntoFolder into an empty folder renames the tag under it", () => {
		const tags = [mkTag(1, "x")];
		const tree = buildTagTree(tags, "default", {}, { E: {} });
		const move = moveIntoFolder(tree, ["x"], "E", tags, { E: {} }, {});
		expect(move!.tagRenames).toEqual([{ id: 1, name: "E/x" }]);
		expect(move!.virtualTags).toEqual({ E: {} });
	});

	it("moveIntoFolder moves an empty folder as a pure virtualTags rewrite", () => {
		const tags = [mkTag(1, "F/u")];
		const tree = buildTagTree(tags, "default", {}, { E: {} });
		const move = moveIntoFolder(tree, ["E"], "F", tags, { E: {} }, {});
		expect(move!.tagRenames).toEqual([]);
		expect(move!.virtualTags).toEqual({ "F/E": {} });
		expect(move!.orderedIds).toEqual([1]);
	});
});

describe("stepSiblingFlatOrder", () => {
	const tree: N[] = [leaf("a", 1), leaf("b", 2), leaf("c", 3)];

	it("moves a node up one slot", () => {
		expect(stepSiblingFlatOrder(tree, "c", "", -1)).toEqual([1, 3, 2]);
	});

	it("moves a node down one slot", () => {
		expect(stepSiblingFlatOrder(tree, "a", "", 1)).toEqual([2, 1, 3]);
	});

	it("stops at either end", () => {
		expect(stepSiblingFlatOrder(tree, "a", "", -1)).toBeNull();
		expect(stepSiblingFlatOrder(tree, "c", "", 1)).toBeNull();
	});

	it("steps within a parent and leaves other subtrees alone", () => {
		const nested: N[] = [
			{
				fullPath: "p",
				tag: null,
				children: [leaf("p/x", 10), leaf("p/y", 11), leaf("p/z", 12)],
			},
			leaf("q", 20),
		];
		expect(stepSiblingFlatOrder(nested, "p/z", "p", -1)).toEqual([10, 12, 11, 20]);
	});

	it("returns null for a path that isn't under the given parent", () => {
		expect(stepSiblingFlatOrder(tree, "nope", "", 1)).toBeNull();
	});
});
