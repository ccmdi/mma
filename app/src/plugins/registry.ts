import { useState, useCallback, type ComponentType, type SetStateAction } from "react";
import { emit as emitEvent } from "@/lib/events";
import { runAsPlugin, disposePlugin } from "@/plugins/scope";
import { cmpVersion } from "@/lib/util/util";
import { cmd } from "@/lib/commands";
import type { PluginManifest } from "@/bindings.gen";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { toast } from "@/lib/util/toast";
import { log } from "@/lib/util/log";
import { t } from "@/lib/i18n";

export interface PluginSettingDef {
	key: string;
	label: string;
	type: "boolean" | "string" | "number";
	default: unknown;
}

/** The fields a plugin shows as itself, declared once by its manifest. */
export type PluginIdentity = Pick<
	PluginManifest,
	"id" | "name" | "description" | "icon" | "comingSoon" | "experimental"
>;

export interface Plugin extends PluginIdentity {
	core?: boolean;
	settings?: PluginSettingDef[];
	/** Keep the sidebar mounted (hidden) when the user leaves plugin mode.
	 *  Only for plugins whose state can't be serialized (e.g. an iframe). */
	keepAlive?: boolean;
	activate(): void | (() => void);
	modal?: ComponentType<{ onClose: () => void }>;
	sidebar?: ComponentType<{ onClose: () => void }>;
	locationPanel?: ComponentType;
}

export type PluginBehavior = Partial<Plugin> & {
	activate(): void | (() => void);
};

/** True when `appVersion` meets the plugin's minimum version requirement. @unstable */
export function isPluginCompatible(
	minAppVersion: string | null | undefined,
	appVersion: string,
): boolean {
	return !minAppVersion || cmpVersion(appVersion, minAppVersion) >= 0;
}

/** True when a newer version is published and the installed version is known. @unstable */
export function isPluginUpdatable(
	installedVersion: string | undefined,
	latestVersion: string | undefined,
): boolean {
	return !!installedVersion && !!latestVersion && installedVersion !== latestVersion;
}

/** True when either the plugin or its sidecar has a newer published version. @unstable */
export function needsUpdate(
	installedVersion: string | undefined,
	latestVersion: string | undefined,
	installedSidecarVersion: string | null | undefined,
	latestSidecarVersion: string | undefined,
): boolean {
	if (isPluginUpdatable(installedVersion, latestVersion)) return true;
	return !!latestSidecarVersion && installedSidecarVersion !== latestSidecarVersion;
}

/** The build of a plugin to install. `ref` is the commit, null for the latest. */
export interface ResolvedBuild {
	version: string;
	ref: string | null;
	minAppVersion: string | null;
}

/** The newest build of a plugin this app version can run. Falls back through older
 *  pinned builds when the latest is incompatible. Null when none fit. @unstable */
export function resolveBuild(entry: PluginManifest, appVersion: string): ResolvedBuild | null {
	if (isPluginCompatible(entry.minAppVersion, appVersion)) {
		return { version: entry.version, ref: null, minAppVersion: entry.minAppVersion ?? null };
	}
	for (const b of entry.builds ?? []) {
		if (isPluginCompatible(b.minAppVersion, appVersion)) {
			return { version: b.version, ref: b.ref, minAppVersion: b.minAppVersion ?? null };
		}
	}
	return null;
}

/** True when the installed plugin should be refreshed to `target`. @unstable */
export function needsBuildUpdate(
	installedVersion: string | undefined,
	target: ResolvedBuild,
	installedSidecarVersion: string | null | undefined,
	latestSidecarVersion: string | undefined,
): boolean {
	if (target.ref) return isPluginUpdatable(installedVersion, target.version);
	return needsUpdate(
		installedVersion,
		target.version,
		installedSidecarVersion,
		latestSidecarVersion,
	);
}

const REGISTRY_URL = "https://raw.githubusercontent.com/ccmdi/mma/master/plugins/registry.json";

let registryPromise: Promise<PluginManifest[]> | null = null;

/** Fetch the marketplace plugin registry (cached for the session). @unstable */
export function fetchPluginRegistry(): Promise<PluginManifest[]> {
	if (!registryPromise) {
		registryPromise = fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000) }).then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.json();
		});
		registryPromise.catch(() => {
			registryPromise = null;
		});
	}
	return registryPromise;
}

/** Auto-update a plugin to the newest compatible build before loading it. Falls back
 *  to what is on disk on failure. @unstable */
export async function autoUpdatePlugin(
	m: PluginManifest,
	latest: PluginManifest | undefined,
	appVersion: string,
): Promise<PluginManifest> {
	if (!latest) return m;
	const target = resolveBuild(latest, appVersion);
	if (!target) return m;
	const sidecarVersion = latest.sidecar
		? await cmd.sidecarInstalledVersion(m.id).catch(() => null)
		: null;
	if (!needsBuildUpdate(m.version, target, sidecarVersion, latest.sidecar?.version)) return m;
	try {
		const fresh = await cmd.installPlugin(m.id, target.ref);
		if (fresh.sidecar) {
			await cmd.sidecarInstall(fresh.id, fresh.sidecar.name, fresh.sidecar.version);
		}
		toast(t("{name} updated to v{version}", { name: fresh.name, version: fresh.version }));
		return fresh;
	} catch (e) {
		log.warn(`[plugin] auto-update failed for "${m.id}":`, e);
		return m;
	}
}

// --- Registry ---

const plugins = new Map<string, Plugin>();
const cleanups = new Map<string, () => void>();
let pendingManifest: PluginManifest | null = null;

/** Set the manifest used to fill identity fields on the next `registerPlugin` call. @unstable */
export function setPendingManifest(manifest: PluginManifest | null) {
	pendingManifest = manifest;
}

const ENABLED_KEY = "mma_plugins_enabled";
function saveEnabled(set: Set<string>) {
	setLocal(ENABLED_KEY, [...set]);
}

const enabledSet = new Set(getLocal<string[]>(ENABLED_KEY, []));

/** Register a plugin. `activate` runs when a map opens; its returned cleanup runs on map close. */
export function registerPlugin(plugin: Plugin | PluginBehavior) {
	if (pendingManifest) {
		const merged: Plugin = {
			id: pendingManifest.id,
			name: pendingManifest.name,
			description: pendingManifest.description,
			icon: pendingManifest.icon,
			experimental: pendingManifest.experimental,
			...plugin,
		};
		plugins.set(merged.id, merged);
		pendingManifest = null;
	} else {
		plugins.set((plugin as Plugin).id, plugin as Plugin);
	}
	emitEvent("plugins:changed");
}

/** All registered plugins, sorted by name. */
export function getPlugins(): Plugin[] {
	return [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up a registered plugin by id. */
export function getPlugin(id: string): Plugin | undefined {
	return plugins.get(id);
}

/** True when the plugin contributes data only and has no UI surfaces. */
export function isBackgroundPlugin(id: string): boolean {
	const plugin = plugins.get(id);
	return !!plugin && !plugin.sidebar && !plugin.modal && !plugin.locationPanel;
}

/** Remove a plugin from the registry. @unstable */
export function unregisterPlugin(id: string) {
	plugins.delete(id);
	emitEvent("plugins:changed");
}

/** True when the plugin is enabled by the user. */
export function isPluginEnabled(id: string): boolean {
	return enabledSet.has(id);
}

/** Enable or disable a plugin. */
export function setPluginEnabled(id: string, enabled: boolean) {
	if (enabled) enabledSet.add(id);
	else enabledSet.delete(id);
	saveEnabled(enabledSet);
	emitEvent("plugins:changed");
}

/** All registered plugins the user has enabled. */
export function getEnabledPlugins(): Plugin[] {
	return [...plugins.values()].filter((p) => enabledSet.has(p.id));
}

// --- Plugin storage (namespaced localStorage, one JSON object per plugin) ---

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
export function createPluginStorage(id: string): PluginStorage {
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
				createPluginStorage(pluginId).set(key, next);
				return next;
			});
		},
		[pluginId, key],
	);
	return [value, set] as const;
}

/** Read a plugin's declared setting value, falling back to the setting's default. */
export function getPluginSetting<T = unknown>(plugin: Plugin, key: string): T {
	const data = readPluginStore(plugin.id);
	if (key in data) return data[key] as T;
	return plugin.settings?.find((s) => s.key === key)?.default as T;
}

/** Write a plugin's declared setting value. */
export function setPluginSetting(id: string, key: string, value: unknown) {
	createPluginStorage(id).set(key, value);
	emitEvent("plugins:changed");
}

// --- Activation lifecycle ---

/** Activate all enabled plugins. Called when a map opens. @unstable */
export function activatePlugins() {
	for (const plugin of getEnabledPlugins()) {
		if (!cleanups.has(plugin.id)) {
			const cleanup = runAsPlugin(plugin.id, () => plugin.activate());
			if (cleanup) cleanups.set(plugin.id, cleanup);
		}
	}
	emitEvent("plugins:changed");
}

/** Deactivate all plugins and stop their sidecars. Called when a map closes. @unstable */
export function deactivatePlugins() {
	for (const id of new Set([...plugins.keys(), ...cleanups.keys()])) teardown(id);
	// Nothing is active any more, so nothing should still be running. Covers plugins
	// that registered no cleanup of their own.
	cmd.sidecarStopAll().catch(() => {});
}

/** Activate a single plugin by id. @unstable */
export function activatePlugin(id: string) {
	const plugin = plugins.get(id);
	if (!plugin || cleanups.has(id)) return;
	const cleanup = runAsPlugin(id, () => plugin.activate());
	if (cleanup) cleanups.set(id, cleanup);
}

/** Deactivate a single plugin and stop its sidecar. @unstable */
export function deactivatePlugin(id: string) {
	teardown(id);
	// A disabled plugin keeps no processes, whether or not it cleaned up after itself.
	cmd.sidecarStop(id).catch(() => {});
}

// Run the plugin's own cleanup, then reverse every host registration it made.
function teardown(id: string) {
	const cleanup = cleanups.get(id);
	cleanups.delete(id);
	try {
		cleanup?.();
	} catch (e) {
		log.error(`[plugin] cleanup failed for "${id}":`, e);
	}
	disposePlugin(id);
}

/** The per-plugin key-value store, under the name the surface uses. */
export const storage = createPluginStorage;

let surfaceReady = false;

/** True once the MMA surface is installed and plugins are safe to call it. */
export function isReady(): boolean {
	return surfaceReady;
}

/** Mark the plugin surface as ready. @unstable */
export function markReady(): void {
	surfaceReady = true;
}
