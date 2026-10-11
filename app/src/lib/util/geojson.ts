import { SelectionList } from "@/store/selectionList";
import type { PolygonGeometry } from "@/bindings.gen";
import { addSelection } from "@/store/selections";
import { pickFiles } from "@/lib/util/util";

/** A GeoJSON Feature for a polygon, as a MultiPolygon when it has more than one part. */
export function polygonFeature(polygon: PolygonGeometry) {
	const geometry = polygon.extraPolygons?.length
		? { type: "MultiPolygon", coordinates: [polygon.coordinates, ...polygon.extraPolygons] }
		: { type: "Polygon", coordinates: polygon.coordinates };
	return { type: "Feature", properties: polygon.properties ?? {}, geometry };
}

/** A GeoJSON FeatureCollection holding each polygon as a feature. */
export function polygonFeatureCollection(polygons: PolygonGeometry[]) {
	return { type: "FeatureCollection", features: polygons.map(polygonFeature) };
}

/** The Polygon and MultiPolygon features of a parsed GeoJSON Feature or FeatureCollection. */
export function polygonsFromGeoJSON(data: unknown): PolygonGeometry[] {
	if (!data || typeof data !== "object") return [];
	const root = data as { type?: string; features?: unknown };
	const features =
		root.type === "FeatureCollection" && Array.isArray(root.features) ? root.features : [root];
	const polygons: PolygonGeometry[] = [];
	for (const f of features as {
		geometry?: { type?: string; coordinates?: unknown };
		properties?: unknown;
	}[]) {
		if (f?.geometry?.type === "Polygon") {
			polygons.push({
				coordinates: f.geometry.coordinates as PolygonGeometry["coordinates"],
				extraPolygons: null,
				properties: f.properties ?? undefined,
			});
		} else if (f?.geometry?.type === "MultiPolygon") {
			const [first, ...rest] = f.geometry.coordinates as PolygonGeometry["coordinates"][];
			if (!first) continue;
			polygons.push({
				coordinates: first,
				extraPolygons: rest.length ? rest : null,
				properties: f.properties ?? undefined,
			});
		}
	}
	return polygons;
}

/** Prompt for GeoJSON file(s) and add their polygons as selections. */
export async function loadGeoJSON() {
	const polygons: PolygonGeometry[] = [];
	for (const file of await pickFiles(".json,.geojson", { multiple: true })) {
		try {
			polygons.push(...polygonsFromGeoJSON(JSON.parse(await file.text())));
		} catch {
			/* ignore malformed files */
		}
	}
	await SelectionList.update(
		addSelection(...polygons.map((polygon) => ({ type: "Polygon" as const, polygon }))),
	);
}
