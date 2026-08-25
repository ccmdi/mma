import { describe, it, expect } from "vitest";
import {
	densifyRing,
	normalizeHeading,
	reverseHeading,
	wrapDeg,
	inBbox,
	lerpLng,
	lngSpan,
	pointInPolygon,
	ringsBbox,
	unionBounds,
	unwrapLng,
	unwrapRing,
} from "@/lib/geo/geo";
import {
	getBoundingBox,
	pointInGeoJsonGeometry,
	poissonDiskSample,
} from "@/plugins/generator/engine/geo";

/** What the rectangle tool builds, before it is closed and densified. */
const corners = (a: number, b: number) => [
	[a, 10],
	[b, 10],
	[b, -10],
	[a, -10],
];
const box = (a: number, b: number) => densifyRing([...corners(a, b), [a, 10]]);

describe("unwrapRing", () => {
	it("returns the ring unchanged (same reference) when it doesn't cross", () => {
		const ring = [
			[10, 0],
			[20, 0],
			[20, 10],
		];
		expect(unwrapRing(ring)).toBe(ring);
	});

	it("continues past the seam instead of jumping a turn back", () => {
		const ring = [
			[170, 0],
			[-170, 0],
			[-175, 10],
		];
		expect(unwrapRing(ring)).toEqual([
			[170, 0],
			[190, 0],
			[185, 10],
		]);
	});

	it("leaves an already-unwrapped ring alone", () => {
		const ring = [
			[200, 0],
			[210, 0],
			[205, 10],
		];
		expect(unwrapRing(ring)).toBe(ring);
	});

	it("folds a ring whose vertices are outside [-180, 180]", () => {
		const ring = [
			[200, 0],
			[-10, 0],
		];
		expect(unwrapRing(ring)).toEqual([
			[200, 0],
			[350, 0],
		]);
	});
});

describe("unwrapLng", () => {
	it("continues a stroke across the seam", () => {
		expect(unwrapLng(-179.5, 179.9)).toBeCloseTo(180.5);
		expect(unwrapLng(179.9, 180.5)).toBeCloseTo(179.9);
	});

	it("accumulates across a drag, so span survives past 180 degrees", () => {
		let lng = 20;
		for (const raw of [-40, -100, -160, 140, -170]) lng = unwrapLng(raw, lng);
		expect(lng).toBeCloseTo(-170);
	});
});

describe("densifyRing", () => {
	it("leaves a ring with only short edges alone", () => {
		const ring = corners(20, 100);
		expect(densifyRing(ring)).toBe(ring);
	});

	it("splits edges of 180 degrees or more so unwrapRing can't fold them", () => {
		const wide = box(20, -170);
		expect(unwrapRing(wide)).toBe(wide);
		const lngs = wide.map((p) => p[0]);
		expect(Math.min(...lngs)).toBe(-170);
		expect(Math.max(...lngs)).toBe(20);
	});
});

describe("wrapDeg", () => {
	it("shifts into [min, min + 360)", () => {
		expect(wrapDeg(-175, 170)).toBeCloseTo(185);
		expect(wrapDeg(160, 170)).toBeCloseTo(520);
		expect(wrapDeg(5, 5)).toBeCloseTo(5);
	});

	it("folds any number of whole turns, not just one", () => {
		expect(wrapDeg(700, -180)).toBeCloseTo(-20);
		expect(wrapDeg(-700, -180)).toBeCloseTo(20);
		expect(wrapDeg(3610, 0)).toBeCloseTo(10);
	});

	it("puts the window start at both ends, so min + 360 folds back to min", () => {
		expect(wrapDeg(-180, -180)).toBe(-180);
		expect(wrapDeg(180, -180)).toBe(-180);
		expect(wrapDeg(360, 0)).toBe(0);
	});
});

describe("normalizeHeading", () => {
	it("passes through values inside [-180, 180)", () => {
		expect(normalizeHeading(0)).toBe(0);
		expect(normalizeHeading(90)).toBe(90);
		expect(normalizeHeading(-90)).toBe(-90);
		expect(normalizeHeading(-180)).toBe(-180);
	});

	it("wraps outside it, over any number of turns", () => {
		expect(normalizeHeading(270)).toBe(-90);
		expect(normalizeHeading(360)).toBe(0);
		expect(normalizeHeading(-270)).toBe(90);
		expect(normalizeHeading(-360)).toBe(0);
		expect(normalizeHeading(700)).toBeCloseTo(-20);
	});

	// The window is half-open, so the antipode has one spelling rather than two.
	it("spells 180 as -180", () => {
		expect(normalizeHeading(180)).toBe(-180);
	});
});

describe("reverseHeading", () => {
	it("is the opposite bearing", () => {
		expect(reverseHeading(0)).toBe(-180);
		expect(reverseHeading(90)).toBe(-90);
		expect(reverseHeading(-90)).toBe(90);
		expect(reverseHeading(350)).toBe(170);
	});

	it("is its own inverse", () => {
		for (const h of [0, 37, 90, 179, -179, -90, 270, 359]) {
			expect(reverseHeading(reverseHeading(h))).toBeCloseTo(normalizeHeading(h));
		}
	});
});

describe("ringsBbox / inBbox", () => {
	it("emits the crossing form and reads it back", () => {
		const bb = ringsBbox([box(170, 190)])!;
		expect([bb.west, bb.east]).toEqual([170, -170]); // west > east = crosses
		expect(inBbox(-175, 0, bb)).toBe(true);
		expect(inBbox(180, 0, bb)).toBe(true);
		expect(inBbox(160, 0, bb)).toBe(false);
		expect(inBbox(0, 0, bb)).toBe(false);
	});

	it("reads a plain box the ordinary way", () => {
		const bb = ringsBbox([box(10, 20)])!;
		expect([bb.west, bb.east]).toEqual([10, 20]);
		expect(inBbox(15, 0, bb)).toBe(true);
		expect(inBbox(25, 0, bb)).toBe(false);
		expect(inBbox(5, 0, bb)).toBe(false);
	});

	it("holds a span wider than 180 degrees", () => {
		const bb = ringsBbox([box(20, -170)])!;
		expect(inBbox(0, 0, bb)).toBe(true);
		expect(inBbox(-100, 0, bb)).toBe(true);
		expect(inBbox(100, 0, bb)).toBe(false);
		expect(inBbox(-175, 0, bb)).toBe(false);
	});

	// Read in their own frames the two parts would span the globe and reject nothing.
	it("merges straddling parts into one frame", () => {
		const bb = ringsBbox([box(170, 190), box(-175, -172)])!;
		expect([bb.west, bb.east]).toEqual([170, -170]);
		expect(inBbox(-174, 0, bb)).toBe(true);
		expect(inBbox(0, 0, bb)).toBe(false);
	});

	it("is null with no vertices", () => {
		expect(ringsBbox([])).toBe(null);
		expect(ringsBbox([[]])).toBe(null);
	});

	// Antarctica-style: a ring running the full -180..180. Folding both edges would
	// collapse the box to zero width and reject everything.
	it("holds a full-globe span instead of collapsing to zero width", () => {
		const ring: number[][] = [];
		for (let lng = -180; lng <= 180; lng += 10) ring.push([lng, -85]);
		for (let lng = 180; lng >= -180; lng -= 10) ring.push([lng, -60]);
		const bb = ringsBbox([ring])!;
		expect([bb.west, bb.east]).toEqual([-180, 180]);
		expect(lngSpan(bb)).toBe(360);
		expect(inBbox(0, -70, bb)).toBe(true);
		expect(inBbox(-179, -70, bb)).toBe(true);
		expect(inBbox(100, -70, bb)).toBe(true);
		expect(inBbox(0, -50, bb)).toBe(false); // latitude still rejects
	});
});

describe("lngSpan / lerpLng", () => {
	it("measures the way the box actually spans", () => {
		expect(lngSpan({ west: 10, east: 20, south: 0, north: 1 })).toBe(10);
		expect(lngSpan({ west: 170, east: -170, south: 0, north: 1 })).toBe(20);
		expect(lngSpan({ west: -170, east: 20, south: 0, north: 1 })).toBe(190);
	});

	it("interpolates across the seam and folds back into range", () => {
		const b = { west: 170, east: -170, south: 0, north: 1 };
		expect(lerpLng(b, 0)).toBeCloseTo(170);
		expect(Math.abs(lerpLng(b, 0.5))).toBeCloseTo(180); // range is half-open, so -180
		expect(lerpLng(b, 1)).toBeCloseTo(-170);
		expect(lerpLng(b, 0.75)).toBeCloseTo(-175);
	});
});

describe("unionBounds", () => {
	it("closes the smaller gap rather than the one at the antimeridian", () => {
		const u = unionBounds(
			{ west: 10, east: 20, south: 0, north: 1 },
			{ west: 350, east: 355, south: 0, north: 1 },
		);
		expect(lngSpan(u)).toBe(30); // 350 -> 20, not the 345 the other way
		expect(inBbox(0, 0.5, u)).toBe(true);
		expect(inBbox(180, 0.5, u)).toBe(false);
	});

	it("behaves like plain min/max when neither box crosses", () => {
		const u = unionBounds(
			{ west: 10, east: 20, south: 0, north: 5 },
			{ west: 30, east: 40, south: -5, north: 1 },
		);
		expect([u.west, u.east, u.south, u.north]).toEqual([10, 40, -5, 5]);
	});

	it("absorbs a box already inside the other", () => {
		const outer = { west: 170, east: -170, south: 0, north: 1 };
		const u = unionBounds(outer, { west: 178, east: -178, south: 0, north: 1 });
		expect(lngSpan(u)).toBe(20);
	});
});

describe("pointInPolygon across the seam", () => {
	it("selects inside a narrow box straddling the antimeridian", () => {
		const ring = box(170, 190);
		expect(pointInPolygon(180, 0, [ring])).toBe(true);
		expect(pointInPolygon(-175, 0, [ring])).toBe(true);
		expect(pointInPolygon(175, 0, [ring])).toBe(true);
		expect(pointInPolygon(160, 0, [ring])).toBe(false);
		expect(pointInPolygon(-160, 0, [ring])).toBe(false);
	});

	// The "shortest rectangle" bug: a box wider than half the globe used to resolve to
	// its complement, because a span over 180 degrees can't be read back off normalized
	// vertices.
	it("selects the drawn side of a box wider than 180 degrees", () => {
		const ring = box(20, -170);
		expect(pointInPolygon(0, 0, [ring])).toBe(true);
		expect(pointInPolygon(-100, 0, [ring])).toBe(true);
		expect(pointInPolygon(-169, 0, [ring])).toBe(true);
		expect(pointInPolygon(100, 0, [ring])).toBe(false);
		expect(pointInPolygon(-175, 0, [ring])).toBe(false);
	});

	// The "inverts" bug: normalizing to [0, 360) only moved the seam to lng 0, so a
	// shape crossing both meridians tore at Greenwich instead.
	it("selects across a shape crossing both the antimeridian and Greenwich", () => {
		const ring = box(170, 365);
		expect(pointInPolygon(180, 0, [ring])).toBe(true);
		expect(pointInPolygon(-90, 0, [ring])).toBe(true);
		expect(pointInPolygon(0, 0, [ring])).toBe(true);
		expect(pointInPolygon(3, 0, [ring])).toBe(true);
		expect(pointInPolygon(30, 0, [ring])).toBe(false);
		expect(pointInPolygon(100, 0, [ring])).toBe(false);
	});

	it("selects with the generator's broad phase, which shares the same frame", () => {
		// pointInGeoJsonGeometry bbox-rejects before the exact test, so a raw comparison
		// there would drop seam-crossing points the ring test would have accepted.
		const geometry: GeoJSON.Polygon = { type: "Polygon", coordinates: [box(170, 190)] };
		expect(pointInGeoJsonGeometry(180, 0, geometry)).toBe(true);
		expect(pointInGeoJsonGeometry(-175, 0, geometry)).toBe(true);
		expect(pointInGeoJsonGeometry(175, 0, geometry)).toBe(true);
		expect(pointInGeoJsonGeometry(160, 0, geometry)).toBe(false);
		expect(pointInGeoJsonGeometry(0, 0, geometry)).toBe(false);
	});

	it("samples a seam-crossing region instead of the rest of the world", () => {
		// Raw min/max bounds made this box 340 degrees wide, so sampling landed almost
		// entirely outside it and every emitted longitude had to be in [-180, 180].
		const feature: GeoJSON.Feature<GeoJSON.Polygon> = {
			type: "Feature",
			properties: {},
			geometry: { type: "Polygon", coordinates: [box(170, 190)] },
		};
		expect(lngSpan(getBoundingBox(feature)!)).toBe(20);
		const points = poissonDiskSample(feature, 40_000);
		expect(points.length).toBeGreaterThan(0);
		for (const p of points) {
			expect(p.lng).toBeGreaterThanOrEqual(-180);
			expect(p.lng).toBeLessThanOrEqual(180);
			expect(pointInGeoJsonGeometry(p.lng, p.lat, feature.geometry)).toBe(true);
		}
		expect(points.some((p) => p.lng < 0)).toBe(true); // reached past the seam
	});

	it("honours holes in the seam frame", () => {
		const outer = box(170, 200);
		const hole = box(180, 190);
		expect(pointInPolygon(185, 0, [outer, hole])).toBe(false);
		expect(pointInPolygon(175, 0, [outer, hole])).toBe(true);
		expect(pointInPolygon(-165, 0, [outer, hole])).toBe(true);
	});
});
