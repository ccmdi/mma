import { describe, it, expect } from "vitest";
import { CommitDiff } from "@/store/commitDiff";
import type { Location } from "@/bindings.gen";

const loc = (id: number, lat: number, lng: number) => ({ id, lat, lng }) as Location;

describe("CommitDiff.positions", () => {
	it("interleaves [lng, lat] pairs as f32", () => {
		const buf = CommitDiff.positions([loc(1, 10, 20), loc(2, 30, 40)]);
		expect(buf).toBeInstanceOf(Float32Array);
		expect(Array.from(buf)).toEqual([20, 10, 40, 30]);
	});

	it("returns an empty buffer for no locations", () => {
		expect(CommitDiff.positions([]).length).toBe(0);
	});
});
