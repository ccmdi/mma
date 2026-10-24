import { describe, it, expect } from "vitest";
import {
	isAtOrUnder,
	leafSegment,
	normalizePath,
	rebasePath,
	shortestUniqueSuffixes,
	type PathTreeNode,
	PathTree,
} from "@/lib/util/paths";

describe("tag paths", () => {
	it("normalizes slashes and whitespace", () => {
		expect(normalizePath("  /Europe//DACH/ ")).toBe("Europe/DACH");
		expect(normalizePath("///")).toBe("");
	});

	it("names the last segment", () => {
		expect(leafSegment("Europe/France/Paris")).toBe("Paris");
		expect(leafSegment("Red")).toBe("Red");
	});

	it("matches a path at or under a prefix, never a sibling sharing its text", () => {
		expect(isAtOrUnder("A", "A")).toBe(true);
		expect(isAtOrUnder("A/B/C", "A")).toBe(true);
		expect(isAtOrUnder("AB", "A")).toBe(false);
		expect(isAtOrUnder("A", "A/B")).toBe(false);
	});

	it("rebases a path under a new prefix, or returns null outside the old one", () => {
		expect(rebasePath("A", "A", "Z")).toBe("Z");
		expect(rebasePath("A/B/C", "A", "Z/Y")).toBe("Z/Y/B/C");
		expect(rebasePath("AB", "A", "Z")).toBeNull();
	});

	it("walks and finds nodes in a generic path tree", () => {
		type Node = PathTreeNode<Node>;
		const root: Node[] = [];
		const make = (segment: string, fullPath: string, parentPath: string): Node => ({
			segment,
			fullPath,
			parentPath,
			children: [],
		});
		const leaf = PathTree.ensure(root, ["Europe", "DACH", "Bavaria"], make);
		expect(leaf.fullPath).toBe("Europe/DACH/Bavaria");
		expect(leaf.parentPath).toBe("Europe/DACH");
		expect(PathTree.at(root, "Europe/DACH")?.segment).toBe("DACH");
		expect(PathTree.at(root, "Europe/France")).toBeNull();
	});
});

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
