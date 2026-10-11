import { useState, useCallback, type SetStateAction } from "react";
import { Store } from "@/store/store";
import { Edit } from "@/store/edit";
import type { MapMeta } from "@/bindings.gen";
import { getLocal, reloadLocal, setLocal } from "@/lib/hooks/useLocalStorage";

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

function keyValue<W>(read: () => Entries, write: (data: Entries) => W) {
	return {
		get<T = unknown>(key: string, fallback?: T): T {
			const data = read();
			return (key in data ? data[key] : fallback) as T;
		},
		set: (key: string, value: unknown) => write({ ...read(), [key]: value }),
		remove: (key: string) => {
			const data = { ...read() };
			delete data[key];
			return write(data);
		},
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

/** Persistent key-value storage namespaced to a plugin. Survives restarts. */
export function storage(id: string): PluginStorage {
	return keyValue(
		() => readPluginStore(id),
		(data) => writePluginStore(id, data),
	);
}

function requireOpenMap(): MapMeta {
	const { map } = Store.get();
	if (!map) throw new Error("No map is open");
	return map;
}

function readMapPluginStore(id: string): Entries {
	return requireOpenMap().settings.pluginData?.[id] ?? {};
}

function writeMapPluginStore(id: string, data: Entries): Promise<void> {
	const map = requireOpenMap();
	const pluginData = { ...map.settings.pluginData };
	if (Object.keys(data).length > 0) pluginData[id] = data;
	else delete pluginData[id];
	return Edit.meta({ id: map.id, settings: { ...map.settings, pluginData } });
}

/** Persistent key-value storage a plugin keeps with the open map, so every map has its own.
 *  Throws when no map is open. */
export function mapStorage(id: string): MapPluginStorage {
	return keyValue(
		() => readMapPluginStore(id),
		(data) => writeMapPluginStore(id, data),
	);
}

/** Re-read a plugin's store after another window wrote it. @unstable */
export function reloadStorage(id: string) {
	reloadLocal(pluginStoreKey(id), {});
}

/** React state hook backed by the plugin's persistent store. Survives sidebar
 *  unmount and app restart. Values are global, not per-map. */
export function usePluginState<T>(pluginId: string, key: string, initial: T | (() => T)) {
	const [value, setValue] = useState<T>(() => {
		const data = readPluginStore(pluginId);
		if (key in data) return data[key] as T;
		return typeof initial === "function" ? (initial as () => T)() : initial;
	});
	const set = useCallback(
		(action: SetStateAction<T>) => {
			setValue((prev) => {
				const next = typeof action === "function" ? (action as (p: T) => T)(prev) : action;
				storage(pluginId).set(key, next);
				return next;
			});
		},
		[pluginId, key],
	);
	return [value, set] as const;
}
