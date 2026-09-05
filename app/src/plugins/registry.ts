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

// `minAppVersion` declares the app version a build needs. The registry pairs it with a
// list of older builds, so an app under the latest floor is offered the newest build it
// can actually run instead of being stranded on whatever it already has.
export function isPluginCompatible(
	minAppVersion: string | null | undefined,
	appVersion: string,
): boolean {
	return !minAppVersion || cmpVersion(appVersion, minAppVersion) >= 0;
}

// An installed plugin is updatable when both its installed version and the registry's
// version are known and differ. The registry only moves forward, so any mismatch means
// a newer build is published. Empty/unknown versions never prompt an update.
export function isPluginUpdatable(
	installedVersion: string | undefined,
	latestVersion: string | undefined,
): boolean {
	return !!installedVersion && !!latestVersion && installedVersion !== latestVersion;
}

// A plugin needs updating when its JS version drifts OR its sidecar drifts. A registry
// sidecar version that differs from what's installed (including a missing sidecar, where
// the installed version is null/undefined) means the sidecar must be (re)downloaded.
export function needsUpdate(
	installedVersion: string | undefined,
	latestVersion: string | undefined,
	installedSidecarVersion: string | null | undefined,
	latestSidecarVersion: string | undefined,
): boolean {
	if (isPluginUpdatable(installedVersion, latestVersion)) return true;
	return !!latestSidecarVersion && installedSidecarVersion !== latestSidecarVersion;
}

/** The build of a plugin an app should install: `ref` is the commit it ships at, null for
 *  the registry's latest (master). */
export interface ResolvedBuild {
	version: string;
	ref: string | null;
	minAppVersion: string | null;
}

/** The newest build of a plugin this app version can run -- the registry's latest when
 *  compatible, else the newest pinned fallback that is. Null when no published build
 *  supports this app at all. `builds` is ordered newest-first. */
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

/** Whether an install should be refreshed to `target`. A pinned build's sidecar version
 *  lives in its own manifest, so only the latest build's sidecar can be compared before
 *  downloading; for a pinned one the install itself reconciles it. */
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

/** The marketplace registry, fetched once per session (startup update check and the
 *  marketplace dialog share it). A failed fetch clears the cache so the next call retries. */
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

/** Refresh a stale install before it loads. Nothing is registered yet at startup, so an
 *  update is just re-downloading the files the normal load then picks up; any failure
 *  falls back to loading what's on disk. Plugins absent from the registry (hand-installed
 *  dev plugins) and plugins with no build this app can run are never touched. */
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

/** @unstable */
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

export function getPlugins(): Plugin[] {
	return [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getPlugin(id: string): Plugin | undefined {
	return plugins.get(id);
}

/** A plugin with no sidebar, modal, or location panel — it only contributes data
 *  (enrichment fields) and never shows UI of its own. Unknown for plugins that
 *  aren't loaded, so uninstalled registry entries report false. */
export function isBackgroundPlugin(id: string): boolean {
	const plugin = plugins.get(id);
	return !!plugin && !plugin.sidebar && !plugin.modal && !plugin.locationPanel;
}

/** @unstable */
export function unregisterPlugin(id: string) {
	plugins.delete(id);
	emitEvent("plugins:changed");
}

export function isPluginEnabled(id: string): boolean {
	return enabledSet.has(id);
}

export function setPluginEnabled(id: string, enabled: boolean) {
	if (enabled) enabledSet.add(id);
	else enabledSet.delete(id);
	saveEnabled(enabledSet);
	emitEvent("plugins:changed");
}

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

/** useState persisted through the plugin's namespaced store. UI state saved this
 *  way survives sidebar unmount and app restart. Values are global, not per-map —
 *  callers must fall back gracefully when a stored value doesn't resolve against
 *  the current map (e.g. a field key or saved-selection id). */
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

// Declarative settings (Plugin.settings) are backed by the same namespaced store,
// falling back to each def's `default` when unset.
export function getPluginSetting<T = unknown>(plugin: Plugin, key: string): T {
	const data = readPluginStore(plugin.id);
	if (key in data) return data[key] as T;
	return plugin.settings?.find((s) => s.key === key)?.default as T;
}

export function setPluginSetting(id: string, key: string, value: unknown) {
	createPluginStorage(id).set(key, value);
	emitEvent("plugins:changed");
}

// --- Activation lifecycle ---

/** @unstable */
export function activatePlugins() {
	for (const plugin of getEnabledPlugins()) {
		if (!cleanups.has(plugin.id)) {
			const cleanup = runAsPlugin(plugin.id, () => plugin.activate());
			if (cleanup) cleanups.set(plugin.id, cleanup);
		}
	}
	emitEvent("plugins:changed");
}

/** @unstable */
export function deactivatePlugins() {
	for (const [_id, cleanup] of cleanups) {
		cleanup();
	}
	cleanups.clear();
	// Nothing is active any more, so nothing should still be running. Covers plugins
	// that registered no cleanup of their own.
	cmd.sidecarStopAll().catch(() => {});
}

/** @unstable */
export function activatePlugin(id: string) {
	const plugin = plugins.get(id);
	if (!plugin || cleanups.has(id)) return;
	const cleanup = runAsPlugin(id, () => plugin.activate());
	if (cleanup) cleanups.set(id, cleanup);
}

/** @unstable */
export function deactivatePlugin(id: string) {
	const cleanup = cleanups.get(id);
	if (cleanup) {
		cleanup();
		cleanups.delete(id);
	}
	// A disabled plugin keeps no processes, whether or not it cleaned up after itself.
	cmd.sidecarStop(id).catch(() => {});
	// Reverse every host registration the plugin made during activation, even when it
	// returned no cleanup — so a disabled plugin's providers/fields/listeners stop.
	disposePlugin(id);
}

/** The per-plugin key-value store, under the name the surface uses. */
export const storage = createPluginStorage;

let surfaceReady = false;

/** True once the MMA surface is installed and plugins are safe to call it. */
export function isReady(): boolean {
	return surfaceReady;
}

/** Called by the entry point once the surface is on `window`. @unstable */
export function markReady(): void {
	surfaceReady = true;
}
