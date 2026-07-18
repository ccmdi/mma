import { useCallback, useEffect, useEffectEvent, useRef, type RefObject } from "react";
import type { PickingInfo } from "@deck.gl/core";
import { buildSceneLayers, type PolyGeom } from "@/lib/render/buildSceneLayers";
import {
	lodBandForZoom,
	cellBounds,
	boundsIntersectCell,
	type CellManager,
} from "@/lib/render/CellManager";
import type { Bounds } from "@/types";
import { lodBinTarget } from "@/lib/render/markerLayer";
import { getScene, subscribeScene } from "@/lib/render/sceneStore";
import type { MapHost, DeckOverlayHandle } from "@/lib/map/host";

import { useSetting, getSettings } from "@/store/settings";
import { useScoreMaxError, subscribeLatLngAnchor } from "@/lib/sv/measure";
import { handleMapClick, handleMapHover } from "@/lib/map/mapClick";
import { subscribeStore, getActiveLocation } from "@/store/useMapStore";
import { log } from "@/lib/util/log";
import { subscribe } from "@/lib/events";
import { getReviewSession } from "@/lib/review/review";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useMapKeyboardNav } from "@/lib/hooks/useMapKeyboardNav";
import { subscribeTrail } from "@/lib/sv/svTrail";
import { subscribeSeenOverlay } from "@/lib/seen/seenOverlay";
import { subscribeProviderCoverageLayers } from "@/lib/sv/providers/coverageLayers";
import type { MapEmbedPrefs } from "@/store/mapEmbedPrefs";

export interface MapSurfaceOpts {
	prefs: MapEmbedPrefs;
	measuring?: boolean;
	onContextMenu?: (clientX: number, clientY: number) => void;
	// In-progress freehand selection path, read live on every rebuild (the editor map only).
	freehandPathRef?: RefObject<number[][] | null>;
	// Placed vertices of an in-progress click-vertex polygon (the editor map only).
	polygonVerticesRef?: RefObject<number[][] | null>;
	onError?: (e: unknown) => void;
	// Camera behaviors. Pan this map to the active location while reviewing.
	followActive?: boolean;
	// Bind the panToLocation hotkey to this map.
	panToActiveHotkey?: boolean;
	// Held-key pan/zoom on this map. Keyboard-driven; opt in on one surface only.
	keyboardNav?: boolean;
	// Pre-created overlay to reuse across mounts (won't be finalized on cleanup).
	overlay?: DeckOverlayHandle;
}

/** Viewport padded by half a span per side — the cull margin, so a pan has a whole
 *  screen of slack before a culled cell could show. Null = draw everything (no
 *  bounds yet, or the padded view already spans most of the world). */
function padBounds(b: Bounds | null): Bounds | null {
	if (!b) return null;
	let spanLng = b.east - b.west;
	if (spanLng < 0) spanLng += 360;
	if (spanLng >= 180) return null; // padded view covers the world — nothing to cull
	const padLng = spanLng * 0.5;
	let west = b.west - padLng;
	let east = b.east + padLng;
	if (west < -180) west += 360;
	if (east > 180) east -= 360;
	const padLat = (b.north - b.south) * 0.5;
	return {
		west,
		east,
		south: Math.max(-90, b.south - padLat),
		north: Math.min(90, b.north + padLat),
	};
}

/** Signature of the cell set a view draws — panning rebuilds only when it changes. */
function visibleCellSig(cm: CellManager, view: Bounds | null): string {
	if (!view) return "*";
	let sig = "";
	for (const [key, cell] of cm.cells) {
		if (cell.count > 0 && boundsIntersectCell(view, cellBounds(key))) sig += key;
	}
	return sig;
}

// The one map surface, shared by the editor map and the minimap: creates the deck overlay
// through the host, builds layers from the single scene store, and wires click/hover through
// the shared pipeline. The only difference between consumers is the caps object + the chrome
// they compose around it. Returns `requestUpdate` for imperative rebuilds (freehand drawing).
export function useMapSurface(
	host: MapHost | null,
	opts: MapSurfaceOpts,
): { requestUpdate: () => void } {
	const overlayRef = useRef<DeckOverlayHandle | null>(null);
	const polygonGeomCache = useRef(new Map<string, PolyGeom>());
	const activeLocationColor = useSetting("activeLocationColor");
	const importPreviewColor = useSetting("importPreviewColor");
	const panoDotColor = useSetting("panoDotColor");
	const panoDotScaled = useSetting("panoDotScaled");
	const scoreMaxError = useScoreMaxError();

	// ---- Aggregation-LOD band: the surface is the single authority. -------------
	// Band swaps happen at TRUE zoom-boundary crossings, never at gesture events:
	// the zoom event fires at animation START with the target zoom, so swapping on
	// it pops reps mid-interpolation (a band is only visually lossless at its design
	// zoom). While a zoom animates, a rAF loop derives the live interpolated zoom
	// from the projected viewport span and swaps each band exactly as its boundary
	// passes. Everything that needs the band (layer build, CPU hit-test) reads the
	// resolved value; no consumer derives it from the target zoom.
	const lodBandRef = useRef<number | null>(null);
	const lodRafRef = useRef(0);
	/** Live interpolated zoom mid-animation (host.getZoom() reports the target). */
	const liveZoom = useCallback((): number => {
		if (!host) return 2;
		const el = host.container;
		const w = el.clientWidth;
		const h = el.clientHeight;
		if (!w) return host.getZoom();
		const west = host.containerPxToLatLng(0, h / 2);
		const east = host.containerPxToLatLng(w, h / 2);
		if (!west || !east) return host.getZoom();
		let span = east.lng - west.lng;
		if (span <= 0) span += 360;
		const z = Math.log2((360 * w) / (span * 256));
		return Number.isFinite(z) ? z : host.getZoom();
	}, [host]);
	const bandForNow = useCallback(
		() =>
			lodBandForZoom(
				liveZoom(),
				getScene().totalCount,
				lodBinTarget(opts.prefs.markerStyle, opts.prefs.markerSize),
			),
		[liveZoom, opts.prefs.markerStyle, opts.prefs.markerSize],
	);
	const resolveLodBand = useCallback(
		(): number | null => (lodBandRef.current = bandForNow()),
		[bandForNow],
	);

	const lastCellSigRef = useRef("*");
	const rebuild = useCallback(() => {
		const overlay = overlayRef.current;
		if (!overlay) return;
		const viewBounds = padBounds(host?.getBounds() ?? null);
		lastCellSigRef.current = visibleCellSig(getScene(), viewBounds);
		const clickCtx = () => ({
			cm: getScene(),
			host,
			markerStyle: opts.prefs.markerStyle,
			markerSize: opts.prefs.markerSize,
			markerOpacity: opts.prefs.markerOpacity,
			lodBand: lodBandRef.current,
			selectOnly: opts.prefs.selectOnly,
			measuring: opts.measuring,
			onContextMenu: opts.onContextMenu,
		});
		const onClick = (info: PickingInfo, domEvent?: Event) =>
			handleMapClick(info, domEvent, clickCtx());
		const onHover = (info: PickingInfo, domEvent?: Event) =>
			handleMapHover(info, domEvent, clickCtx());
		const layers = buildSceneLayers(getScene(), {
			markerStyle: opts.prefs.markerStyle,
			markerOpacity: opts.prefs.markerOpacity,
			markerSize: opts.prefs.markerSize,
			lodBand: resolveLodBand(),
			viewBounds,
			showPerfectScoreCircle: opts.prefs.showPerfectScoreCircle,
			scoreMaxError,
			svPanoramas: opts.prefs.svPanoramas,
			panoDotColor,
			panoDotScaled,
			activeLocationColor,
			importPreviewColor,
			polygonGeomCache: polygonGeomCache.current,
			freehandPath: opts.freehandPathRef?.current ?? null,
			polygonVertices: opts.polygonVerticesRef?.current ?? null,
		});
		overlay.setProps({
			layers,
			onClick,
			onHover,
			onError:
				opts.onError ??
				((e: unknown) => log.error("[deck]", e instanceof Error ? (e.stack ?? e.message) : e)),
		});
	}, [
		host,
		scoreMaxError,
		activeLocationColor,
		importPreviewColor,
		opts.prefs.markerStyle,
		opts.prefs.markerOpacity,
		opts.prefs.markerSize,
		opts.prefs.showPerfectScoreCircle,
		opts.prefs.svPanoramas,
		panoDotColor,
		panoDotScaled,
		opts.prefs.selectOnly,
		opts.measuring,
		opts.onContextMenu,
		opts.onError,
		opts.freehandPathRef,
		opts.polygonVerticesRef,
		resolveLodBand,
	]);

	// Latest rebuild, so overlay creation paints the first frame with current values.
	const rebuildLatest = useEffectEvent(() => rebuild());

	// Repaint on every visual signal WITHOUT rendering the host component — these buses
	// used to be render subscriptions serving purely as effect triggers. Same-tick bursts
	// coalesce into one rebuild (React's batching did this implicitly before).
	const rebuildQueued = useRef(false);
	const scheduleRebuild = useEffectEvent(() => {
		if (rebuildQueued.current) return;
		rebuildQueued.current = true;
		queueMicrotask(() => {
			rebuildQueued.current = false;
			rebuildLatest();
		});
	});

	useEffect(() => {
		const unsubs = [
			subscribeStore(scheduleRebuild),
			subscribeScene(scheduleRebuild),
			subscribeTrail(scheduleRebuild),
			subscribeSeenOverlay(scheduleRebuild),
			subscribeLatLngAnchor(scheduleRebuild),
			subscribeProviderCoverageLayers(scheduleRebuild),
		];
		return () => unsubs.forEach((u) => u());
	}, []);

	// Rebuild whenever the live zoom crosses a band boundary. A zoom event starts a
	// rAF loop that tracks the interpolated zoom through the animation, swapping
	// each band at the boundary itself (where decimation is lossless in both
	// directions); the loop stops at idle, which also runs a final backstop check.
	useEffect(() => {
		if (!host) return;
		lodBandRef.current = bandForNow();
		const check = () => {
			const fresh = bandForNow();
			if (fresh !== lodBandRef.current) {
				log.debug(`[lod] band swap ${lodBandRef.current} -> ${fresh} @ z${liveZoom().toFixed(2)}`);
				lodBandRef.current = fresh;
				scheduleRebuild();
			}
		};
		const stopLoop = () => {
			if (lodRafRef.current) cancelAnimationFrame(lodRafRef.current);
			lodRafRef.current = 0;
		};
		const startLoop = () => {
			if (lodRafRef.current) return;
			const tick = () => {
				lodRafRef.current = requestAnimationFrame(tick);
				check();
			};
			lodRafRef.current = requestAnimationFrame(tick);
		};
		const unsubZoom = host.on("zoom", startLoop);
		const unsubIdle = host.on("idle", () => {
			stopLoop();
			check();
		});
		// Panning: rebuild only when the padded viewport's cell set changes (a cheap
		// <=32 intersection sweep per camera event) — cull slack covers the gap.
		const unsubCamera = host.on("camera", () => {
			const sig = visibleCellSig(getScene(), padBounds(host.getBounds()));
			if (sig !== lastCellSigRef.current) scheduleRebuild();
		});
		return () => {
			stopLoop();
			unsubZoom();
			unsubIdle();
			unsubCamera();
		};
	}, [host, bandForNow, liveZoom]);

	const externalOverlay = opts.overlay ?? null;

	useEffect(() => {
		if (!host) return;
		if (externalOverlay) {
			overlayRef.current = externalOverlay;
			rebuildLatest();
			return () => {
				overlayRef.current = null;
			};
		}
		const overlay = host.createDeckOverlay();
		overlayRef.current = overlay;
		rebuildLatest();
		return () => {
			overlayRef.current = null;
			overlay.finalize();
		};
	}, [host, externalOverlay]);

	// Rebuild when the layer inputs themselves change (settings, prefs, measuring, ...).
	useEffect(() => {
		rebuild();
	}, [rebuild]);

	// Follow the active location into view while reviewing.
	useEffect(() => {
		if (!host || !opts.followActive) return;
		return subscribe("active:change", (id) => {
			if (id == null || !getReviewSession() || !getSettings().followActiveInReview) return;
			const loc = getActiveLocation();
			if (loc && loc.id === id) host.panTo({ lat: loc.lat, lng: loc.lng });
		});
	}, [host, opts.followActive]);

	useHotkey(useBinding("panToLocation"), () => {
		if (!host || !opts.panToActiveHotkey) return;
		const loc = getActiveLocation();
		if (loc) host.panTo({ lat: loc.lat, lng: loc.lng });
	});

	useMapKeyboardNav(opts.keyboardNav ? host : null);

	return { requestUpdate: rebuild };
}
