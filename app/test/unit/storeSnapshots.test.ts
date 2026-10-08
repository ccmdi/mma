import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { applySelectionUpdate, getActiveSelections, getMapState } from "@/store/useMapStore";
import { toggleGhost } from "@/store/selections";
import type { ListedSelection } from "@/bindings.gen";

vi.mock("@/lib/commands", async () => {
	const { selectionsHeld } = await import("./fixtures/mocks");
	return { cmd: { storeEditSelections: vi.fn(async (rows: unknown[]) => selectionsHeld(rows)) } };
});

const fakeRow = (key: string): ListedSelection => ({
	selection: { key, color: [0, 0, 0], selector: { type: "Everything" } },
	ghosted: false,
});

beforeEach(() => {
	const s = getMapState() as Record<string, unknown>;
	s.map = { id: "test" };
	s.selectionList = [fakeRow("tag:1"), fakeRow("tag:2")];
});

afterEach(() => {
	const s = getMapState() as Record<string, unknown>;
	s.map = null;
	s.selectionList = [];
});

describe("store snapshot invariants", () => {
	it("selectionList is reassigned on every change, never mutated in place", async () => {
		const before = getMapState().selectionList;
		await applySelectionUpdate(toggleGhost(0));
		const ghosted = getMapState().selectionList;
		expect(ghosted).not.toBe(before);
		expect(ghosted[0].ghosted).toBe(true);
		expect(before[0].ghosted).toBe(false);

		await applySelectionUpdate(toggleGhost(0));
		const unghosted = getMapState().selectionList;
		expect(unghosted).not.toBe(ghosted);
		expect(unghosted[0].ghosted).toBe(false);
	});

	it("getActiveSelections returns a stable reference between mutations", async () => {
		expect(getActiveSelections()).toBe(getActiveSelections());
		await applySelectionUpdate(toggleGhost(1));
		expect(getActiveSelections().map((s) => s.key)).toEqual(["tag:1"]);
		expect(getActiveSelections()).toBe(getActiveSelections());
	});
});
