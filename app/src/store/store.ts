import type { Derived } from "@/bindings.gen";
import { emit as emitEvent, useEventValue } from "@/lib/events";

/** The full local mirror of the store's derived state, as of the map version it reflects. */
type EngineState = {
	[K in Exclude<keyof Derived, "meta">]: NonNullable<Derived[K]>;
} & { version: number };

/** The open map's own details. Its value records, field definitions, and counts live in their
 *  own slices. */
export type MapDetails = NonNullable<Derived["meta"]>;

export interface UiState {
	mapId: string | null;
	/** Persisted identity slice (metadata + settings). Changes rarely. */
	map: MapDetails | null;
	/** Why the map in `mapId` could not be opened, or null. */
	openError: string | null;
}

export type MapState = UiState & EngineState;

const ENGINE_INITIAL: EngineState = {
	writingLayers: [],
	locationCount: 0,
	pending: { added: 0, removed: 0, updated: 0 },
	history: {},
	fieldValues: {},
	fieldDefs: {},
	selectionCounts: {},
	selectionList: [],
	unsaved: false,
	version: 0,
};

const INITIAL_STATE: MapState = {
	...ENGINE_INITIAL,
	mapId: null,
	map: null,
	openError: null,
};

let state: MapState = INITIAL_STATE;

export const Store = {
	/** Replace state fields and notify subscribers. @unstable */
	patch: (patch: Partial<MapState>) => {
		state = { ...state, ...patch };
		emitEvent("snapshot:changed");
	},
	/** Apply derived state as of `version` and remove null field values. @unstable */
	merge: (v: Derived, version: number) => {
		const { fieldValues, meta, ...rest } = v;
		if (meta && state.map) state = { ...state, map: meta };
		state = {
			...state,
			...Object.fromEntries(Object.entries(rest).filter(([, x]) => x != null)),
			version,
		};
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
		emitEvent("snapshot:changed");
	},
	/** Reactive slice of the map state. Re-renders only when the selected value's
	 *  reference changes (`Object.is`), so selectors must return state fields or
	 *  memoized values, not a new value per call. */
	use: <T>(selector: (s: MapState) => T): T => {
		return useEventValue("snapshot:changed", () => selector(state));
	},
	/** Imperative snapshot of the map state. */
	get: (): Readonly<MapState> => {
		return state;
	},
	/** Clear derived state when the map closes. @unstable */
	resetDerived: () => {
		Store.patch(ENGINE_INITIAL);
	},
};
