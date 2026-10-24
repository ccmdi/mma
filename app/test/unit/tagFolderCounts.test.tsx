// @vitest-environment jsdom
import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Tag } from "@/types";
import {
	useTagTree,
	type TagTreeNode,
	type TagTreeSource,
} from "@/components/editor/tags/tagTreeModel";
import { mount } from "./fixtures/harness";

const locationTags = vi.hoisted(() => [[1, 2], [1], [2], [3]]);

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		onmessage: (e: unknown) => void = () => {};
	},
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/commands", async () => {
	const { cmdProxy } = await import("./fixtures/mocks");
	return cmdProxy({
		storeRead: async (_target: unknown, selector: unknown) => {
			const asked = new Set(
				[...JSON.stringify(selector).matchAll(/"value":(\d+)/g)].map((m) => Number(m[1])),
			);
			const count = locationTags.filter((held) => held.some((id) => asked.has(id))).length;
			return { kind: "count", count };
		},
	});
});

const tags = [
	{ id: 1, name: "F/a", color: "#ff0000", visible: true },
	{ id: 2, name: "F/b", color: "#00ff00", visible: true },
	{ id: 3, name: "c", color: "#0000ff", visible: true },
] as Tag[];
const source: TagTreeSource = {
	tags,
	split: true,
	sortMode: "default",
	virtualTags: {},
	aliases: {},
};

let tree: TagTreeNode[] = [];
function Probe() {
	// eslint-disable-next-line react-hooks/globals -- renderHook-style probe
	tree = useTagTree(source);
	return null;
}

describe("useTagTree", () => {
	it("counts a location holding several of a folder's tags once", async () => {
		mount(createElement(Probe), { attach: false });
		await act(async () => {});
		const folder = tree.find((n) => n.segment === "F")!;
		expect(folder.count).toBe(3);
	});
});
