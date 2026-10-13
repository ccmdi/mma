import type { MapMeta, Derived } from "@/bindings.gen";
import { emit as emitEvent, useEventValue } from "@/lib/events";
import { SelectedIds } from "@/lib/render/CellManager";

/** The full local mirror of the store's derived state. */
type EngineState = {
	[K in Exclude<keyof Derived, "meta">]: NonNullable<Derived[K]>;
};

export interface UiState {
	mapId: string | null;
	/** Persisted identity slice (metadata + settings). Changes rarely. */
	map: MapMeta | null;
	selectedLocationIds: SelectedIds;
}

export type MapState = UiState & EngineState;

const ENGINE_INITIAL: EngineState = {
	writingLayers: [],
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
};

let state: MapState = INITIAL_STATE;

export const Store = {
	/** Replace state fields and notify subscribers. @unstable */
	patch: (patch: Partial<MapState>) => {
		state = { ...state, ...patch };
		emitEvent("store:changed");
	},
	/** Apply complete derived state and remove null field values. @unstable */
	merge: (v: Derived) => {
		const { fieldValues, meta, ...rest } = v;
		if (meta && state.map) state = { ...state, map: meta };
		state = { ...state, ...Object.fromEntries(Object.entries(rest).filter(([, x]) => x != null)) };
		if (fieldValues) {
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
		emitEvent("store:changed");
	},
	/** Reactive slice of the map state. Re-renders only when the selected value's
	 *  reference changes (`Object.is`), so selectors must return state fields or
	 *  memoized values, not a new value per call. */
	use: <T>(selector: (s: MapState) => T): T => {
		return useEventValue("store:changed", () => selector(state));
	},
	/** Imperative snapshot of the map state. */
	get: (): Readonly<MapState> => {
		return state;
	},
	/** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want. @unstable */
	setSelected: (ids: SelectedIds) => {
		Store.patch({ selectedLocationIds: ids });
	},
	/** Replace the open map's row in state; persisting it is the caller's. @unstable */
	setMeta: (map: MapMeta) => {
		Store.patch({ map });
	},
	/** Clear derived state when the map closes. @unstable */
	resetDerived: () => {
		Store.patch(ENGINE_INITIAL);
	},
};
