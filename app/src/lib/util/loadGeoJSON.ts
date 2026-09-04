import { applySelectionUpdate } from "@/store/useMapStore";
import { addSelection, batch } from "@/store/selections";
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
								extraPolygons: null,
								properties: f.properties ?? undefined,
							},
						});
					} else if (f.geometry?.type === "MultiPolygon") {
						const [first, ...rest] = f.geometry.coordinates;
						if (!first) continue;
						const polygon: PolygonGeometry = {
							coordinates: first,
							extraPolygons: rest.length ? rest : null,
							properties: f.properties ?? undefined,
						};
						selector.push({ type: "Polygon", polygon });
					}
				}
			} catch {
				/* ignore malformed files */
			}
		}
		if (selector.length) void applySelectionUpdate(batch(addSelection)(selector));
	};
	input.click();
}
