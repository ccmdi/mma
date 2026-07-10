// SV coverage draping math: the host renders a GRID x GRID block of coverage
// tiles into one texture anchored to a deck common-space rect; the mesh shader
// projects each vertex into that rect to sample it (a top-down decal, which is
// exactly what SV coverage is). Pure math here; tile IO lives in the host.

/** Common-space rect: x of the west edge, y of the NORTH edge (deck common y
 *  grows north; texture v grows south like tile rows), width, height. */
export type CoverageRect = [x: number, yTop: number, w: number, h: number];

export interface CoverageGrid {
	tileZ: number;
	/** Unwrapped tile x of the west column (mod 2^z for fetching). */
	tx0: number;
	/** Tile y of the north row (google tile y grows south). */
	ty0: number;
	rect: CoverageRect;
}

/**
 * Choose the tile block for a view: finest zoom where GRID tiles still span
 * `spanCommon` around the center, snapped to the tile lattice.
 */
export function coverageGrid(
	centerCommon: [number, number],
	spanCommon: number,
	grid: number,
	maxZ = 21,
): CoverageGrid {
	const tileZ = Math.max(0, Math.min(maxZ, Math.floor(Math.log2((512 * grid) / spanCommon))));
	const tc = 512 / 2 ** tileZ;
	const n = 2 ** tileZ;
	const tx0 = Math.round(centerCommon[0] / tc - grid / 2);
	// common y -> tile y flips: tile row 0 is the north edge (common y = 512)
	const ty0 = Math.round(n - centerCommon[1] / tc - grid / 2);
	return { tileZ, tx0, ty0, rect: [tx0 * tc, (n - ty0) * tc, grid * tc, grid * tc] };
}

/**
 * Column-major 4x4 mapping common space -> coverage texture uv (v = 0 at the
 * rect's north edge). Compose with a node's commonFromMesh in f64 before
 * downcasting: the combined translation is uv-scale, so f32 is safe.
 */
export function covUvMatrix(rect: CoverageRect): Float64Array {
	const [x0, yTop, w, h] = rect;
	// out.u = (x - x0) / w; out.v = (yTop - y) / h
	return new Float64Array([1 / w, 0, 0, 0, 0, -1 / h, 0, 0, 0, 0, 0, 0, -x0 / w, yTop / h, 0, 1]);
}
