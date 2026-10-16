import type { ListedSelection, RGB, Selection } from "@/bindings.gen";
import type { Selector } from "@/types";

type PolygonSelection = Selection & { selector: Extract<Selector, { type: "Polygon" }> };

/** One polygon as the store triangulated it: the area it selects, and its rings as drawn. */
interface PolygonMesh {
	fill: Float64Array;
	triangles: Uint32Array;
	rings: Float64Array;
	/** Where each ring starts in `rings`, in vertices, then the end. */
	ringStarts: Uint32Array;
}

/** Every drawn polygon as binary layer data for one fill layer and one ring layer, with the
 *  color of each fill and each ring. */
export interface PolygonLayerData {
	fill: {
		length: number;
		startIndices: Uint32Array;
		attributes: { getPolygon: { value: Float64Array; size: 2 }; indices: Uint32Array };
	};
	fillColors: RGB[];
	rings: {
		length: number;
		startIndices: Uint32Array;
		attributes: { getPath: { value: Float64Array; size: 2 } };
	};
	ringColors: RGB[];
}

function decode(buffer: ArrayBuffer): PolygonMesh {
	const [vertices, indices, rings, ringVertices] = new Uint32Array(buffer, 0, 4);
	let at = 16;
	const f64 = (count: number) => {
		const out = new Float64Array(buffer, at, count);
		at += count * 8;
		return out;
	};
	const u32 = (count: number) => {
		const out = new Uint32Array(buffer, at, count);
		at += count * 4;
		return out;
	};
	const fill = f64(vertices * 2);
	const ring = f64(ringVertices * 2);
	return { fill, rings: ring, triangles: u32(indices), ringStarts: u32(rings + 1) };
}

const meshes = new Map<string, PolygonMesh>();
const utf8 = new TextDecoder();

/** Apply a render frame's polygon section, which starts at `at`: forget the polygons it
 *  names gone, then take each new one's mesh. A replace frame first forgets every polygon.
 *  Returns whether anything changed. */
export function applyPolygonFrame(buf: ArrayBuffer, at: number, replace: boolean): boolean {
	const dv = new DataView(buf);
	const added = dv.getUint32(at, true);
	const removed = dv.getUint32(at + 4, true);
	at += 8;
	const key = () => {
		const len = dv.getUint32(at, true);
		const text = utf8.decode(new Uint8Array(buf, at + 4, len));
		at = (at + 4 + len + 3) & ~3;
		return text;
	};
	const changed = replace && meshes.size > 0;
	if (replace) meshes.clear();
	for (let i = 0; i < removed; i++) meshes.delete(key());
	for (let i = 0; i < added; i++) {
		const name = key();
		const len = dv.getUint32(at, true);
		at = (at + 4 + 7) & ~7;
		// Copied out, so a mesh does not keep the whole frame alive.
		meshes.set(name, decode(buf.slice(at, at + len)));
		at += len;
	}
	return changed || added > 0 || removed > 0;
}

/** The polygons the map draws: listed polygon selections and the polygon parts of listed intersections. */
export function drawnPolygons(rows: ListedSelection[]): PolygonSelection[] {
	return rows
		.flatMap(({ selection: s }) =>
			s.selector.type === "Intersection" ? s.selector.selections : [s],
		)
		.filter((s): s is PolygonSelection => s.selector.type === "Polygon");
}

function merge(drawn: { mesh: PolygonMesh; color: RGB }[]): PolygonLayerData {
	const sum = (pick: (mesh: PolygonMesh) => number) =>
		drawn.reduce((n, { mesh }) => n + pick(mesh), 0);
	const filled = drawn.filter(({ mesh }) => mesh.fill.length > 0);
	const fill = new Float64Array(sum((m) => m.fill.length));
	const triangles = new Uint32Array(sum((m) => m.triangles.length));
	const fillStarts = new Uint32Array(filled.length + 1);
	const rings = new Float64Array(sum((m) => m.rings.length));
	const ringStarts = new Uint32Array(sum((m) => m.ringStarts.length - 1) + 1);
	const ringColors: RGB[] = [];
	let [vertex, index, ringVertex, ring] = [0, 0, 0, 0];
	filled.forEach(({ mesh }, i) => {
		fill.set(mesh.fill, vertex * 2);
		for (let t = 0; t < mesh.triangles.length; t++)
			triangles[index + t] = mesh.triangles[t] + vertex;
		index += mesh.triangles.length;
		vertex += mesh.fill.length / 2;
		fillStarts[i + 1] = vertex;
	});
	for (const { mesh, color } of drawn) {
		rings.set(mesh.rings, ringVertex * 2);
		for (let r = 1; r < mesh.ringStarts.length; r++) {
			ringStarts[++ring] = ringVertex + mesh.ringStarts[r];
			ringColors.push(color);
		}
		ringVertex += mesh.rings.length / 2;
	}
	return {
		fill: {
			length: filled.length,
			startIndices: fillStarts,
			attributes: { getPolygon: { value: fill, size: 2 }, indices: triangles },
		},
		fillColors: filled.map(({ color }) => color),
		rings: {
			length: ring,
			startIndices: ringStarts,
			attributes: { getPath: { value: rings, size: 2 } },
		},
		ringColors,
	};
}

let merged: { drawn: { mesh: PolygonMesh; color: RGB }[]; data: PolygonLayerData } | null = null;

/** The layer data for every polygon `rows` draw whose mesh has arrived. Rebuilt only when a
 *  mesh or a color changes, so the layers keep their buffers otherwise. */
export function polygonLayerData(rows: ListedSelection[]): PolygonLayerData {
	const drawn = drawnPolygons(rows).flatMap(({ key, color }) => {
		const mesh = meshes.get(key);
		return mesh ? [{ mesh, color }] : [];
	});
	const same =
		merged?.drawn.length === drawn.length &&
		drawn.every(
			({ mesh, color }, i) =>
				merged!.drawn[i].mesh === mesh && merged!.drawn[i].color.every((c, k) => c === color[k]),
		);
	if (!merged || !same) merged = { drawn, data: merge(drawn) };
	return merged.data;
}
