/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
	useActiveLocation,
	useCurrentMap,
	getActiveLocation,
	getCurrentMap,
	updateLocations,
} from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { createSyncStore } from "@/lib/util/syncStore";
import { hasLoadAsPanoId } from "@/types";
import { isFieldEnabled } from "@/lib/data/fieldDefs";
import { useTimezone } from "@/lib/util/timezone";
import type { PanoReference } from "@/lib/sv/lookup";
import { findPanoProvider } from "@/lib/sv/panoProvider";
import { getLocationProvider } from "@/lib/sv/providers/types";
import { baiduSpawnPanoId } from "@/lib/sv/baidu/session";
import { tencentSpawnPanoId } from "@/lib/sv/tencent/session";
import { useExactDate } from "./useExactDate";
import { derivePanoDateState, type PanoDateState } from "./panoDate";
import {
	restoreSuspendedFullscreenMap,
	registerPanoFullscreenSetter,
	clearSuspendedPanoFullscreen,
} from "./fullscreenModeState";

// Altitude lives outside React: its only reader is the imperative coordinate
// readout, so routing it through context would re-render every consumer.
// `null` = unknown (hide in coordinate-control); `0` = sea level (still show).
let panoAltitude: number | null = null;
const altitudeStore = createSyncStore();
export function setPanoAltitude(v: number | null): void {
	if (v === panoAltitude) return;
	panoAltitude = v;
	altitudeStore.notify();
}
export function getPanoAltitude(): number | null {
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
	/**
	 * Live "Default" capture at the current coverage spot (Baidu IsCurrent).
	 * Updated as the user moves; falls back to spawn until the first date load.
	 */
	coverageDefaultPanoId: string | null;
	setCoverageDefaultPanoId: React.Dispatch<React.SetStateAction<string | null>>;
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
	const [coverageDefaultPanoId, setCoverageDefaultPanoId] = useState<string | null>(null);

	const provider = location ? findPanoProvider(location) : null;
	const injectProvider =
		location != null ? getLocationProvider(location) : ("google" as const);
	const isInjectAlt = injectProvider === "baidu" || injectProvider === "tencent";
	const spawnPanoId = location
		? injectProvider === "baidu"
			? baiduSpawnPanoId(location)
			: injectProvider === "tencent"
				? tencentSpawnPanoId(location)
				: provider?.getSpawnPanoId
					? provider.getSpawnPanoId(location)
					: null
		: null;

	useEffect(() => {
		setCoverageDefaultPanoId(null);
	}, [location?.id]);

	// Inject alts: Default tracks coverage default / spawn. Look Around: specific.
	// Google: LoadAsPanoId flag.
	const defaultPanoId = isInjectAlt
		? (coverageDefaultPanoId ?? spawnPanoId)
		: (spawnPanoId ?? location?.panoId ?? null);

	const currentViewerPano = currentPano?.location?.pano ?? null;
	const selectedPanoId = isInjectAlt
		? currentViewerPano && defaultPanoId && currentViewerPano !== defaultPanoId
			? currentViewerPano
			: null
		: spawnPanoId && currentViewerPano
			? currentViewerPano
			: location && hasLoadAsPanoId(location) && currentViewerPano
				? currentViewerPano
				: null;
	const lat = currentPano?.location?.latLng?.lat() ?? location?.lat ?? 0;
	const lng = currentPano?.location?.latLng?.lng() ?? location?.lng ?? 0;
	const datetimeEnabled = isFieldEnabled(
		currentMap?.meta.settings.enrichFields ?? null,
		"datetime",
	);
	const dateTimezone = useSetting("dateTimezone");

	const defaultDateFromExtra =
		typeof location?.extra?.datetime === "number"
			? new Date(location.extra.datetime * 1000)
			: null;

	const dateState = useMemo(
		() =>
			derivePanoDateState(
				panoDates,
				selectedPanoId,
				currentPano,
				defaultPanoId,
				defaultDateFromExtra,
			),
		[panoDates, selectedPanoId, currentPano, defaultPanoId, defaultDateFromExtra],
	);
	const exactDate = useExactDate(
		dateState.triggerPanoId,
		lat,
		lng,
		dateState.yearMonth,
		datetimeEnabled,
		dateState.currentEntry?.date ?? dateState.displayDate,
	);
	const resolvedTz = useTimezone(lat, lng, datetimeEnabled && dateTimezone === "location");

	// Single writer: persist the resolved exact date back to the active location's extra.
	useEffect(() => {
		if (exactDate.ts == null) return;
		if (!(getCurrentMap()?.meta.settings.enrichMetadata ?? true)) return;
		const loc = getActiveLocation();
		if (!loc || loc.extra?.datetime != null) return;
		updateLocations(
			[{ id: loc.id, patch: { extra: { datetime: exactDate.ts, timezone: resolvedTz } } }],
			{ undoable: false },
		);
	}, [exactDate.ts, resolvedTz]);

	useEffect(() => registerPanoFullscreenSetter(setIsFullscreen), []);

	// Location cleared (save/delete/close): drop pano fullscreen and resume
	// fullscreen-map if it was suspended. Must restore before clearing flags.
	useEffect(() => {
		if (location) return;
		setIsFullscreen(false);
		restoreSuspendedFullscreenMap();
		clearSuspendedPanoFullscreen();
	}, [location]);

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
			coverageDefaultPanoId,
			setCoverageDefaultPanoId,
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
			coverageDefaultPanoId,
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
