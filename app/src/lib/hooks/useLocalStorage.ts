import { useCallback, useSyncExternalStore } from "react";
import { migrationsFor } from "@/store/migrations";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A localStorage-backed blob: its key and its defaults, declared where the shape is defined so
 *  no call site restates the pair. Older stored shapes are handled by `store/migrations.ts`. */
export interface PersistedStore<T> {
	key: string;
	defaults: T;
}

export function persisted<T>(key: string, defaults: T): PersistedStore<T> {
	return { key, defaults };
}

type StoreArg<T> = PersistedStore<T> | string;

function asStore<T>(arg: StoreArg<T>, defaults?: T): PersistedStore<T> {
	return typeof arg === "string" ? { key: arg, defaults: defaults as T } : arg;
}

interface Entry {
	value: unknown;
	listeners: Set<() => void>;
}

const registry = new Map<string, Entry>();

function read<T>(store: PersistedStore<T>): T {
	try {
		const stored = localStorage.getItem(store.key);
		if (stored === null) return store.defaults;
		const parsed = JSON.parse(stored);
		if (!isPlainObject(parsed)) return parsed as T;
		for (const migrate of migrationsFor(store.key)) migrate(parsed);
		// Write-back: persist the migrated blob so old shapes leave disk after one launch and
		// pruning aged-out migrations can't strand them. The migrated blob only -- baking the
		// defaults merge in would stop absent keys from tracking future default changes.
		const migrated = JSON.stringify(parsed);
		if (migrated !== stored) {
			try {
				localStorage.setItem(store.key, migrated);
			} catch {
				// ignored
			}
		}
		// Merge defaults under stored object values so keys added after the blob was saved still
		// resolve. Primitives/arrays pass through unchanged.
		return isPlainObject(store.defaults) ? ({ ...store.defaults, ...parsed } as T) : (parsed as T);
	} catch {
		return store.defaults;
	}
}

function entryFor<T>(store: PersistedStore<T>): Entry {
	let entry = registry.get(store.key);
	if (!entry) {
		entry = { value: read(store), listeners: new Set() };
		registry.set(store.key, entry);
	}
	return entry;
}

/** Imperative read. Initializes the key's store from localStorage on first use. */
export function getLocal<T>(store: PersistedStore<T>): T;
export function getLocal<T>(key: string, defaultValue: T): T;
export function getLocal<T>(arg: StoreArg<T>, defaultValue?: T): T {
	return entryFor(asStore(arg, defaultValue)).value as T;
}

/** Re-read a key from localStorage into the in-memory authority and notify subscribers.
 *  For cross-window bridges, where another window wrote the backing store. */
export function reloadLocal<T>(store: PersistedStore<T>): T;
export function reloadLocal<T>(key: string, defaultValue: T): T;
export function reloadLocal<T>(arg: StoreArg<T>, defaultValue?: T): T {
	const store = asStore(arg, defaultValue);
	const entry = entryFor(store);
	entry.value = read(store);
	entry.listeners.forEach((l) => l());
	return entry.value as T;
}

/** Imperative write: updates the in-memory authority, persists, and notifies every subscriber. */
export function setLocal<T>(store: PersistedStore<T>, value: T): void;
export function setLocal<T>(key: string, value: T): void;
export function setLocal<T>(arg: StoreArg<T>, value: T): void {
	const store = asStore(arg, value);
	const entry = entryFor(store);
	entry.value = value;
	try {
		localStorage.setItem(store.key, JSON.stringify(value));
	} catch {
		// ignored
	}
	entry.listeners.forEach((l) => l());
}

/** Reactive view of a localStorage-backed key. */
export function useLocalStorage<T>(
	store: PersistedStore<T>,
): [T, (v: T | ((prev: T) => T)) => void];
export function useLocalStorage<T>(
	key: string,
	defaultValue: T,
): [T, (v: T | ((prev: T) => T)) => void];
export function useLocalStorage<T>(
	arg: StoreArg<T>,
	defaultValue?: T,
): [T, (v: T | ((prev: T) => T)) => void] {
	const { key } = asStore(arg, defaultValue);
	entryFor(asStore(arg, defaultValue));
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
