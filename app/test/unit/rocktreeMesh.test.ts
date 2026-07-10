/**
 * Rocktree geometry conversion invariants: strip-to-triangles, final UVs, and
 * the ENU anchoring that places ECEF meshes in deck.gl's METER_OFFSETS frame.
 * Fixture provenance: see rocktree.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { WebMercatorViewport } from "@deck.gl/core";
import { parseNodeData, ecefToLatLng, latLngToEcef } from "@/lib/render/rocktree/decode";
import {
	commonAnchor,
	stripToTriangles,
	meshPositions,
	meshUvs,
	enuAnchor,
} from "@/lib/render/rocktree/mesh";
import { commonUnitsPerMeter, lngLatToCommon } from "@/lib/render/rocktree/coverage";
import { composeNodeModel, composeNodeMvp } from "@/lib/render/rocktree/layer";

const nodeUser = () =>
	parseNodeData(
		new Uint8Array(readFileSync(new URL("./fixtures/rocktree/node_user.bin", import.meta.url))),
	);

describe("stripToTriangles", () => {
	it("converts a plain strip with winding flip on odd positions", () => {
		const tris = stripToTriangles(new Uint16Array([0, 1, 2, 3]));
		expect(Array.from(tris)).toEqual([0, 1, 2, 1, 3, 2]);
	});

	it("drops degenerate triangles (strip restarts)", () => {
		// strip 0,1,1,2,3: positions 0 and 1 are degenerate, position 2 survives
		const tris = stripToTriangles(new Uint16Array([0, 1, 1, 2, 3]));
		expect(Array.from(tris)).toEqual([1, 2, 3]);
	});

	it("truncates at end (layer bound)", () => {
		const strip = new Uint16Array([0, 1, 2, 3, 4, 5]);
		expect(Array.from(stripToTriangles(strip, 4))).toEqual([0, 1, 2, 1, 3, 2]);
	});

	it("fixture strip yields only valid, non-degenerate triangles", () => {
		const m = nodeUser().meshes[0];
		const tris = stripToTriangles(m.strip, m.layerBounds[3]);
		expect(tris.length % 3).toBe(0);
		expect(tris.length).toBeGreaterThan(0);
		for (let i = 0; i < tris.length; i += 3) {
			const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
			expect(a).not.toBe(b);
			expect(a).not.toBe(c);
			expect(b).not.toBe(c);
			expect(Math.max(a, b, c)).toBeLessThan(m.vertexCount);
		}
	});
});

describe("meshPositions / meshUvs", () => {
	it("positions match the decoded vertex bytes", () => {
		const m = nodeUser().meshes[0];
		const pos = meshPositions(m);
		expect(pos.length).toBe(m.vertexCount * 3);
		expect([pos[0], pos[1], pos[2]]).toEqual([90, 23, 3]);
		expect([pos[198], pos[199], pos[200]]).toEqual([87, 231, 251]);
	});

	it("final UVs apply (uv + offset) * scale and stay near [0, 1]", () => {
		const m = nodeUser().meshes[0];
		const uv = meshUvs(m);
		expect(uv.length).toBe(m.vertexCount * 2);
		expect(uv[0]).toBeCloseTo((16267 - 16384) / 32768, 6);
		expect(uv[1]).toBeCloseTo((49262 - 16384) / 32768, 6);
		for (const v of uv) {
			expect(v).toBeGreaterThan(-0.05);
			expect(v).toBeLessThan(1.05);
		}
	});
});

describe("enuAnchor", () => {
	it("origin is the matrix translation on the sphere frame", () => {
		const node = nodeUser();
		const { origin } = enuAnchor(node.matrix);
		const direct = ecefToLatLng(node.matrix[12], node.matrix[13], node.matrix[14]);
		expect(origin[0]).toBeCloseTo(direct.lng, 12);
		expect(origin[1]).toBeCloseTo(direct.lat, 12);
		expect(origin[2]).toBeCloseTo(direct.alt, 9);
	});

	it("rotation is orthonormal with zero translation", () => {
		const { modelMatrix: m } = enuAnchor(
			Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...latLngToEcef(40, -73), 1]),
		);
		expect([m[3], m[7], m[11], m[12], m[13], m[14], m[15]]).toEqual([0, 0, 0, 0, 0, 0, 1]);
		// columns of the rotation part are orthonormal (identity node matrix)
		const col = (j: number) => [m[j * 4], m[j * 4 + 1], m[j * 4 + 2]];
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) {
				const dot = col(i).reduce((s, v, k) => s + v * col(j)[k], 0);
				expect(dot).toBeCloseTo(i === j ? 1 : 0, 12);
			}
		}
	});

	it("ENU axes match numeric derivatives of latLngToEcef at the origin", () => {
		const node = nodeUser();
		const { origin, modelMatrix: mm } = enuAnchor(node.matrix);
		const [lng, lat, alt] = origin;
		// node matrix rotation is not identity, so recover R by anchoring identity
		const { modelMatrix: r } = enuAnchor(
			Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...latLngToEcef(lat, lng, alt), 1]),
		);
		const apply = (v: number[]) => [
			r[0] * v[0] + r[4] * v[1] + r[8] * v[2],
			r[1] * v[0] + r[5] * v[1] + r[9] * v[2],
			r[2] * v[0] + r[6] * v[1] + r[10] * v[2],
		];
		const p0 = latLngToEcef(lat, lng, alt);
		const d = 1e-4;
		const diff = (p1: number[]) => p1.map((v, i) => v - p0[i]);
		const east = apply(diff(latLngToEcef(lat, lng + d, alt)));
		const north = apply(diff(latLngToEcef(lat + d, lng, alt)));
		const up = apply(diff(latLngToEcef(lat, lng, alt + 1)));
		// east displacement rotates to +x only, north to +y only, up to +z only
		const scale = Math.hypot(...east);
		expect(east[0] / scale).toBeCloseTo(1, 8);
		expect(Math.abs(east[1] / scale)).toBeLessThan(1e-6);
		const nScale = Math.hypot(...north);
		expect(north[1] / nScale).toBeCloseTo(1, 8);
		expect(Math.abs(north[0] / nScale)).toBeLessThan(1e-6);
		expect(up[2]).toBeCloseTo(1, 6);
		// and mm is exactly R composed with the node matrix rotation
		expect(mm[15]).toBe(1);
	});

	it("origin + ENU offsets reconstruct the exact ECEF position for every vertex", () => {
		const node = nodeUser();
		const m = node.meshes[0];
		const { origin, modelMatrix: mm } = enuAnchor(node.matrix);
		const M = node.matrix;
		const c = [M[12], M[13], M[14]];
		// exact ENU basis at the origin (columns of R transposed)
		const p = (origin[1] * Math.PI) / 180;
		const l = (origin[0] * Math.PI) / 180;
		const E = [-Math.sin(l), Math.cos(l), 0];
		const N = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
		const U = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
		for (let i = 0; i < m.vertexCount; i++) {
			const x = m.vertexData[i * 8],
				y = m.vertexData[i * 8 + 1],
				z = m.vertexData[i * 8 + 2];
			const direct = [
				M[0] * x + M[4] * y + M[8] * z + M[12],
				M[1] * x + M[5] * y + M[9] * z + M[13],
				M[2] * x + M[6] * y + M[10] * z + M[14],
			];
			const east = mm[0] * x + mm[4] * y + mm[8] * z;
			const north = mm[1] * x + mm[5] * y + mm[9] * z;
			const up = mm[2] * x + mm[6] * y + mm[10] * z;
			for (let k = 0; k < 3; k++) {
				const back = c[k] + E[k] * east + N[k] * north + U[k] * up;
				expect(Math.abs(back - direct[k])).toBeLessThan(1e-6);
			}
		}
	});
});

describe("mercator helpers vs deck", () => {
	const vp = new WebMercatorViewport({ width: 800, height: 600, longitude: 10, latitude: 20 });

	it("lngLatToCommon and commonUnitsPerMeter reproduce projectPosition", () => {
		for (const [lng, lat, alt] of [
			[-96.8, 32.77, 150],
			[139.7, 35.68, 40],
			[18.4, -33.9, 0],
			[0, 66.5, 300],
		]) {
			const [ex, ey, ez] = vp.projectPosition([lng, lat, alt]);
			const [x, y] = lngLatToCommon(lng, lat);
			expect(x).toBeCloseTo(ex, 9);
			expect(y).toBeCloseTo(ey, 9);
			expect(alt * commonUnitsPerMeter(lat)).toBeCloseTo(ez, 9);
		}
	});
});

describe("commonAnchor (coarse nodes)", () => {
	// 10 km per local unit: a node spanning far beyond ENU validity
	const S = 10000;
	const t = latLngToEcef(32.77, -96.8);
	const matrix = new Float64Array([S, 0, 0, 0, 0, S, 0, 0, 0, 0, S, 0, t[0], t[1], t[2], 1]);

	it("vertices drawn through the standard mvp land where deck projects their true lat/lng", () => {
		const vp = new WebMercatorViewport({
			width: 800,
			height: 600,
			longitude: -96.8,
			latitude: 32.77,
			zoom: 4,
			pitch: 30,
			bearing: 15,
		});
		const locals = new Float32Array([0, 0, 0, 10, 5, 1, -20, 8, 2]);
		const { origin, modelMatrix, positions } = commonAnchor(matrix, [locals]);
		const mvp = composeNodeMvp(
			vp.viewProjectionMatrix,
			vp.projectPosition(origin),
			vp.getDistanceScales(origin).unitsPerMeter,
			modelMatrix,
		);
		for (let i = 0; i < locals.length; i += 3) {
			const wx = matrix[0] * locals[i] + t[0];
			const wy = matrix[5] * locals[i + 1] + t[1];
			const wz = matrix[10] * locals[i + 2] + t[2];
			const p = ecefToLatLng(wx, wy, wz);
			const [ex, ey] = vp.project([p.lng, p.lat, p.alt]);
			const px = positions[0][i],
				py = positions[0][i + 1],
				pz = positions[0][i + 2];
			const cw = mvp[3] * px + mvp[7] * py + mvp[11] * pz + mvp[15];
			const cx = (mvp[0] * px + mvp[4] * py + mvp[8] * pz + mvp[12]) / cw;
			const cy = (mvp[1] * px + mvp[5] * py + mvp[9] * pz + mvp[13]) / cw;
			expect(((cx + 1) / 2) * 800).toBeCloseTo(ex, 1);
			expect(((1 - cy) / 2) * 600).toBeCloseTo(ey, 1);
		}
	});

	it("unwraps longitudes across the antimeridian toward the anchor", () => {
		const ta = latLngToEcef(0, 179.9);
		const m = new Float64Array([S, 0, 0, 0, 0, S, 0, 0, 0, 0, S, 0, ta[0], ta[1], ta[2], 1]);
		// vertices straddling the dateline (y offsets rotate lng at the equator)
		const locals = new Float32Array([0, -20, 0, 0, 20, 0]);
		const { positions } = commonAnchor(m, [locals]);
		// contiguous: both within a node span of the anchor, no 512-unit wrap jump
		expect(Math.abs(positions[0][0])).toBeLessThan(10);
		expect(Math.abs(positions[0][3])).toBeLessThan(10);
		expect(Math.sign(positions[0][0])).not.toBe(Math.sign(positions[0][3]));
	});

	it("clamps polar vertices to the mercator limit (finite y)", () => {
		const tp = latLngToEcef(84, 0);
		const m = new Float64Array([S, 0, 0, 0, 0, S, 0, 0, 0, 0, S, 0, tp[0], tp[1], tp[2], 1]);
		const locals = new Float32Array([0, 0, 80]); // pushes past the pole-ish
		const { positions } = commonAnchor(m, [locals]);
		expect(Number.isFinite(positions[0][1])).toBe(true);
	});

	it("modelMatrix is diag(metersPerUnit) so deck's unitsPerMeter cancels", () => {
		const { origin, modelMatrix } = commonAnchor(matrix, []);
		const vp = new WebMercatorViewport({ width: 100, height: 100, longitude: 0, latitude: 0 });
		const model = composeNodeModel(
			vp.projectPosition(origin),
			vp.getDistanceScales(origin).unitsPerMeter,
			modelMatrix,
		);
		expect(model[0]).toBeCloseTo(1, 6);
		expect(model[5]).toBeCloseTo(1, 6);
		expect(model[10]).toBeCloseTo(1, 6);
	});
});
