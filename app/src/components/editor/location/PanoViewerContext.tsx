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
import { hasLoadAsPanoId, type LatLng, type Pano } from "@/types";
import type { Location } from "@/bindings.gen";
import { isFieldEnabled } from "@/lib/data/fieldDefs";
import { useAsync, useAsyncSticky } from "@/lib/hooks/useAsync";
import { procedureEntry, queryProcedure } from "@/lib/data/procedures";
import { viewedPano, type ViewedPano } from "@/lib/sv/query";
import { enrich } from "@/lib/sv/enrich";
import { derivePanoDateState, type PanoDateState } from "./panoDate";
import { onFullscreenMapChanged, onLocationCleared } from "./fullscreenModeState";

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
	/** The viewed pano once fetched; null until it lands. */
	pano: ViewedPano | null;
	/** Exact capture timestamp of the date picker's pano, resolved once and shared. */
	exactDate: ReturnType<typeof useExactDate>;
}

const PanoViewerContext = createContext<PanoViewerContextValue | null>(null);

/** Where the viewer is: the viewed pano once known, else the location. */
export function viewerPosition(pano: ViewedPano | null, location: Location | null): LatLng {
	return pano ?? location ?? { lat: 0, lng: 0 };
}

/** The date picker's view of the viewer: a pinned location's pano is its choice, a
 *  floating one has none. Read off the fetched pano, which is held while the next one
 *  loads, so the picker never shows a choice its timeline cannot find. */
export function panoDates(pano: ViewedPano | null, location: Location | null): PanoDateState {
	const chosen = location && hasLoadAsPanoId(location) ? (pano?.pano ?? null) : null;
	return derivePanoDateState(
		pano?.nearby ?? EMPTY_TIMELINE,
		chosen,
		pano,
		location?.panoId ?? null,
	);
}
const EMPTY_TIMELINE: Pano["time"] = [];

/** The location's own pano: the one it stores, else the one its open landed on. */
export function locationPano(viewer: Viewer | null, location: Location | null): string | null {
	return location?.panoId ?? viewer?.resolved ?? null;
}

const EXACT_DATE_ENTRY = procedureEntry("exactDate");

/** The exact capture time of the pano the date picker points at: the stored value when
 *  that pano is the location's own and already dated, else one lookup by position and
 *  month, the same narrowing an enrichment run does per row. */
function useExactDate(viewer: Viewer | null, pano: ViewedPano | null, location: Location | null) {
	const enrichFields = useMapState((s) => s.map?.settings.enrichFields ?? null);
	const enabled = isFieldEnabled(enrichFields, "datetime");
	const { triggerPanoId: trigger, yearMonth } = panoDates(pano, location);
	const { lat, lng } = viewerPosition(pano, location);
	const stored =
		trigger != null && trigger === locationPano(viewer, location)
			? (location?.extra?.datetime as number | undefined)
			: undefined;
	const { data, loading, error } = useAsync<number | null>(() => {
		if (stored != null) return stored;
		if (!enabled || !trigger || !yearMonth) return null;
		return queryProcedure<number | null>(EXACT_DATE_ENTRY, {
			op: "resolve",
			lat,
			lng,
			imageDate: yearMonth,
		});
	}, [trigger, lat, lng, yearMonth, enabled, stored]);
	return useMemo(() => ({ ts: data, loading, error: error != null }), [data, loading, error]);
}

export function PanoViewerProvider({ children }: { children: ReactNode }) {
	const location = useMapState((s) => s.activeLocation);
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

	// Held across a walk so the panel never blanks between panos; dropped with the location.
	const pano = useAsyncSticky(
		(signal) => (viewed ? viewedPano(viewed, signal) : null),
		[viewed],
		viewer?.locationId ?? null,
	);

	// A location's extra describes its own pano, never the one being walked through: the
	// viewed metadata reaches the store only while the two coincide, which is on open and
	// again after a save moves the stored pano.
	const own = locationPano(viewer, location);
	const locationMeta = pano && pano.pano === own ? pano : null;
	useEffect(() => {
		const loc = getMapState().activeLocation;
		if (loc && locationMeta) void enrich(loc, locationMeta);
	}, [location?.id, location?.panoId, locationMeta]);

	const exactDate = useExactDate(viewer, pano, location);

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
		() => ({ viewer, open, view, pano, exactDate }),
		[viewer, open, view, pano, exactDate],
	);

	return <PanoViewerContext.Provider value={value}>{children}</PanoViewerContext.Provider>;
}

export function usePanoViewer(): PanoViewerContextValue {
	const ctx = useContext(PanoViewerContext);
	if (!ctx) throw new Error("usePanoViewer must be used within PanoViewerProvider");
	return ctx;
}

export function usePanoDates(): PanoDateState {
	const { pano } = usePanoViewer();
	const location = useMapState((s) => s.activeLocation);
	return useMemo(() => panoDates(pano, location), [pano, location]);
}
