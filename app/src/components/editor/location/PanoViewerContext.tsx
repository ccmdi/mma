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
import {
	getMapState,
	read,
	rowsOf,
	mutate,
	setOpenRow,
	useMapState,
	VIEWER,
	type Open,
} from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { PanoType } from "@/bindings.consts";
import { usePano } from "@/lib/hooks/usePano";
import type { LatLng } from "@/types";
import type { Location, Pano } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { useAsyncSticky } from "@/lib/hooks/useAsync";
import { geocodeGoogle, reverseGeocode, type GeoDisplay } from "@/lib/geo/reverseGeocode";
import { panosAt, svMetadata } from "@/lib/sv/query";
import { allUnofficial, mergeTimelines } from "@/lib/sv/panoId";
import { SV_OFFICIAL_FALLBACK_RADIUS, SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { enrich } from "@/lib/sv/enrich";
import { log } from "@/lib/util/log";
import { panoDates, type PanoDateState } from "./panoDate";
import { onFullscreenMapChanged, onLocationCleared } from "./fullscreenModeState";
import { useEvent } from "@/lib/events";

interface PanoViewerContextValue {
	/** The viewer's draft, or null before opening. Save applies it to the map; Close discards it. */
	draft: Location | null;
	/** Start a viewer draft for the location and its resolved pano. */
	open: (location: Location, resolved: string | null) => void;
	/** The draft changed: the viewer moved, a date was chosen, a pin toggled. */
	edit: (patch: Partial<Location> | ((draft: Location) => Partial<Location>)) => void;
	/** Save the draft with `patch` as one undo step. Pending enrichment joins that step.
	 * Returns the saved row id, or null if there is no draft. */
	land: (patch: Partial<Location>) => Promise<number | null>;
	/** Metadata for the draft's pano, or null while loading. */
	currentPano: Pano | null;
	/** Available captures for the date picker, or null while loading. */
	timeline: Pano["time"] | null;
	/** The pano Google resolves for the draft's position: what "Default" means there. */
	defaultPano: Pano | null;
	/** Geocoded position, or null while loading. Google uses the pano on screen. */
	geo: GeoDisplay | null;
	/** The draft's enrichment is still in flight. */
	enriching: boolean;
}

type ViewerSession = { open: Open; landed: boolean };

const isOpen = (session: number | undefined) => getMapState().open?.session === session;

const PanoViewerContext = createContext<PanoViewerContextValue | null>(null);

/** Where the viewer is: the draft once the location is open, else the location. */
export function viewerPosition(draft: Location | null, location: Location | null): LatLng {
	return draft ?? location ?? { lat: 0, lng: 0 };
}

/** A `Partial<Location>` as the wire patch for layer row `id`. */
function put(id: number, patch: Partial<Location>) {
	const { id: _, ...fields } = patch;
	return { put: { ...fields, id } };
}

export function PanoViewerProvider({ children }: { children: ReactNode }) {
	const opened = useMapState((s) => s.open);
	const location = opened?.row ?? null;
	const pano = usePano();
	const [enriching, setEnriching] = useState(false);
	const session = useRef<ViewerSession | null>(null);
	// Serialize layer calls so draft edits cannot run before initialization.
	const chain = useRef<Promise<unknown>>(Promise.resolve());
	const queue = useCallback(
		<T,>(fn: () => Promise<T>, owner = getMapState().open?.session): Promise<T | null> => {
			const run = () => (isOpen(owner) ? fn() : Promise.resolve(null));
			const p = chain.current.then(run, run);
			chain.current = p.catch((e: unknown) => log.error("[viewer] layer call failed:", e));
			return p.catch(() => null);
		},
		[],
	);

	const currentSession = useCallback(() => {
		const h = session.current;
		return h && isOpen(h.open.session) && !h.landed ? h : null;
	}, []);

	const draft = session.current?.open.session === opened?.session ? location : null;

	const refresh = useCallback(async (h: ViewerSession) => {
		const [fresh] = await rowsOf(
			(
				await read(
					{ type: "Locations", locations: [h.open.id], name: null },
					{ kind: "rows" },
					"rows",
					VIEWER,
				)
			).rows,
		);
		setOpenRow(fresh ?? null, h.open.session);
	}, []);

	const release = useCallback(async (h: ViewerSession | null) => {
		if (getMapState().open && !isOpen(h?.open.session)) return;
		await cmd.storeDrop(VIEWER.name);
	}, []);

	// Native changes invalidate the projection; publishing the projection does not.
	const changed = useEvent("store:change");
	useEffect(() => {
		const h = currentSession();
		if (h) void queue(() => refresh(h), h.open.session);
	}, [changed, currentSession, queue, refresh]);

	const open = useCallback(
		(loc: Location, resolved: string | null) => {
			const opened = getMapState().open;
			if (!opened) return;
			void queue(async () => {
				if (opened.origin === "map") await cmd.storeDrop(VIEWER.name);
				await cmd.storeEdit(
					VIEWER,
					[put(loc.id, { panoId: resolved ?? loc.panoId ?? null })],
					null,
				);
				const h: ViewerSession = { open: opened, landed: false };
				session.current = h;
				await refresh(h);
			});
		},
		[queue, refresh],
	);

	const edit = useCallback(
		(patch: Partial<Location> | ((draft: Location) => Partial<Location>)) => {
			void queue(async () => {
				const h = currentSession();
				const base = getMapState().open?.row;
				if (!h || !base) return;
				const p = typeof patch === "function" ? patch(base) : patch;
				await mutate(() => cmd.storeEdit(VIEWER, [put(h.open.id, p)], null));
				await refresh(h);
			});
		},
		[currentSession, queue, refresh],
	);

	const land = useCallback(
		(patch: Partial<Location>) => {
			return queue(async () => {
				const h = currentSession();
				if (!h) return null;
				await mutate(() => cmd.storeEdit(VIEWER, [put(h.open.id, patch)], { land: true }));
				h.landed = true;
				return h.open.id;
			});
		},
		[currentSession, queue],
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
	const looked = useAsyncSticky(
		() =>
			location && geocodeProvider !== "google" ? reverseGeocode(location.lat, location.lng) : null,
		[location?.lat, location?.lng, geocodeProvider],
		location?.id ?? null,
	);
	const geo = useMemo(
		() => (geocodeProvider === "google" ? geocodeGoogle(currentPano) : looked),
		[geocodeProvider, currentPano, looked],
	);

	// Enrich once per pano. Results update the draft or its saved row;
	// stale results are discarded by the store.
	useEffect(() => {
		const h = currentSession();
		if (!h || !draft || !getMapState().map?.settings.enrichMetadata) return;
		const ac = new AbortController();
		setEnriching(true);
		enrich(
			{ type: "Locations", locations: [h.open.id], name: null },
			{
				on: VIEWER,
				resolve: false,
				signal: ac.signal,
				onPartial: (rows) => {
					const mine = rows.find((r) => r.id === h.open.id);
					if (mine && !ac.signal.aborted) {
						setOpenRow(mine, h.open.session);
					}
				},
			},
		)
			.catch((e: unknown) => {
				if (!ac.signal.aborted) log.error("[viewer] enrichment failed:", e);
			})
			.finally(() => {
				if (ac.signal.aborted) return;
				if (isOpen(h.open.session)) setEnriching(false);
				if (h.landed) void queue(() => release(h));
				else void queue(() => refresh(h), h.open.session);
			});
		return () => {
			// A saved draft's run keeps going: its answers land on the map row it became.
			if (!h.landed) {
				ac.abort();
				setEnriching(false);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- one run per pano shown
	}, [opened?.session, draft?.panoId, currentSession, queue, refresh, release]);

	const fullscreenMap = useSetting("fullscreenMap");
	const prevFullscreenMap = useRef(fullscreenMap);
	useEffect(() => {
		if (prevFullscreenMap.current === fullscreenMap) return;
		prevFullscreenMap.current = fullscreenMap;
		onFullscreenMapChanged(fullscreenMap);
	}, [fullscreenMap]);

	// Location cleared (save/delete/close): drop the layer unless it landed, reset
	// fullscreen modes, hide the viewer.
	useEffect(() => {
		if (location) return;
		const h = session.current;
		session.current = null;
		if (!h?.landed) {
			void queue(() => release(h));
		}
		onLocationCleared();
		pano.hide();
	}, [pano, location, queue, release]);

	const value = useMemo(
		() => ({
			draft,
			open,
			edit,
			land,
			currentPano,
			timeline,
			defaultPano,
			geo,
			enriching,
		}),
		[draft, open, edit, land, currentPano, timeline, defaultPano, geo, enriching],
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
