import type { Selector } from "@/types";
import type { ListedSelection, Selection } from "@/bindings.gen";
import { cmd } from "@/lib/commands";

type PolygonSelection = Selection & { selector: Extract<Selector, { type: "Polygon" }> };
type Fill = [number, number][][][];

let fills = new Map<string, Fill>();
let generation = 0;

/** The polygons the map draws: listed polygon selections and the polygon parts of listed intersections. */
export function drawnPolygons(rows: ListedSelection[]): PolygonSelection[] {
	return rows
		.flatMap(({ selection: s }) =>
			s.selector.type === "Intersection" ? s.selector.selections : [s],
		)
		.filter((s): s is PolygonSelection => s.selector.type === "Polygon");
}

/** The area a drawn polygon selects, as pieces whose edges never cross; undefined until it arrives. */
export function getPolygonFill(key: string): Fill | undefined {
	return fills.get(key);
}

/** Hold the fill of every polygon `rows` draw, asking the store only for ones not yet held. */
export async function refreshPolygonFills(rows: ListedSelection[]): Promise<void> {
	const current = ++generation;
	const next = new Map<string, Fill>();
	await Promise.all(
		drawnPolygons(rows).map(async ({ key, selector }) => {
			next.set(key, fills.get(key) ?? (await cmd.polygonFill(selector.polygon)));
		}),
	);
	if (current === generation) fills = next;
}
