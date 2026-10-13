import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import { toggleGhost } from "@/store/selections";
import type { ListedSelection } from "@/bindings.gen";

vi.mock("@/lib/commands", async () => {
	const { selectionsHeld } = await import("./fixtures/mocks");
	return {
		cmd: {
			storeEditSelections: vi.fn(async (rows: unknown[]) => selectionsHeld(rows)),
		},
	};
});

const fakeRow = (key: string): ListedSelection => ({
	selection: { key, color: [0, 0, 0], selector: { type: "Everything" } },
	ghosted: false,
});

beforeEach(() => {
	const s = Store.get() as Record<string, unknown>;
	s.map = { id: "test" };
	s.selectionList = [fakeRow("tag:1"), fakeRow("tag:2")];
});

afterEach(() => {
	const s = Store.get() as Record<string, unknown>;
	s.map = null;
	s.selectionList = [];
});

describe("store snapshot invariants", () => {
	it("selectionList is reassigned on every change, never mutated in place", async () => {
		const before = Store.get().selectionList;
		await SelectionList.update(toggleGhost(0));
		const ghosted = Store.get().selectionList;
		expect(ghosted).not.toBe(before);
		expect(ghosted[0].ghosted).toBe(true);
		expect(before[0].ghosted).toBe(false);

		await SelectionList.update(toggleGhost(0));
		const unghosted = Store.get().selectionList;
		expect(unghosted).not.toBe(ghosted);
		expect(unghosted[0].ghosted).toBe(false);
	});

	it("getActiveSelections returns a stable reference between mutations", async () => {
		expect(SelectionList.active()).toBe(SelectionList.active());
		await SelectionList.update(toggleGhost(1));
		expect(SelectionList.active().map((s) => s.key)).toEqual(["tag:1"]);
		expect(SelectionList.active()).toBe(SelectionList.active());
	});
});
