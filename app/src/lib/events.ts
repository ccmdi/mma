import { log } from "@/lib/util/log";
import type {
	Location,
	Update,
	LocationPatch_Deserialize,
	MapData,
	Selection,
	Tag,
	TagPatch,
} from "@/bindings.gen";

/** Phantom helper: captures a payload type at the value level without a real value. */
const event = <T>() => null as T;

const EVENT_DEFS = {
	"location:add": event<Location[]>(),
	"location:remove": event<number[]>(),
	"location:update": event<Update<LocationPatch_Deserialize>[]>(),
	"tag:add": event<Tag[]>(),
	"tag:remove": event<number[]>(),
	"tag:update": event<Update<TagPatch>[]>(),
	"selection:change": event<Selection[]>(),
	"active:change": event<number | null>(),
	"map:open": event<MapData>(),
	"map:close": event<void>(),
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

export function emit<E extends EditorEvent>(evt: E, ...args: EmitArgs<E>): void {
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
const eventsWithPrefix = <P extends string>(prefix: P): EventsWithPrefix<P>[] =>
	ALL_EVENTS.filter((e): e is EventsWithPrefix<P> => e.startsWith(`${prefix}:`));

/** The events that fire whenever location data changes. */
export const LOCATION_DATA_EVENTS = eventsWithPrefix("location");
/** Selection-related events. */
export const SELECTION_EVENTS = eventsWithPrefix("selection");
/** The events that fire whenever tag definitions change. */
export const TAG_DATA_EVENTS = eventsWithPrefix("tag");
/** Map open/close lifecycle. */
export const MAP_LIFECYCLE_EVENTS = eventsWithPrefix("map");
