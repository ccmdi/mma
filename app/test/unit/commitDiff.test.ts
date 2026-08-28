import { describe, it, expect } from "vitest";
import { categorizeCommitDelta, diffPositions } from "@/store/commitDiff";
import type { Location } from "@/bindings.gen";

const loc = (id: number, lat: number, lng: number) => ({ id, lat, lng }) as Location;

describe("categorizeCommitDelta", () => {
	it("classifies pure adds, pure removes, and modifications by id", () => {
		const delta = {
			created: [loc(1, 0, 0), loc(2, 1, 1)], // 1 = modified (also in removed), 2 = added
			removed: [loc(1, 9, 9), loc(3, 2, 2)], // 1 = modified (old), 3 = removed
		};
		const { added, removed, modified } = categorizeCommitDelta(delta);
		expect(added.map((l) => l.id)).toEqual([2]);
		expect(removed.map((l) => l.id)).toEqual([3]);
		expect(modified.map((l) => l.id)).toEqual([1]);
	});

	it("modified uses the new (created) version of the location", () => {
		const delta = {
			created: [loc(1, 5, 6)],
			removed: [loc(1, 0, 0)],
		};
		const { modified } = categorizeCommitDelta(delta);
		expect(modified[0]).toEqual(loc(1, 5, 6));
	});

	it("handles empty deltas", () => {
		const { added, removed, modified } = categorizeCommitDelta({ created: [], removed: [] });
		expect(added).toEqual([]);
		expect(removed).toEqual([]);
		expect(modified).toEqual([]);
	});
});

describe("diffPositions", () => {
	it("interleaves [lng, lat] pairs as f32", () => {
		const buf = diffPositions([loc(1, 10, 20), loc(2, 30, 40)]);
		expect(buf).toBeInstanceOf(Float32Array);
		expect(Array.from(buf)).toEqual([20, 10, 40, 30]);
	});

	it("returns an empty buffer for no locations", () => {
		expect(diffPositions([]).length).toBe(0);
	});
});
