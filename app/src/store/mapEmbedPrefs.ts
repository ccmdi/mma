import type { SvColor, MapTypeKey, SvCoverageType, SvThickness, MarkerStyle } from "@/types";
import type { OpacityToggleMode } from "./settings";
import { persisted } from "@/lib/hooks/useLocalStorage";
import { msg } from "@/lib/i18n";

/** Basemap order: also the order the previous/next basemap commands step through. */
export const MAP_TYPES: readonly MapTypeKey[] = ["map", "satellite", "osm", "vector"];

export const MAP_TYPE_LABELS: Record<MapTypeKey, string> = {
	map: msg("Map"),
	satellite: msg("Satellite"),
	osm: msg("OSM"),
	vector: msg("Vector"),
};

export interface MapEmbedPrefs {
	svOpacity: number;
	svVisible: boolean;
	svColor: SvColor;
	showLabels: boolean;
	showTerrain: boolean;
	svPanoramas: boolean;
	svCoverageType: SvCoverageType;
	svThickness: SvThickness;
	svBlobby: boolean;
	boldCountryBorders: boolean;
	boldSubdivisionBorders: boolean;
	hideRoadLabels: boolean;
	hidePoi: boolean;
	hideTransit: boolean;
	hideHighways: boolean;
	mapStyleName: string;
	vectorStyleName: string;
	mapType: MapTypeKey;
	markerStyle: MarkerStyle;
	markerOpacity: number;
	markerVisible: boolean;
	markerSize: number;
	showPerfectScoreCircle: boolean;
	showSearchRadiusCursor: boolean;
	showPreviews: boolean;
	selectOnly: boolean;
}

export const DEFAULT_PREFS: MapEmbedPrefs = {
	svOpacity: 0.5,
	svVisible: true,
	svColor: "#1098ad",
	showLabels: true,
	showTerrain: false,
	svPanoramas: false,
	svCoverageType: "official",
	svThickness: "default",
	svBlobby: false,
	boldCountryBorders: false,
	boldSubdivisionBorders: false,
	hideRoadLabels: false,
	hidePoi: false,
	hideTransit: false,
	hideHighways: false,
	mapStyleName: "default",
	vectorStyleName: "liberty",
	mapType: "map",
	markerStyle: "pin",
	markerOpacity: 1,
	markerVisible: true,
	markerSize: 1,
	showPerfectScoreCircle: true,
	showSearchRadiusCursor: false,
	showPreviews: false,
	selectOnly: false,
};

export const MAP_EMBED_PREFS = persisted("mapEmbedPrefs", DEFAULT_PREFS);

/** What the SV tile layer renders at: its opacity, gated by its visibility. */
export function svLayerOpacity(prefs: MapEmbedPrefs): number {
	return prefs.svVisible ? prefs.svOpacity : 0;
}

/** What the marker layers render at: their opacity, gated by their visibility. */
export function markerLayerOpacity(prefs: MapEmbedPrefs): number {
	return prefs.markerVisible ? prefs.markerOpacity : 0;
}

/** Next state for a layer visibility toggle. Hiding keeps the opacity value, so showing
 *  restores it -- or full opacity, per the setting. */
export function toggledLayer(
	opacity: number,
	visible: boolean,
	mode: OpacityToggleMode,
): { opacity: number; visible: boolean } {
	if (visible) return { opacity, visible: false };
	return { opacity: mode === "full" || opacity <= 0 ? 1 : opacity, visible: true };
}
