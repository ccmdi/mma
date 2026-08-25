import { describe, it, expect } from "vitest";
import { getActiveSelections, getMapState, toggleGhostSelection } from "@/store/useMapStore";

// Store hooks use their value as the useSyncExternalStore snapshot, so consumers
// re-render iff the reference changes. Two invariants keep that correct:
// mutations must reassign published references, and getters must return cached
// references (never construct per call).

describe("store snapshot invariants", () => {
	it("ghostedSelections is reassigned on every change, never mutated in place", async () => {
		const before = getMapState().ghostedSelections;
		await toggleGhostSelection("tag:1");
		const ghosted = getMapState().ghostedSelections;
		expect(ghosted).not.toBe(before);
		expect(ghosted.has("tag:1")).toBe(true);

		await toggleGhostSelection("tag:1");
		const unghosted = getMapState().ghostedSelections;
		expect(unghosted).not.toBe(ghosted);
		expect(unghosted.has("tag:1")).toBe(false);
	});

	it("getActiveSelections returns a stable reference between mutations", async () => {
		expect(getActiveSelections()).toBe(getActiveSelections());
		// The filtered (ghosted non-empty) branch must be cached too.
		await toggleGhostSelection("tag:2");
		expect(getMapState().ghostedSelections.size).toBeGreaterThan(0);
		expect(getActiveSelections()).toBe(getActiveSelections());
		await toggleGhostSelection("tag:2");
	});
});
