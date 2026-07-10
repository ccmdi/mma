// CPU rasterization of the drawn mesh into a top-down heightmap (max altitude
// per texel over a world-anchored rect). Markers sample it in the vertex
// shader to sit on the 3D surface instead of at sea level. Pure math, no GL.

/** Sentinel for "no mesh here" (f32-exact); the shader treats anything below -1e29 as a miss. */
export const HEIGHT_NONE = Math.fround(-1e30);

export interface HeightMesh {
	/** Column-major mesh-local -> (u, v, altitude m) over the rect (uvAltMatrix). */
	uvAlt: Float64Array;
	positions: Float32Array;
	indices: Uint16Array;
}

/**
 * Rasterize triangles into a size x size grid of max altitudes. Texel (i, j)
 * is sampled at uv ((i+0.5)/size, (j+0.5)/size); row j = 0 is the rect's
 * north edge, matching the texture upload order.
 */
export function rasterizeHeights(meshes: Iterable<HeightMesh>, size: number): Float32Array {
	const out = new Float32Array(size * size).fill(HEIGHT_NONE);
	for (const { uvAlt, positions, indices } of meshes) {
		const m = uvAlt;
		const count = positions.length / 3;
		// vertices to texel space (x = u*size - 0.5 so integer coords are texel centers)
		const vx = new Float64Array(count);
		const vy = new Float64Array(count);
		const va = new Float64Array(count);
		for (let i = 0; i < count; i++) {
			const x = positions[i * 3];
			const y = positions[i * 3 + 1];
			const z = positions[i * 3 + 2];
			vx[i] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * size - 0.5;
			vy[i] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * size - 0.5;
			va[i] = m[2] * x + m[6] * y + m[10] * z + m[14];
		}
		for (let t = 0; t < indices.length; t += 3) {
			const a = indices[t];
			const b = indices[t + 1];
			const c = indices[t + 2];
			const ax = vx[a],
				ay = vy[a],
				bx = vx[b],
				by = vy[b],
				cx = vx[c],
				cy = vy[c];
			const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)));
			const x1 = Math.min(size - 1, Math.floor(Math.max(ax, bx, cx)));
			if (x0 > x1) continue;
			const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy)));
			const y1 = Math.min(size - 1, Math.floor(Math.max(ay, by, cy)));
			if (y0 > y1) continue;
			const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
			if (area === 0) continue;
			const inv = 1 / area;
			const aa = va[a],
				ab = va[b],
				ac = va[c];
			for (let y = y0; y <= y1; y++) {
				const row = y * size;
				for (let x = x0; x <= x1; x++) {
					const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) * inv;
					if (w0 < 0) continue;
					const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) * inv;
					if (w1 < 0) continue;
					const w2 = 1 - w0 - w1;
					if (w2 < 0) continue;
					const alt = w0 * aa + w1 * ab + w2 * ac;
					if (alt > out[row + x]) out[row + x] = alt;
				}
			}
		}
	}
	return out;
}
