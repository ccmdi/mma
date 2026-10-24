import { subscribe } from "@/lib/events";
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
	/** The same setting kept with the open map, reading the shared value until the map saves its own. */
	perMap(): PluginSetting<T>;
}

interface SettingStores {
	read(): Entries[];
	use(): Entries[];
	write(value: unknown): void;
	subscribe(listener: () => void): () => void;
}

const sameKind = (a: unknown, b: unknown) =>
	typeof a === typeof b && Array.isArray(a) === Array.isArray(b);

const NO_ENTRIES: Entries = {};

/** A typed value under `key` in the plugin's persistent store. A stored value of another
 *  type than `fallback` reads as `fallback`. @api */
export function pluginSetting<T>(pluginId: string, key: string, fallback: T): PluginSetting<T> {
	const typed = (data: Entries) =>
		key in data && (fallback === null || fallback === undefined || sameKind(data[key], fallback));
	const valueIn = (stores: Entries[]): T => {
		const found = stores.find(typed);
		return found ? (found[key] as T) : fallback;
	};
	const shared: SettingStores = {
		read: () => [readPluginStore(pluginId)],
		use: () => [useLocalStorage<Entries>(pluginStoreKey(pluginId), {})[0]],
		write: (value) => storage(pluginId).set(key, value),
		subscribe: (listener) => subscribeLocal(pluginStoreKey(pluginId), listener),
	};
	const kept: SettingStores = {
		read: () => [Store.get().map?.settings.pluginData?.[pluginId] ?? NO_ENTRIES, ...shared.read()],
		use: () => [
			Store.use((s) => s.map?.settings.pluginData?.[pluginId]) ?? NO_ENTRIES,
			...shared.use(),
		],
		write: (value) => void mapStorage(pluginId).set(key, value),
		subscribe: (listener) => {
			const offs = [subscribe("snapshot:changed", listener), shared.subscribe(listener)];
			return () => offs.forEach((off) => off());
		},
	};
	const settingIn = (stores: SettingStores): PluginSetting<T> => {
		const get = () => valueIn(stores.read());
		const set = (value: T) => stores.write(value);
		return {
			get,
			set,
			use: () => [valueIn(stores.use()), set] as const,
			on(listener) {
				let last = get();
				return stores.subscribe(() => {
					const next = get();
					if (Object.is(next, last)) return;
					last = next;
					listener(next);
				});
			},
			perMap: () => settingIn(kept),
		};
	};
	return settingIn(shared);
}
