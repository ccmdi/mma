// Plugin registration scope: ownership tracking and teardown.
// Ownership is captured synchronously during `runAsPlugin`. Registrations made
// after an `await` or in a later callback are not attributed.
import { subscribe, type EditorEvent, type EventHandler } from "@/lib/events";
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

/** Subscribe to an editor event, automatically unsubscribed on plugin deactivation. */
export function on<E extends EditorEvent>(event: E, handler: EventHandler<E>) {
	const unsub = subscribe(event, handler);
	trackDisposable(unsub);
	return unsub;
}
