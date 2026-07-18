import { useCallback, useSyncExternalStore } from "react";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Entry {
	value: unknown;
	listeners: Set<() => void>;
}

const registry = new Map<string, Entry>();

function read<T>(key: string, defaultValue: T): T {
	try {
		const stored = localStorage.getItem(key);
		if (stored === null) return defaultValue;
		const parsed = JSON.parse(stored);
		// Merge defaults under stored object values so keys added after the blob was saved still
		// resolve. Primitives/arrays pass through unchanged.
		if (isPlainObject(parsed) && isPlainObject(defaultValue)) {
			return { ...defaultValue, ...parsed } as T;
		}
		return parsed as T;
	} catch {
		return defaultValue;
	}
}

function entryFor<T>(key: string, defaultValue: T): Entry {
	let entry = registry.get(key);
	if (!entry) {
		entry = { value: read(key, defaultValue), listeners: new Set() };
		registry.set(key, entry);
	}
	return entry;
}

/** Imperative read. Initializes the key's store from localStorage on first use. */
export function getLocal<T>(key: string, defaultValue: T): T {
	return entryFor(key, defaultValue).value as T;
}

/** Imperative write: updates the in-memory authority, persists, and notifies every subscriber. */
export function setLocal<T>(key: string, value: T): void {
	const entry = entryFor(key, value);
	entry.value = value;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// ignored
	}
	entry.listeners.forEach((l) => l());
}

/** Subscribe to imperative/reactive updates for a localStorage-backed key. */
export function subscribeLocal(key: string, cb: () => void): () => void {
	const entry = entryFor(key, null);
	entry.listeners.add(cb);
	return () => entry.listeners.delete(cb);
}

/** Reactive view of a localStorage-backed key. */
export function useLocalStorage<T>(
	key: string,
	defaultValue: T,
): [T, (v: T | ((prev: T) => T)) => void] {
	entryFor(key, defaultValue);
	const subscribe = useCallback(
		(cb: () => void) => {
			const entry = registry.get(key)!;
			entry.listeners.add(cb);
			return () => entry.listeners.delete(cb);
		},
		[key],
	);
	const value = useSyncExternalStore(subscribe, () => registry.get(key)!.value as T);
	const set = useCallback(
		(v: T | ((prev: T) => T)) => {
			const next =
				typeof v === "function" ? (v as (prev: T) => T)(registry.get(key)!.value as T) : v;
			setLocal(key, next);
		},
		[key],
	);
	return [value, set];
}
