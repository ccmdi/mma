// Pixel-ray picking against the CPU-side copies of the drawn rocktree meshes,
// in each node's mesh-local frame: the click ray (two clip-space points through
// the pixel) is pulled into local space via the inverse node MVP, so the test
// is exactly consistent with what the shader draws. The ray parameter t is the
// same world parameterization for every node (affine maps preserve it), so the
// smallest t across nodes is the nearest surface.

import type { Vec3 } from "./decode";

export interface LocalRay {
	/** Ray origin (near plane) in mesh-local units. */
	p0: Vec3;
	/** p1 - p0 (far plane); hits are t in [0, 1] along this. */
	dir: Vec3;
}

/** Invert a column-major 4x4 (f64); null if singular. */
export function invert4(m: ArrayLike<number>): Float64Array | null {
	const inv = new Float64Array(16);
	inv[0] =
		m[5] * m[10] * m[15] -
		m[5] * m[11] * m[14] -
		m[9] * m[6] * m[15] +
		m[9] * m[7] * m[14] +
		m[13] * m[6] * m[11] -
		m[13] * m[7] * m[10];
	inv[4] =
		-m[4] * m[10] * m[15] +
		m[4] * m[11] * m[14] +
		m[8] * m[6] * m[15] -
		m[8] * m[7] * m[14] -
		m[12] * m[6] * m[11] +
		m[12] * m[7] * m[10];
	inv[8] =
		m[4] * m[9] * m[15] -
		m[4] * m[11] * m[13] -
		m[8] * m[5] * m[15] +
		m[8] * m[7] * m[13] +
		m[12] * m[5] * m[11] -
		m[12] * m[7] * m[9];
	inv[12] =
		-m[4] * m[9] * m[14] +
		m[4] * m[10] * m[13] +
		m[8] * m[5] * m[14] -
		m[8] * m[6] * m[13] -
		m[12] * m[5] * m[10] +
		m[12] * m[6] * m[9];
	inv[1] =
		-m[1] * m[10] * m[15] +
		m[1] * m[11] * m[14] +
		m[9] * m[2] * m[15] -
		m[9] * m[3] * m[14] -
		m[13] * m[2] * m[11] +
		m[13] * m[3] * m[10];
	inv[5] =
		m[0] * m[10] * m[15] -
		m[0] * m[11] * m[14] -
		m[8] * m[2] * m[15] +
		m[8] * m[3] * m[14] +
		m[12] * m[2] * m[11] -
		m[12] * m[3] * m[10];
	inv[9] =
		-m[0] * m[9] * m[15] +
		m[0] * m[11] * m[13] +
		m[8] * m[1] * m[15] -
		m[8] * m[3] * m[13] -
		m[12] * m[1] * m[11] +
		m[12] * m[3] * m[9];
	inv[13] =
		m[0] * m[9] * m[14] -
		m[0] * m[10] * m[13] -
		m[8] * m[1] * m[14] +
		m[8] * m[2] * m[13] +
		m[12] * m[1] * m[10] -
		m[12] * m[2] * m[9];
	inv[2] =
		m[1] * m[6] * m[15] -
		m[1] * m[7] * m[14] -
		m[5] * m[2] * m[15] +
		m[5] * m[3] * m[14] +
		m[13] * m[2] * m[7] -
		m[13] * m[3] * m[6];
	inv[6] =
		-m[0] * m[6] * m[15] +
		m[0] * m[7] * m[14] +
		m[4] * m[2] * m[15] -
		m[4] * m[3] * m[14] -
		m[12] * m[2] * m[7] +
		m[12] * m[3] * m[6];
	inv[10] =
		m[0] * m[5] * m[15] -
		m[0] * m[7] * m[13] -
		m[4] * m[1] * m[15] +
		m[4] * m[3] * m[13] +
		m[12] * m[1] * m[7] -
		m[12] * m[3] * m[5];
	inv[14] =
		-m[0] * m[5] * m[14] +
		m[0] * m[6] * m[13] +
		m[4] * m[1] * m[14] -
		m[4] * m[2] * m[13] -
		m[12] * m[1] * m[6] +
		m[12] * m[2] * m[5];
	inv[3] =
		-m[1] * m[6] * m[11] +
		m[1] * m[7] * m[10] +
		m[5] * m[2] * m[11] -
		m[5] * m[3] * m[10] -
		m[9] * m[2] * m[7] +
		m[9] * m[3] * m[6];
	inv[7] =
		m[0] * m[6] * m[11] -
		m[0] * m[7] * m[10] -
		m[4] * m[2] * m[11] +
		m[4] * m[3] * m[10] +
		m[8] * m[2] * m[7] -
		m[8] * m[3] * m[6];
	inv[11] =
		-m[0] * m[5] * m[11] +
		m[0] * m[7] * m[9] +
		m[4] * m[1] * m[11] -
		m[4] * m[3] * m[9] -
		m[8] * m[1] * m[7] +
		m[8] * m[3] * m[5];
	inv[15] =
		m[0] * m[5] * m[10] -
		m[0] * m[6] * m[9] -
		m[4] * m[1] * m[10] +
		m[4] * m[2] * m[9] +
		m[8] * m[1] * m[6] -
		m[8] * m[2] * m[5];
	const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
	if (det === 0 || !Number.isFinite(det)) return null;
	for (let i = 0; i < 16; i++) inv[i] /= det;
	return inv;
}

const project = (m: ArrayLike<number>, x: number, y: number, z: number): Vec3 | null => {
	const w = m[3] * x + m[7] * y + m[11] * z + m[15];
	if (w === 0) return null;
	return [
		(m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
		(m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
		(m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
	];
};

/** The pixel ray (clip near -> far points) expressed in mesh-local units. */
export function localRay(invMvp: ArrayLike<number>, ndcX: number, ndcY: number): LocalRay | null {
	const p0 = project(invMvp, ndcX, ndcY, -1);
	const p1 = project(invMvp, ndcX, ndcY, 1);
	if (!p0 || !p1) return null;
	return { p0, dir: [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]] };
}

/**
 * Cheap precull: does the pixel fall inside the screen bounds of the node's
 * mesh-local bounding box? Conservative: any corner behind the eye (w <= 0)
 * makes the node a candidate.
 */
export function ndcHitsNodeBounds(
	mvp: ArrayLike<number>,
	ndcX: number,
	ndcY: number,
	min: Vec3,
	max: Vec3,
): boolean {
	let minX = Infinity,
		maxX = -Infinity,
		minY = Infinity,
		maxY = -Infinity;
	for (let c = 0; c < 8; c++) {
		const x = c & 1 ? max[0] : min[0];
		const y = c & 2 ? max[1] : min[1];
		const z = c & 4 ? max[2] : min[2];
		const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
		if (w <= 0) return true;
		const px = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w;
		const py = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w;
		minX = Math.min(minX, px);
		maxX = Math.max(maxX, px);
		minY = Math.min(minY, py);
		maxY = Math.max(maxY, py);
	}
	return ndcX >= minX && ndcX <= maxX && ndcY >= minY && ndcY <= maxY;
}

/**
 * Nearest triangle hit (Moller-Trumbore, both windings) as the ray parameter
 * t in [0, 1], or null. Triangles whose octant bit is set in `mask` are drawn
 * by a finer descendant and skipped, matching the shader.
 */
export function raycastMesh(
	ray: LocalRay,
	positions: Float32Array,
	indices: Uint16Array,
	octants: Float32Array,
	mask: number,
): number | null {
	const [ox, oy, oz] = ray.p0;
	const [dx, dy, dz] = ray.dir;
	let best: number | null = null;
	for (let i = 0; i < indices.length; i += 3) {
		const a = indices[i];
		if (mask & (1 << octants[a])) continue;
		const b = indices[i + 1];
		const c = indices[i + 2];
		const ax = positions[a * 3],
			ay = positions[a * 3 + 1],
			az = positions[a * 3 + 2];
		const e1x = positions[b * 3] - ax,
			e1y = positions[b * 3 + 1] - ay,
			e1z = positions[b * 3 + 2] - az;
		const e2x = positions[c * 3] - ax,
			e2y = positions[c * 3 + 1] - ay,
			e2z = positions[c * 3 + 2] - az;
		const px = dy * e2z - dz * e2y,
			py = dz * e2x - dx * e2z,
			pz = dx * e2y - dy * e2x;
		const det = e1x * px + e1y * py + e1z * pz;
		if (det > -1e-12 && det < 1e-12) continue;
		const inv = 1 / det;
		const tx = ox - ax,
			ty = oy - ay,
			tz = oz - az;
		const u = (tx * px + ty * py + tz * pz) * inv;
		if (u < 0 || u > 1) continue;
		const qx = ty * e1z - tz * e1y,
			qy = tz * e1x - tx * e1z,
			qz = tx * e1y - ty * e1x;
		const v = (dx * qx + dy * qy + dz * qz) * inv;
		if (v < 0 || u + v > 1) continue;
		const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
		if (t < 0 || t > 1) continue;
		if (best === null || t < best) best = t;
	}
	return best;
}
