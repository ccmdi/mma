import { emit as emitEvent } from "@/lib/events";
import { runAsPlugin, disposePlugin } from "@/plugins/scope";
import { getPlugin, getPlugins, type Plugin } from "@/plugins/registry";
import { cmd } from "@/lib/commands";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { log } from "@/lib/util/log";

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

/** Enable or disable a plugin. */
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
	for (const plugin of getEnabledPlugins()) {
		if (!cleanups.has(plugin.id)) {
			const cleanup = runAsPlugin(plugin.id, () => plugin.activate());
			if (cleanup) cleanups.set(plugin.id, cleanup);
		}
	}
	emitEvent("plugins:changed");
}

/** Deactivate all plugins and stop their sidecars. Called when a map closes. */
export function deactivatePlugins() {
	for (const id of new Set([...getPlugins().map((p) => p.id), ...cleanups.keys()])) teardown(id);
	// Nothing is active any more, so nothing should still be running. Covers plugins
	// that registered no cleanup of their own.
	cmd.sidecarStopAll().catch(() => {});
}

/** Activate a single plugin by id. */
export function activatePlugin(id: string) {
	const plugin = getPlugin(id);
	if (!plugin || cleanups.has(id)) return;
	const cleanup = runAsPlugin(id, () => plugin.activate());
	if (cleanup) cleanups.set(id, cleanup);
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

/** True once the MMA surface is installed and plugins are safe to call it. */
export function isReady(): boolean {
	return surfaceReady;
}

/** Mark the plugin surface as ready. */
export function markReady(): void {
	surfaceReady = true;
}
