import {
	emit,
	subscribe,
	useEventValue,
	type EditorEvent,
	type EventHandler,
	type PluginEvent,
} from "@/lib/events";
import { trackDisposable } from "@/plugins/scope";

/** Subscribe to an editor event or a plugin's own event, automatically unsubscribed on plugin
 *  deactivation. */
export function on<E extends EditorEvent | PluginEvent<unknown>>(
	event: E,
	handler: EventHandler<E>,
) {
	const unsub = subscribe(event, handler);
	trackDisposable(unsub);
	return unsub;
}

/** Name one of plugin `pluginId`'s own events, carrying a `T`. Define it once and share it, so
 *  whoever raises it and whoever hears it agree on the payload. @unstable */
export function definePluginEvent<T = void>(pluginId: string, name: string): PluginEvent<T> {
	return `plugin:${pluginId}:${name}` as PluginEvent<T>;
}

/** Raise one of a plugin's own events, with its payload when it carries one. @unstable */
export function emitPluginEvent<T>(
	event: PluginEvent<T>,
	...payload: T extends void ? [] : [payload: T]
): void {
	emit(event as PluginEvent<unknown>, (payload as unknown[])[0]);
}

/** React hook: what `read` returns, read again each time `event` is raised. `read` must return
 *  the same reference while nothing it reads has changed. @unstable */
export function usePluginEvent<V>(event: PluginEvent<unknown>, read: () => V): V {
	return useEventValue(event, read);
}
