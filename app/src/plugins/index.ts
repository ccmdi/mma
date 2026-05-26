/**
 * Plugin bootstrap — loads core and user plugins.
 * The MMA API is defined in @/api.ts and exposed as window.MMA.
 */

import { setPendingManifest, type PluginManifest } from "./registry";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";

// Re-export the API type for plugin consumers
export type { MMA as MMAApi } from "@/api";

// Core plugins auto-discovered via glob. Each folder's index.ts calls registerPlugin().
const corePlugins = import.meta.glob("./*/index.ts");

async function loadCorePlugins() {
	await Promise.all(Object.values(corePlugins).map((load) => load()));
}

async function loadUserPlugins() {
	let manifests: PluginManifest[];
	try {
		manifests = await cmd.listUserPlugins();
	} catch {
		return;
	}
	const appDataDir = await cmd.getAppDataDir();
	for (const m of manifests) {
		try {
			setPendingManifest(m);
			const filePath = `${appDataDir}\\plugins\\${m.id}\\${m.main}`;
			const code = await cmd.readFile(filePath);
			const blob = new Blob([code], { type: "application/javascript" });
			await import(/* @vite-ignore */ URL.createObjectURL(blob));
			setPendingManifest(null);
		} catch (e) {
			setPendingManifest(null);
			log.error(`[plugin] failed to load user plugin "${m.id}":`, e);
		}
	}
}

export const pluginsReady = loadCorePlugins().then(loadUserPlugins);
