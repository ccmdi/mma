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
import { useMapState } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { PanoType } from "@/bindings.consts";
import { singletonPano } from "@/lib/sv/panoSingleton";
import { sameRow, type LatLng, type Pano } from "@/types";
import type { Location } from "@/bindings.gen";
import { withoutProvided } from "@/lib/data/fieldDefs";
import { useAsyncSticky } from "@/lib/hooks/useAsync";
import { panosAt, svMetadata } from "@/lib/sv/query";
import { allUnofficial, mergeTimelines } from "@/lib/sv/getMetadata";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { enrich } from "@/lib/sv/enrich";
import { log } from "@/lib/util/log";
import { panoDates, type PanoDateState } from "./panoDate";
import { onFullscreenMapChanged, onLocationCleared } from "./fullscreenModeState";

interface PanoViewerContextValue {
	/** The location as a save would write it: on the pano showing now, at its position,
	 *  pinned or not, with what enrichment answered for it. Moves as the user walks;
	 *  nothing here reaches the store until Save, and Close drops it. Null until open. */
	draft: Location | null;
	/** The location's pano is resolved and showing: `resolved` is the pano the open landed
	 *  on, which an unpinned location does not store. */
	open: (location: Location, resolved: string | null) => void;
	/** The draft changed: the viewer moved, a date was chosen, a pin toggled. */
	edit: (patch: Partial<Location> | ((draft: Location) => Partial<Location>)) => void;
	/** The draft once enrichment in flight has answered: what a save writes. */
	settled: () => Promise<Location | null>;
	/** The draft's pano as Google describes it, for what the UI shows off the pano itself
	 *  rather than off the draft; null until it lands. */
	meta: Pano | null;
	/** The captures the date picker can offer at the draft's pano; null until it lands. */
	timeline: Pano["time"] | null;
	/** The pano Google resolves for the draft's position: what "Default" means there. */
	defaultPano: string | null;
	/** The draft's enrichment is still in flight. */
	enriching: boolean;
}

const PanoViewerContext = createContext<PanoViewerContextValue | null>(null);

/** Where the viewer is: the draft once the location is open, else the location. */
export function viewerPosition(draft: Location | null, location: Location | null): LatLng {
	return draft ?? location ?? { lat: 0, lng: 0 };
}

export function PanoViewerProvider({ children }: { children: ReactNode }) {
	const location = useMapState((s) => s.activeLocation);
	const [state, setState] = useState<Location | null>(null);
	// Keyed by the location that opened it: another location's draft is simply not this one.
	const draft = state && state.id === location?.id ? state : null;
	// Off the stored row's pano, every provider field belongs to another pano.
	const moved = draft !== null && draft.panoId !== location?.panoId;
	const draftPano = draft?.panoId ?? null;

	const open = useCallback((loc: Location, resolved: string | null) => {
		setState({ ...loc, panoId: resolved ?? loc.panoId });
	}, []);
	const edit = useCallback((patch: Partial<Location> | ((draft: Location) => Partial<Location>)) => {
		setState((prev) => {
			if (!prev) return prev;
			const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
			return Object.keys(next).some((k) => next[k as keyof Location] !== prev[k as keyof Location])
				? next
				: prev;
		});
	}, []);

	// The pano on screen as Google describes it, and the captures the date picker can offer
	// there. Held across a walk so the panel never blanks between panos; dropped with the location.
	const onScreen = useAsyncSticky(
		async (signal) => {
			if (!draftPano) return null;
			const [meta] = await svMetadata([draftPano], signal);
			if (!meta) return null;
			const here = [{ lat: meta.lat, lng: meta.lng }];
			const [atCoord] = await panosAt(here, SV_SEARCH_RADIUS, undefined, signal);
			let timeline = mergeTimelines([atCoord, meta]);
			if (allUnofficial(timeline)) {
				const [official] = await panosAt(here, 25, { sources: [PanoType.Official] }, signal);
				timeline = mergeTimelines([atCoord, meta, official]);
			}
			return { meta, timeline, defaultPano: atCoord?.pano ?? meta.pano };
		},
		[draftPano],
		draft?.id ?? null,
	);
	const meta = onScreen?.meta ?? null;
	const timeline = onScreen?.timeline ?? null;
	const defaultPano = onScreen?.defaultPano ?? null;

	const [enriching, setEnriching] = useState(false);
	const inFlight = useRef<Promise<Location | null>>(Promise.resolve(null));
	useEffect(() => {
		if (!draft) return;
		const ac = new AbortController();
		const patch = (extra: Location["extra"]) =>
			setState((prev) => (prev && sameRow(prev, draft) ? { ...prev, extra } : prev));
		setEnriching(true);
		inFlight.current = enrich(draft, { signal: ac.signal, force: moved })
			.then((row) => {
				if (ac.signal.aborted) return null;
				patch(row.extra);
				return row;
			})
			.catch((e: unknown) => {
				if (ac.signal.aborted) return null;
				log.error("[viewer] enrichment failed:", e);
				// Off the stored pano the draft's fields are another pano's: Save must not write them.
				if (moved) patch(withoutProvided(draft.extra));
				return null;
			})
			.finally(() => {
				if (!ac.signal.aborted) setEnriching(false);
			});
		return () => ac.abort();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runs per pano, reading the draft as it is then
	}, [draft?.id, draftPano]);
	const settled = useCallback(async () => {
		const row = await inFlight.current;
		if (!draft) return null;
		if (row && sameRow(row, draft)) return { ...draft, extra: row.extra };
		return moved ? { ...draft, extra: withoutProvided(draft.extra) } : draft;
	}, [draft, moved]);

	const fullscreenMap = useSetting("fullscreenMap");
	const prevFullscreenMap = useRef(fullscreenMap);
	useEffect(() => {
		if (prevFullscreenMap.current === fullscreenMap) return;
		prevFullscreenMap.current = fullscreenMap;
		onFullscreenMapChanged(fullscreenMap);
	}, [fullscreenMap]);

	// Location cleared (save/delete/close): drop the draft, reset fullscreen modes, hide the viewer.
	useEffect(() => {
		if (location) return;
		setState(null);
		onLocationCleared();
		if (singletonPano) singletonPano.setVisible(false);
	}, [location]);

	const value = useMemo(
		() => ({ draft, open, edit, settled, meta, timeline, defaultPano, enriching }),
		[draft, open, edit, settled, meta, timeline, defaultPano, enriching],
	);

	return <PanoViewerContext.Provider value={value}>{children}</PanoViewerContext.Provider>;
}

export function usePanoViewer(): PanoViewerContextValue {
	const ctx = useContext(PanoViewerContext);
	if (!ctx) throw new Error("usePanoViewer must be used within PanoViewerProvider");
	return ctx;
}

export function usePanoDates(): PanoDateState {
	const { meta, timeline, defaultPano, draft } = usePanoViewer();
	return useMemo(
		() => panoDates(meta, timeline, defaultPano, draft),
		[meta, timeline, defaultPano, draft],
	);
}
