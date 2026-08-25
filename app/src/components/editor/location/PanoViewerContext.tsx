/* eslint-disable react-refresh/only-export-components */
import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useMapState, getMapState, updateLocations } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { singletonPano } from "@/lib/sv/panoSingleton";
import { emit as emitEvent } from "@/lib/events";
import { hasLoadAsPanoId } from "@/types";
import { isFieldEnabled } from "@/lib/data/fieldDefs";
import { useTimezone } from "@/lib/util/timezone";
import type { Pano } from "@/types";
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

interface PanoViewerContextValue {
	currentPano: ViewerPano | null;
	setCurrentPano: React.Dispatch<React.SetStateAction<ViewerPano | null>>;
	panoDates: Pano["time"];
	setPanoDates: React.Dispatch<React.SetStateAction<Pano["time"]>>;
	panoReady: boolean;
	setPanoReady: React.Dispatch<React.SetStateAction<boolean>>;
	selectedPanoId: string | null;
	/** Resolved live pano position (current pano if loaded, else the active location). */
	lat: number;
	lng: number;
	/** Date-picker view state + resolution inputs, derived once for every picker. */
	dateState: PanoDateState;
	/** Exact capture timestamp, resolved once and shared (the lookup is expensive). */
	exactDate: ReturnType<typeof useExactDate>;
	resolvedTz: string | null;
}

/** The part of a `Pano` the viewer itself knows, read straight off the live panorama.
 *  Everything else about it has to be fetched, so it stays out of here. */
export type ViewerPano = Pick<Pano, "pano" | "lat" | "lng" | "date">;

const PanoViewerContext = createContext<PanoViewerContextValue | null>(null);

export function PanoViewerProvider({ children }: { children: ReactNode }) {
	const location = useMapState((s) => s.activeLocation);
	const currentMap = useMapState((s) => s.map);
	const [currentPano, setCurrentPano] = useState<ViewerPano | null>(null);
	const [panoDates, setPanoDates] = useState<Pano["time"]>([]);
	const [panoReady, setPanoReady] = useState(false);

	const selectedPanoId =
		location && hasLoadAsPanoId(location) && currentPano?.pano
			? currentPano.pano
			: null;

	const defaultPanoId = location?.panoId ?? null;
	const lat = currentPano?.lat ?? location?.lat ?? 0;
	const lng = currentPano?.lng ?? location?.lng ?? 0;
	const datetimeEnabled = isFieldEnabled(
		currentMap?.meta.settings.enrichFields ?? null,
		"datetime",
	);
	const dateTimezone = useSetting("dateTimezone");

	const dateState = useMemo(
		() => derivePanoDateState(panoDates, selectedPanoId, currentPano, defaultPanoId),
		[panoDates, selectedPanoId, currentPano, defaultPanoId],
	);
	const exactDate = useExactDate(
		dateState.triggerPanoId,
		lat,
		lng,
		dateState.yearMonth,
		datetimeEnabled,
	);
	const resolvedTz = useTimezone(lat, lng, datetimeEnabled && dateTimezone === "location");

	// Single writer: persist the resolved exact date back to the active location's extra.
	useEffect(() => {
		if (exactDate.ts == null) return;
		if (!getMapState().map?.meta.settings.enrichMetadata) return;
		const loc = getMapState().activeLocation;
		if (!loc || loc.extra?.datetime != null) return;
		void updateLocations(
			[{ id: loc.id, patch: { extra: { datetime: exactDate.ts, timezone: resolvedTz } } }],
			{ undoable: false },
		);
	}, [exactDate.ts, resolvedTz]);

	const fullscreenMap = useSetting("fullscreenMap");
	const prevFullscreenMap = useRef(fullscreenMap);
	useEffect(() => {
		if (prevFullscreenMap.current === fullscreenMap) return;
		prevFullscreenMap.current = fullscreenMap;
		onFullscreenMapChanged(fullscreenMap);
	}, [fullscreenMap]);

	// Location cleared (save/delete/close): reset fullscreen modes and pano state.
	useEffect(() => {
		if (location) return;
		onLocationCleared();
		setCurrentPano(null);
		setPanoReady(false);
		if (singletonPano) singletonPano.setVisible(false);
	}, [location]);

	const value = useMemo(
		() => ({
			currentPano,
			setCurrentPano,
			panoDates,
			setPanoDates,
			panoReady,
			setPanoReady,
			selectedPanoId,
			lat,
			lng,
			dateState,
			exactDate,
			resolvedTz,
		}),
		[
			currentPano,
			panoDates,
			panoReady,
			selectedPanoId,
			lat,
			lng,
			dateState,
			exactDate,
			resolvedTz,
		],
	);

	return <PanoViewerContext.Provider value={value}>{children}</PanoViewerContext.Provider>;
}

export function usePanoViewer(): PanoViewerContextValue {
	const ctx = useContext(PanoViewerContext);
	if (!ctx) throw new Error("usePanoViewer must be used within PanoViewerProvider");
	return ctx;
}
