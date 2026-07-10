import type { SvColor, MapTypeKey, SvCoverageType, SvThickness, MarkerStyle } from "@/types";

export interface MapEmbedPrefs {
	svOpacity: number;
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
	markerSize: number;
	showPerfectScoreCircle: boolean;
	showSearchRadiusCursor: boolean;
	showPreviews: boolean;
	selectOnly: boolean;
}

export const DEFAULT_PREFS: MapEmbedPrefs = {
	svOpacity: 0.5,
	svColor: "cyan",
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
	markerSize: 1,
	showPerfectScoreCircle: true,
	showSearchRadiusCursor: false,
	showPreviews: false,
	selectOnly: false,
};
