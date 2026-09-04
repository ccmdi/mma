import { useCallback, useMemo, useSyncExternalStore } from "react";
import { emit as tauriEmit, listen } from "@tauri-apps/api/event";
import { appWindow, hasWindowHost } from "@/lib/window";
import { log } from "@/lib/util/log";
import type {
	Location,
	Update,
	LocationPatch_Deserialize,
	MapMeta,
	RenderDelta,
	Selection,
	Tag,
	TagPatch,
} from "@/bindings.gen";
import type { SelectedIds, SelCellEntry } from "@/lib/render/CellManager";
import type { RGB } from "@/lib/util/color";

/** Phantom helper: captures a payload type at the value level without a real value. */
const event = <T>() => null as T;

export interface SelectionBitmaskPayload {
	selColors: RGB[];
	cellEntries: SelCellEntry[];
	setIds: (ids: SelectedIds) => void;
}

const EVENT_DEFS = {
	"location:add": event<Location[]>(),
	"location:remove": event<number[]>(),
	"location:update": event<Update<LocationPatch_Deserialize>[]>(),
	/** Location data changed in bulk without per-location patches (e.g. a Rust-side
	 *  field op). Anything derived from location data must re-query. */
	"location:invalidate": event<void>(),
	"tag:add": event<Tag[]>(),
	"tag:remove": event<number[]>(),
	"tag:update": event<Update<TagPatch>[]>(),
	"selection:change": event<Selection[]>(),
	"active:change": event<number | null>(),
	"map:open": event<MapMeta>(),
	"map:close": event<void>(),
	"store:changed": event<void>(),
	"render:delta": event<RenderDelta>(),
	"render:selection": event<SelectionBitmaskPayload>(),
	"map-list:changed": event<void>(),
	"saved-selections:changed": event<void>(),
	"settings:changed": event<void>(),
	"fullscreen:changed": event<void>(),
	"plugins:changed": event<void>(),
	"hotkeys:changed": event<void>(),
	"toasts:changed": event<void>(),
	"scene:changed": event<void>(),
	"measure:changed": event<void>(),
	"anchor:changed": event<void>(),
	"viewport-lock:changed": event<void>(),
	"trail:changed": event<void>(),
	"seen:changed": event<void>(),
	"update:changed": event<void>(),
	"review:changed": event<void>(),
	"fields:changed": event<void>(),
	"route:changed": event<void>(),
	"import-markers:changed": event<void>(),
	"diff-markers:changed": event<void>(),
	"commit-diff:changed": event<void>(),
};

export type EditorEventMap = typeof EVENT_DEFS;
export type EditorEvent = keyof EditorEventMap;
export type EventHandler<E extends EditorEvent> = (payload: EditorEventMap[E]) => void;

/** Events whose payload is `void` may be emitted with no argument; all others require one. */
type EmitArgs<E extends EditorEvent> = EditorEventMap[E] extends void
	? []
	: [payload: EditorEventMap[E]];

const ALL_EVENTS = Object.keys(EVENT_DEFS) as EditorEvent[];

const handlers = new Map<EditorEvent, Set<(payload: never) => void>>();
const versions = new Map<EditorEvent, number>();

export function emit<E extends EditorEvent>(evt: E, ...args: EmitArgs<E>): void {
	versions.set(evt, (versions.get(evt) ?? 0) + 1);
	if (!applyingRemote && bridgedEvents.has(evt)) {
		void tauriEmit(`xwin:${evt}`, appWindow.label).catch((e) =>
			log.error(`[event] broadcast ${evt}:`, e),
		);
	}
	const set = handlers.get(evt);
	if (!set) return;
	const payload = args[0] as never;
	for (const h of set) {
		try {
			h(payload);
		} catch (e) {
			log.error(`[event] ${evt}:`, e);
		}
	}
}

/** Events with no payload; the only kind a cross-window bridge can mirror, since the
 *  receiver rereads state instead of receiving it. */
type VoidEvent = { [E in EditorEvent]: EditorEventMap[E] extends void ? E : never }[EditorEvent];

const bridgedEvents = new Set<EditorEvent>();
let applyingRemote = false;

/** Mirror `event` to every window: local emits also broadcast a Tauri event, and another
 *  window's broadcast runs `rehydrate` (reread the backing store into module state) before
 *  re-emitting locally, so all consumers update through their normal subscription. Emits
 *  during `rehydrate` don't re-broadcast, so two bridged windows can't echo. */
export function bridgeAcrossWindows(event: VoidEvent, rehydrate: () => void): void {
	if (!hasWindowHost) return;
	bridgedEvents.add(event);
	void listen<string>(`xwin:${event}`, (e) => {
		if (e.payload === appWindow.label) return;
		applyingRemote = true;
		try {
			rehydrate();
			emit(event);
		} finally {
			applyingRemote = false;
		}
	});
}

/** Normalizes event input into a stable key, event list, and subscribe callback. */
function useEventSubscription(evt: EditorEvent | readonly EditorEvent[]) {
	const key = Array.isArray(evt) ? evt.join("|") : (evt as string);
	const events = useMemo(() => key.split("|") as EditorEvent[], [key]);
	const sub = useCallback((cb: () => void) => subscribeMany(events, cb), [events]);
	return { events, sub };
}

/** Subscribe to an event and derive a reactive value from it. The value itself is the
 *  `useSyncExternalStore` snapshot, so consumers re-render only when its reference
 *  changes (`Object.is`). Two invariants follow:
 *  - `getValue` must return a cached/stable reference, never construct one per call
 *  - producers must reassign the published reference, never mutate it in place */
export function useEventValue<T>(evt: EditorEvent | readonly EditorEvent[], getValue: () => T): T {
	const { sub } = useEventSubscription(evt);
	// getValue doubles as the server snapshot: the value is module state either way.
	return useSyncExternalStore(sub, getValue, getValue);
}

/** React hook: re-renders when the given event(s) fire. Returns a version counter. */
export function useEvent(evt: EditorEvent | readonly EditorEvent[]): number {
	const { events, sub } = useEventSubscription(evt);
	const snap = useCallback(
		() => events.reduce((sum, e) => sum + (versions.get(e) ?? 0), 0),
		[events],
	);
	return useSyncExternalStore(sub, snap);
}

/** Non-hook read of the version counter for a single event. */
export function getEventVersion(evt: EditorEvent): number {
	return versions.get(evt) ?? 0;
}

export function subscribe<E extends EditorEvent>(evt: E, handler: EventHandler<E>): () => void {
	let set = handlers.get(evt);
	if (!set) {
		set = new Set();
		handlers.set(evt, set);
	}
	const h = handler as (payload: never) => void;
	set.add(h);
	return () => {
		set!.delete(h);
	};
}

/** Subscribe one payload-agnostic handler to several events; returns a single combined unsubscribe. */
export function subscribeMany(events: readonly EditorEvent[], handler: () => void): () => void {
	const unsubs = events.map((e) => subscribe(e, handler));
	return () => unsubs.forEach((u) => u());
}

/** Events under a given `namespace:` prefix, derived from the event map. */
type EventsWithPrefix<P extends string> = Extract<EditorEvent, `${P}:${string}`>;
const eventsWithPrefix = <P extends string>(
	prefix: [EventsWithPrefix<P>] extends [never] ? `No events match prefix "${P}:"` : P,
): EventsWithPrefix<P>[] =>
	ALL_EVENTS.filter((e): e is EventsWithPrefix<P> => e.startsWith(`${prefix}:`));

/** Signals that change what the map overlay draws. A module whose state reaches
 *  `buildSceneLayers` belongs here; every map surface repaints on all of them, so such a
 *  module emits its own event and never calls back into the surface. Not prefix-derived:
 *  the members share a consequence, not a namespace. */
export const OVERLAY_REPAINT_EVENTS = [
	"store:changed",
	"scene:changed",
	"trail:changed",
	"seen:changed",
	"anchor:changed",
	"measure:changed",
] as const satisfies readonly EditorEvent[];

/** The events that fire whenever location data changes. */
export const LOCATION_DATA_EVENTS = eventsWithPrefix("location");
/** Selection-related events. */
export const SELECTION_EVENTS = eventsWithPrefix("selection");
/** The events that fire whenever tag definitions change. */
export const TAG_DATA_EVENTS = eventsWithPrefix("tag");
/** Map open/close lifecycle. */
export const MAP_LIFECYCLE_EVENTS = eventsWithPrefix("map");
