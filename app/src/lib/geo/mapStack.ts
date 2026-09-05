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
import { BLOBBY_ZOOM_THRESHOLD } from "@/lib/sv/constants";
import { createCompositeMapType, type TileLayer } from "@/lib/geo/stackedMapType";
import { svLayerOpacity, type MapEmbedPrefs } from "@/store/mapEmbedPrefs";

export interface CustomStyle {
	name: string;
	style: MapStyle[];
}

export const CUSTOM_STYLES_KEY = "mma_custom_styles";

interface BuildOpts {
	customStyles?: MapStyle[];
}

export interface SvTileSource {
	url(x: number, y: number, z: number): string;
	/** Effective opacity of a tile at z. */
	opacity(z: number): number;
	/** Change-detection identity. */
	key: string;
}

/** SV coverage as a per-tile source. */
export function createSvTileSource(prefs: MapEmbedPrefs): SvTileSource {
	const showOfficial = prefs.svCoverageType === "official" || prefs.svCoverageType === "default";
	const showUnofficial =
		prefs.svCoverageType === "unofficial" || prefs.svCoverageType === "default";
	const line = createSvTileConfig({
		showOfficial,
		showUnofficial,
		color: prefs.svColor,
		thickness: prefs.svThickness,
	});
	const blobby = prefs.svBlobby
		? createSvBlobbyTileConfig({ showOfficial, showUnofficial, color: prefs.svColor })
		: null;
	const blobbyAt = (z: number) => blobby !== null && z <= BLOBBY_ZOOM_THRESHOLD;
	const url = (x: number, y: number, z: number) =>
		buildTileUrl(blobbyAt(z) ? blobby! : line, x, y, z);
	const opacity = svLayerOpacity(prefs);
	const dimmed = prefs.svCoverageType !== "default" ? opacity * 0.6 : opacity;
	return {
		url,
		opacity: (z) => (blobbyAt(z) ? dimmed : opacity),
		key: url(0, 0, 0) + url(0, 0, BLOBBY_ZOOM_THRESHOLD + 1),
	};
}

export function buildMapStack(prefs: MapEmbedPrefs, opts: BuildOpts): google.maps.ImageMapType {
	const layers: TileLayer[] = [];
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
		layers.push({ url: (x, y, z) => buildTileUrl(cfg, x, y, z) });
		if (prefs.showTerrain) {
			const tcfg = createTerrainOverlayTileConfig();
			layers.push({ url: (x, y, z) => buildTileUrl(tcfg, x, y, z) });
		}
	} else if (prefs.mapType === "osm") {
		layers.push({
			url: (x, y, z) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
			maxZoom: 19,
		});
	} else if (prefs.showTerrain) {
		if (legacyMap) {
			const cfg = createLegacyTerrainTileConfig();
			layers.push({ url: (x, y, z) => buildStyledTileUrl(cfg, LEGACY_STYLE_MAP_ID, x, y, z) });
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
			layers.push({ url: (x, y, z) => buildTileUrl(cfg, x, y, z) });
		}
	} else if (legacyMap) {
		const cfg = createLegacyTileConfig(extraStyles);
		layers.push({ url: (x, y, z) => buildStyledTileUrl(cfg, LEGACY_STYLE_MAP_ID, x, y, z) });
	} else {
		const cfg = createRoadmapTileConfig(extraStyles);
		layers.push({ url: (x, y, z) => buildTileUrl(cfg, x, y, z) });
	}

	// A hidden coverage layer is left out entirely rather than stacked at zero alpha
	const sv = createSvTileSource(prefs);
	if (svLayerOpacity(prefs) > 0) layers.push({ url: sv.url, opacity: sv.opacity });

	if (prefs.showLabels && prefs.mapType !== "osm") {
		const labelCfg =
			prefs.mapType === "satellite"
				? createSatelliteLabelsTileConfig(extraStyles)
				: createLabelsTileConfig(extraStyles);
		layers.push({ url: (x, y, z) => buildTileUrl(labelCfg, x, y, z) });
	}

	return createCompositeMapType(layers);
}

export function resolveStackForPrefs(
	prefs: MapEmbedPrefs,
	opts: { customStyles: CustomStyle[] },
): google.maps.ImageMapType {
	const custom = opts.customStyles.find((s) => s.name === prefs.mapStyleName);
	return buildMapStack(prefs, { customStyles: custom?.style });
}
