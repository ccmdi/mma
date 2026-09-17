// Plugin registration scope: ownership tracking and teardown.
// Ownership is captured synchronously during `runAsPlugin`. Registrations made
// after an `await` or in a later callback are not attributed.
import { log } from "@/lib/util/log";

type Disposable = () => void;

let currentOwner: string | null = null;
const stores = new Map<string, Disposable[]>();
const baseDirs = new Map<string, string>();

/** Run `fn` as plugin `id`. Registrations made during `fn` are tracked for teardown. */
export function runAsPlugin<T>(id: string, fn: () => T): T {
	const prev = currentOwner;
	currentOwner = id;
	try {
		return fn();
	} finally {
		currentOwner = prev;
	}
}

/** Enroll a teardown callback under the current plugin. No-op outside activation. */
export function trackDisposable(dispose: Disposable): void {
	if (!currentOwner) return;
	let store = stores.get(currentOwner);
	if (!store) {
		store = [];
		stores.set(currentOwner, store);
	}
	store.push(dispose);
}

/** Set the base directory for a plugin's assets on disk. */
export function setPluginBaseDir(id: string, dir: string): void {
	baseDirs.set(id, dir);
}

/** Resolve a relative path against the current plugin's base directory. Absolute
 *  paths and `res://` URLs pass through unchanged. */
export function resolvePluginPath(path: string): string {
	if (!currentOwner || path.startsWith("res://") || path.startsWith("/") || /^[a-zA-Z]:/.test(path))
		return path;
	const dir = baseDirs.get(currentOwner);
	return dir ? `${dir}/${path}` : path;
}

/** Run all teardowns a plugin registered (in reverse order) and clear them. */
export function disposePlugin(id: string): void {
	const store = stores.get(id);
	if (!store) return;
	stores.delete(id);
	for (const dispose of store.toReversed()) {
		try {
			dispose();
		} catch (e) {
			log.error(`[plugin] teardown failed for "${id}":`, e);
		}
	}
}
