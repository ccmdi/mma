import { useCallback, useEffect, useEffectEvent, useRef, type RefObject } from "react";
import type { PickingInfo } from "@deck.gl/core";
import { buildSceneLayers, type PolyGeom } from "@/lib/render/buildSceneLayers";
import { getScene, subscribeScene } from "@/lib/render/sceneStore";
import type { MapHost, DeckOverlayHandle } from "@/lib/map/host";

import { useSetting, getSettings } from "@/store/settings";
import { useScoreMaxError, subscribeLatLngAnchor } from "@/lib/sv/measure";
import { handleMapClick, handleMapHover } from "@/lib/map/mapClick";
import { subscribeStore, getActiveLocation } from "@/store/useMapStore";
import { subscribe } from "@/lib/events";
import { getReviewSession } from "@/lib/review/review";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useMapKeyboardNav } from "@/lib/hooks/useMapKeyboardNav";
import { subscribeTrail } from "@/lib/sv/svTrail";
import { subscribeSeenOverlay } from "@/lib/seen/seenOverlay";
import type { MapEmbedPrefs } from "@/store/mapEmbedPrefs";

export interface MapSurfaceOpts {
	prefs: MapEmbedPrefs;
	measuring?: boolean;
	onContextMenu?: (clientX: number, clientY: number) => void;
	// In-progress freehand selection path, read live on every rebuild (the editor map only).
	freehandPathRef?: RefObject<number[][] | null>;
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

	const rebuild = useCallback(() => {
		const overlay = overlayRef.current;
		if (!overlay) return;
		const onClick = (info: PickingInfo, domEvent?: Event) =>
			handleMapClick(info, domEvent, {
				cm: getScene(),
				host,
				selectOnly: opts.prefs.selectOnly,
				measuring: opts.measuring,
				onContextMenu: opts.onContextMenu,
			});
		const layers = buildSceneLayers(getScene(), {
			markerStyle: opts.prefs.markerStyle,
			markerOpacity: opts.prefs.markerOpacity,
			markerSize: opts.prefs.markerSize,
			showPerfectScoreCircle: opts.prefs.showPerfectScoreCircle,
			scoreMaxError,
			svPanoramas: opts.prefs.svPanoramas,
			panoDotColor,
			panoDotScaled,
			activeLocationColor,
			importPreviewColor,
			polygonGeomCache: polygonGeomCache.current,
			freehandPath: opts.freehandPathRef?.current ?? null,
		});
		overlay.setProps({
			layers,
			onClick,
			onHover: handleMapHover,
			onError: opts.onError,
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
		];
		return () => unsubs.forEach((u) => u());
	}, []);

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
