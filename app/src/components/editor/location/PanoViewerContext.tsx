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
import { getMapState, updateLocations, useMapState } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { LOCATION_MERGED, PanoType } from "@/bindings.consts";
import { usePano } from "@/lib/hooks/usePano";
import { applyPatch, patchBetween, sameRow, type LatLng } from "@/types";
import type { Pano } from "@/bindings.gen";
import type { Location } from "@/bindings.gen";
import { withoutDerivedFrom } from "@/lib/data/fieldDefs";
import { useAsync, useAsyncSticky } from "@/lib/hooks/useAsync";
import { geocodeGoogle, reverseGeocode, type GeoDisplay } from "@/lib/geo/reverseGeocode";
import { panosAt, svMetadata } from "@/lib/sv/query";
import { allUnofficial, mergeTimelines } from "@/lib/sv/panoId";
import { SV_OFFICIAL_FALLBACK_RADIUS, SV_SEARCH_RADIUS } from "@/lib/sv/constants";
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
	/** What a save writes: the draft as it stands, never waiting on enrichment. */
	settled: () => Promise<Location | null>;
	/** The draft was saved as map row `id` in undo step `step`: enrichment still in flight
	 *  lands there, in the same step while it is the newest. */
	commit: (id: number, step: number | null) => void;
	/** The draft's pano as Google describes it, for what the UI shows off the pano itself
	 *  rather than off the draft; null until it lands. */
	currentPano: Pano | null;
	/** The captures the date picker can offer at the draft's pano; null until it lands. */
	timeline: Pano["time"] | null;
	/** The pano Google resolves for the draft's position: what "Default" means there. */
	defaultPano: Pano | null;
	/** The geocoder's answer for the location's position (the google provider answers from
	 *  the pano on screen); null until it lands. */
	geo: GeoDisplay | null;
	/** The draft's enrichment is still in flight. */
	enriching: boolean;
}

const PanoViewerContext = createContext<PanoViewerContextValue | null>(null);

/** An enrichment run, and the map row and undo step its draft was saved as, once saved. */
interface Run {
	saved?: { id: number; step: number | null };
}

/** Where the viewer is: the draft once the location is open, else the location. */
export function viewerPosition(draft: Location | null, location: Location | null): LatLng {
	return draft ?? location ?? { lat: 0, lng: 0 };
}

/** `to`, without the fields derived from any input it changed from `from`. */
function moved(from: Location, to: Location): Location {
	const changed = Object.keys(patchBetween(from, to)).filter((k) => k !== "extra");
	return changed.length ? { ...to, extra: withoutDerivedFrom(to.extra, changed) } : to;
}

export function PanoViewerProvider({ children }: { children: ReactNode }) {
	const location = useMapState((s) => s.activeLocation);
	const pano = usePano();
	const [state, setState] = useState<Location | null>(null);
	// Keyed by the location that opened it: another location's draft is simply not this one.
	const draft = state && state.id === location?.id ? state : null;

	const open = useCallback((loc: Location, resolved: string | null) => {
		setState(moved(loc, { ...loc, panoId: resolved ?? loc.panoId }));
	}, []);

	const edit = useCallback(
		(patch: Partial<Location> | ((draft: Location) => Partial<Location>)) => {
			setState((prev) => {
				if (!prev) return prev;
				const next = moved(prev, {
					...prev,
					...(typeof patch === "function" ? patch(prev) : patch),
				});
				return Object.keys(patchBetween(prev, next)).length > 0 ? next : prev;
			});
		},
		[],
	);

	// The pano on screen as Google describes it, and the captures the date picker can offer
	// there. Held across a walk so the panel never blanks between panos; dropped with the location.
	const onScreen = useAsyncSticky(
		async (signal) => {
			if (!draft?.panoId) return null;
			const [shown] = await svMetadata([draft.panoId], signal);
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
		[draft?.panoId],
		draft?.id ?? null,
	);
	const currentPano = onScreen?.currentPano ?? null;
	const timeline = onScreen?.timeline ?? null;
	const defaultPano = onScreen?.defaultPano ?? null;

	const geocodeProvider = useSetting("geocodeProvider");
	const lookup = useAsync(
		() =>
			location && geocodeProvider !== "google" ? reverseGeocode(location.lat, location.lng) : null,
		[location?.lat, location?.lng, geocodeProvider],
	);
	const geo = useMemo(
		() => (geocodeProvider === "google" ? geocodeGoogle(currentPano) : lookup.data),
		[geocodeProvider, currentPano, lookup.data],
	);

	const draftKey = draft && `${draft.id}:${draft.panoId}`;
	const [enrichedKey, setEnrichedKey] = useState<string | null>(null);
	const enriching = location != null && (draftKey == null || enrichedKey !== draftKey);
	const inFlight = useRef<Promise<Location | null>>(Promise.resolve(null));
	const run = useRef<Run>({});
	useEffect(() => {
		if (!draft) return;
		const ac = new AbortController();
		const thisRun: Run = {};
		run.current = thisRun;
		// An answer is one patch over the row the run read, laid wherever that row lives now:
		// on the draft, or once saved, on the map row it became, in the save's undo step.
		let landing = Promise.resolve();
		const land = (row: Location) => {
			const patch = { extra: patchBetween(draft.extra ?? {}, row.extra ?? {}) };
			landing = landing.then(async () => {
				const saved = thisRun.saved;
				if (!saved) {
					setState((prev) =>
						prev && sameRow(prev, draft) ? applyPatch(prev, patch, LOCATION_MERGED) : prev,
					);
					return;
				}
				await updateLocations([{ ...patch, id: saved.id }], { join: saved.step });
				saved.step = getMapState().step ?? saved.step;
			});
		};
		inFlight.current = enrich(draft, {
			signal: ac.signal,
			onPartial: ([row]) => {
				if (row && !ac.signal.aborted && sameRow(row, draft)) land(row);
			},
		})
			.then((row) => {
				if (ac.signal.aborted) return null;
				land(row);
				return row;
			})
			.catch((e: unknown) => {
				if (ac.signal.aborted) return null;
				log.error("[viewer] enrichment failed:", e);
				if (!thisRun.saved) {
					setState((prev) =>
						prev && sameRow(prev, draft) ? { ...prev, extra: draft.extra } : prev,
					);
				}
				return null;
			})
			.finally(() => {
				if (!ac.signal.aborted) setEnrichedKey(draftKey);
			});
		return () => {
			if (!thisRun.saved) ac.abort();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runs per pano, reading the draft as it is then
	}, [draft?.id, draft?.panoId]);
	const commit = useCallback(
		(id: number, step: number | null) => {
			if (enriching) run.current.saved = { id, step };
		},
		[enriching],
	);
	const settled = useCallback(async () => {
		if (!draft) return null;
		if (enriching) return draft;
		const row = await inFlight.current;
		if (row && sameRow(row, draft)) return { ...draft, extra: row.extra };
		return draft;
	}, [draft, enriching]);

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
		setEnrichedKey(null);
		onLocationCleared();
		pano.hide();
	}, [pano, location]);

	const value = useMemo(
		() => ({
			draft,
			open,
			edit,
			settled,
			commit,
			currentPano,
			timeline,
			defaultPano,
			geo,
			enriching,
		}),
		[draft, open, edit, settled, commit, currentPano, timeline, defaultPano, geo, enriching],
	);

	return <PanoViewerContext.Provider value={value}>{children}</PanoViewerContext.Provider>;
}

export function usePanoViewer(): PanoViewerContextValue {
	const ctx = useContext(PanoViewerContext);
	if (!ctx) throw new Error("usePanoViewer must be used within PanoViewerProvider");
	return ctx;
}

export function usePanoDates(): PanoDateState {
	const { currentPano, timeline, defaultPano, draft } = usePanoViewer();
	return useMemo(
		() => panoDates(currentPano, timeline, defaultPano, draft),
		[currentPano, timeline, defaultPano, draft],
	);
}
