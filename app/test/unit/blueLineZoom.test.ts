import { describe, it, expect } from "vitest";
import { calculateZoom, keepRate } from "@/plugins/generator/engine/blueLineSampler";
import type { Bounds } from "@/types";

const ARGENTINA: Bounds = { west: -73.6, south: -55.1, east: -53.6, north: -21.8 };
const SMALL: Bounds = { west: -58.44, south: -34.64, east: -58.4, north: -34.6 };

describe("blueline tile plan", () => {
	it("a wider axis cap buys a finer zoom for a large region", () => {
		const base = calculateZoom(ARGENTINA, 50);
		const fine = calculateZoom(ARGENTINA, 150);
		expect(fine.zoom).toBeGreaterThan(base.zoom);
		expect(fine.cols).toBeLessThanOrEqual(150);
		expect(fine.rows).toBeLessThanOrEqual(150);
	});

	it("fine pixels thin back to the base zoom's line density", () => {
		const base = calculateZoom(ARGENTINA, 50);
		const fine = calculateZoom(ARGENTINA, 150);
		expect(keepRate(fine.zoom, base.zoom)).toBeCloseTo(2 ** (base.zoom - fine.zoom));
		expect(keepRate(fine.zoom, base.zoom)).toBeLessThan(1);
	});

	it("a small region already at its finest zoom keeps every pixel", () => {
		const base = calculateZoom(SMALL, 50);
		const fine = calculateZoom(SMALL, 150);
		expect(fine.zoom).toBe(base.zoom);
		expect(keepRate(fine.zoom, base.zoom)).toBe(1);
	});
});
