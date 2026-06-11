import { useEffect, useRef, useCallback, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { GoogleMapsOverlay } from "@deck.gl/google-maps";
import type { GoogleMapsOverlayProps } from "@deck.gl/google-maps";
import type { PickingInfo, Layer, Position } from "@deck.gl/core";
type OverlayEvent = { srcEvent?: { domEvent?: Event } };
import { ScatterplotLayer, PolygonLayer, PathLayer, LineLayer } from "@deck.gl/layers";
import { mdiGoogleStreetView, mdiMapMarker } from "@mdi/js";
import SDFMarkerLayer from "@/lib/render/sdf-marker-layer/SDFMarkerLayer";
import { Icon } from "@/components/primitives/Icon";

function normalizeRing<T extends number[]>(ring: T[]): T[] {
	const crosses = ring.some((p) => p[0] > 180 || p[0] < -180) ||
		ring.some((_, i, a) => i > 0 && Math.abs(a[i][0] - a[i - 1][0]) > 180);
	if (!crosses) return ring;
	return ring.map((p) => {
		const out = [...p] as unknown as T;
		if (out[0] < 0) out[0] += 360;
		return out;
	});
}

function normalizePolygonCoords<T extends number[]>(coords: T[][]): T[][] {
	return coords.map(normalizeRing);
}
import { lookupStreetView, svThumbnailUrl, showToast, svSearchRadius } from "@/lib/sv/lookup";
import { cmd } from "@/lib/commands";
import { mmaBufUrl } from "@/lib/util/util";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { useSetting } from "@/store/settings";
import { CellManager } from "@/lib/render/CellManager";
import {
	useMeasure,
	useLatLngAnchor,
	useScoreMaxError,
	openContextMenuLatLng,
	openContextMenuLocation,
} from "@/lib/sv/measure";
import { MeasurementBar } from "@/components/primitives/MeasurementBar";
import { MapContextMenuContent } from "@/components/editor/map/MapContextMenu";
import {
	useCurrentMap,
	useMapVersion,
	useSelectedLocationIds,
	useSelectedTagIds,
	useSelections,
	useActiveLocation,
	toggleManualSelection,
	selectPolygon,
	setActiveLocation,
	addLocations,
	getWorkArea,
	getSelectedLocationIds,
	useImportMarkerVersion,
	getImportPreviewPositions,
	useDiffMarkerVersion,
	getCommitDiffPreview,
	renderDeltaBus,
	selBitmaskBus,
	mapOpenMark,
} from "@/store/useMapStore";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import { useTrailVersion, getTrail } from "@/lib/sv/svTrail";
import {
	setGoogleMap as setGoogleMapInstance,
	getGoogleMap as getGoogleMapInstance,
	tryInterceptClick,
	tryInterceptDraw,
} from "@/lib/map/mapState";
import { useHotkey, parseHotkey, matchesKey, isEditableElement } from "@/lib/hooks/useHotkey";
import { useBinding, getBinding } from "@/lib/util/hotkeys";
import { useSettings } from "@/store/settings";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { PolygonTools } from "@/components/editor/PolygonTools";
import { boundsToTiles, fetchPanoDots, type PanoDot } from "@/lib/geo/photometa";

import {
	buildTileUrl,
	createRoadmapTileConfig,
	createLabelsTileConfig,
	createSatelliteTileConfig,
	createSvTileConfig,
	createSvBlobbyTileConfig,
	createTerrainBasemapTileConfig,
	createTerrainOverlayTileConfig,
	type MapStyle,
} from "@/lib/geo/tiles";
import type { Location } from "@/types";
import { SearchControl } from "@/components/editor/map/SearchControl";
import {
	MapTypeDropdown,
	MapSettingsDropdown,
	type SvCoverageType,
	type SvThickness,
	type MarkerStyle,
} from "@/components/editor/map/MapSettingsPanel";
import type { SvColor, MapTypeKey } from "@/components/editor/map/mapSettingsTypes";
import { useMapSetting } from "@/components/editor/map/useMapSetting";

const DARK_MODE_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#242f3e" }] },
	{ elementType: "geometry.stroke", stylers: [{ color: "#cccccc" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#d59563" }],
	},
	{
		featureType: "poi",
		elementType: "labels.text.fill",
		stylers: [{ color: "#d59563" }],
	},
	{
		featureType: "poi.park",
		elementType: "geometry",
		stylers: [{ color: "#263c3f" }],
	},
	{
		featureType: "poi.park",
		elementType: "labels.text.fill",
		stylers: [{ color: "#6b9a76" }],
	},
	{
		featureType: "road",
		elementType: "geometry",
		stylers: [{ color: "#38414e" }],
	},
	{
		featureType: "road",
		elementType: "geometry.stroke",
		stylers: [{ color: "#212a37" }],
	},
	{
		featureType: "road",
		elementType: "labels.text.fill",
		stylers: [{ color: "#9ca5b3" }],
	},
	{
		featureType: "road.highway",
		elementType: "geometry",
		stylers: [{ color: "#746855" }],
	},
	{
		featureType: "road.highway",
		elementType: "geometry.stroke",
		stylers: [{ color: "#1f2835" }],
	},
	{
		featureType: "road.highway",
		elementType: "labels.text.fill",
		stylers: [{ color: "#f3d19c" }],
	},
	{
		featureType: "transit",
		elementType: "geometry",
		stylers: [{ color: "#2f3948" }],
	},
	{
		featureType: "transit.station",
		elementType: "labels.text.fill",
		stylers: [{ color: "#d59563" }],
	},
	{
		featureType: "water",
		elementType: "geometry",
		stylers: [{ color: "#17263c" }],
	},
	{
		featureType: "water",
		elementType: "labels.text.fill",
		stylers: [{ color: "#515c6d" }],
	},
	{
		featureType: "water",
		elementType: "labels.text.stroke",
		stylers: [{ color: "#17263c" }],
	},
];

function waitForTileLoad(el: Element): Promise<void> {
	return new Promise((resolve) => {
		google.maps.event.addListenerOnce(el, "load", resolve);
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-created class
let StackedMapType: any = null;

function initStackedMapType() {
	if (StackedMapType) return;
	StackedMapType = class extends google.maps.ImageMapType {
		layers: google.maps.ImageMapType[];
		constructor(layers: google.maps.ImageMapType[], opts: google.maps.ImageMapTypeOptions) {
			super({ ...opts, getTileUrl: () => null });
			this.layers = layers;
		}
		getTile(coord: google.maps.Point | null, zoom: number, doc: Document | null) {
			if (!coord || !doc) return null;
			const tiles = this.layers.map((l) => l.getTile(coord, zoom, doc)!);
			const div = doc.createElement("div");
			div.append(...tiles.filter(Boolean));
			Promise.all(tiles.filter((t): t is Element => t != null).map(waitForTileLoad)).then(() => {
				google.maps.event.trigger(div, "load");
			});
			return div;
		}
		releaseTile(el: HTMLElement) {
			let i = 0;
			for (let j = 0; j < el.children.length; j++) {
				const child = el.children[j];
				if (child instanceof HTMLElement) {
					this.layers[i]?.releaseTile(child);
					i++;
				}
			}
		}
	};
}

function createCompositeMapType(layers: google.maps.ImageMapType[]): google.maps.ImageMapType {
	initStackedMapType();
	return new StackedMapType(layers, {
		tileSize: new google.maps.Size(256, 256),
		minZoom: 0,
		maxZoom: 20,
	});
}

const LOCATION_LAYER_ID = "locations";
const isLocationLayer = (id?: string) =>
	id?.startsWith(LOCATION_LAYER_ID) || id?.startsWith("cell:") || id?.startsWith("sel-overlay:");
const PERFECT_SCORE_LAYER_ID = "perfect-score";

interface MapEmbedPrefs {
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
	mapStyleName: string;
	mapType: MapTypeKey;
	markerStyle: MarkerStyle;
	markerOpacity: number;
	showPerfectScoreCircle: boolean;
	showPreviews: boolean;
	selectOnly: boolean;
}

const DEFAULT_PREFS: MapEmbedPrefs = {
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
	mapStyleName: "default",
	mapType: "map",
	markerStyle: "pin",
	markerOpacity: 1,
	showPerfectScoreCircle: true,
	showPreviews: false,
	selectOnly: false,
};

function FpsCounter() {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let frames = 0;
		let last = performance.now();
		let rafId = 0;
		const tick = () => {
			frames++;
			const now = performance.now();
			if (now - last >= 1000) {
				if (ref.current) ref.current.textContent = `${frames} fps`;
				frames = 0;
				last = now;
			}
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
	}, []);
	return (
		<div
			ref={ref}
			style={{
				position: "absolute",
				top: 8,
				right: 8,
				zIndex: 999,
				background: "rgba(0,0,0,0.7)",
				color: "#0f0",
				padding: "2px 6px",
				fontSize: 12,
				fontFamily: "monospace",
				borderRadius: 3,
				pointerEvents: "none",
			}}
		/>
	);
}

export function MapEmbed() {
	const map = useCurrentMap();
	const mapVer = useMapVersion();

	const selected = useSelectedLocationIds();
	const selectedTags = useSelectedTagIds();
	const allSelections = useSelections();
	const activeLocation = useActiveLocation();
	const trailVersion = useTrailVersion();
	const importMarkerVersion = useImportMarkerVersion();
	const diffMarkerVersion = useDiffMarkerVersion();
	const containerRef = useRef<HTMLDivElement>(null);
	const cellMgrRef = useRef(new CellManager());
	const [renderTick, setRenderTick] = useState(0);
	const gMapRef = useRef<google.maps.Map>(null);
	const overlayRef = useRef<GoogleMapsOverlay | null>(null);
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const selectedTagsRef = useRef(selectedTags);
	selectedTagsRef.current = selectedTags;
	const activeLocRef = useRef(activeLocation);
	activeLocRef.current = activeLocation;
	const prevActiveRef = useRef<number | null>(null);
	const mapDataRef = useRef(map);
	mapDataRef.current = map;

	const gRef = useRef<Google>(null);
	const svSettingsRef = useRef({
		preferOfficial: false,
		onlyOfficial: false,
		pointAlongRoad: true,
		preferDirection: null as string | null,
		defaultPanoId: false,
		preferHigherQuality: false,
		minRadius: undefined as number | undefined,
	});
	const [prefs, setPrefs] = useLocalStorage<MapEmbedPrefs>("mapEmbedPrefs", DEFAULT_PREFS);
	const pref =
		<K extends keyof MapEmbedPrefs>(k: K) =>
		(v: MapEmbedPrefs[K]) =>
			setPrefs((p) => ({ ...p, [k]: v }));
	const {
		svOpacity,
		svColor,
		showLabels,
		showTerrain,
		svPanoramas,
		svCoverageType,
		svThickness,
		svBlobby,
		boldCountryBorders,
		boldSubdivisionBorders,
		mapStyleName,
		mapType,
		markerStyle,
		markerOpacity,
		showPerfectScoreCircle,
		showPreviews,
		selectOnly,
	} = prefs;
	const setSvOpacity = pref("svOpacity");
	const setMarkerOpacity = pref("markerOpacity");
	const setSvColor = pref("svColor");
	const setShowLabels = pref("showLabels");
	const setShowTerrain = pref("showTerrain");
	const setSvPanoramas = pref("svPanoramas");
	const setSvCoverageType = pref("svCoverageType");
	const setSvThickness = pref("svThickness");
	const setSvBlobby = pref("svBlobby");
	const setBoldCountryBorders = pref("boldCountryBorders");
	const setBoldSubdivisionBorders = pref("boldSubdivisionBorders");
	const setMapStyleName = pref("mapStyleName");
	const setMapType = pref("mapType");
	const setMarkerStyle = pref("markerStyle");
	const setShowPerfectScoreCircle = pref("showPerfectScoreCircle");
	const setShowPreviews = pref("showPreviews");
	const setSelectOnly = pref("selectOnly");
	const selectOnlyRef = useRef(selectOnly);
	selectOnlyRef.current = selectOnly;
	const coordDisplayRef = useRef<HTMLSpanElement>(null);
	const [mapZoom, setMapZoom] = useState(2);
	const scoreMaxError = useScoreMaxError();
	const activeLocationColor = useSetting("activeLocationColor");
	const importPreviewColor = useSetting("importPreviewColor");

	const [pointAlongRoad] = useMapSetting("pointAlongRoad");
	const [preferDirection] = useMapSetting("preferDirection");
	const [preferOfficial] = useMapSetting("preferOfficial");
	const [onlyOfficial] = useMapSetting("onlyOfficial");
	const [preferHigherQuality] = useMapSetting("preferHigherQuality");
	const [defaultPanoId] = useMapSetting("defaultPanoId");
	const [searchRadius] = useMapSetting("searchRadius");
	const [customStyles, setCustomStyles] = useState<{ name: string; style: MapStyle[] }[]>(() => {
		try {
			return JSON.parse(localStorage.getItem("mma_custom_styles") ?? "[]");
		} catch {
			return [];
		}
	});
	const [showStylesDialog, setShowStylesDialog] = useState(false);
	const [svPreview, setSvPreview] = useState<{
		url: string;
		date?: string;
	} | null>(null);
	const previewAbortRef = useRef<AbortController | null>(null);
	const [panoDots, setPanoDots] = useState<PanoDot[]>([]);
	const [opacityTarget, setOpacityTarget] = useState<"sv" | "markers">("sv");
	const [mapReady, setMapReady] = useState(false);
	const freehandPathRef = useRef<number[][] | null>(null);
	const contextTriggerRef = useRef<HTMLSpanElement>(null);
	const { isMeasuring } = useMeasure();
	const latLngAnchor = useLatLngAnchor();
	const latLngAnchorRef = useRef(latLngAnchor);
	latLngAnchorRef.current = latLngAnchor;
	svSettingsRef.current = {
		preferOfficial,
		onlyOfficial,
		pointAlongRoad,
		preferDirection,
		defaultPanoId,
		preferHigherQuality,
		minRadius: searchRadius ?? undefined,
	};

	// Earcut tessellation of selection polygons is expensive and runs on every
	// buildLayers call if the data reference changes. Cache the normalized fill/stroke
	// arrays keyed by selection, invalidating only when the geometry object changes, so
	// deck.gl reuses the same reference and re-tessellates once per geometry, not per render.
	const polygonGeomCache = useRef(
		new Map<string, { poly: object; fill: Position[][][]; stroke: Position[][] }>(),
	);

	const buildLayers = useCallback(() => {
		const m = mapDataRef.current;
		if (!m) {
			return [];
		}

		const layers: Layer[] = [];

		// Commit-diff overlay temporarily replaces the regular markers.
		if (getWorkArea() === "diff") {
			const diff = getCommitDiffPreview();
			if (diff) {
				const diffLayer = (id: string, pos: Float32Array, color: [number, number, number, number]) =>
					new ScatterplotLayer({
						id,
						data: { length: pos.length / 2, attributes: { getPosition: { value: pos, size: 2 } } },
						getRadius: 5,
						radiusUnits: "pixels" as const,
						radiusMinPixels: 3,
						getFillColor: color,
						stroked: false,
						pickable: false,
					});
				if (diff.removed.length) layers.push(diffLayer("diff-removed", diff.removed, [239, 68, 68, 210]));
				if (diff.added.length) layers.push(diffLayer("diff-added", diff.added, [34, 197, 94, 210]));
				if (diff.modified.length)
					layers.push(diffLayer("diff-modified", diff.modified, [245, 158, 11, 220]));
			}
			return layers;
		}

		const polygonSels = allSelections.flatMap((sel) =>
			sel.props.type === "Intersection" ? sel.props.selections : [sel],
		);
		const livePolygonKeys = new Set<string>();
		for (const sel of polygonSels) {
			if (sel.props.type !== "Polygon") continue;
			const poly = sel.props.polygon;
			livePolygonKeys.add(sel.key);
			let geom = polygonGeomCache.current.get(sel.key);
			if (!geom || geom.poly !== poly) {
				const fill = [poly.coordinates, ...(poly.extraPolygons ?? [])].map(normalizePolygonCoords);
				geom = { poly, fill, stroke: fill.flatMap((p) => p) as Position[][] };
				polygonGeomCache.current.set(sel.key, geom);
			}
			const fillColor: [number, number, number, number] = [...sel.color, 26];
			const strokeColor: [number, number, number, number] = [...sel.color, 153];
			layers.push(
				new PolygonLayer<Position[][]>({
					id: `selectionPolygonFill:${sel.key}`,
					data: geom.fill,
					getPolygon: (d) => d,
					getFillColor: fillColor,
					stroked: false,
					pickable: false,
					opacity: 1,
				}),
				new PathLayer<Position[]>({
					id: `selectionPolygonStroke:${sel.key}`,
					data: geom.stroke,
					getPath: (d) => d,
					getColor: strokeColor,
					getWidth: 4,
					widthUnits: "pixels",
					jointRounded: true,
					pickable: false,
					opacity: 1,
				}),
			);
		}
		for (const k of polygonGeomCache.current.keys()) {
			if (!livePolygonKeys.has(k)) polygonGeomCache.current.delete(k);
		}

		const cm = cellMgrRef.current;
		const activeId = activeLocRef.current?.id ?? null;
		// Sync bridge: restore old active's visibility while Rust's state catches up.
		// store_set_active keeps Rust in sync (fire-and-forget), no full re-render.
		if (prevActiveRef.current != null && prevActiveRef.current !== activeId) {
			const prevId = prevActiveRef.current;
			if (!getSelectedLocationIds().has(prevId)) {
				for (const cb of cm.cells.values()) {
					const idx = cb.idToIndex.get(prevId);
					if (idx != null) {
						cb.patchColor(idx, 42, 42, 42, 255);
						break;
					}
				}
			}
		}
		prevActiveRef.current = activeId;
		if (activeId != null) {
			for (const cb of cm.cells.values()) {
				const idx = cb.idToIndex.get(activeId);
				if (idx != null) {
					cb.patchColor(idx, 0, 0, 0, 0);
					break;
				}
			}
		}
		if (markerOpacity > 0 && cm.totalCount > 0) {
			for (const [cellKey, cell] of cm.cells) {
				if (cell.count === 0) continue;
				if (markerStyle === "circle") {
					layers.push(
						new ScatterplotLayer({
							id: `cell:${cellKey}:s`,
							data: {
								length: cell.count,
								attributes: {
									getPosition: { value: cell.positions, size: 2 },
									getFillColor: { value: cell.colors, size: 4 },
								},
							},
							getRadius: 6,
							radiusUnits: "pixels",
							radiusMinPixels: 3,
							opacity: markerOpacity,
							pickable: true,
							updateTriggers: {
								opacity: [markerOpacity],
								getFillColor: [cell.colorVersion],
								getPosition: [cell.positionVersion],
							},
						}),
					);
				} else if (markerStyle === "arrow") {
					layers.push(
						new SDFMarkerLayer({
							id: `cell:${cellKey}:d`,
							data: {
								length: cell.count,
								attributes: {
									getPosition: { value: cell.positions, size: 2 },
									getFillColor: { value: cell.colors, size: 4 },
									getAngle: { value: cell.angles, size: 1 },
								},
							},
							shape: "arrow",
							radiusPixels: 12,
							opacity: markerOpacity,
							pickable: true,
							updateTriggers: {
								opacity: [markerOpacity],
								getFillColor: [cell.colorVersion],
								getPosition: [cell.positionVersion],
								getAngle: [cell.positionVersion],
							},
						}),
					);
				} else {
					layers.push(
						new SDFMarkerLayer({
							id: `cell:${cellKey}:d`,
							data: {
								length: cell.count,
								attributes: {
									getPosition: { value: cell.positions, size: 2 },
									getFillColor: { value: cell.colors, size: 4 },
								},
							},
							shape: "pin",
							radiusPixels: 16,
							opacity: markerOpacity,
							pickable: true,
							updateTriggers: {
								opacity: [markerOpacity],
								getFillColor: [cell.colorVersion],
								getPosition: [cell.positionVersion],
							},
						}),
					);
				}
			}
		}

		if (cm.selOverlayCount > 0) {
			if (markerStyle === "circle") {
				layers.push(
					new ScatterplotLayer({
						id: "sel-overlay:s",
						data: {
							length: cm.selOverlayCount,
							attributes: {
								getPosition: { value: cm.selOverlayPositions, size: 2 },
								getFillColor: { value: cm.selOverlayColors, size: 4 },
							},
						},
						getRadius: 6,
						radiusUnits: "pixels",
						radiusMinPixels: 3,
						// Selection overlay is drawn on top of the cell markers, so it must also be pickable on
						// top — otherwise clicks fall through to the cell layer where selected markers have no
						// z-priority, and an overlapping neighbor gets picked instead of the marker on top.
						pickable: true,
						updateTriggers: {
							getFillColor: [cm.selOverlayVersion],
							getPosition: [cm.selOverlayVersion],
						},
					}),
				);
			} else if (markerStyle === "arrow") {
				layers.push(
					new SDFMarkerLayer({
						id: "sel-overlay:d",
						data: {
							length: cm.selOverlayCount,
							attributes: {
								getPosition: { value: cm.selOverlayPositions, size: 2 },
								getFillColor: { value: cm.selOverlayColors, size: 4 },
								getAngle: { value: cm.selOverlayAngles, size: 1 },
							},
						},
						shape: "arrow",
						radiusPixels: 12,
						pickable: true,
						updateTriggers: {
							getFillColor: [cm.selOverlayVersion],
							getPosition: [cm.selOverlayVersion],
							getAngle: [cm.selOverlayVersion],
						},
					}),
				);
			} else {
				layers.push(
					new SDFMarkerLayer({
						id: "sel-overlay:d",
						data: {
							length: cm.selOverlayCount,
							attributes: {
								getPosition: { value: cm.selOverlayPositions, size: 2 },
								getFillColor: { value: cm.selOverlayColors, size: 4 },
							},
						},
						shape: "pin",
						radiusPixels: 16,
						pickable: true,
						updateTriggers: {
							getFillColor: [cm.selOverlayVersion],
							getPosition: [cm.selOverlayVersion],
						},
					}),
				);
			}
		}

		if (activeLocRef.current && cm.totalCount > 0) {
			const activeLoc = activeLocRef.current;
			const activeColor: [number, number, number, number] = [
				activeLocationColor.r,
				activeLocationColor.g,
				activeLocationColor.b,
				255,
			];
			if (markerStyle === "arrow") {
				layers.push(
					new SDFMarkerLayer<Location>({
						id: `${LOCATION_LAYER_ID}-current-sdf`,
						data: [activeLoc],
						getPosition: (d) => [d.lng, d.lat],
						shape: "arrow",
						radiusPixels: 12,
						getFillColor: activeColor,
						getAngle: (d: Location) => 180 - d.heading,
						pickable: true,
						updateTriggers: {
							getAngle: [markerStyle],
						},
					}),
				);
			} else if (markerStyle === "circle") {
				layers.push(
					new ScatterplotLayer<Location>({
						id: `${LOCATION_LAYER_ID}-current-scatter`,
						data: [activeLoc],
						getPosition: (d) => [d.lng, d.lat],
						getRadius: 6,
						radiusUnits: "pixels",
						radiusMinPixels: 3,
						getFillColor: activeColor,
						pickable: true,
					}),
				);
			} else {
				layers.push(
					new SDFMarkerLayer<Location>({
						id: `${LOCATION_LAYER_ID}-current-sdf`,
						data: [activeLoc],
						getPosition: (d) => [d.lng, d.lat],
						shape: "pin",
						radiusPixels: 16,
						getFillColor: activeColor,
						pickable: true,
					}),
				);
			}
		}

		if (showPerfectScoreCircle && activeLocRef.current && cm.totalCount > 0) {
			const loc = activeLocRef.current;
			const trail = getTrail();
			const last = trail.length ? trail[trail.length - 1] : null;
			const center = last ? { lng: last[0], lat: last[1] } : { lat: loc.lat, lng: loc.lng };
			layers.push(
				new ScatterplotLayer({
					id: PERFECT_SCORE_LAYER_ID,
					data: [center],
					getPosition: (d: { lat: number; lng: number }) => [d.lng, d.lat],
					getFillColor: [200, 0, 0, 26],
					getLineColor: [200, 0, 0, 128],
					getRadius: Math.max(25, scoreMaxError),
					radiusUnits: "meters" as const,
					stroked: true,
					filled: true,
					lineWidthPixels: 1,
					pickable: false,
				}),
			);
		}

		if (svPanoramas && panoDots.length > 0) {
			layers.push(
				new ScatterplotLayer<PanoDot>({
					id: "panorama-dots",
					data: panoDots,
					getPosition: (d) => [d.lng, d.lat],
					getFillColor: [255, 0, 0],
					getRadius: 2,
					radiusMaxPixels: 8,
					stroked: false,
					filled: true,
					opacity: 0.7,
					pickable: false,
				}),
			);
		}

		const anchor = latLngAnchorRef.current;
		if (anchor) {
			layers.push(
				new LineLayer({
					id: "lat-lng-anchor",
					visible: true,
					data: [
						{ from: [anchor.lng, 90], to: [anchor.lng, -90] },
						{ from: [-180, anchor.lat], to: [180, anchor.lat] },
					],
					pickable: false,
					getWidth: 2,
					getSourcePosition: (d) => d.from,
					getTargetPosition: (d) => d.to,
					getColor: [0, 0, 0],
				}),
			);
		}

		const freehand = freehandPathRef.current;
		if (freehand && freehand.length >= 2) {
			layers.push(
				new PathLayer({
					id: "freehand-drawing",
					data: [normalizeRing(freehand)],
					getPath: (d) => d,
					getColor: [255, 255, 255, 200],
					getWidth: 3,
					widthUnits: "pixels" as const,
					jointRounded: true,
					capRounded: true,
					pickable: false,
				}),
			);
		}

		const svTrail = getTrail();
		if (svTrail.length >= 2) {
			layers.push(
				new PathLayer({
					id: "sv-trail",
					data: [svTrail],
					getPath: (d) => d,
					getColor: [255, 0, 0],
					getWidth: 2,
					widthUnits: "pixels" as const,
					jointRounded: true,
					capRounded: true,
					pickable: false,
				}),
			);
		}

		// Staged import preview markers, non-pickable so they don't intercept clicks.
		if (getWorkArea() === "import") {
			const previewPos = getImportPreviewPositions();
			const previewCount = previewPos.length / 2;
			if (previewCount > 0) {
				layers.push(
					new ScatterplotLayer({
						id: "import-preview",
						data: {
							length: previewCount,
							attributes: { getPosition: { value: previewPos, size: 2 } },
						},
						getRadius: 6,
						radiusUnits: "pixels",
						radiusMinPixels: 3,
						getFillColor: [importPreviewColor.r, importPreviewColor.g, importPreviewColor.b, 200],
						stroked: false,
						pickable: false,
					}),
				);
			}
		}

		return layers;
	}, [
		markerOpacity,
		markerStyle,
		activeLocationColor,
		importPreviewColor,
		showPerfectScoreCircle,
		scoreMaxError,
		svPanoramas,
		panoDots,
		allSelections,
		latLngAnchor,
		renderTick,
		trailVersion,
		importMarkerVersion,
		diffMarkerVersion,
	]);

	const dispatchContextMenu = useCallback((clientX: number, clientY: number) => {
		contextTriggerRef.current?.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, clientX, clientY }),
		);
	}, []);

	const handleClick = useCallback(
		async (info: PickingInfo, event: OverlayEvent) => {
			const domEvent = event?.srcEvent?.domEvent;

			const resolvePickedLocation = async (): Promise<Location | undefined> => {
				if (info.object) return info.object as Location;
				if (typeof info.index !== "number" || info.index < 0) return undefined;
				const layerId = info.layer?.id;
				if (layerId?.startsWith("sel-overlay:")) {
					const id = cellMgrRef.current.selOverlayIds[info.index];
					if (id == null) return undefined;
					const loc = await cmd.storeGetLocation(id);
					return loc ?? undefined;
				}
				if (!layerId?.startsWith("cell:")) return undefined;
				const cellKey = layerId.split(":")[1];
				const id = cellMgrRef.current.resolvePickFromCell(cellKey, info.index);
				if (id == null) {
					const rustId: number | null = await cmd.storeResolvePick(cellKey, info.index);
					if (rustId == null) return undefined;
					const loc = await cmd.storeGetLocation(rustId);
					return loc ?? undefined;
				}
				const loc = await cmd.storeGetLocation(id);
				return loc ?? undefined;
			};

			if (domEvent instanceof MouseEvent && domEvent.button === 2) {
				if (isLocationLayer(info.layer?.id)) {
					const loc = await resolvePickedLocation();
					if (loc) {
						openContextMenuLocation(loc);
					} else if (info.coordinate) {
						openContextMenuLatLng({
							lat: info.coordinate[1],
							lng: info.coordinate[0],
						});
					}
				} else if (info.coordinate) {
					openContextMenuLatLng({
						lat: info.coordinate[1],
						lng: info.coordinate[0],
					});
				}
				dispatchContextMenu(domEvent.clientX, domEvent.clientY);
				return;
			}

			if (domEvent instanceof MouseEvent && domEvent.button !== 0) return;

			if (isLocationLayer(info.layer?.id)) {
				const loc = await resolvePickedLocation();
				if (loc) {
					if (domEvent instanceof MouseEvent && domEvent.ctrlKey) {
						toggleManualSelection(loc.id);
					} else {
						setActiveLocation(loc.id);
					}
					return;
				}
			}

			if (isMeasuring) return;

			if (info.coordinate) {
				const [lng, lat] = info.coordinate;
				if (tryInterceptClick(lat, lng)) return;
				if (getWorkArea() === "plugin") return;
				if (getWorkArea() === "import") return;
				if (getWorkArea() === "diff") return;
				if (selectOnlyRef.current) {
					if (containerRef.current) {
						showToast(containerRef.current, "Select-only mode is on.");
					}
					return;
				}
				const g = gRef.current;
				if (!g) return;
				const currentZoom = gMapRef.current?.getZoom() ?? 2;
				const t = trace("add");
				const loc = await lookupStreetView(lat, lng, currentZoom, svSettingsRef.current);
				if (!loc) {
					if (containerRef.current) {
						showToast(containerRef.current, "No coverage found at this location.");
					}
					return;
				}
				t.step("lookup");
				await addLocations([loc], { hideInDelta: true });
				t.step("addLocations");
				setActiveLocation(loc.id);
				t.step("setActive");
				t.end();
			}
		},
		[isMeasuring, dispatchContextMenu],
	);

	const handleHover = useCallback((info: PickingInfo, event: OverlayEvent) => {
		const hasObject =
			info.object != null ||
			(isLocationLayer(info.layer?.id) === true &&
				typeof info.index === "number" &&
				info.index >= 0);
		const domEvent = event?.srcEvent?.domEvent;
		if (domEvent instanceof MouseEvent) {
			const target = domEvent.target as HTMLElement | null;
			if (target) target.style.cursor = hasObject ? "pointer" : "";
		}
	}, []);

	const svLayerRef = useRef<google.maps.ImageMapType>(null);

	const buildMapStack = useCallback(
		(opts: {
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
		}) => {
			const tileSize = new google.maps.Size(256, 256);
			const layers: google.maps.ImageMapType[] = [];

			const extraStyles: MapStyle[] = [];
			if (opts.style === "darkMode") {
				extraStyles.push(...DARK_MODE_STYLES);
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
						getTileUrl: (coord: TileCoord, zoom: number) =>
							buildTileUrl(cfg, coord.x, coord.y, zoom),
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
				} else {
					const cfg = createRoadmapTileConfig(extraStyles);
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
			svLayer.setOpacity(blobbySingleType ? svOpacity * 0.6 : svOpacity);
			svLayerRef.current = svLayer;
			layers.push(svLayer);

			if (opts.labels && opts.type !== "osm") {
				const labelCfg = createLabelsTileConfig(extraStyles);
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

			return createCompositeMapType(layers);
		},
		[svOpacity],
	);

	useEffect(() => {
		if (!containerRef.current || !map) return;
		mapOpenMark("mounted");
		let cancelled = false;
		let rafId: number;

		loadOpenSV().then(() => {
			if (cancelled || !containerRef.current) return;
			if (!google?.maps) return;
			gRef.current = google;

			if (!gMapRef.current) {
				gMapRef.current = new google.maps.Map(containerRef.current, {
					center: { lat: 0, lng: 0 },
					zoom: 2,
					minZoom: 1,
					disableDefaultUI: true,
					scaleControl: true,
					cameraControl: false,
					zoomControl: false,
					streetViewControl: false,
					fullscreenControl: false,
					mapTypeControl: false,
					clickableIcons: false,
					gestureHandling: "greedy",
					draggableCursor: "crosshair",
					styles: [{ stylers: [{ visibility: "off" }] }],
				});

				const custom = customStyles.find((s) => s.name === mapStyleName);
				const stack = buildMapStack({
					type: mapType,
					labels: showLabels,
					terrain: showTerrain,
					color: svColor,
					coverageType: svCoverageType,
					thickness: svThickness,
					useBlobby: svBlobby,
					boldCountry: boldCountryBorders,
					boldSubdivision: boldSubdivisionBorders,
					style: mapStyleName,
					customStyles: custom?.style,
				});
				gMapRef.current.mapTypes.set("stack", stack);
				gMapRef.current.setMapTypeId("stack");
				setGoogleMapInstance(gMapRef.current);

				gMapRef.current.addListener("mousemove", (e: google.maps.MapMouseEvent) => {
					if (e.latLng) {
						if (coordDisplayRef.current) {
							coordDisplayRef.current.textContent = `${e.latLng.lat().toFixed(6)}° ${e.latLng.lng().toFixed(6)}°`;
						}
					}
				});
				gMapRef.current.addListener("zoom_changed", () => {
					setMapZoom(gMapRef.current?.getZoom() ?? 0);
				});
				setMapReady(true);
				mapOpenMark("map-ready");
				google.maps.event.addListenerOnce(gMapRef.current, "tilesloaded", () =>
					mapOpenMark("tiles"),
				);

				rafId = requestAnimationFrame(() => {
					if (cancelled) return;
					const overlay = new GoogleMapsOverlay({
						layers: [],
						pickingRadius: 2,
					});
					overlay.setMap(gMapRef.current);
					overlayRef.current = overlay;
					updateOverlay();
				});

				if (map.meta.locationCount > 0) {
					cmd.storeBounds(false).then((bounds) => {
						if (cancelled || !gMapRef.current || !bounds) return;
						const [west, south, east, north] = bounds as [number, number, number, number];
						const gm = gMapRef.current!;
						gm.fitBounds({ west, south, east, north });
						google.maps.event.addListenerOnce(gm, "bounds_changed", () => {
							gm.moveCamera({ center: gm.getCenter()!, zoom: gm.getZoom()! });
						});
					});
				}
			}
		});

		return () => {
			cancelled = true;
			if (rafId) cancelAnimationFrame(rafId);
		};
	}, []);

	useEffect(() => {
		if (!svLayerRef.current) return;
		const blobbySingleType = svBlobby && mapZoom <= 13 && svCoverageType !== "default";
		svLayerRef.current.setOpacity(blobbySingleType ? svOpacity * 0.6 : svOpacity);
	}, [svOpacity, svBlobby, mapZoom, svCoverageType]);

	useEffect(() => {
		if (!svPanoramas || !gMapRef.current || mapZoom < 15) {
			setPanoDots([]);
			return;
		}
		const map = gMapRef.current;
		let cancelled = false;
		const load = async () => {
			const bounds = map.getBounds();
			if (!bounds) return;
			const ne = bounds.getNorthEast();
			const sw = bounds.getSouthWest();
			const tiles = boundsToTiles(sw.lng(), sw.lat(), ne.lng(), ne.lat());
			const results = await Promise.all(tiles.map(fetchPanoDots));
			if (!cancelled) setPanoDots(results.flat());
		};
		load();
		const listener = map.addListener("idle", load);
		return () => {
			cancelled = true;
			if (google?.maps) google.maps.event.removeListener(listener);
		};
	}, [svPanoramas, mapZoom]);

	const [fullResetCounter, setFullResetCounter] = useState(0);

	// Fetch render buffer from Rust ONLY when data changes (not on viewport pan).
	// deck.gl handles camera transforms on the GPU — cached buffer stays valid during pan.
	useEffect(() => {
		if (!mapReady) {
			cellMgrRef.current.clear();
			return;
		}

		let cancelled = false;
		const fetchRender = async () => {
			const t = trace("render", { summary: true });
			try {
				const filePath = await cmd.storeFillRenderFile({
					west: -180,
					south: -90,
					east: 180,
					north: 90,
					markerStyle,
				});
				t.step("fill");
				const resp = await fetch(mmaBufUrl(filePath));
				if (!resp.ok) throw new Error(`render fetch ${resp.status}: ${await resp.text()}`);
				const buf = await resp.arrayBuffer();
				t.step("fetch");
				if (cancelled) return;

				cellMgrRef.current.initFromBinary(buf);
				t.step("parse");
				mapOpenMark("markers");
				t.end({
					cells: cellMgrRef.current.cells.size,
					total: cellMgrRef.current.totalCount,
					bytes: buf.byteLength,
				});
				setRenderTick((t) => t + 1);
			} catch (e) {
				log.error("[render] fetchRender failed:", e);
			}
		};

		fetchRender();
		return () => {
			cancelled = true;
		};
	}, [mapReady, fullResetCounter, markerStyle]);

	useEffect(() => {
		const unsub1 = renderDeltaBus.on((delta) => {
			if (delta.fullReset) {
				setFullResetCounter((c) => c + 1);
				return;
			}
			const t = trace("delta", { summary: true });
			const cm = cellMgrRef.current;
			const affected = cm.applyDelta(delta);
			const aid = activeLocRef.current?.id ?? null;
			if (aid != null) {
				for (const cb of cm.cells.values()) {
					const idx = cb.idToIndex.get(aid);
					if (idx != null) {
						cb.patchColor(idx, 0, 0, 0, 0);
						break;
					}
				}
			}
			if (delta.colorPatches.length > 0) {
				const selPatches = delta.colorPatches.filter(
					(cp) => !(cp.r === 42 && cp.g === 42 && cp.b === 42),
				);
				cm.appendToSelectionOverlay(selPatches);
			}
			t.end({ affected: affected.size, added: delta.added.length, removed: delta.removed.length });
			if (affected.size > 0 || delta.colorPatches.length > 0) setRenderTick((t) => t + 1);
		});
		const unsub2 = selBitmaskBus.on((selColors, cellEntries, setIds) => {
			const t = trace("selection", { summary: true });
			const ids = cellMgrRef.current.applySelectionBitmasks(selColors, cellEntries);
			setIds(ids);
			t.end({ cells: cellEntries.length, sels: selColors.length, ids: ids.size });
			setRenderTick((t) => t + 1);
		});
		return () => {
			unsub1();
			unsub2();
		};
	}, []);

	useEffect(() => {
		if (svPreview?.url) return () => URL.revokeObjectURL(svPreview.url);
	}, [svPreview?.url]);

	useEffect(() => {
		if (!gMapRef.current || !showPreviews) {
			setSvPreview(null);
			return;
		}
		const map = gMapRef.current;
		if (!google?.maps) return;

		const moveListener = map.addListener("mousemove", async (e: google.maps.MapMouseEvent) => {
			if (!e.latLng) return;
			setSvPreview(null);
			previewAbortRef.current?.abort();
			const ac = new AbortController();
			previewAbortRef.current = ac;

			const lat = e.latLng.lat();
			const lng = e.latLng.lng();
			const zoom = map.getZoom() ?? 2;

			await new Promise((r) => setTimeout(r, 300));
			if (ac.signal.aborted) return;

			const sv = new google.maps.StreetViewService();
			sv.getPanorama(
				{
					location: { lat, lng },
					radius: svSearchRadius(lat, zoom),
					sources: [google.maps.StreetViewSource.GOOGLE],
					preference: google.maps.StreetViewPreference.NEAREST,
				},
				async (data: google.maps.StreetViewPanoramaData | null, status: string) => {
					if (ac.signal.aborted || status !== "OK" || !data?.location?.pano) return;
					const heading = data.tiles.centerHeading ?? 0;
					const url = svThumbnailUrl(data.location.pano, heading);
					try {
						const res = await fetch(url, { signal: ac.signal });
						if (!res.ok || ac.signal.aborted) return;
						const blob = await res.blob();
						if (ac.signal.aborted) return;
						setSvPreview({ url: URL.createObjectURL(blob) });
					} catch {
						// ignored
					}
				},
			);
		});

		const outListener = map.addListener("mouseout", () => {
			previewAbortRef.current?.abort();
			previewAbortRef.current = null;
			setSvPreview(null);
		});

		return () => {
			google.maps.event.removeListener(moveListener);
			google.maps.event.removeListener(outListener);
			previewAbortRef.current?.abort();
			setSvPreview(null);
		};
	}, [showPreviews]);

	const useBlobby = svBlobby && mapZoom <= 13;

	useEffect(() => {
		if (!gMapRef.current) return;
		if (!google?.maps) return;
		const custom = customStyles.find((s) => s.name === mapStyleName);
		const stack = buildMapStack({
			type: mapType,
			labels: showLabels,
			terrain: showTerrain,
			color: svColor,
			coverageType: svCoverageType,
			thickness: svThickness,
			useBlobby,
			boldCountry: boldCountryBorders,
			boldSubdivision: boldSubdivisionBorders,
			style: mapStyleName,
			customStyles: custom?.style,
		});
		gMapRef.current.mapTypes.set("stack", stack);
		gMapRef.current.setMapTypeId("stack");
	}, [
		mapType,
		showLabels,
		showTerrain,
		svColor,
		svCoverageType,
		svThickness,
		useBlobby,
		boldCountryBorders,
		boldSubdivisionBorders,
		mapStyleName,
		customStyles,
		buildMapStack,
	]);

	const updateOverlay = useCallback(() => {
		if (!overlayRef.current) return;
		const layers = buildLayers();
		overlayRef.current.setProps({
			layers,
			onClick: handleClick as GoogleMapsOverlayProps["onClick"],
			onHover: handleHover as GoogleMapsOverlayProps["onHover"],
			onError: (e: unknown) => log.error("[deck.gl overlay error]", e),
		});
	}, [buildLayers, handleClick, handleHover]);

	useEffect(() => {
		updateOverlay();
	}, [
		mapVer,
		renderTick,
		map?.meta.tags,
		selected,
		selectedTags,
		activeLocation?.id,
		markerOpacity,
		markerStyle,
		showPerfectScoreCircle,
		svPanoramas,
		panoDots,
		isMeasuring,
		latLngAnchor,
		trailVersion,
		importMarkerVersion,
		diffMarkerVersion,
	]);

	useEffect(() => {
		return () => {
			overlayRef.current?.setMap(null);
			overlayRef.current?.finalize();
		};
	}, []);

	const handleSearchResult = useCallback((lat: number, lng: number, _name: string) => {
		if (!gMapRef.current) return;
		if (!google?.maps) return;
		const bounds = new google.maps.LatLngBounds(
			{ lat: lat - 0.003, lng: lng - 0.003 },
			{ lat: lat + 0.003, lng: lng + 0.003 },
		);
		gMapRef.current.fitBounds(bounds);
	}, []);

	const zoomIn = useCallback(() => {
		if (gMapRef.current) gMapRef.current.setZoom((gMapRef.current.getZoom() ?? 0) + 1);
	}, []);

	const zoomOut = useCallback(() => {
		if (gMapRef.current) gMapRef.current.setZoom(Math.max(1, (gMapRef.current.getZoom() ?? 0) - 1));
	}, []);

	const showFps = useSetting("showFps");

	const mapNavRef = useRef({
		held: new Set<string>(),
		zoom: null as number | null,
		rafId: 0,
		alt: false,
		lastTime: 0,
	});
	const appSettings = useSettings();
	const mapNavSettingsRef = useRef(appSettings);
	mapNavSettingsRef.current = appSettings;

	useHotkey(useBinding("mapZoomReset"), () => {
		const gm = gMapRef.current;
		if (gm) gm.moveCamera({ zoom: 1 });
	});

	useHotkey(useBinding("toggleSelectOnly"), () => {
		setPrefs((p) => ({ ...p, selectOnly: !p.selectOnly }));
	});
	useHotkey(useBinding("mapZoomBounds"), () => {
		cmd.storeBounds(false).then((bounds) => {
			const gm = gMapRef.current;
			if (!gm || !bounds || !google?.maps) return;
			const [west, south, east, north] = bounds as [number, number, number, number];
			gm.fitBounds({ west, south, east, north });
			google.maps.event.addListenerOnce(gm, "bounds_changed", () => {
				gm.moveCamera({ center: gm.getCenter()!, zoom: gm.getZoom()! });
			});
		});
	});

	useHotkey(useBinding("mapZoomSelection"), () => {
		cmd.storeBounds(true).then((bounds) => {
			const gm = gMapRef.current;
			if (!gm || !bounds || !google?.maps) return;
			const [west, south, east, north] = bounds as [number, number, number, number];
			gm.fitBounds({ west, south, east, north });
			google.maps.event.addListenerOnce(gm, "bounds_changed", () => {
				gm.moveCamera({ center: gm.getCenter()!, zoom: gm.getZoom()! });
			});
		});
	});

	useEffect(() => {
		const nav = mapNavRef.current;
		const actions = ["panLeft", "panRight", "panUp", "panDown", "mapZoomIn", "mapZoomOut"] as const;

		function tick() {
			const map = getGoogleMapInstance();
			if (!map || nav.held.size === 0) {
				nav.rafId = 0;
				nav.lastTime = 0;
				return;
			}

			const now = performance.now();
			const dt = nav.lastTime ? (now - nav.lastTime) / 16.667 : 1;
			nav.lastTime = now;

			const proj = map.getProjection();
			const center = map.getCenter();
			if (!proj || !center) {
				nav.rafId = 0;
				nav.lastTime = 0;
				return;
			}

			if (nav.zoom === null) nav.zoom = map.getZoom() ?? 2;

			const s = mapNavSettingsRef.current;
			const slow = nav.alt ? s.slowModifier : 1;
			let dx = 0,
				dy = 0;
			if (nav.held.has("panLeft")) dx -= (s.mapPanSpeed * dt) / slow;
			if (nav.held.has("panRight")) dx += (s.mapPanSpeed * dt) / slow;
			if (nav.held.has("panUp")) dy -= (s.mapPanSpeed * dt) / slow;
			if (nav.held.has("panDown")) dy += (s.mapPanSpeed * dt) / slow;

			const zoomStep = (0.02 * dt) / slow;
			if (nav.held.has("mapZoomIn")) nav.zoom += zoomStep;
			if (nav.held.has("mapZoomOut")) nav.zoom = Math.max(1, nav.zoom - zoomStep);

			const scale = Math.pow(2, nav.zoom);
			const worldPoint = proj.fromLatLngToPoint(center)!;
			worldPoint.x += dx / scale;
			worldPoint.y += dy / scale;

			map.moveCamera({
				center: proj.fromPointToLatLng(worldPoint)!,
				zoom: nav.zoom,
			});
			nav.rafId = requestAnimationFrame(tick);
		}

		const bindings = actions.map((a) => ({
			action: a,
			parsed: parseHotkey(getBinding(a)),
		}));

		function onKeyDown(e: KeyboardEvent) {
			nav.alt = e.altKey;
			if (e.key === "Alt") {
				e.preventDefault();
				return;
			}
			if (e.defaultPrevented || e.repeat) return;
			if (isEditableElement(e.target)) return;
			for (const { action, parsed } of bindings) {
				for (const alt of parsed) {
					if (alt.length === 1 && matchesKey(e, alt[0], { ignoreAlt: true })) {
						nav.held.add(action);
						if (!nav.rafId) nav.rafId = requestAnimationFrame(tick);
						return;
					}
				}
			}
		}

		function onKeyUp(e: KeyboardEvent) {
			nav.alt = e.altKey;
			if (nav.held.size === 0) return;
			const key = e.key.toLowerCase();
			for (const { action, parsed } of bindings) {
				for (const alt of parsed) {
					if (alt.length === 1 && alt[0].key === key) {
						nav.held.delete(action);
					}
				}
			}
		}

		const gmap = getGoogleMapInstance();
		let zoomListener: google.maps.MapsEventListener | undefined;
		if (gmap) {
			zoomListener = gmap.addListener("zoom_changed", () => {
				if (nav.held.size === 0) nav.zoom = null;
			});
		}

		function onBlur() {
			nav.held.clear();
		}

		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("blur", onBlur);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onBlur);
			if (nav.rafId) cancelAnimationFrame(nav.rafId);
			if (zoomListener) google.maps.event.removeListener(zoomListener);
		};
	}, []);

	return (
		<ContextMenu.Root modal={false}>
			<div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
			{showFps && <FpsCounter />}
			<div className="embed-controls">
				{/* TopLeft: Map dropdown, Search */}
				<div
					className="embed-controls__control"
					style={{ top: 0, left: 0, display: "flex", alignItems: "flex-start" }}
				>
					<MapTypeDropdown
						layerConfig={{
							basemap: mapType,
							setBasemap: setMapType,
							labels: showLabels,
							setLabels: setShowLabels,
							supportsLabels: mapType !== "osm",
							terrain: showTerrain,
							setTerrain: setShowTerrain,
							supportsTerrain: mapType === "map" || mapType === "satellite",
							streetViewPanoramas: svPanoramas,
							setStreetViewPanoramas: setSvPanoramas,
							streetViewCoverageType: svCoverageType,
							setStreetViewCoverageType: setSvCoverageType,
							svColor,
							setSvColor,
							streetViewCoverageThickness: svThickness,
							setStreetViewCoverageThickness: setSvThickness,
							streetViewBlobby: svBlobby,
							setStreetViewBlobby: setSvBlobby,
							boldCountryBorders,
							setBoldCountryBorders,
							boldSubdivisionBorders,
							setBoldSubdivisionBorders,
							mapStyleName,
							setMapStyleName,
							customStyles,
							onManageStyles: () => setShowStylesDialog(true),
						}}
					/>
					<SearchControl onResult={handleSearchResult} />
				</div>
				{/* LeftTop: polygon/rectangle drawing tools */}
				{mapReady && (
					<div className="embed-controls__control" style={{ left: 0, top: "52px" }}>
						<PolygonTools
							map={gMapRef.current}
							onDraw={(rings) => {
								if (rings.length === 0) return;
								if (tryInterceptDraw(rings)) return;
								selectPolygon({ coordinates: rings as [number, number][][] });
							}}
							freehandPathRef={freehandPathRef}
							requestOverlayUpdate={updateOverlay}
						/>
					</div>
				)}
				{/* TopRight: Map settings, SV opacity slider */}
				<div
					className="embed-controls__control"
					style={{
						top: 0,
						right: 0,
						display: "flex",
						alignItems: "flex-start",
					}}
				>
					<MapSettingsDropdown
						settings={{
							markerStyle,
							setMarkerStyle,
							showPerfectScoreCircle,
							setShowPerfectScoreCircle,
							showPreviews,
							setShowPreviews,
							selectOnly,
							setSelectOnly,
						}}
					/>
					<div className="map-control sv-opacity-control">
						<button
							className="opacity-target-toggle"
							onClick={() => setOpacityTarget((t) => (t === "sv" ? "markers" : "sv"))}
							role="tooltip"
							aria-label={
								opacityTarget === "sv" ? "Adjusting Street View opacity" : "Adjusting marker opacity"
							}
							data-microtip-position="left"
						>
							<Icon path={opacityTarget === "sv" ? mdiGoogleStreetView : mdiMapMarker} size={20} />
						</button>
						<input
							className="sv-opacity-control__slider"
							type="range"
							min={0}
							max={1}
							step={0.05}
							value={opacityTarget === "sv" ? svOpacity : markerOpacity}
							onChange={(e) =>
								(opacityTarget === "sv" ? setSvOpacity : setMarkerOpacity)(Number(e.target.value))
							}
							title={opacityTarget === "sv" ? "Street View layer opacity" : "Marker layer opacity"}
						/>
					</div>
				</div>
				<div className="embed-controls__control" style={{ right: 0, bottom: 0 }}>
					<div className="map-control map-control--button white">
						<button
							onClick={zoomIn}
							role="tooltip"
							aria-label="Zoom in"
							data-microtip-position="left"
						>
							<svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
								<path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" />
							</svg>
						</button>
						<button
							onClick={zoomOut}
							role="tooltip"
							aria-label="Zoom out"
							data-microtip-position="left"
						>
							<svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
								<path d="M19,13H5V11H19V13Z" />
							</svg>
						</button>
					</div>
				</div>
				{svPreview && (
					<div className="embed-controls__control" style={{ bottom: "40px", left: 0 }}>
						<div className="map-control sv-preview-control">
							<figure className="sv-preview-control__window">
								<img src={svPreview.url} width={320} height={180} />
								{svPreview.date && (
									<figcaption className="sv-preview-control__caption">
										<span>{svPreview.date}</span>
									</figcaption>
								)}
							</figure>
						</div>
					</div>
				)}
				<MeasurementBar />
				<div className="embed-controls__control" style={{ bottom: 0, left: 0 }}>
					<div className="map-control coordinate-control">
						<span ref={coordDisplayRef} /> · zoom {mapZoom}
					</div>
				</div>
			</div>
			{showStylesDialog && (
				<Dialog open onOpenChange={(open) => !open && setShowStylesDialog(false)}>
					<DialogContent title="Manage map styles" className="map-styles-modal">
						{customStyles.length > 0 && (
							<ul className="map-style-list">
								{customStyles.map((s) => (
									<li key={s.name} className="map-style-thumb">
										<span className="map-style-thumb__name">{s.name}</span>
										<div className="map-style-thumb__actions">
											<button
												className="icon-button"
												style={{ color: "var(--sand-11)" }}
												onClick={() => {
													navigator.clipboard.writeText(JSON.stringify(s.style, null, 2));
												}}
												aria-label="Copy JSON"
											>
												<svg height="20" width="20" viewBox="0 0 24 24" fill="currentColor">
													<path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" />
												</svg>
											</button>
											<button
												className="icon-button"
												style={{ color: "var(--sand-11)" }}
												onClick={() => {
													const next = customStyles.filter((c) => c.name !== s.name);
													setCustomStyles(next);
													localStorage.setItem("mma_custom_styles", JSON.stringify(next));
													if (mapStyleName === s.name) setMapStyleName("default");
												}}
												aria-label="Delete style"
											>
												<svg height="20" width="20" viewBox="0 0 24 24" fill="currentColor">
													<path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" />
												</svg>
											</button>
										</div>
									</li>
								))}
							</ul>
						)}
						<strong>New style</strong>
						<p style={{ margin: 0 }}>Paste a Google Maps style JSON array below.</p>
						<form
							onSubmit={(ev) => {
								ev.preventDefault();
								const fd = new FormData(ev.currentTarget);
								const name = (fd.get("name") as string)?.trim();
								const raw = (fd.get("style") as string)?.trim();
								if (!name || !raw) return;
								try {
									const style = JSON.parse(raw);
									if (!Array.isArray(style)) return;
									const next = [...customStyles.filter((s) => s.name !== name), { name, style }];
									setCustomStyles(next);
									localStorage.setItem("mma_custom_styles", JSON.stringify(next));
									ev.currentTarget.reset();
								} catch {
									// ignored
								}
							}}
						>
							<p>
								<input
									name="name"
									className="input"
									placeholder="Style name"
									required
									style={{ width: "100%" }}
								/>
							</p>
							<p>
								<textarea
									name="style"
									className="input"
									placeholder='[{"featureType":"water","stylers":[{"color":"#ff0000"}]}]'
									rows={5}
									style={{
										width: "100%",
										fontFamily: "monospace",
										fontSize: "0.8rem",
									}}
									required
								/>
							</p>
							<p>
								<button type="submit" className="button button--primary">
									Upload
								</button>
							</p>
						</form>
					</DialogContent>
				</Dialog>
			)}
			<ContextMenu.Trigger asChild>
				<span ref={contextTriggerRef} title="Context menu" />
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<MapContextMenuContent mapRef={gMapRef} />
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
