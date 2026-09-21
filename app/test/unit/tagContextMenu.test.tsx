// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ContextMenu } from "@base-ui-components/react/context-menu";

const h = vi.hoisted(() => ({
	deleteTags: vi.fn(async (_ids: number[]) => {}),
	countIn: vi.fn(async (_s: unknown) => 0),
	selectedTagIds: new Set<number>(),
}));

vi.mock("@/store/useMapStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/store/useMapStore")>()),
	deleteTags: h.deleteTags,
	countIn: h.countIn,
	getActiveSelections: () => [],
	useMapState: (sel: () => unknown) => sel(),
}));

vi.mock("@/store/selectionActions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/store/selectionActions")>()),
	getSelectedTagIds: () => h.selectedTagIds,
}));

import { TagContextMenu } from "@/components/editor/tags/TagContextMenu";
import { buildTagTree, type TagTreeNode } from "@/components/editor/tags/tagTreeModel";
import { any, tagSelector } from "@/store/selections";
import { mountAsync } from "./fixtures/harness";
import { findNode, mkTag } from "./fixtures/tagFixtures";

beforeEach(() => {
	h.deleteTags.mockClear();
	h.countIn.mockReset();
	h.countIn.mockResolvedValue(0);
	h.selectedTagIds = new Set();
});

const tree = buildTagTree(
	[mkTag(1, "F"), mkTag(2, "F/a"), mkTag(3, "F/b"), mkTag(4, "c"), mkTag(5, "d"), mkTag(6, "e")],
	"default",
	{},
);
const node = (path: string) => findNode(tree, path)!;

async function openMenu(n: TagTreeNode) {
	await mountAsync(
		<ContextMenu.Root open>
			<ContextMenu.Trigger>Area</ContextMenu.Trigger>
			<TagContextMenu node={n} onRename={() => {}} onAddAlias={() => {}} />
		</ContextMenu.Root>,
	);
	await act(async () => {});
	return [...document.querySelectorAll<HTMLElement>(".context-menu__item")];
}

const countFor = (tagIds: number[], n: number) =>
	h.countIn.mockImplementation(async (s) =>
		JSON.stringify(s) === JSON.stringify(any(...tagIds.map(tagSelector))) ? n : 0,
	);

describe("tag context menu", () => {
	it("removes a folder tag from all together with every tag under it", async () => {
		countFor([1, 2, 3], 7);
		const [removeAll] = await openMenu(node("F"));
		expect(removeAll.textContent).toBe("Remove from all (7 locations)");

		act(() => removeAll.click());
		expect(h.deleteTags).toHaveBeenCalledWith([1, 2, 3]);
	});

	it("offers removing a folder tag on its own, leaving the tags under it", async () => {
		h.countIn.mockImplementation(async (s) =>
			JSON.stringify(s) === JSON.stringify(tagSelector(1)) ? 2 : 0,
		);
		const items = await openMenu(node("F"));
		const only = items.find((i) => i.textContent === "Remove this tag only (2 locations)")!;

		act(() => only.click());
		expect(h.deleteTags).toHaveBeenCalledWith([1]);
	});

	it("does not offer removing a leaf on its own", async () => {
		const items = await openMenu(node("c"));
		expect(items.some((i) => i.textContent?.startsWith("Remove this tag only"))).toBe(false);
	});

	it("acts on every selected tag when the clicked tag is one of them", async () => {
		h.selectedTagIds = new Set([4, 5, 6]);
		countFor([4, 5, 6], 9);
		const items = await openMenu(node("c"));
		expect(items.map((i) => i.textContent)).toEqual([
			"Remove 3 tags from all (9 locations)",
			"Remove 3 tags from selection (0 locations)",
		]);

		act(() => items[0].click());
		expect(h.deleteTags).toHaveBeenCalledWith([4, 5, 6]);
	});

	it("ignores the tag selection when the clicked tag is outside it", async () => {
		h.selectedTagIds = new Set([5, 6]);
		const items = await openMenu(node("c"));
		expect(items.map((i) => i.textContent)).toContain("Add alias...");

		act(() => items[0].click());
		expect(h.deleteTags).toHaveBeenCalledWith([4]);
	});
});
