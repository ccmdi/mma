import type { ListedSelection, Selection } from "@/bindings.gen";
import type { Selector } from "@/types";

type PolygonSelection = Selection & { selector: Extract<Selector, { type: "Polygon" }> };

/** One polygon selection as deck.gl draws it, already triangulated: the area it selects,
 *  and its rings as drawn. Each is binary layer data, built once per polygon. */
export interface PolygonMesh {
	fill: {
		length: number;
		startIndices: Uint32Array;
		attributes: { getPolygon: { value: Float64Array; size: 2 }; indices: Uint32Array };
	};
	rings: {
		length: number;
		startIndices: Uint32Array;
		attributes: { getPath: { value: Float64Array; size: 2 } };
	};
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
	return {
		fill: {
			length: vertices > 0 ? 1 : 0,
			startIndices: Uint32Array.of(0, vertices),
			attributes: { getPolygon: { value: fill, size: 2 }, indices: u32(indices) },
		},
		rings: {
			length: rings,
			startIndices: u32(rings + 1),
			attributes: { getPath: { value: ring, size: 2 } },
		},
	};
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

/** How a drawn polygon is drawn; undefined until it arrives. */
export function getPolygonMesh(key: string): PolygonMesh | undefined {
	return meshes.get(key);
}
