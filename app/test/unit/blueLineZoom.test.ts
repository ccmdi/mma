import { describe, it, expect } from "vitest";
import {
	calculateZoom,
	keepRate,
	cellKeepRate,
	thinCells,
} from "@/plugins/generator/engine/blueLineSampler";
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

	it("density keeps the global rate; even flattens dense cells; balanced sits between", () => {
		const quota = 600 * (32 / 256) ** 2;
		expect(cellKeepRate(2_000, 0.25, 0)).toBe(0.25);
		expect(cellKeepRate(2_000, 0.25, 1)).toBeCloseTo(quota / 2_000);
		expect(cellKeepRate(5, 0.25, 1)).toBe(1);
		const balanced = cellKeepRate(2_000, 0.25, 0.5);
		expect(balanced).toBeGreaterThan(cellKeepRate(2_000, 0.25, 1));
		expect(balanced).toBeLessThan(0.25);
		expect(cellKeepRate(0, 0.25, 0.5)).toBe(0);
	});

	it("even mode holds inside a tile: a dense corner is capped, a sparse road is untouched", () => {
		const xs: number[] = [];
		const ys: number[] = [];
		for (let i = 0; i < 1000; i++) {
			xs.push(i % 32);
			ys.push((i / 32) | 0);
		}
		for (let i = 0; i < 5; i++) {
			xs.push(64 + i);
			ys.push(0);
		}
		thinCells(xs, ys, 0, 1, 1);
		const dense = xs.filter((x) => x < 32).length;
		const sparse = xs.filter((x) => x >= 64).length;
		expect(sparse).toBe(5);
		expect(dense).toBeLessThan(60);
		expect(dense).toBeGreaterThan(0);
	});

	it("density mode keeps everything when the global rate is 1", () => {
		const xs = Array.from({ length: 500 }, (_, i) => i % 32);
		const ys = Array.from({ length: 500 }, (_, i) => (i / 32) | 0);
		thinCells(xs, ys, 0, 1, 0);
		expect(xs).toHaveLength(500);
	});

	it("a small region already at its finest zoom keeps every pixel", () => {
		const base = calculateZoom(SMALL, 50);
		const fine = calculateZoom(SMALL, 150);
		expect(fine.zoom).toBe(base.zoom);
		expect(keepRate(fine.zoom, base.zoom)).toBe(1);
	});
});
