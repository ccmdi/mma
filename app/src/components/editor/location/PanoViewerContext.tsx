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
import { mutate, setOpenRow, useMapState, VIEWER } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { PanoType } from "@/bindings.consts";
import { usePano } from "@/lib/hooks/usePano";
import { isImportPreview, isSeenPreview, type LatLng } from "@/types";
import type { Location, Pano } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { useAsync, useAsyncSticky } from "@/lib/hooks/useAsync";
import { geocodeGoogle, reverseGeocode, type GeoDisplay } from "@/lib/geo/reverseGeocode";
import { panosAt, svMetadata } from "@/lib/sv/query";
import { allUnofficial, mergeTimelines } from "@/lib/sv/panoId";
import { SV_OFFICIAL_FALLBACK_RADIUS, SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { enrichAt } from "@/lib/sv/enrich";
import { log } from "@/lib/util/log";
import { panoDates, type PanoDateState } from "./panoDate";
import { onFullscreenMapChanged, onLocationCleared } from "./fullscreenModeState";
import { useEvent } from "@/lib/events";

interface PanoViewerContextValue {
	/** The location as a save would write it: the viewer's layer row. Moves as the user
	 *  walks; nothing here reaches the map until Save, and Close drops it. Null until open. */
	draft: Location | null;
	/** The location's pano is resolved and showing: `resolved` is the pano the open landed
	 *  on, which an unpinned location does not store. */
	open: (location: Location, resolved: string | null) => void;
	/** The draft changed: the viewer moved, a date was chosen, a pin toggled. */
	edit: (patch: Partial<Location> | ((draft: Location) => Partial<Location>)) => void;
	/** Land the draft with `patch` written over it: one undo step, with enrichment still
	 *  in flight following it there. The map row's id once landed, or null with no draft. */
	land: (patch: Partial<Location>) => Promise<number | null>;
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
	const location = useMapState((s) => s.openRow);
	const pano = usePano();
	const [row, setRow] = useState<Location | null>(null);
	// Which location the layer is open for, and the layer row's id (a preview's differs).
	const [held, setHeld] = useState<{ openFor: number; id: number } | null>(null);
	const [enriching, setEnriching] = useState(false);
	const rowRef = useRef(row);
	rowRef.current = row;
	const heldRef = useRef(held);
	heldRef.current = held;
	const landedRef = useRef(false);
	// Layer calls land in order, so a walk's edit can never pass the open that seeds it.
	const chain = useRef<Promise<unknown>>(Promise.resolve());
	const queue = useCallback(<T,>(fn: () => Promise<T>): Promise<T | null> => {
		const p = chain.current.then(fn, fn);
		chain.current = p.catch((e: unknown) => log.error("[viewer] layer call failed:", e));
		return p.catch(() => null);
	}, []);

	const draft = held && location && held.openFor === location.id ? row : null;

	// A change landing underneath the open row (sync, bulk work, undo) shows through the
	// layer; re-read so the projection follows.
	const changed = useEvent("store:changed");
	useEffect(() => {
		const h = heldRef.current;
		if (!h || landedRef.current) return;
		void queue(async () => {
			if (heldRef.current?.id !== h.id) return;
			const fresh = await cmd.storeRow(VIEWER, h.id);
			setRow(fresh);
			setOpenRow(fresh);
		});
	}, [changed, queue]);

	const open = useCallback(
		(loc: Location, resolved: string | null) => {
			void queue(async () => {
				// A preview was already seeded into the layer by the store; a map row holds
				// its key here from this moment.
				if (!isSeenPreview(loc) && !isImportPreview(loc)) {
					await cmd.storeDrop(VIEWER.name);
				}
				landedRef.current = false;
				await cmd.storeEdit(
					VIEWER,
					[put(loc.id, { panoId: resolved ?? loc.panoId ?? null })],
					null,
				);
				setHeld({ openFor: loc.id, id: loc.id });
				const row = await cmd.storeRow(VIEWER, loc.id);
				setRow(row);
				setOpenRow(row);
			});
		},
		[queue],
	);

	const edit = useCallback(
		(patch: Partial<Location> | ((draft: Location) => Partial<Location>)) => {
			void queue(async () => {
				const h = heldRef.current;
				const base = rowRef.current;
				if (!h || !base) return;
				const p = typeof patch === "function" ? patch(base) : patch;
				await mutate(() => cmd.storeEdit(VIEWER, [put(h.id, p)], null));
				const row = await cmd.storeRow(VIEWER, h.id);
				setRow(row);
				setOpenRow(row);
			});
		},
		[queue],
	);

	const land = useCallback(
		(patch: Partial<Location>) =>
			queue(async () => {
				const h = heldRef.current;
				if (!h) return null;
				await mutate(() => cmd.storeEdit(VIEWER, [put(h.id, patch)], { land: true }));
				landedRef.current = true;
				return h.id;
			}),
		[queue],
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

	// One run per pano the draft shows. Answers land in the layer in Rust, clearing what
	// the pano move invalidated and, once the draft is saved, following it onto the map
	// row in the save's undo step; a run's stale answers are dropped at delivery.
	useEffect(() => {
		const h = heldRef.current;
		if (!h || !row || row.id !== h.id) return;
		const ac = new AbortController();
		setEnriching(true);
		enrichAt(VIEWER, {
			signal: ac.signal,
			onPartial: (rows) => {
				const mine = rows.find((r) => r.id === h.id);
				if (mine && !ac.signal.aborted) {
					setRow(mine);
					setOpenRow(mine);
				}
			},
		})
			.catch((e: unknown) => {
				if (!ac.signal.aborted) log.error("[viewer] enrichment failed:", e);
			})
			.finally(() => {
				if (ac.signal.aborted) return;
				setEnriching(false);
				void queue(async () => {
					if (heldRef.current?.id === h.id && !landedRef.current) {
						const fresh = await cmd.storeRow(VIEWER, h.id);
						setRow(fresh);
						setOpenRow(fresh);
					}
					if (landedRef.current) await cmd.storeDrop(VIEWER.name);
				});
			});
		return () => {
			// A saved draft's run keeps going: its answers land on the map row it became.
			if (!landedRef.current) {
				ac.abort();
				setEnriching(false);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- one run per pano shown
	}, [held?.id, row?.panoId]);

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
		setHeld(null);
		setRow(null);
		if (!landedRef.current) {
			void queue(() => cmd.storeDrop(VIEWER.name));
		}
		onLocationCleared();
		pano.hide();
	}, [pano, location, queue]);

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
