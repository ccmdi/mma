/**
 * M6 SV-coverage decal invariants: tile-grid selection (zoom choice, lattice
 * snap, center containment, the tile-y/common-y flip) and the common-space ->
 * texture-uv matrix the shader drapes with.
 */
import { describe, it, expect } from "vitest";
import { coverageGrid, covUvMatrix, type CoverageRect } from "@/lib/render/rocktree/coverage";

const GRID = 8;

const applyUv = (m: Float64Array, x: number, y: number) => [
	m[0] * x + m[4] * y + m[12],
	m[1] * x + m[5] * y + m[13],
];

describe("coverageGrid", () => {
	it("picks the finest zoom whose block still spans the request", () => {
		const g = coverageGrid([256, 256], 10, GRID);
		const block = (512 / 2 ** g.tileZ) * GRID;
		expect(block).toBeGreaterThanOrEqual(10);
		// one zoom deeper would no longer cover the span
		expect((512 / 2 ** (g.tileZ + 1)) * GRID).toBeLessThan(10);
	});

	it("clamps zoom to [0, maxZ]", () => {
		expect(coverageGrid([256, 256], 1e9, GRID).tileZ).toBe(0);
		expect(coverageGrid([256, 256], 1e-9, GRID).tileZ).toBe(21);
	});

	it("snaps the rect to the tile lattice and contains the center", () => {
		const center: [number, number] = [123.456, 333.21];
		const { tileZ, tx0, ty0, rect } = coverageGrid(center, 5, GRID);
		const tc = 512 / 2 ** tileZ;
		expect(rect[0]).toBeCloseTo(tx0 * tc, 12);
		expect(rect[2]).toBeCloseTo(GRID * tc, 12);
		expect(center[0]).toBeGreaterThanOrEqual(rect[0]);
		expect(center[0]).toBeLessThanOrEqual(rect[0] + rect[2]);
		expect(center[1]).toBeLessThanOrEqual(rect[1]);
		expect(center[1]).toBeGreaterThanOrEqual(rect[1] - rect[3]);
		expect(rect[1]).toBeCloseTo((2 ** tileZ - ty0) * tc, 12);
	});

	it("flips tile y against common y (north row = small tile y = large common y)", () => {
		const north = coverageGrid([256, 400], 5, GRID);
		const south = coverageGrid([256, 100], 5, GRID);
		expect(north.tileZ).toBe(south.tileZ);
		expect(north.ty0).toBeLessThan(south.ty0);
		expect(north.rect[1]).toBeGreaterThan(south.rect[1]);
	});
});

describe("covUvMatrix", () => {
	const rect: CoverageRect = [100, 350, 16, 16];
	const m = covUvMatrix(rect);

	it("maps the rect's northwest corner to uv (0,0) and southeast to (1,1)", () => {
		expect(applyUv(m, 100, 350)).toEqual([0, 0]);
		const [u, v] = applyUv(m, 116, 334);
		expect(u).toBeCloseTo(1, 12);
		expect(v).toBeCloseTo(1, 12);
	});

	it("v grows southward (decreasing common y)", () => {
		const [, vTop] = applyUv(m, 108, 349);
		const [, vBottom] = applyUv(m, 108, 335);
		expect(vBottom).toBeGreaterThan(vTop);
	});
});
