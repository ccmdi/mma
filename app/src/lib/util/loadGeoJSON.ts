import { addSelections } from "@/store/useMapStore";
import type { PolygonGeometry, Selector } from "@/bindings.gen";

/** Prompt for GeoJSON file(s) and add their polygons as selections. */
export async function loadGeoJSON() {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = ".json,.geojson";
	input.multiple = true;
	input.onchange = async () => {
		if (!input.files) return;
		const selector: Selector[] = [];
		for (const file of input.files) {
			try {
				const text = await file.text();
				const data = JSON.parse(text);
				const features = data.type === "FeatureCollection" ? data.features : [data];
				for (const f of features) {
					if (f.geometry?.type === "Polygon") {
						selector.push({
							type: "Polygon",
							polygon: {
								coordinates: f.geometry.coordinates,
								properties: f.properties ?? undefined,
							},
							includeInformational: false,
						});
					} else if (f.geometry?.type === "MultiPolygon") {
						const [first, ...rest] = f.geometry.coordinates;
						if (!first) continue;
						const polygon: PolygonGeometry = {
							coordinates: first,
							properties: f.properties ?? undefined,
						};
						if (rest.length) polygon.extraPolygons = rest;
						selector.push({ type: "Polygon", polygon, includeInformational: false });
					}
				}
			} catch {
				/* ignore malformed files */
			}
		}
		if (selector.length) void addSelections(selector);
	};
	input.click();
}
