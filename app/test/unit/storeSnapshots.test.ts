import { describe, it, expect } from "vitest";
import { getSelections, getGhostedSelections, toggleGhostSelection } from "@/store/useMapStore";

// Store hooks use their value as the useSyncExternalStore snapshot, so consumers
// re-render iff the reference changes. Two invariants keep that correct:
// mutations must reassign published references, and getters must return cached
// references (never construct per call).

describe("store snapshot invariants", () => {
	it("ghostedSelections is reassigned on every change, never mutated in place", () => {
		const before = getGhostedSelections();
		toggleGhostSelection("tag:1");
		const ghosted = getGhostedSelections();
		expect(ghosted).not.toBe(before);
		expect(ghosted.has("tag:1")).toBe(true);

		toggleGhostSelection("tag:1");
		const unghosted = getGhostedSelections();
		expect(unghosted).not.toBe(ghosted);
		expect(unghosted.has("tag:1")).toBe(false);
	});

	it("getSelections returns a stable reference between mutations", () => {
		expect(getSelections()).toBe(getSelections());
		// The filtered (ghosted non-empty) branch must be cached too.
		toggleGhostSelection("tag:2");
		expect(getGhostedSelections().size).toBeGreaterThan(0);
		expect(getSelections()).toBe(getSelections());
		toggleGhostSelection("tag:2");
	});
});
