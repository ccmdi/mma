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
import type { MapEmbedPrefs } from "@/store/mapEmbedPrefs";

export interface MapStackResult {
	mapType: google.maps.ImageMapType;
	svLayer: google.maps.ImageMapType;
}

export interface CustomStyle {
	name: string;
	style: MapStyle[];
}

export const CUSTOM_STYLES_KEY = "mma_custom_styles";

interface BuildOpts {
	useBlobby: boolean;
	customStyles?: MapStyle[];
}

/** SV coverage tile config for the current prefs; shared by the Google raster stack
 *  and the MapLibre raster overlay. */
export function createSvConfigForPrefs(prefs: MapEmbedPrefs, useBlobby: boolean) {
	const showOfficial = prefs.svCoverageType === "official" || prefs.svCoverageType === "default";
	const showUnofficial =
		prefs.svCoverageType === "unofficial" || prefs.svCoverageType === "default";
	return useBlobby
		? createSvBlobbyTileConfig({
				showOfficial,
				showUnofficial,
				color: prefs.svColor,
			})
		: createSvTileConfig({
				showOfficial,
				showUnofficial,
				color: prefs.svColor,
				thickness: prefs.svThickness,
			});
}

export function buildMapStack(prefs: MapEmbedPrefs, opts: BuildOpts): MapStackResult {
	const tileSize = new google.maps.Size(256, 256);
	const layers: google.maps.ImageMapType[] = [];
	const legacyMap = prefs.mapStyleName === "legacy" && prefs.mapType === "map";

	const extraStyles: MapStyle[] = [];
	const builtinStyles = BUILTIN_STYLE_MAP[prefs.mapStyleName as keyof typeof BUILTIN_STYLE_MAP];
	if (builtinStyles) {
		extraStyles.push(...builtinStyles);
	} else if (opts.customStyles) {
		extraStyles.push(...opts.customStyles);
	}
	if (prefs.boldCountryBorders) {
		const s: Record<string, string | number> = { weight: 2 };
		if (prefs.mapStyleName === "default") s.color = "#000000";
		extraStyles.push({
			featureType: "administrative.country",
			elementType: "geometry.stroke",
			stylers: [s],
		});
	}
	if (prefs.boldSubdivisionBorders) {
		extraStyles.push({
			featureType: "administrative.province",
			elementType: "geometry.stroke",
			stylers: [{ weight: 3 }],
		});
	}
	if (prefs.hideRoadLabels) {
		extraStyles.push({
			featureType: "road",
			elementType: "labels",
			stylers: [{ visibility: "off" }],
		});
	}
	if (prefs.hidePoi) {
		extraStyles.push({ featureType: "poi", stylers: [{ visibility: "off" }] });
	}
	if (prefs.hideTransit) {
		extraStyles.push({ featureType: "transit", stylers: [{ visibility: "off" }] });
	}
	if (prefs.hideHighways) {
		extraStyles.push({
			featureType: "road.highway",
			elementType: "geometry",
			stylers: [{ visibility: "off" }],
		});
	}

	if (prefs.mapType === "satellite") {
		const cfg = createSatelliteTileConfig();
		layers.push(
			new google.maps.ImageMapType({
				getTileUrl: (coord: TileCoord, zoom: number) => buildTileUrl(cfg, coord.x, coord.y, zoom),
				tileSize,
				minZoom: 0,
				maxZoom: 20,
			}),
		);
		if (prefs.showTerrain) {
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
	} else if (prefs.mapType === "osm") {
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
		if (prefs.showTerrain) {
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

	const showOfficial = prefs.svCoverageType === "official" || prefs.svCoverageType === "default";
	const showUnofficial =
		prefs.svCoverageType === "unofficial" || prefs.svCoverageType === "default";
	const svCfg = createSvConfigForPrefs(prefs, opts.useBlobby);
	const svLayer = new google.maps.ImageMapType({
		getTileUrl: (coord: TileCoord, zoom: number) => buildTileUrl(svCfg, coord.x, coord.y, zoom),
		tileSize,
		minZoom: 0,
		maxZoom: 20,
	});
	const blobbySingleType = opts.useBlobby && !(showOfficial && showUnofficial);
	svLayer.setOpacity(blobbySingleType ? prefs.svOpacity * 0.6 : prefs.svOpacity);
	layers.push(svLayer);

	if (prefs.showLabels && prefs.mapType !== "osm") {
		const labelCfg =
			prefs.mapType === "satellite"
				? createSatelliteLabelsTileConfig(extraStyles)
				: createLabelsTileConfig(extraStyles);
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
	return buildMapStack(prefs, { useBlobby: opts.useBlobby, customStyles: custom?.style });
}
