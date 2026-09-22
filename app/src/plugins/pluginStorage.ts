import { useState, useCallback, type SetStateAction } from "react";
import { getLocal, reloadLocal, setLocal } from "@/lib/hooks/useLocalStorage";

export interface PluginStorage {
	get<T = unknown>(key: string, fallback?: T): T;
	set(key: string, value: unknown): void;
	remove(key: string): void;
	keys(): string[];
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
	return {
		get<T = unknown>(key: string, fallback?: T): T {
			const data = readPluginStore(id);
			return (key in data ? data[key] : fallback) as T;
		},
		set(key, value) {
			const data = readPluginStore(id);
			data[key] = value;
			writePluginStore(id, data);
		},
		remove(key) {
			const data = readPluginStore(id);
			delete data[key];
			writePluginStore(id, data);
		},
		keys() {
			return Object.keys(readPluginStore(id));
		},
	};
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
