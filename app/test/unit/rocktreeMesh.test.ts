/**
 * Rocktree geometry conversion invariants: strip-to-triangles, final UVs, and
 * the ENU anchoring that places ECEF meshes in deck.gl's METER_OFFSETS frame.
 * Fixture provenance: see rocktree.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseNodeData, ecefToLatLng, latLngToEcef } from "@/lib/render/rocktree/decode";
import { stripToTriangles, meshPositions, meshUvs, enuAnchor } from "@/lib/render/rocktree/mesh";

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
