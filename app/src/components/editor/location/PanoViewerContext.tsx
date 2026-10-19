/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useSetting } from "@/store/settings";
import { PanoType } from "@/bindings.consts";
import { usePano } from "@/lib/hooks/usePano";
import type { Pano } from "@/bindings.gen";
import { useAsync, useAsyncSticky, useSticky, type Rerunnable } from "@/lib/hooks/useAsync";
import { geocodeGoogle, reverseGeocode, type GeoDisplay } from "@/lib/geo/reverseGeocode";
import { panosAt, svMetadata } from "@/lib/sv/query";
import { allUnofficial, mergeTimelines } from "@/lib/sv/panoId";
import { SV_OFFICIAL_FALLBACK_RADIUS, SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { onFullscreenMapChanged, onLocationCleared } from "./fullscreenModeState";
import { Editor } from "@/store/editor";
import type { Loading } from "@/types/util";

export interface OnScreen {
	/** The location's pano, null when it has none. */
	currentPano: Pano | null;
	/** The captures the date picker offers. */
	timeline: Pano["time"];
	/** The pano Google resolves for the location's position: what "Default" means there. */
	defaultPano: Pano | null;
}

interface PanoViewerContextValue {
	/** The pano on screen as Google describes it. */
	onScreen: Rerunnable<OnScreen> | Loading;
	/** Geocoded position, or null while loading. Google uses the pano on screen. */
	geo: GeoDisplay | null;
}

const PanoViewerContext = createContext<PanoViewerContextValue | null>(null);

export function PanoViewerProvider({ children }: { children: ReactNode }) {
	const open = Editor.use((s) => s.open);
	const location = open?.location ?? null;
	const pano = usePano();

	// The pano on screen as Google describes it, and the captures the date picker can offer
	// there. Held across a walk so the panel never blanks between panos; dropped with the location.
	const layer = open?.layer ?? null;
	const lookup = useAsync(
		async (signal): Promise<OnScreen> => {
			const nothing = { currentPano: null, timeline: [], defaultPano: null };
			if (!location?.panoId) return nothing;
			const [shown] = await svMetadata([location.panoId], signal);
			if (!shown) return nothing;
			const here = [{ lat: shown.lat, lng: shown.lng }];
			const [atCoord] = await panosAt(here, SV_SEARCH_RADIUS, undefined, signal);

			let timeline = shown.time;
			if (allUnofficial(timeline)) {
				const [official] = await panosAt(
					here,
					SV_OFFICIAL_FALLBACK_RADIUS,
					{ sources: [PanoType.Official] },
					signal,
				);
				timeline = mergeTimelines([official, shown]);
			}

			return { currentPano: shown, timeline, defaultPano: atCoord ?? shown };
		},
		[location?.panoId, layer],
	);
	const onScreen = useSticky(lookup, layer);

	const geocodeProvider = useSetting("geocodeProvider");
	const spawn = open?.spawn ?? null;
	const looked = useAsyncSticky(
		() => (spawn && geocodeProvider !== "google" ? reverseGeocode(spawn.lat, spawn.lng) : null),
		[spawn?.lat, spawn?.lng, geocodeProvider],
		layer,
	);
	const geo = useMemo(() => {
		if (geocodeProvider === "google")
			return onScreen.map((shown) => geocodeGoogle(shown.currentPano)).ok();
		return looked.ok();
	}, [geocodeProvider, onScreen, looked]);

	const fullscreenMap = useSetting("fullscreenMap");
	const prevFullscreenMap = useRef(fullscreenMap);
	useEffect(() => {
		if (prevFullscreenMap.current === fullscreenMap) return;
		prevFullscreenMap.current = fullscreenMap;
		onFullscreenMapChanged(fullscreenMap);
	}, [fullscreenMap]);

	// Location cleared: reset fullscreen modes and hide the viewer.
	useEffect(() => {
		if (location) return;
		onLocationCleared();
		pano.hide();
	}, [pano, location]);

	const value = useMemo(() => ({ onScreen, geo }), [onScreen, geo]);

	return <PanoViewerContext.Provider value={value}>{children}</PanoViewerContext.Provider>;
}

export function usePanoViewer(): PanoViewerContextValue {
	const ctx = useContext(PanoViewerContext);
	if (!ctx) throw new Error("usePanoViewer must be used within PanoViewerProvider");
	return ctx;
}
