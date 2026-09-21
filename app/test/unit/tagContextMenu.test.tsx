// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ContextMenu } from "@base-ui-components/react/context-menu";

const h = vi.hoisted(() => ({
	setTags: vi.fn(async () => {}),
	countIn: vi.fn(async (_s: unknown) => 0),
}));

vi.mock("@/store/useMapStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/store/useMapStore")>()),
	setTags: h.setTags,
	countIn: h.countIn,
	getActiveSelections: () => [],
}));

import { TagContextMenuContent } from "@/components/editor/tags/TagManager";
import { any, tagSelector } from "@/store/selections";
import { mountAsync } from "./fixtures/harness";

beforeEach(() => {
	h.setTags.mockClear();
	h.countIn.mockClear();
});

async function openMenu(tagId: number, subtreeTagIds: number[]) {
	await mountAsync(
		<ContextMenu.Root open>
			<ContextMenu.Trigger>Area</ContextMenu.Trigger>
			<TagContextMenuContent tagId={tagId} subtreeTagIds={subtreeTagIds} onRename={() => {}} />
		</ContextMenu.Root>,
	);
	await act(async () => {});
	return [...document.querySelectorAll<HTMLElement>(".context-menu__item")];
}

describe("tag context menu", () => {
	it("removes a folder tag from all together with every tag under it", async () => {
		const subtree = any(...[1, 2, 3].map(tagSelector));
		h.countIn.mockImplementation(async (s) =>
			JSON.stringify(s) === JSON.stringify(subtree) ? 7 : 0,
		);
		const [removeAll] = await openMenu(1, [1, 2, 3]);
		expect(removeAll.textContent).toBe("Remove from all (7 locations)");

		act(() => removeAll.click());
		expect(h.setTags).toHaveBeenCalledWith([], [1, 2, 3], subtree);
	});

	it("removes a leaf tag on its own", async () => {
		const [removeAll] = await openMenu(4, [4]);
		act(() => removeAll.click());
		expect(h.setTags).toHaveBeenCalledWith([], [4], tagSelector(4));
	});
});
