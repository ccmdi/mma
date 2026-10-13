/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useSetting } from "@/store/settings";
import { PanoType } from "@/bindings.consts";
import { usePano } from "@/lib/hooks/usePano";
import type { Pano } from "@/bindings.gen";
import { useAsyncSticky } from "@/lib/hooks/useAsync";
import { geocodeGoogle, reverseGeocode, type GeoDisplay } from "@/lib/geo/reverseGeocode";
import { panosAt, svMetadata } from "@/lib/sv/query";
import { allUnofficial, mergeTimelines } from "@/lib/sv/panoId";
import { SV_OFFICIAL_FALLBACK_RADIUS, SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { onFullscreenMapChanged, onLocationCleared } from "./fullscreenModeState";
import { Editor } from "@/store/editor";

interface PanoViewerContextValue {
	/** Metadata for the location's pano, or null while loading. */
	currentPano: Pano | null;
	/** Available captures for the date picker, or null while loading. */
	timeline: Pano["time"] | null;
	/** The pano Google resolves for the location's position: what "Default" means there. */
	defaultPano: Pano | null;
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
	const onScreen = useAsyncSticky(
		async (signal) => {
			if (!location?.panoId) return null;
			const [shown] = await svMetadata([location.panoId], signal);
			if (!shown) return null;
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
		[location?.panoId],
		open?.layer ?? null,
	);
	const currentPano = onScreen?.currentPano ?? null;
	const timeline = onScreen?.timeline ?? null;
	const defaultPano = onScreen?.defaultPano ?? null;

	const geocodeProvider = useSetting("geocodeProvider");
	const looked = useAsyncSticky(
		() =>
			location && geocodeProvider !== "google" ? reverseGeocode(location.lat, location.lng) : null,
		[location?.lat, location?.lng, geocodeProvider],
		open?.layer ?? null,
	);
	const geo = useMemo(
		() => (geocodeProvider === "google" ? geocodeGoogle(currentPano) : looked),
		[geocodeProvider, currentPano, looked],
	);

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

	const value = useMemo(
		() => ({
			currentPano,
			timeline,
			defaultPano,
			geo,
		}),
		[currentPano, timeline, defaultPano, geo],
	);

	return <PanoViewerContext.Provider value={value}>{children}</PanoViewerContext.Provider>;
}

export function usePanoViewer(): PanoViewerContextValue {
	const ctx = useContext(PanoViewerContext);
	if (!ctx) throw new Error("usePanoViewer must be used within PanoViewerProvider");
	return ctx;
}
