/**
 * M6 mesh-picking invariants: 4x4 inversion, local pixel rays, triangle
 * intersection with octant-mask skip, the screen-bounds precull, and the
 * end-to-end consistency "raycasting the pixel a point projects to recovers
 * that point" against deck's own viewport math.
 */
import { describe, it, expect } from "vitest";
import { WebMercatorViewport } from "@deck.gl/core";
import {
	invert4,
	localRay,
	ndcHitsNodeBounds,
	raycastMesh,
	type LocalRay,
} from "@/lib/render/rocktree/raycast";
import { composeNodeModel, mul4 } from "@/lib/render/rocktree/layer";

const IDENTITY16 = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe("invert4", () => {
	it("inverts a nontrivial matrix (m * inv = identity)", () => {
		// column-major: scale + translation + a shear
		const m = new Float64Array([2, 0, 0, 0, 0.5, 3, 0, 0, 0, 0, 4, 0, 7, -2, 9, 1]);
		const inv = invert4(m)!;
		const id = mul4(m, inv);
		for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(IDENTITY16[i], 10);
	});

	it("returns null for a singular matrix", () => {
		expect(invert4(new Float64Array(16))).toBeNull();
	});
});

describe("localRay", () => {
	it("with an identity mvp the ray spans the clip z range at the pixel", () => {
		const ray = localRay(IDENTITY16, 0.25, -0.5)!;
		expect(ray.p0).toEqual([0.25, -0.5, -1]);
		expect(ray.dir).toEqual([0, 0, 2]);
	});
});

describe("raycastMesh", () => {
	// two parallel quads (z = -0.5 near the ray origin, z = 0.5 behind it)
	const quad = (z: number) => new Float32Array([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z]);
	const positions = new Float32Array([...quad(-0.5), ...quad(0.5)]);
	const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
	const ray: LocalRay = { p0: [0, 0, -1], dir: [0, 0, 2] };

	it("returns the nearest hit along the ray", () => {
		const octants = new Float32Array(8);
		const t = raycastMesh(ray, positions, indices, octants, 0);
		expect(t).toBeCloseTo(0.25, 12); // z -1 -> -0.5 is a quarter of dir
	});

	it("skips triangles whose octant bit is masked, exposing the surface behind", () => {
		const octants = new Float32Array([3, 3, 3, 3, 0, 0, 0, 0]);
		const t = raycastMesh(ray, positions, indices, octants, 1 << 3);
		expect(t).toBeCloseTo(0.75, 12);
	});

	it("hits regardless of winding", () => {
		const flipped = new Uint16Array([2, 1, 0, 3, 2, 0]);
		const t = raycastMesh(ray, positions.subarray(0, 12), flipped, new Float32Array(4), 0);
		expect(t).toBeCloseTo(0.25, 12);
	});

	it("misses geometry outside the pixel ray", () => {
		const off: LocalRay = { p0: [5, 5, -1], dir: [0, 0, 2] };
		expect(raycastMesh(off, positions, indices, new Float32Array(8), 0)).toBeNull();
	});
});

describe("ndcHitsNodeBounds", () => {
	const MIN: [number, number, number] = [0, 0, 0];
	const MAX: [number, number, number] = [255, 255, 255];
	// maps the local [0,255] box onto ndc [-1,1]
	const box = new Float64Array([
		2 / 255,
		0,
		0,
		0,
		0,
		2 / 255,
		0,
		0,
		0,
		0,
		2 / 255,
		0,
		-1,
		-1,
		-1,
		1,
	]);

	it("accepts pixels inside and rejects pixels outside the projected box", () => {
		expect(ndcHitsNodeBounds(box, 0, 0, MIN, MAX)).toBe(true);
		expect(ndcHitsNodeBounds(box, 0.99, -0.99, MIN, MAX)).toBe(true);
		expect(ndcHitsNodeBounds(box, 1.5, 0, MIN, MAX)).toBe(false);
	});

	it("respects custom bounds (common-anchored coarse nodes)", () => {
		// same matrix, but geometry only occupies the lower-left octant
		expect(ndcHitsNodeBounds(box, 0.5, 0.5, MIN, [127, 127, 127])).toBe(false);
		expect(ndcHitsNodeBounds(box, -0.5, -0.5, MIN, [127, 127, 127])).toBe(true);
	});

	it("is conservative when a corner is behind the eye", () => {
		const behind = new Float64Array(box);
		behind[15] = -1;
		expect(ndcHitsNodeBounds(behind, 100, 100, MIN, MAX)).toBe(true);
	});
});

describe("raycast vs deck projection round-trip", () => {
	const vp = new WebMercatorViewport({
		width: 800,
		height: 600,
		longitude: -96.8,
		latitude: 32.77,
		zoom: 16,
		pitch: 45,
		bearing: 30,
	});
	const origin: [number, number, number] = [-96.801, 32.771, 100];
	// mesh local -> ENU meters: 2 m per unit
	const enuModel = new Float64Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
	// a quad tilted in z so the hit is not at constant altitude
	const positions = new Float32Array([0, 0, 0, 255, 0, 40, 255, 255, 80, 0, 255, 40]);
	const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
	const octants = new Float32Array(4);

	it("raycasting the pixel a surface point projects to recovers that point", () => {
		const model = composeNodeModel(
			vp.projectPosition(origin),
			vp.getDistanceScales(origin).unitsPerMeter,
			enuModel,
		);
		const mvp = mul4(vp.viewProjectionMatrix, model);

		// pick a point on the quad (barycentric inside triangle 0)
		const p = [127.5, 63.75, 40 * 0.5 + 40 * 0.25];
		const clipW = mvp[3] * p[0] + mvp[7] * p[1] + mvp[11] * p[2] + mvp[15];
		const ndcX = (mvp[0] * p[0] + mvp[4] * p[1] + mvp[8] * p[2] + mvp[12]) / clipW;
		const ndcY = (mvp[1] * p[0] + mvp[5] * p[1] + mvp[9] * p[2] + mvp[13]) / clipW;

		expect(ndcHitsNodeBounds(mvp, ndcX, ndcY, [0, 0, 0], [255, 255, 255])).toBe(true);
		const ray = localRay(invert4(mvp)!, ndcX, ndcY)!;
		const t = raycastMesh(ray, positions, indices, octants, 0)!;
		expect(t).not.toBeNull();
		const hit = [
			ray.p0[0] + ray.dir[0] * t,
			ray.p0[1] + ray.dir[1] * t,
			ray.p0[2] + ray.dir[2] * t,
		];
		for (let i = 0; i < 3; i++) expect(hit[i]).toBeCloseTo(p[i], 4);

		// and the lat/lng derived from the hit matches deck's own for that point
		const common = [
			model[0] * hit[0] + model[4] * hit[1] + model[8] * hit[2] + model[12],
			model[1] * hit[0] + model[5] * hit[1] + model[9] * hit[2] + model[13],
			model[2] * hit[0] + model[6] * hit[1] + model[10] * hit[2] + model[14],
		];
		const [lng, lat] = vp.unprojectPosition(common);
		const expectedCommon = [
			model[0] * p[0] + model[4] * p[1] + model[8] * p[2] + model[12],
			model[1] * p[0] + model[5] * p[1] + model[9] * p[2] + model[13],
			model[2] * p[0] + model[6] * p[1] + model[10] * p[2] + model[14],
		];
		const [elng, elat] = vp.unprojectPosition(expectedCommon);
		expect(lat).toBeCloseTo(elat, 9);
		expect(lng).toBeCloseTo(elng, 9);
	});
});
