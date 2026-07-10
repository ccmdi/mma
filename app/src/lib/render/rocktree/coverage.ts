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

/**
 * Column-major 4x4 mapping mesh-local -> (rect u, rect v, altitude meters).
 * Rows 0-1 come from covUvMatrix * commonFromMesh (f64); row 2 is the ENU up
 * row in meters plus `altOffset` (the node origin's altitude for absolute
 * heights, 0 when only slopes/derivatives matter).
 */
export function uvAltMatrix(
	rect: CoverageRect,
	commonFromMesh: Float64Array,
	enuModel: Float64Array,
	altOffset = 0,
): Float64Array {
	const [x0, yTop, w, h] = rect;
	const out = new Float64Array(16);
	for (let col = 0; col < 4; col++) {
		out[col * 4] = commonFromMesh[col * 4] / w;
		out[col * 4 + 1] = -commonFromMesh[col * 4 + 1] / h;
		out[col * 4 + 2] = enuModel[col * 4 + 2];
		out[col * 4 + 3] = commonFromMesh[col * 4 + 3];
	}
	out[12] += -x0 / w;
	out[13] += yTop / h;
	out[14] += altOffset;
	return out;
}

/** Deck common-space (512px world) coordinates -> lng/lat degrees. */
export function commonToLngLat(x: number, y: number): [lng: number, lat: number] {
	const lng = (x / 512) * 360 - 180;
	const lat =
		((2 * Math.atan(Math.exp((y / 512 - 0.5) * 2 * Math.PI)) - Math.PI / 2) * 180) / Math.PI;
	return [lng, lat];
}
