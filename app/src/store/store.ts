import type { MapMeta, Derived, Location } from "@/bindings.gen";
import { emit as emitEvent, useEventValue } from "@/lib/events";
import { SelectedIds } from "@/lib/render/CellManager";
import type { WorkArea } from "@/types";

/** The full local mirror of the store's derived state. */
type EngineState = {
	[K in Exclude<keyof Derived, "meta">]: NonNullable<Derived[K]>;
};

export interface UiState {
	mapId: string | null;
	/** Persisted identity slice (metadata + settings). Changes rarely. */
	map: MapMeta | null;
	selectedLocationIds: SelectedIds;
	/** The location open in the editor, or null. */
	open: Open | null;
	/** @unstable */
	duplicateLocations: Location[];
	/** @unstable */
	workArea: WorkArea;
	/** @unstable */
	activePluginId: string | null;
}

/** Where an open location came from: the map, the seen history, or a pending import. */
export type OpenOrigin = "map" | "seen" | "import";

/** A location open in the editor. A preview's id is its viewer-layer id. */
export interface Open {
	id: number;
	origin: OpenOrigin;
	/** Identifies this editor session, even when reopening the same location. */
	session: number;
	/** The location as last read from the viewer's layer, or null while loading. */
	location: Location | null;
}

export type MapState = UiState & EngineState;

const ENGINE_INITIAL: EngineState = {
	locationCount: 0,
	history: {},
	fieldValues: {},
	fieldDefs: {},
	selectionCounts: {},
	selectionList: [],
};

const INITIAL_STATE: MapState = {
	...ENGINE_INITIAL,
	mapId: null,
	map: null,
	selectedLocationIds: SelectedIds.EMPTY,
	open: null,
	duplicateLocations: [],
	workArea: "overview",
	activePluginId: null,
};

let state: MapState = INITIAL_STATE;

/** Replace state fields and notify subscribers. @unstable */
function patch(patch: Partial<MapState>) {
	state = { ...state, ...patch };
	emitEvent("store:changed");
}

/** Merge derived updates, preserving null fields and removing null field values. @unstable */
function merge(v: Derived) {
	const { fieldValues, meta, ...rest } = v;
	if (meta && state.map) state = { ...state, map: { ...state.map, ...meta } };
	state = { ...state, ...Object.fromEntries(Object.entries(rest).filter(([, x]) => x != null)) };
	if (!fieldValues) return;
	const merged = { ...state.fieldValues };
	for (const [field, values] of Object.entries(fieldValues)) {
		const next = { ...merged[field] };
		for (const [key, value] of Object.entries(values)) {
			if (value) next[key] = value;
			else delete next[key];
		}
		merged[field] = next;
	}
	state = { ...state, fieldValues: merged };
}

/** Reactive slice of the map state. Re-renders only when the selected value's
 *  reference changes (`Object.is`), so selectors must return state fields or
 *  memoized values, not a new value per call. */
function use<T>(selector: (s: MapState) => T): T {
	return useEventValue("store:changed", () => selector(state));
}

/** Imperative snapshot of the map state. */
function get(): Readonly<MapState> {
	return state;
}

/** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want. @unstable */
function setSelected(ids: SelectedIds) {
	patch({ selectedLocationIds: ids });
}

/** Replace the open map's row in state; persisting it is the caller's. @unstable */
function setMeta(map: MapMeta) {
	patch({ map });
}

/** Clear derived state when the map closes. @unstable */
function resetDerived() {
	patch(ENGINE_INITIAL);
}

export const Store = { patch, merge, use, get, setSelected, setMeta, resetDerived };
