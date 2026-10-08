import { describe, it, expect } from "vitest";
import { diffPositions } from "@/store/commitDiff";
import type { Location } from "@/bindings.gen";

const loc = (id: number, lat: number, lng: number) => ({ id, lat, lng }) as Location;

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
