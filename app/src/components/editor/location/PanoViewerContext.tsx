/* eslint-disable react-refresh/only-export-components */
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useMapState, getMapState } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { singletonPano } from "@/lib/sv/panoSingleton";
import { emit as emitEvent } from "@/lib/events";
import { hasLoadAsPanoId, type LatLng } from "@/types";
import type { Location } from "@/bindings.gen";
import { isFieldEnabled } from "@/lib/data/fieldDefs";
import { useAsync } from "@/lib/hooks/useAsync";
import { panoSpot, type PanoSpot } from "@/lib/sv/query";
import { enrich } from "@/lib/sv/enrich";
import { useExactDate } from "./useExactDate";
import { derivePanoDateState, type PanoDateState } from "./panoDate";
import { onFullscreenMapChanged, onLocationCleared } from "./fullscreenModeState";

// Altitude lives outside React: its only reader is the imperative coordinate
// readout, so routing it through context would re-render every consumer.
let panoAltitude = 0;
export function setPanoAltitude(v: number): void {
	if (v === panoAltitude) return;
	panoAltitude = v;
	emitEvent("altitude:changed");
}
export function getPanoAltitude(): number {
	return panoAltitude;
}

/** The viewer as one location opened it: the pano the open landed on, which is the
 *  location's own pano when it stores none, and the pano showing now, which moves as
 *  the user walks. */
export interface Viewer {
	locationId: number;
	resolved: string | null;
	viewed: string | null;
}

interface PanoViewerContextValue {
	viewer: Viewer | null;
	/** The location's pano is resolved and showing. */
	open: (locationId: number, resolved: string | null) => void;
	/** The viewer moved to another pano. */
	view: (pano: string) => void;
	/** Everything fetched about the viewed pano; null until it lands. */
	spot: PanoSpot | null;
	/** Exact capture timestamp of the date picker's pano, resolved once and shared. */
	exactDate: ReturnType<typeof useExactDate>;
}

const PanoViewerContext = createContext<PanoViewerContextValue | null>(null);

/** Where the viewer is: the viewed pano once known, else the location. */
export function viewerPosition(spot: PanoSpot | null, location: Location | null): LatLng {
	return spot?.meta ?? location ?? { lat: 0, lng: 0 };
}

/** The date picker's view of the viewer: a pinned location's viewed pano is its choice,
 *  a floating one has none. */
export function panoDates(
	viewer: Viewer | null,
	spot: PanoSpot | null,
	location: Location | null,
): PanoDateState {
	const chosen = location && hasLoadAsPanoId(location) ? (viewer?.viewed ?? null) : null;
	return derivePanoDateState(
		spot?.timeline ?? EMPTY_TIMELINE,
		chosen,
		spot?.meta ?? null,
		location?.panoId ?? null,
	);
}
const EMPTY_TIMELINE: PanoSpot["timeline"] = [];

export function PanoViewerProvider({ children }: { children: ReactNode }) {
	const location = useMapState((s) => s.activeLocation);
	const currentMap = useMapState((s) => s.map);
	const [state, setState] = useState<Viewer | null>(null);
	// Keyed by the location that opened it: another location's viewer is simply not this one.
	const viewer = state && state.locationId === location?.id ? state : null;
	const viewed = viewer?.viewed ?? null;

	const open = useCallback((locationId: number, resolved: string | null) => {
		setState({ locationId, resolved, viewed: resolved });
	}, []);
	const view = useCallback((pano: string) => {
		setState((prev) => (prev && prev.viewed !== pano ? { ...prev, viewed: pano } : prev));
	}, []);

	const spot = useAsync((signal) => (viewed ? panoSpot(viewed, signal) : null), [viewed]).data;
	useEffect(() => {
		if (spot) setPanoAltitude(spot.meta.altitude);
	}, [spot]);

	// A location's extra describes its own pano, never the one being walked through: the
	// viewed metadata reaches the store only while the two coincide, which is on open and
	// again after a save moves the stored pano.
	const locationPano = location?.panoId ?? viewer?.resolved ?? null;
	const locationMeta = spot && spot.meta.pano === locationPano ? spot.meta : null;
	useEffect(() => {
		const loc = getMapState().activeLocation;
		if (loc && locationMeta) void enrich(loc, locationMeta);
	}, [location?.id, location?.panoId, locationMeta]);

	const dates = panoDates(viewer, spot, location);
	const { lat, lng } = viewerPosition(spot, location);
	const exactDate = useExactDate(
		dates.triggerPanoId,
		locationPano,
		lat,
		lng,
		dates.yearMonth,
		isFieldEnabled(currentMap?.settings.enrichFields ?? null, "datetime"),
	);

	const fullscreenMap = useSetting("fullscreenMap");
	const prevFullscreenMap = useRef(fullscreenMap);
	useEffect(() => {
		if (prevFullscreenMap.current === fullscreenMap) return;
		prevFullscreenMap.current = fullscreenMap;
		onFullscreenMapChanged(fullscreenMap);
	}, [fullscreenMap]);

	// Location cleared (save/delete/close): reset fullscreen modes and hide the viewer.
	useEffect(() => {
		if (location) return;
		onLocationCleared();
		if (singletonPano) singletonPano.setVisible(false);
	}, [location]);

	const value = useMemo(
		() => ({ viewer, open, view, spot, exactDate }),
		[viewer, open, view, spot, exactDate],
	);

	return <PanoViewerContext.Provider value={value}>{children}</PanoViewerContext.Provider>;
}

export function usePanoViewer(): PanoViewerContextValue {
	const ctx = useContext(PanoViewerContext);
	if (!ctx) throw new Error("usePanoViewer must be used within PanoViewerProvider");
	return ctx;
}

export function usePanoDates(): PanoDateState {
	const { viewer, spot } = usePanoViewer();
	const location = useMapState((s) => s.activeLocation);
	return useMemo(() => panoDates(viewer, spot, location), [viewer, spot, location]);
}
