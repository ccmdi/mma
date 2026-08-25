/**
 * Plugin bootstrap — loads core and user plugins.
 * The MMA API is defined in @/api.ts and exposed as window.MMA.
 */

import { preloadModules, getAvailableExternals } from "./externals";
import {
	setPendingManifest,
	getPlugins,
	activatePlugin,
	autoUpdatePlugin,
	fetchPluginRegistry,
} from "./registry";
import { appVersion } from "@/lib/version";
import type { PluginManifest } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";

// Re-export the API type for plugin consumers
export type { MMA as MMAApi } from "@/api";

// Core plugins auto-discovered via glob. Each folder's index.ts calls registerPlugin().
const corePlugins = import.meta.glob("./*/index.ts");

async function loadCorePlugins() {
	await Promise.all(Object.values(corePlugins).map((load) => load()));
	for (const p of getPlugins()) p.core = true;
}

export async function loadUserPlugin(m: PluginManifest) {
	// Lazy externals (deck.gl/luma.gl) must be resolved before the plugin's
	// synchronous __mma_require calls run at import time. Idempotent.
	await preloadModules(getAvailableExternals());
	const appDataDir = await cmd.getAppDataDir();
	setPendingManifest(m);
	try {
		const filePath = `${appDataDir}/plugins/${m.id}/${m.main}`;
		const code = await cmd.readFile(filePath);
		const blob = new Blob([code], { type: "application/javascript" });
		await import(/* @vite-ignore */ URL.createObjectURL(blob));
	} finally {
		setPendingManifest(null);
	}
}

async function loadUserPlugins() {
	let manifests: PluginManifest[];
	try {
		manifests = await cmd.listUserPlugins();
	} catch {
		return;
	}
	if (manifests.length === 0) return;
	// Silent update pass: refresh stale marketplace installs before anything loads.
	let latest = new Map<string, PluginManifest>();
	try {
		latest = new Map((await fetchPluginRegistry()).map((r) => [r.id, r]));
	} catch (e) {
		log.warn("[plugin] registry unavailable, skipping update check:", e);
	}
	for (const m of manifests) {
		try {
			await loadUserPlugin(await autoUpdatePlugin(m, latest.get(m.id), appVersion() ?? "0"));
		} catch (e) {
			log.error(`[plugin] failed to load user plugin "${m.id}":`, e);
		}
	}
}

export async function loadAndActivatePlugin(manifest: PluginManifest) {
	await loadUserPlugin(manifest);
	activatePlugin(manifest.id);
}

export const pluginsReady = loadCorePlugins().then(loadUserPlugins);
