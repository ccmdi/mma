// Geometry conversion from decoded rocktree meshes to render-ready arrays,
// plus the ENU anchoring that places a node's ECEF-frame mesh into deck.gl's
// MapView (METER_OFFSETS around a lat/lng origin). Pure math, no IO/GL.

import { ecefToLatLng, type DecodedMesh } from "./decode";

/**
 * Convert a triangle strip to a triangle list, dropping degenerate triangles
 * (strip restarts) and flipping winding on odd strip positions.
 * @param end render only strip[0, end) (pass layerBounds[3] to skip hidden/water layers)
 */
export function stripToTriangles(strip: Uint16Array, end = strip.length): Uint16Array {
	const out = new Uint16Array(Math.max(0, end - 2) * 3);
	let n = 0;
	for (let i = 0; i < end - 2; i++) {
		const a = strip[i],
			b = strip[i + 1],
			c = strip[i + 2];
		if (a === b || a === c || b === c) continue;
		out[n++] = a;
		if (i & 1) {
			out[n++] = c;
			out[n++] = b;
		} else {
			out[n++] = b;
			out[n++] = c;
		}
	}
	return out.subarray(0, n);
}

/** Mesh-local positions (0-255) as float triples. */
export function meshPositions(mesh: DecodedMesh): Float32Array {
	const out = new Float32Array(mesh.vertexCount * 3);
	for (let i = 0; i < mesh.vertexCount; i++) {
		out[i * 3] = mesh.vertexData[i * 8];
		out[i * 3 + 1] = mesh.vertexData[i * 8 + 1];
		out[i * 3 + 2] = mesh.vertexData[i * 8 + 2];
	}
	return out;
}

/** Per-vertex octant ids (0-7) as floats for the mask shader. */
export function meshOctants(mesh: DecodedMesh): Float32Array {
	const out = new Float32Array(mesh.vertexCount);
	for (let i = 0; i < mesh.vertexCount; i++) out[i] = mesh.vertexData[i * 8 + 3];
	return out;
}

/** Final texture coordinates: (uv + uvOffset) * uvScale. */
export function meshUvs(mesh: DecodedMesh): Float32Array {
	const dv = new DataView(mesh.vertexData.buffer, mesh.vertexData.byteOffset);
	const out = new Float32Array(mesh.vertexCount * 2);
	for (let i = 0; i < mesh.vertexCount; i++) {
		out[i * 2] = (dv.getUint16(i * 8 + 4, true) + mesh.uvOffset[0]) * mesh.uvScale[0];
		out[i * 2 + 1] = (dv.getUint16(i * 8 + 6, true) + mesh.uvOffset[1]) * mesh.uvScale[1];
	}
	return out;
}

export interface EnuAnchor {
	/** [lng, lat, alt] for deck's coordinateOrigin. */
	origin: [number, number, number];
	/** Column-major 4x4: mesh-local (0-255) -> ENU meter offsets from origin. */
	modelMatrix: Float64Array;
}

/**
 * Anchor a node at its own matrix translation: rotate the node matrix into the
 * local east/north/up frame there, so vertices become meter offsets from the
 * origin lat/lng. The huge ECEF translation cancels exactly in f64 (the anchor
 * IS the translation), so the returned matrix is safe to downcast to f32.
 * Only valid while the mesh is small relative to the planet (a few km).
 */
export function enuAnchor(matrix: Float64Array): EnuAnchor {
	const cx = matrix[12],
		cy = matrix[13],
		cz = matrix[14];
	const { lat, lng, alt } = ecefToLatLng(cx, cy, cz);
	const p = (lat * Math.PI) / 180;
	const l = (lng * Math.PI) / 180;
	const sinP = Math.sin(p),
		cosP = Math.cos(p);
	const sinL = Math.sin(l),
		cosL = Math.cos(l);
	// rows: east, north, up (ENU-from-ECEF rotation at the origin)
	const r = [
		[-sinL, cosL, 0],
		[-sinP * cosL, -sinP * sinL, cosP],
		[cosP * cosL, cosP * sinL, sinP],
	];
	const modelMatrix = new Float64Array(16);
	for (let col = 0; col < 3; col++) {
		const mx = matrix[col * 4],
			my = matrix[col * 4 + 1],
			mz = matrix[col * 4 + 2];
		for (let row = 0; row < 3; row++) {
			modelMatrix[col * 4 + row] = r[row][0] * mx + r[row][1] * my + r[row][2] * mz;
		}
	}
	modelMatrix[15] = 1;
	return { origin: [lng, lat, alt], modelMatrix };
}
