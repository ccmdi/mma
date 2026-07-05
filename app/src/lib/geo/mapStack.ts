import { google } from "@/lib/sv/opensv";
import {
	buildTileUrl,
	buildStyledTileUrl,
	createRoadmapTileConfig,
	createLegacyTileConfig,
	createLegacyTerrainTileConfig,
	createLabelsTileConfig,
	createSatelliteLabelsTileConfig,
	createSatelliteTileConfig,
	createSvTileConfig,
	createSvBlobbyTileConfig,
	createTerrainBasemapTileConfig,
	createTerrainOverlayTileConfig,
	LEGACY_STYLE_MAP_ID,
	type MapStyle,
} from "@/lib/geo/tiles";
import { BUILTIN_STYLE_MAP } from "@/lib/geo/mapStyles";
import { createCompositeMapType } from "@/lib/geo/stackedMapType";
import type { SvColor, MapTypeKey, SvCoverageType, SvThickness } from "@/types";
import type { MapEmbedPrefs } from "@/store/mapEmbedPrefs";

export interface MapStackOpts {
	type: MapTypeKey;
	labels: boolean;
	terrain: boolean;
	color: SvColor;
	coverageType: SvCoverageType;
	thickness: SvThickness;
	useBlobby: boolean;
	boldCountry: boolean;
	boldSubdivision: boolean;
	style: string;
	customStyles?: MapStyle[];
	svOpacity: number;
}

export interface MapStackResult {
	mapType: google.maps.ImageMapType;
	svLayer: google.maps.ImageMapType;
}

export interface CustomStyle {
	name: string;
	style: MapStyle[];
}

export const CUSTOM_STYLES_KEY = "mma_custom_styles";

// Maps the saved map prefs onto stack opts. `useBlobby` and resolved `customStyles` are passed in
// because callers derive them differently (zoom-coupled blobby on the big map; per-call vs reactive
// custom-style lists).
export function mapStackOptsFromPrefs(
	prefs: MapEmbedPrefs,
	opts: { useBlobby: boolean; customStyles?: MapStyle[] },
): MapStackOpts {
	return {
		type: prefs.mapType,
		labels: prefs.showLabels,
		terrain: prefs.showTerrain,
		color: prefs.svColor,
		coverageType: prefs.svCoverageType,
		thickness: prefs.svThickness,
		useBlobby: opts.useBlobby,
		boldCountry: prefs.boldCountryBorders,
		boldSubdivision: prefs.boldSubdivisionBorders,
		style: prefs.mapStyleName,
		customStyles: opts.customStyles,
		svOpacity: prefs.svOpacity,
	};
}

// Composes the basemap + SV coverage + labels/border tile layers into one stacked map type.
// Returns the SV layer so the caller can drive reactive opacity without rebuilding the stack.
export function buildMapStack(opts: MapStackOpts): MapStackResult {
	const tileSize = new google.maps.Size(256, 256);
	const layers: google.maps.ImageMapType[] = [];
	const legacyMap = opts.style === "legacy" && opts.type === "map";

	const extraStyles: MapStyle[] = [];
	const builtinStyles = BUILTIN_STYLE_MAP[opts.style as keyof typeof BUILTIN_STYLE_MAP];
	if (builtinStyles) {
		extraStyles.push(...builtinStyles);
	} else if (opts.customStyles) {
		extraStyles.push(...opts.customStyles);
	}
	if (opts.boldCountry) {
		const s: Record<string, string | number> = { weight: 2 };
		if (opts.style === "default") s.color = "#000000";
		extraStyles.push({
			featureType: "administrative.country",
			elementType: "geometry.stroke",
			stylers: [s],
		});
	}
	if (opts.boldSubdivision) {
		extraStyles.push({
			featureType: "administrative.province",
			elementType: "geometry.stroke",
			stylers: [{ weight: 3 }],
		});
	}

	if (opts.type === "satellite") {
		const cfg = createSatelliteTileConfig();
		layers.push(
			new google.maps.ImageMapType({
				getTileUrl: (coord: TileCoord, zoom: number) => buildTileUrl(cfg, coord.x, coord.y, zoom),
				tileSize,
				minZoom: 0,
				maxZoom: 20,
			}),
		);
		if (opts.terrain) {
			const tcfg = createTerrainOverlayTileConfig();
			layers.push(
				new google.maps.ImageMapType({
					getTileUrl: (coord: TileCoord, zoom: number) =>
						buildTileUrl(tcfg, coord.x, coord.y, zoom),
					tileSize,
					minZoom: 0,
					maxZoom: 20,
				}),
			);
		}
	} else if (opts.type === "osm") {
		layers.push(
			new google.maps.ImageMapType({
				getTileUrl: (coord: TileCoord, zoom: number) =>
					`https://tile.openstreetmap.org/${zoom}/${coord.x}/${coord.y}.png`,
				tileSize,
				minZoom: 0,
				maxZoom: 19,
			}),
		);
	} else {
		if (opts.terrain) {
			if (legacyMap) {
				const cfg = createLegacyTerrainTileConfig();
				layers.push(
					new google.maps.ImageMapType({
						getTileUrl: (coord: TileCoord, zoom: number) =>
							buildStyledTileUrl(cfg, LEGACY_STYLE_MAP_ID, coord.x, coord.y, zoom),
						tileSize,
						minZoom: 0,
						maxZoom: 20,
					}),
				);
			} else {
				const cfg = createTerrainBasemapTileConfig([
					{ elementType: "labels", stylers: [{ visibility: "off" }] },
					{
						elementType: "geometry.stroke",
						featureType: "administrative",
						stylers: [{ visibility: "off" }],
					},
					...extraStyles,
				]);
				layers.push(
					new google.maps.ImageMapType({
						getTileUrl: (coord: TileCoord, zoom: number) =>
							buildTileUrl(cfg, coord.x, coord.y, zoom),
						tileSize,
						minZoom: 0,
						maxZoom: 20,
					}),
				);
			}
		} else if (legacyMap) {
			const cfg = createLegacyTileConfig(extraStyles);
			layers.push(
				new google.maps.ImageMapType({
					getTileUrl: (coord: TileCoord, zoom: number) =>
						buildStyledTileUrl(cfg, LEGACY_STYLE_MAP_ID, coord.x, coord.y, zoom),
					tileSize,
					minZoom: 0,
					maxZoom: 20,
				}),
			);
		} else {
			const cfg = createRoadmapTileConfig(extraStyles);
			layers.push(
				new google.maps.ImageMapType({
					getTileUrl: (coord: TileCoord, zoom: number) => buildTileUrl(cfg, coord.x, coord.y, zoom),
					tileSize,
					minZoom: 0,
					maxZoom: 20,
				}),
			);
		}
	}

	const showOfficial = opts.coverageType === "official" || opts.coverageType === "default";
	const showUnofficial = opts.coverageType === "unofficial" || opts.coverageType === "default";
	const svCfg = opts.useBlobby
		? createSvBlobbyTileConfig({
				showOfficial,
				showUnofficial,
				color: opts.color,
			})
		: createSvTileConfig({
				showOfficial,
				showUnofficial,
				color: opts.color,
				thickness: opts.thickness,
			});
	const svLayer = new google.maps.ImageMapType({
		getTileUrl: (coord: TileCoord, zoom: number) => buildTileUrl(svCfg, coord.x, coord.y, zoom),
		tileSize,
		minZoom: 0,
		maxZoom: 20,
	});
	const blobbySingleType = opts.useBlobby && !(showOfficial && showUnofficial);
	svLayer.setOpacity(blobbySingleType ? opts.svOpacity * 0.6 : opts.svOpacity);
	layers.push(svLayer);

	if (opts.labels && opts.type !== "osm") {
		const labelCfg =
			opts.type === "satellite"
				? createSatelliteLabelsTileConfig(extraStyles) : createLabelsTileConfig(extraStyles);
		layers.push(
			new google.maps.ImageMapType({
				getTileUrl: (coord: TileCoord, zoom: number) =>
					buildTileUrl(labelCfg, coord.x, coord.y, zoom),
				tileSize,
				minZoom: 0,
				maxZoom: 20,
			}),
		);
	}

	return { mapType: createCompositeMapType(layers), svLayer };
}

export function resolveStackForPrefs(
	prefs: MapEmbedPrefs,
	opts: { useBlobby: boolean; customStyles: CustomStyle[] },
): MapStackResult {
	const custom = opts.customStyles.find((s) => s.name === prefs.mapStyleName);
	return buildMapStack(
		mapStackOptsFromPrefs(prefs, { useBlobby: opts.useBlobby, customStyles: custom?.style }),
	);
}
