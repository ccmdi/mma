import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { applySelectionUpdate, getActiveSelections, getMapState } from "@/store/useMapStore";
import { toggleGhost } from "@/store/selections";
import type { Selection } from "@/bindings.gen";

vi.mock("@/lib/commands", () => ({
	cmd: { storeSyncSelections: vi.fn(async () => ({ selectionCounts: {}, selectedCount: 0 })) },
}));

const fakeSelection = (key: string): Selection => ({
	key,
	color: [0, 0, 0],
	selector: { type: "Everything" },
});

beforeEach(() => {
	const s = getMapState() as Record<string, unknown>;
	s.map = { id: "test" };
	s.selections = [fakeSelection("tag:1"), fakeSelection("tag:2")];
	s.ghostedSelections = new Set<string>();
});

afterEach(() => {
	const s = getMapState() as Record<string, unknown>;
	s.map = null;
	s.selections = [];
	s.ghostedSelections = new Set<string>();
});

describe("store snapshot invariants", () => {
	it("ghostedSelections is reassigned on every change, never mutated in place", async () => {
		const before = getMapState().ghostedSelections;
		await applySelectionUpdate(toggleGhost("tag:1"));
		const ghosted = getMapState().ghostedSelections;
		expect(ghosted).not.toBe(before);
		expect(ghosted.has("tag:1")).toBe(true);

		await applySelectionUpdate(toggleGhost("tag:1"));
		const unghosted = getMapState().ghostedSelections;
		expect(unghosted).not.toBe(ghosted);
		expect(unghosted.has("tag:1")).toBe(false);
	});

	it("getActiveSelections returns a stable reference between mutations", async () => {
		expect(getActiveSelections()).toBe(getActiveSelections());
		await applySelectionUpdate(toggleGhost("tag:2"));
		expect(getMapState().ghostedSelections.size).toBeGreaterThan(0);
		expect(getActiveSelections()).toBe(getActiveSelections());
		await applySelectionUpdate(toggleGhost("tag:2"));
	});
});
