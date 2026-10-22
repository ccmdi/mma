import { describe, it, expect, afterEach } from "vitest";
import { Measure } from "@/lib/map/measure";
import { distMeters } from "@/lib/geo/geo";

const A = { lat: 40, lng: -74 };
const B = { lat: 40.01, lng: -74 };
const C = { lat: 40.01, lng: -73.99 };

afterEach(() => Measure.end());

describe("measure tool", () => {
	it("starts anchored at the clicked point with no length", () => {
		Measure.start(A);
		expect(Measure.points()).toEqual([[A.lng, A.lat]]);
		expect(Measure.length()).toBe(0);
	});

	it("sums every placed segment", () => {
		Measure.start(A);
		Measure.add(B);
		expect(Measure.length()).toBeCloseTo(distMeters(A, B), 6);
		Measure.add(C);
		expect(Measure.length()).toBeCloseTo(distMeters(A, B) + distMeters(B, C), 6);
	});

	it("remeasures when a node is dragged", () => {
		Measure.start(A);
		Measure.add(B);
		Measure.move(1, C);
		expect(Measure.points()[1]).toEqual([C.lng, C.lat]);
		expect(Measure.length()).toBeCloseTo(distMeters(A, C), 6);
	});

	it("ignores a drag of a node that does not exist", () => {
		Measure.start(A);
		Measure.move(4, C);
		expect(Measure.points()).toEqual([[A.lng, A.lat]]);
	});

	it("takes no points once ended", () => {
		Measure.start(A);
		Measure.end();
		Measure.add(B);
		expect(Measure.points()).toEqual([]);
		expect(Measure.length()).toBe(0);
	});
});
