// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/types")>()),
	Location: {},
}));
vi.mock("@/store/useMapStore", () => ({
	useMapState: (sel: (s: { map: null }) => unknown) => sel({ map: null }),
	fetchBounds: async () => null,
}));
vi.mock("@/lib/commands", () => ({ cmd: {} }));
vi.mock("@/lib/events", () => ({ emit: () => {}, subscribe: () => () => {} }));

import {
	computeScore,
	bboxToMaxError,
	locationsBbox,
	padBbox,
	resolveScoreMaxError,
	resolveScoreMaxErrorFromBounds,
	WORLD_MAX_ERROR,
} from "@/lib/geo/scoring";
import { isWorldBounds } from "@/types";

const WORLD_BOUNDS = { south: -90, west: -180, north: 90, east: 180 };

describe("computeScore", () => {
	it("returns 5000 for distance <= 25", () => {
		expect(computeScore(25)).toBe(5000);
	});

	it("returns 5000 for distance = 0", () => {
		expect(computeScore(0)).toBe(5000);
	});

	it("returns 5000 for exactly 25 meters", () => {
		expect(computeScore(25)).toBe(5000);
	});

	it("returns 0 for extremely large distance", () => {
		const score = computeScore(100_000_000);
		expect(score).toBe(0);
	});

	it("score decreases monotonically as distance increases", () => {
		const distances = [500, 1000, 5000, 10000, 100000, 1000000];
		const scores = distances.map((d) => computeScore(d));
		for (let i = 1; i < scores.length; i++) {
			expect(scores[i]).toBeLessThan(scores[i - 1]);
		}
	});

	it("returns score between 0 and 5000 for distances > 25", () => {
		for (const d of [1000, 10000, 100000, 1000000]) {
			const score = computeScore(d);
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(5000);
		}
	});

	it("custom maxErrorDistance changes the score curve", () => {
		const defaultScore = computeScore(1000);
		const widerScore = computeScore(1000, 500);
		expect(defaultScore).not.toBe(widerScore);
	});

	it("returns near-perfect score for 100m with default max", () => {
		const score = computeScore(100);
		expect(score).toBe(5000);
	});
});

describe("locationsBbox", () => {
	it("computes [minLng, minLat, maxLng, maxLat] (GeoJSON order)", () => {
		const bbox = locationsBbox([
			{ lat: 0, lng: 0 },
			{ lat: 1, lng: 1 },
		]);
		expect(bbox).toEqual([0, 0, 1, 1]);
	});

	it("pads a degenerate (single-point) bbox by 0.01 on each side", () => {
		const bbox = locationsBbox([{ lat: 5, lng: 10 }]);
		expect(bbox[0]).toBeCloseTo(9.99, 5);
		expect(bbox[1]).toBeCloseTo(4.99, 5);
		expect(bbox[2]).toBeCloseTo(10.01, 5);
		expect(bbox[3]).toBeCloseTo(5.01, 5);
	});
});

describe("bboxToMaxError", () => {
	it("computes the score curve's max error for a 1x1 degree box", () => {
		expect(bboxToMaxError([0, 0, 1, 1])).toBeCloseTo(1.5725383681512268, 9);
	});

	it("grows with a larger bounding box", () => {
		expect(bboxToMaxError([0, 0, 2, 2])).toBeGreaterThan(bboxToMaxError([0, 0, 1, 1]));
	});
});

describe("isWorldBounds", () => {
	it("recognises the canonical world rectangle", () => {
		expect(isWorldBounds(WORLD_BOUNDS)).toBe(true);
		expect(isWorldBounds({ south: -90, west: -180, north: 90, east: 180 })).toBe(true);
	});

	it("rejects any other rectangle", () => {
		expect(isWorldBounds({ south: 0, west: 0, north: 1, east: 1 })).toBe(false);
		expect(isWorldBounds({ south: -89, west: -180, north: 90, east: 180 })).toBe(false);
	});
});

describe("resolveScoreMaxError", () => {
	it("returns 25 for auto with 0 or 1 locations", () => {
		expect(resolveScoreMaxError("auto", [])).toBe(25);
		expect(resolveScoreMaxError("auto", [{ lat: 0, lng: 0 }])).toBe(25);
	});

	it("derives auto error from the locations bbox when >1 location", () => {
		const err = resolveScoreMaxError("auto", [
			{ lat: 0, lng: 0 },
			{ lat: 1, lng: 1 },
		]);
		expect(err).toBeCloseTo(1.5725383681512268, 9);
	});

	it("returns the exact ACW constant for world bounds", () => {
		expect(resolveScoreMaxError(WORLD_BOUNDS, [])).toBe(WORLD_MAX_ERROR);
	});

	it("converts fixed bounds to GeoJSON order", () => {
		const err = resolveScoreMaxError({ south: 40, west: -74, north: 41, east: -73 }, []);
		expect(err).toBeCloseTo(1.3969259251946928, 9);
	});
});

describe("padBbox", () => {
	it("pads a degenerate (single-point) bbox by 0.01 on each side", () => {
		const b = padBbox([10, 5, 10, 5]);
		expect(b[0]).toBeCloseTo(9.99, 5);
		expect(b[1]).toBeCloseTo(4.99, 5);
		expect(b[2]).toBeCloseTo(10.01, 5);
		expect(b[3]).toBeCloseTo(5.01, 5);
	});

	it("leaves an already-large bbox unchanged", () => {
		expect(padBbox([0, 0, 1, 1])).toEqual([0, 0, 1, 1]);
	});

	it("is consistent with locationsBbox for a single point", () => {
		expect(padBbox([10, 5, 10, 5])).toEqual(locationsBbox([{ lat: 5, lng: 10 }]));
	});

	it("unwraps an antimeridian-crossing box (west > east) instead of collapsing it", () => {
		// store_bounds returns the 4°-wide crossing box as [178, 0, -178, 0]. The
		// midpoint must stay at 180, not snap to longitude 0 and squash the span.
		const b = padBbox([178, 0, -178, 0]);
		expect(b[0]).toBe(178);
		expect(b[2]).toBe(182); // -178 unwrapped past 180
		// haversine sees a real 4° longitude span, not ~0.
		expect(bboxToMaxError(b)).toBeCloseTo(bboxToMaxError(padBbox([178, 0, 182, 0])), 9);
	});

	it("spreading points across the IDL loosens the score, never tightens it", () => {
		// A wider crossing span must not produce a stricter (smaller) max error.
		const near = resolveScoreMaxErrorFromBounds("auto", [179, 0, -179, 0]); // 2° apart
		const far = resolveScoreMaxErrorFromBounds("auto", [170, 0, -170, 0]); // 20° apart
		expect(far).toBeGreaterThan(near);
	});
});

describe("resolveScoreMaxErrorFromBounds", () => {
	it("returns 25 for auto when the locations bbox is null (empty map)", () => {
		expect(resolveScoreMaxErrorFromBounds("auto", null)).toBe(25);
	});

	it("derives auto error from a precomputed [minLng, minLat, maxLng, maxLat] bbox", () => {
		// Matches resolveScoreMaxError("auto", [{0,0},{1,1}]) since [0,0,1,1] is non-degenerate.
		expect(resolveScoreMaxErrorFromBounds("auto", [0, 0, 1, 1])).toBeCloseTo(1.5725383681512268, 9);
	});

	it("pads a degenerate auto bbox before resolving (single-location map)", () => {
		const fromBounds = resolveScoreMaxErrorFromBounds("auto", [10, 5, 10, 5]);
		const fromLocations = resolveScoreMaxError("auto", [
			{ lat: 5, lng: 10 },
			{ lat: 5, lng: 10 },
		]);
		expect(fromBounds).toBeCloseTo(fromLocations, 9);
	});

	it("returns the ACW constant for world bounds regardless of the auto bbox", () => {
		expect(resolveScoreMaxErrorFromBounds(WORLD_BOUNDS, [0, 0, 1, 1])).toBe(WORLD_MAX_ERROR);
	});

	it("resolves fixed bounds identically to resolveScoreMaxError", () => {
		const fixed = { south: 40, west: -74, north: 41, east: -73 };
		expect(resolveScoreMaxErrorFromBounds(fixed, null)).toBeCloseTo(
			resolveScoreMaxError(fixed, []),
			9,
		);
	});
});
