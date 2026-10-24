import { describe, expect, it } from "vitest";
import { Tree } from "@/lib/util/tree";

interface Node {
	name: string;
	children: Node[];
	note?: string;
}

const n = (name: string, ...children: Node[]): Node => ({ name, children });
const forest = () => [n("a", n("a1"), n("a2", n("a2x"))), n("b")];
const names = (nodes: Node[]) => nodes.map((node) => node.name);

describe("Tree", () => {
	it("walks each node before its children, skipping where told not to descend", () => {
		expect(names(Tree.walk(forest()))).toEqual(["a", "a1", "a2", "a2x", "b"]);
		expect(names(Tree.walk(forest(), (node) => node.name !== "a2"))).toEqual([
			"a",
			"a1",
			"a2",
			"b",
		]);
	});

	it("finds the first match, looking only inside the nodes it is let into", () => {
		expect(Tree.find(forest(), (node) => node.name === "a2x")?.name).toBe("a2x");
		expect(
			Tree.find(
				forest(),
				(node) => node.name === "a2x",
				(node) => node.name !== "a2",
			),
		).toBeNull();
	});

	it("folds each node from its children's results, deepest first", () => {
		const sizes = Tree.fold(forest(), (_, children: number[]) =>
			children.reduce((a, b) => a + b, 1),
		);
		expect(sizes).toEqual([4, 1]);
	});

	it("hands each node what its parent passed down", () => {
		const nodes = forest();
		Tree.inherit(
			nodes,
			(node, path: string) => (node.note = path ? `${path}/${node.name}` : node.name),
			"",
		);
		expect(Tree.walk(nodes).map((node) => node.note)).toEqual([
			"a",
			"a/a1",
			"a/a2",
			"a/a2/a2x",
			"b",
		]);
	});

	it("prunes to the accepted nodes and their ancestors, leaving the original whole", () => {
		const nodes = forest();
		const kept = Tree.prune(nodes, (node) => node.name === "a2x");
		expect(names(Tree.walk(kept))).toEqual(["a", "a2", "a2x"]);
		expect(names(Tree.walk(nodes))).toHaveLength(5);
	});

	it("sorts every sibling list", () => {
		const nodes = [n("b"), n("a", n("z"), n("y"))];
		Tree.sortLevels(nodes, (x, y) => x.name.localeCompare(y.name));
		expect(names(Tree.walk(nodes))).toEqual(["a", "y", "z", "b"]);
	});
});
