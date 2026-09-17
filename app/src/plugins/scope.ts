// Plugin registration scope: ownership tracking and teardown.
// Ownership is captured synchronously during `runAsPlugin`. Registrations made
// after an `await` or in a later callback are not attributed.
import {
	emit,
	subscribe,
	useEventValue,
	type EditorEvent,
	type EventHandler,
	type PluginEvent,
} from "@/lib/events";
import { log } from "@/lib/util/log";

type Disposable = () => void;

let currentOwner: string | null = null;
const stores = new Map<string, Disposable[]>();
const baseDirs = new Map<string, string>();

/** Run `fn` as plugin `id`. Registrations made during `fn` are tracked for teardown. @unstable */
export function runAsPlugin<T>(id: string, fn: () => T): T {
	const prev = currentOwner;
	currentOwner = id;
	try {
		return fn();
	} finally {
		currentOwner = prev;
	}
}

/** Enroll a teardown callback under the current plugin. No-op outside activation. @unstable */
export function trackDisposable(dispose: Disposable): void {
	if (!currentOwner) return;
	let store = stores.get(currentOwner);
	if (!store) {
		store = [];
		stores.set(currentOwner, store);
	}
	store.push(dispose);
}

/** Set the base directory for a plugin's assets on disk. @unstable */
export function setPluginBaseDir(id: string, dir: string): void {
	baseDirs.set(id, dir);
}

/** Resolve a relative path against the current plugin's base directory. Absolute
 *  paths and `res://` URLs pass through unchanged. @unstable */
export function resolvePluginPath(path: string): string {
	if (!currentOwner || path.startsWith("res://") || path.startsWith("/") || /^[a-zA-Z]:/.test(path))
		return path;
	const dir = baseDirs.get(currentOwner);
	return dir ? `${dir}/${path}` : path;
}

/** Run all teardowns a plugin registered (in reverse order) and clear them. @unstable */
export function disposePlugin(id: string): void {
	const store = stores.get(id);
	if (!store) return;
	stores.delete(id);
	for (let i = store.length - 1; i >= 0; i--) {
		try {
			store[i]();
		} catch (e) {
			log.error(`[plugin] teardown failed for "${id}":`, e);
		}
	}
}

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
