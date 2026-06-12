import { describe, it, expect } from "vitest";
import {
	isVirtualLocation,
	stagedIndexToVirtualId,
	virtualIdToStagedIndex,
} from "@/types";

// Virtual (staged-import) locations are identified by negative ids encoded from
// the preview index. The encoding must round-trip, never collide with real ids
// (>= 1) or the unassigned sentinel (0), and isVirtualLocation must agree.
describe("virtual location id encoding", () => {
	it("round-trips preview indexes", () => {
		for (const idx of [0, 1, 2, 999, 1_000_000]) {
			const id = stagedIndexToVirtualId(idx);
			expect(virtualIdToStagedIndex(id)).toBe(idx);
			expect(isVirtualLocation({ id })).toBe(true);
		}
	});

	it("never collides with real or sentinel ids", () => {
		expect(stagedIndexToVirtualId(0)).toBeLessThan(0);
		expect(isVirtualLocation({ id: 0 })).toBe(false); // unassigned sentinel
		expect(isVirtualLocation({ id: 1 })).toBe(false);
		expect(isVirtualLocation({ id: 4_294_967_295 })).toBe(false); // u32 max
	});
});
