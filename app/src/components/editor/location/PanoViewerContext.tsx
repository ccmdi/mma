/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
	useActiveLocation,
	useCurrentMap,
	getActiveLocation,
	getCurrentMap,
	patchLocationExtra,
} from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { createSyncStore } from "@/lib/util/syncStore";
import { hasLoadAsPanoId } from "@/types";
import { isFieldEnabled } from "@/lib/data/fieldDefs";
import { useTimezone } from "@/lib/util/timezone";
import type { PanoReference } from "@/lib/sv/lookup";
import { useExactDate } from "./useExactDate";
import { derivePanoDateState, type PanoDateState } from "./panoDate";

// Altitude lives outside React: its only reader is the imperative coordinate
// readout, so routing it through context would re-render every consumer.
let panoAltitude = 0;
const altitudeStore = createSyncStore();
export function setPanoAltitude(v: number): void {
	if (v === panoAltitude) return;
	panoAltitude = v;
	altitudeStore.notify();
}
export function getPanoAltitude(): number {
	return panoAltitude;
}
export const subscribePanoAltitude = altitudeStore.subscribe;

interface PanoViewerContextValue {
	currentPano: Pick<google.maps.StreetViewPanoramaData, "location" | "imageDate"> | null;
	setCurrentPano: React.Dispatch<React.SetStateAction<PanoViewerContextValue["currentPano"]>>;
	panoDates: PanoReference[];
	setPanoDates: React.Dispatch<React.SetStateAction<PanoReference[]>>;
	isFullscreen: boolean;
	setIsFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
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

const PanoViewerContext = createContext<PanoViewerContextValue | null>(null);

export function PanoViewerProvider({ children }: { children: ReactNode }) {
	const location = useActiveLocation();
	const currentMap = useCurrentMap();
	const [currentPano, setCurrentPano] = useState<PanoViewerContextValue["currentPano"]>(null);
	const [panoDates, setPanoDates] = useState<PanoReference[]>([]);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [panoReady, setPanoReady] = useState(false);

	const selectedPanoId =
		location && hasLoadAsPanoId(location) && currentPano?.location?.pano
			? currentPano.location.pano
			: null;

	const defaultPanoId = location?.panoId ?? null;
	const lat = currentPano?.location?.latLng?.lat() ?? location?.lat ?? 0;
	const lng = currentPano?.location?.latLng?.lng() ?? location?.lng ?? 0;
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
		if (!(getCurrentMap()?.meta.settings.enrichMetadata ?? true)) return;
		const loc = getActiveLocation();
		if (!loc || loc.extra?.datetime != null) return;
		patchLocationExtra(loc, { datetime: exactDate.ts, timezone: resolvedTz });
	}, [exactDate.ts, resolvedTz]);

	const value = useMemo(
		() => ({
			currentPano,
			setCurrentPano,
			panoDates,
			setPanoDates,
			isFullscreen,
			setIsFullscreen,
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
			isFullscreen,
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
