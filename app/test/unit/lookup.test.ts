// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import {
	parsePanoDate,
	svSearchRadius,
	normalizeHeading,
	calcHeading,
	samePano,
	isUnofficial,
	svThumbnailUrl,
} from "@/lib/sv/lookup.add";

describe("parsePanoDate", () => {
	it("passes through a valid Date", () => {
		const d = new Date("2024-06-15");
		expect(parsePanoDate(d).getTime()).toBe(d.getTime());
	});

	it("parses {year, month} object", () => {
		const d = parsePanoDate({ year: 2024, month: 6 });
		expect(d.getFullYear()).toBe(2024);
		expect(d.getMonth()).toBe(5); // 0-indexed
	});

	it("parses YYYY-MM string", () => {
		const d = parsePanoDate("2024-06");
		expect(d.getFullYear()).toBe(2024);
		expect(d.getMonth()).toBe(5);
	});

	it("returns epoch for null", () => {
		expect(parsePanoDate(null).getTime()).toBe(0);
	});

	it("returns epoch for invalid Date", () => {
		expect(parsePanoDate(new Date("invalid")).getTime()).toBe(0);
	});

	it("handles missing month in {year} object", () => {
		const d = parsePanoDate({ year: 2020 });
		expect(d.getFullYear()).toBe(2020);
		expect(d.getMonth()).toBe(0);
	});
});

describe("svSearchRadius", () => {
	it("returns at least 25", () => {
		expect(svSearchRadius(0, 20)).toBeGreaterThanOrEqual(25);
	});

	it("larger at low zoom", () => {
		const lowZoom = svSearchRadius(0, 5);
		const highZoom = svSearchRadius(0, 15);
		expect(lowZoom).toBeGreaterThan(highZoom);
	});

	it("accounts for latitude (smaller radius at high latitudes)", () => {
		const equator = svSearchRadius(0, 10);
		const polar = svSearchRadius(80, 10);
		expect(equator).toBeGreaterThan(polar);
	});

	it("zoom 0 produces an absurdly large radius (the jump bug)", () => {
		const r = svSearchRadius(0, 0);
		expect(r).toBeGreaterThan(600_000);
	});

	it("zoom 15+ produces a radius suitable for local navigation", () => {
		const r = svSearchRadius(0, 15);
		expect(r).toBeLessThan(200);
	});
});

describe("normalizeHeading", () => {
	it("passes through values in [-180, 180]", () => {
		expect(normalizeHeading(0)).toBe(0);
		expect(normalizeHeading(90)).toBe(90);
		expect(normalizeHeading(-90)).toBe(-90);
		expect(normalizeHeading(180)).toBe(180);
		expect(normalizeHeading(-180)).toBe(-180);
	});

	it("wraps values > 180", () => {
		expect(normalizeHeading(270)).toBe(-90);
		expect(normalizeHeading(360)).toBe(0);
	});

	it("wraps values < -180", () => {
		expect(normalizeHeading(-270)).toBe(90);
		expect(normalizeHeading(-360)).toBe(0);
	});
});

describe("calcHeading", () => {
	function makeData(opts: {
		centerHeading?: number;
		links?: { heading: number }[];
	}): google.maps.StreetViewResolvedPanoramaData {
		return {
			tiles: { centerHeading: opts.centerHeading ?? 0, originHeading: 0 },
			links: opts.links ?? [],
		} as any;
	}

	it("returns 0 when pointAlongRoad is false", () => {
		expect(calcHeading(makeData({ centerHeading: 90, links: [{ heading: 45 }] }))).toBe(0);
		expect(calcHeading(makeData({ centerHeading: 90 }), { pointAlongRoad: false })).toBe(0);
	});

	it("returns first link heading when no preferDirection", () => {
		const data = makeData({ links: [{ heading: 45 }, { heading: 135 }] });
		expect(calcHeading(data, { pointAlongRoad: true })).toBe(45);
	});

	it("returns center heading for forwards", () => {
		const data = makeData({ centerHeading: 90 });
		expect(calcHeading(data, { pointAlongRoad: true, preferDirection: "forwards" })).toBe(90);
	});

	it("returns center - 180 for backwards", () => {
		const data = makeData({ centerHeading: 90 });
		expect(calcHeading(data, { pointAlongRoad: true, preferDirection: "backwards" })).toBe(-90);
	});

	it("picks closest link to cardinal direction", () => {
		const data = makeData({ links: [{ heading: 10 }, { heading: 170 }, { heading: 260 }] });
		expect(calcHeading(data, { pointAlongRoad: true, preferDirection: "south" })).toBe(170);
		expect(calcHeading(data, { pointAlongRoad: true, preferDirection: "west" })).toBe(260);
		expect(calcHeading(data, { pointAlongRoad: true, preferDirection: "north" })).toBe(10);
	});
});

describe("samePano", () => {
	const makeP = (pano: string) => ({ location: { pano } }) as any;

	it("true for same pano ID", () => {
		expect(samePano(makeP("ABC"), makeP("ABC"))).toBe(true);
	});

	it("false for different pano ID", () => {
		expect(samePano(makeP("ABC"), makeP("XYZ"))).toBe(false);
	});

	it("false for null", () => {
		expect(samePano(null, makeP("ABC"))).toBe(false);
		expect(samePano(makeP("ABC"), null)).toBe(false);
		expect(samePano(null, null)).toBe(false);
	});
});

describe("isUnofficial", () => {
	it("long pano ID is unofficial", () => {
		expect(isUnofficial({ location: { pano: "A".repeat(30) } } as any)).toBe(true);
	});

	it("22-char pano ID is official", () => {
		expect(isUnofficial({ location: { pano: "A".repeat(22) } } as any)).toBe(false);
	});

	it("null is not unofficial", () => {
		expect(isUnofficial(null)).toBe(false);
	});

	it("copyright with 'user-uploaded' is unofficial", () => {
		expect(
			isUnofficial({
				location: { pano: "A".repeat(22) },
				copyright: "Photo by John",
			} as any),
		).toBe(true);
	});
});

describe("svThumbnailUrl", () => {
	it("includes pano ID and heading", () => {
		const url = svThumbnailUrl("ABC123", 90);
		expect(url).toContain("panoid=ABC123");
		expect(url).toContain("yaw=90");
	});

	it("uses default dimensions", () => {
		const url = svThumbnailUrl("ABC123", 0);
		expect(url).toContain("w=320");
		expect(url).toContain("h=180");
	});

	it("respects custom dimensions", () => {
		const url = svThumbnailUrl("ABC123", 0, 640, 360);
		expect(url).toContain("w=640");
		expect(url).toContain("h=360");
	});
});
