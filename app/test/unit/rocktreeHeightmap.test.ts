/**
 * Marker-draping invariants: the uv+altitude transform, common-space ->
 * lng/lat conversion (against deck's own mercator math), the top-down
 * max-height rasterizer, and the height extension's uniform mapping.
 */
import { describe, it, expect } from "vitest";
import { WebMercatorViewport } from "@deck.gl/core";
import { commonToLngLat, uvAltMatrix, type CoverageRect } from "@/lib/render/rocktree/coverage";
import { HEIGHT_NONE, rasterizeHeights } from "@/lib/render/rocktree/heightmap";
import { meshHeightsModule } from "@/lib/map/meshHeightExtension";

const apply3 = (m: Float64Array, x: number, y: number, z: number) => [
	m[0] * x + m[4] * y + m[8] * z + m[12],
	m[1] * x + m[5] * y + m[9] * z + m[13],
	m[2] * x + m[6] * y + m[10] * z + m[14],
];

describe("uvAltMatrix", () => {
	// commonFromMesh: 0.01 common units per local unit, translated to (100, 342)
	const model = new Float64Array([0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0.01, 0, 100, 342, 3, 1]);
	// ENU: 2 m per local unit in z
	const enu = new Float64Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
	const rect: CoverageRect = [100, 342, 2, 2];

	it("maps local points to (rect u, rect v, altitude meters)", () => {
		const m = uvAltMatrix(rect, model, enu, 150);
		// local (100, 0, 10): common x = 101 -> u = 0.5; common y = 342 -> v = 0
		const [u, v, alt] = apply3(m, 100, 0, 10);
		expect(u).toBeCloseTo(0.5, 12);
		expect(v).toBeCloseTo(0, 12);
		expect(alt).toBeCloseTo(150 + 2 * 10, 12);
	});

	it("v grows southward (decreasing common y)", () => {
		const m = uvAltMatrix(rect, model, enu);
		const [, vSouth] = apply3(m, 0, -100, 0); // common y 341
		expect(vSouth).toBeCloseTo(0.5, 12);
	});
});

describe("commonToLngLat", () => {
	it("inverts deck's projectPosition", () => {
		const vp = new WebMercatorViewport({ width: 100, height: 100, longitude: 0, latitude: 0 });
		for (const [lng, lat] of [
			[-96.8, 32.77],
			[139.7, 35.68],
			[0, 0],
			[-179.9, -45],
		]) {
			const [x, y] = vp.projectPosition([lng, lat, 0]);
			const [rlng, rlat] = commonToLngLat(x, y);
			expect(rlng).toBeCloseTo(lng, 9);
			expect(rlat).toBeCloseTo(lat, 9);
		}
	});
});

describe("rasterizeHeights", () => {
	const SIZE = 8;
	// uvAlt = identity-ish: local x -> u, local y -> v, local z -> alt
	const direct = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	const at = (x: number, y: number) =>
		Math.round(y * SIZE - 0.5) * SIZE + Math.round(x * SIZE - 0.5);

	it("fills covered texels with interpolated altitude, leaves the rest empty", () => {
		// flat triangle at alt 50 covering the lower-left half of the rect
		const positions = new Float32Array([0, 0, 50, 1, 0, 50, 0, 1, 50]);
		const out = rasterizeHeights(
			[{ uvAlt: direct, positions, indices: new Uint16Array([0, 1, 2]) }],
			SIZE,
		);
		expect(out[at(0.2, 0.2)]).toBeCloseTo(50, 5);
		expect(out[at(0.9, 0.9)]).toBe(HEIGHT_NONE);
	});

	it("keeps the max altitude when triangles overlap", () => {
		const quad = (z: number) =>
			new Float32Array([0, 0, z, 1, 0, z, 1, 1, z, 0, 0, z, 1, 1, z, 0, 1, z]);
		const indices = new Uint16Array([0, 1, 2, 3, 4, 5]);
		const out = rasterizeHeights(
			[
				{ uvAlt: direct, positions: quad(10), indices },
				{ uvAlt: direct, positions: quad(120), indices },
			],
			SIZE,
		);
		expect(out[at(0.5, 0.5)]).toBeCloseTo(120, 5);
	});

	it("interpolates sloped surfaces barycentrically", () => {
		// alt rises 0 -> 80 across u
		const positions = new Float32Array([0, 0, 0, 1, 0, 80, 1, 1, 80, 0, 0, 0, 1, 1, 80, 0, 1, 0]);
		const out = rasterizeHeights(
			[{ uvAlt: direct, positions, indices: new Uint16Array([0, 1, 2, 3, 4, 5]) }],
			SIZE,
		);
		const u = (Math.round(0.5 * SIZE - 0.5) + 0.5) / SIZE;
		expect(out[at(0.5, 0.5)]).toBeCloseTo(80 * u, 5);
	});

	it("ignores degenerate triangles and geometry outside the rect", () => {
		const positions = new Float32Array([5, 5, 9, 6, 5, 9, 5, 6, 9, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
		const out = rasterizeHeights(
			[{ uvAlt: direct, positions, indices: new Uint16Array([0, 1, 2, 3, 4, 5]) }],
			SIZE,
		);
		expect(out.every((v) => v === HEIGHT_NONE)).toBe(true);
	});
});

describe("meshHeightsModule uniforms", () => {
	it("maps bounds and enables only when heights exist", () => {
		const texture = { fake: true } as never;
		const on = meshHeightsModule.getUniforms!({
			heights: { texture, bounds: [-97, 33, 10, 12] },
		}) as Record<string, unknown>;
		expect(on.enabled).toBe(1);
		expect(on.west).toBe(-97);
		expect(on.north).toBe(33);
		expect(on.invSpanX).toBe(10);
		expect(on.invSpanY).toBe(12);
		expect(on.meshHeights_tex).toBe(texture);

		const off = meshHeightsModule.getUniforms!({
			heights: null,
			emptyTexture: texture,
		}) as Record<string, unknown>;
		expect(off.enabled).toBe(0);
		expect(off.meshHeights_tex).toBe(texture);
	});
});
