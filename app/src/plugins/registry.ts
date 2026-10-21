import type { ComponentType } from "react";
import { emit as emitEvent } from "@/lib/events";
import type { PluginManifest } from "@/bindings.gen";
import { runAsPlugin, disposePlugin } from "@/plugins/scope";
import { cmd } from "@/lib/commands";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { log } from "@/lib/util/log";

/** The fields a plugin shows as itself, declared once by its manifest. */
export type PluginIdentity = Pick<
	PluginManifest,
	"id" | "name" | "description" | "icon" | "comingSoon" | "experimental"
>;

export interface Plugin extends PluginIdentity {
	core?: boolean;
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

const plugins = new Map<string, Plugin>();
let pendingManifest: PluginManifest | null = null;

/** Set the manifest used to fill identity fields on the next `registerPlugin` call. */
export function setPendingManifest(manifest: PluginManifest | null) {
	pendingManifest = manifest;
}

/** Register a plugin. `activate` runs when a map opens; its returned cleanup runs on map close. @api */
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

/** All registered plugins, sorted by name. @api */
export function getPlugins(): Plugin[] {
	return [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up a registered plugin by id. @api */
export function getPlugin(id: string): Plugin | undefined {
	return plugins.get(id);
}

/** True when the plugin contributes data only and has no UI surfaces. @api */
export function isBackgroundPlugin(id: string): boolean {
	const plugin = plugins.get(id);
	return !!plugin && !plugin.sidebar && !plugin.modal && !plugin.locationPanel;
}

/** Remove a plugin from the registry. @api @unstable */
export function unregisterPlugin(id: string) {
	plugins.delete(id);
	emitEvent("plugins:changed");
}

const cleanups = new Map<string, () => void>();

const ENABLED_KEY = "mma_plugins_enabled";
function saveEnabled(set: Set<string>) {
	setLocal(ENABLED_KEY, [...set]);
}

const enabledSet = new Set(getLocal<string[]>(ENABLED_KEY, []));

/** True when the plugin is enabled by the user. */
export function isPluginEnabled(id: string): boolean {
	return enabledSet.has(id);
}

/** Enable or disable a plugin. @api @unstable */
export function setPluginEnabled(id: string, enabled: boolean) {
	if (enabled) enabledSet.add(id);
	else enabledSet.delete(id);
	saveEnabled(enabledSet);
	emitEvent("plugins:changed");
}

/** All registered plugins the user has enabled. */
export function getEnabledPlugins(): Plugin[] {
	return getPlugins().filter((p) => enabledSet.has(p.id));
}

/** Activate all enabled plugins. Called when a map opens. */
export function activatePlugins() {
	for (const plugin of getEnabledPlugins()) activate(plugin);
	emitEvent("plugins:changed");
}

/** Deactivate all plugins and stop their sidecars. Called when a map closes. */
export function deactivatePlugins() {
	for (const id of new Set([...getPlugins().map((p) => p.id), ...cleanups.keys()])) teardown(id);
	// Nothing is active any more, so nothing should still be running. Covers plugins
	// that registered no cleanup of their own.
	cmd.sidecarStop(null).catch(() => {});
}

/** Activate a single plugin by id. @api @unstable */
export function activatePlugin(id: string) {
	const plugin = getPlugin(id);
	if (plugin) activate(plugin);
}

// A plugin that throws while activating stays inactive without stopping the others.
function activate(plugin: Plugin) {
	if (cleanups.has(plugin.id)) return;
	try {
		const cleanup = runAsPlugin(plugin.id, () => plugin.activate());
		if (cleanup) cleanups.set(plugin.id, cleanup);
	} catch (e) {
		log.error(`[plugin] activate failed for "${plugin.id}":`, e);
		disposePlugin(plugin.id);
	}
}

/** Deactivate a single plugin and stop its sidecar. */
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

let surfaceReady = false;

/** True once the MMA surface is installed and plugins are safe to call it. @api @unstable */
export function isReady(): boolean {
	return surfaceReady;
}

/** Mark the plugin surface as ready. */
export function markReady(): void {
	surfaceReady = true;
}
