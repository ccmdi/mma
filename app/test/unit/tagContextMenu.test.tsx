import { selectionFixture } from "./fixtures/selection";
// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ContextMenu } from "@base-ui-components/react/context-menu";

const h = vi.hoisted(() => ({
	deleteTags: vi.fn(async (_ids: number[]) => {}),
	countIn: vi.fn(async (_s: unknown) => 0),
	openDialog: vi.fn(),
	selectedTagIds: new Set<number>(),
	active: [] as import("@/bindings.gen").Selection[],
	work: vi.fn(async () => {}),
}));

vi.mock("@/store/useMapStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/store/useMapStore")>()),
	deleteTags: h.deleteTags,
	query: (s: unknown) => ({ count: () => h.countIn(s) }),
	getActiveSelections: () => h.active,
	useMapState: (sel: () => unknown) => sel(),
}));

vi.mock("@/store/edit", () => ({ work: h.work }));

vi.mock("@/store/dialogBus", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/store/dialogBus")>()),
	openDialog: h.openDialog,
}));

vi.mock("@/store/selectionActions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/store/selectionActions")>()),
	getSelectedTagIds: () => h.selectedTagIds,
}));

import { TagContextMenu } from "@/components/editor/tags/TagContextMenu";
import { buildTagTree, type TagTreeNode } from "@/components/editor/tags/tagTreeModel";
import { all, any, tagSelector } from "@/store/selections";
import { mountAsync } from "./fixtures/harness";
import { findNode, mkTag } from "./fixtures/tagFixtures";

beforeEach(() => {
	h.deleteTags.mockClear();
	h.openDialog.mockClear();
	h.countIn.mockReset();
	h.countIn.mockResolvedValue(0);
	h.selectedTagIds = new Set();
	h.active = [];
	h.work.mockClear();
});

const tree = buildTagTree(
	[
		mkTag(1, "F"),
		mkTag(2, "F/a"),
		mkTag(3, "F/b"),
		mkTag(4, "c"),
		mkTag(5, "d"),
		mkTag(6, "e"),
		mkTag(7, "V/x"),
		mkTag(8, "V/y"),
	],
	"default",
	{},
);
const node = (path: string) => findNode(tree, path)!;

async function openMenu(n: TagTreeNode) {
	await mountAsync(
		<ContextMenu.Root open>
			<ContextMenu.Trigger>Area</ContextMenu.Trigger>
			<TagContextMenu node={n} onAddAlias={n.tag ? () => {} : undefined} />
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
			"Remove only this tag from selection (0 locations)",
			"Rename 3 tags in all (9 locations)",
			"Rename 3 tags in selection (0 locations)",
			"Recolor 3 tags...",
		]);

		act(() => items[0].click());
		expect(h.deleteTags).toHaveBeenCalledWith([4, 5, 6]);
	});

	it("recolors every selected tag together", async () => {
		h.selectedTagIds = new Set([4, 5, 6]);
		const items = await openMenu(node("c"));
		act(() => items.find((i) => i.textContent === "Recolor 3 tags...")!.click());
		expect(h.openDialog).toHaveBeenCalledWith("recolor-tags", { tagIds: [4, 5, 6], root: null });
	});

	it("recolors and renames a folder as a whole", async () => {
		const items = await openMenu(node("F"));
		act(() => items.find((i) => i.textContent === "Recolor 3 tags...")!.click());
		expect(h.openDialog).toHaveBeenCalledWith("recolor-tags", { tagIds: [1, 2, 3], root: "F" });
		act(() => items.find((i) => i.textContent === "Rename folder...")!.click());
		expect(h.openDialog).toHaveBeenCalledWith("rename-folder", "F");
	});

	it("gives a folder with no tag of its own the subtree actions only", async () => {
		const labels = (await openMenu(node("V"))).map((i) => i.textContent);
		expect(labels).toEqual([
			"Remove from all (0 locations)",
			"Remove from selection (0 locations)",
			"Rename in selection (0 locations)",
			"Recolor 2 tags...",
			"Rename folder...",
		]);
	});

	it("renames every selected tag within the rest of the selection, merging them", async () => {
		const manual = selectionFixture({ type: "Manual", locations: [1, 2] });
		h.selectedTagIds = new Set([4, 5, 6]);
		h.active = [...[4, 5, 6].map((id) => selectionFixture(tagSelector(id))), manual];
		h.countIn.mockResolvedValue(2);
		const items = await openMenu(node("c"));
		act(() => items.find((i) => i.textContent?.startsWith("Rename 3 tags in selection"))!.click());
		expect(h.openDialog).toHaveBeenCalledWith("rename-tags", {
			tagIds: [4, 5, 6],
			name: "c",
			scope: { type: "Union", selections: [manual] },
		});
	});

	it("renames every selected tag on all their locations when nothing else is selected", async () => {
		h.selectedTagIds = new Set([4, 5, 6]);
		h.active = [4, 5, 6].map((id) => selectionFixture(tagSelector(id)));
		countFor([4, 5, 6], 9);
		const items = await openMenu(node("c"));
		const renameAll = items.find((i) => i.textContent === "Rename 3 tags in all (9 locations)")!;
		expect(renameAll.getAttribute("aria-disabled")).not.toBe("true");
		act(() => renameAll.click());
		expect(h.openDialog).toHaveBeenCalledWith("rename-tags", {
			tagIds: [4, 5, 6],
			name: "c",
			scope: null,
		});
	});

	it("ignores the tag selection when the clicked tag is outside it", async () => {
		h.selectedTagIds = new Set([5, 6]);
		const items = await openMenu(node("c"));
		expect(items.map((i) => i.textContent)).toContain("Add alias...");

		act(() => items[0].click());
		expect(h.deleteTags).toHaveBeenCalledWith([4]);
	});

	it("never counts the targets' own selections as the selection", async () => {
		h.selectedTagIds = new Set([4, 5, 6]);
		h.active = [4, 5, 6].map((id) => selectionFixture(tagSelector(id)));
		h.countIn.mockResolvedValue(5);
		const items = await openMenu(node("c"));
		const fromSelection = items.find((i) => i.textContent?.includes("from selection"))!;
		expect(fromSelection.textContent).toBe("Remove 3 tags from selection (0 locations)");
		expect(fromSelection.hasAttribute("data-disabled")).toBe(true);
	});

	it("removes only the clicked tag from the rest of the selection", async () => {
		h.selectedTagIds = new Set([4, 5, 6]);
		h.active = [4, 5, 6].map((id) => selectionFixture(tagSelector(id)));
		const scope = {
			type: "Union",
			selections: [5, 6].map((id) => selectionFixture(tagSelector(id))),
		};
		h.countIn.mockImplementation(async (s) =>
			JSON.stringify(s) === JSON.stringify(all(any(tagSelector(4)), scope as never)) ? 3 : 0,
		);
		const items = await openMenu(node("c"));
		const onlyThis = items.find(
			(i) => i.textContent === "Remove only this tag from selection (3 locations)",
		)!;
		act(() => onlyThis.click());
		expect(h.work).toHaveBeenCalledWith(scope, {
			kind: "listSet",
			key: "tags",
			add: [],
			remove: [4],
		});
	});

	it("removes the targets from the rest of the selection only", async () => {
		const polygon = selectionFixture({ type: "Manual", locations: [1, 2] });
		h.selectedTagIds = new Set([4, 5, 6]);
		h.active = [...[4, 5, 6].map((id) => selectionFixture(tagSelector(id))), polygon];
		const carriers = any(...[4, 5, 6].map(tagSelector));
		const scope = { type: "Union", selections: [polygon] };
		h.countIn.mockImplementation(async (s) =>
			JSON.stringify(s) === JSON.stringify(all(carriers, scope as never)) ? 2 : 0,
		);
		const items = await openMenu(node("c"));
		const fromSelection = items.find(
			(i) => i.textContent === "Remove 3 tags from selection (2 locations)",
		)!;
		act(() => fromSelection.click());
		expect(h.work).toHaveBeenCalledWith(scope, {
			kind: "listSet",
			key: "tags",
			add: [],
			remove: [4, 5, 6],
		});
	});
});
