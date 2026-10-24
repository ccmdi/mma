import { useCallback, useMemo, useState, type SetStateAction } from "react";
import { Store } from "@/store/store";
import { Edit } from "@/store/edit";
import type { Op } from "@/bindings.gen";
import type { MapDetails } from "@/store/store";
import {
	getLocal,
	reloadLocal,
	setLocal,
	subscribeLocal,
	useLocalStorage,
} from "@/lib/hooks/useLocalStorage";

export interface PluginStorage {
	get<T = unknown>(key: string, fallback?: T): T;
	set(key: string, value: unknown): void;
	remove(key: string): void;
	keys(): string[];
}

/** A plugin's store in the open map. Writes resolve once they are saved. */
export interface MapPluginStorage {
	get<T = unknown>(key: string, fallback?: T): T;
	set(key: string, value: unknown): Promise<void>;
	remove(key: string): Promise<void>;
	keys(): string[];
}

type Entries = Record<string, unknown>;
type KeyChange = Op<unknown, never, null>;

function keyValue<W>(read: () => Entries, write: (key: string, change: KeyChange) => W) {
	return {
		get<T = unknown>(key: string, fallback?: T): T {
			const data = read();
			return (key in data ? data[key] : fallback) as T;
		},
		set: (key: string, value: unknown) => write(key, { set: value }),
		remove: (key: string) => write(key, { remove: null }),
		keys: () => Object.keys(read()),
	};
}

function pluginStoreKey(id: string): string {
	return `mma_plugin:${id}`;
}

function readPluginStore(id: string): Record<string, unknown> {
	return getLocal<Record<string, unknown>>(pluginStoreKey(id), {});
}

function writePluginStore(id: string, data: Record<string, unknown>) {
	setLocal(pluginStoreKey(id), data);
}

/** Persistent key-value storage namespaced to a plugin. Survives restarts. @api */
export function storage(id: string): PluginStorage {
	return keyValue(
		() => readPluginStore(id),
		(key, change) => {
			const data = { ...readPluginStore(id) };
			if ("set" in change) data[key] = change.set;
			else delete data[key];
			writePluginStore(id, data);
		},
	);
}

function requireOpenMap(): MapDetails {
	const { map } = Store.get();
	if (!map) throw new Error("No map is open");
	return map;
}

function readMapPluginStore(id: string): Entries {
	return requireOpenMap().settings.pluginData?.[id] ?? {};
}

function writeMapPluginKey(id: string, key: string, change: KeyChange): Promise<void> {
	const map = requireOpenMap();
	return Edit.meta({
		id: map.id,
		settings: { pluginData: { [id]: { put: { [key]: change } } } },
	});
}

/** Persistent key-value storage a plugin keeps with the open map, so every map has its own.
 *  Each write changes only one key, patched onto the current map settings. @api */
export function mapStorage(id: string): MapPluginStorage {
	return keyValue(
		() => readMapPluginStore(id),
		(key, change) => writeMapPluginKey(id, key, change),
	);
}

/** Re-read a plugin's store after another window wrote it. */
export function reloadStorage(id: string) {
	reloadLocal(pluginStoreKey(id), {});
}

/** One typed value in a plugin's persistent store, read anywhere and live in React. @api */
export interface PluginSetting<T> {
	/** The stored value, or the fallback while nothing of its type is stored. */
	get(): T;
	set(value: T): void;
	/** React hook: the value and its setter, re-rendering on every write. */
	use(): readonly [T, (value: T) => void];
	/** Call `listener` with each new value; returns the unsubscribe. */
	on(listener: (value: T) => void): () => void;
}

const sameKind = (a: unknown, b: unknown) =>
	typeof a === typeof b && Array.isArray(a) === Array.isArray(b);

/** A typed value under `key` in the plugin's persistent store. A stored value of another
 *  type than `fallback` reads as `fallback`. @api */
export function pluginSetting<T>(pluginId: string, key: string, fallback: T): PluginSetting<T> {
	const valueIn = (data: Entries): T => {
		const typed = fallback === null || fallback === undefined || sameKind(data[key], fallback);
		return key in data && typed ? (data[key] as T) : fallback;
	};
	const get = () => valueIn(readPluginStore(pluginId));
	const set = (value: T) => storage(pluginId).set(key, value);
	return {
		get,
		set,
		use: () => [valueIn(useLocalStorage<Entries>(pluginStoreKey(pluginId), {})[0]), set] as const,
		on(listener) {
			let last = get();
			return subscribeLocal(pluginStoreKey(pluginId), () => {
				const next = get();
				if (Object.is(next, last)) return;
				last = next;
				listener(next);
			});
		},
	};
}

/** React state hook backed by the plugin's persistent store. Survives sidebar
 *  unmount and app restart. Values are global, not per-map. @api */
export function usePluginState<T>(pluginId: string, key: string, initial: T | (() => T)) {
	const [fallback] = useState(initial);
	const setting = useMemo(() => pluginSetting(pluginId, key, fallback), [pluginId, key, fallback]);
	const [value] = setting.use();
	const update = useCallback(
		(action: SetStateAction<T>) =>
			setting.set(typeof action === "function" ? (action as (p: T) => T)(setting.get()) : action),
		[setting],
	);
	return [value, update] as const;
}
