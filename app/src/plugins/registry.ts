import type { ComponentType } from "react";
import { emit as emitEvent } from "@/lib/events";
import type { PluginManifest } from "@/bindings.gen";

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

/** Set the manifest used to fill identity fields on the next `registerPlugin` call. @unstable */
export function setPendingManifest(manifest: PluginManifest | null) {
	pendingManifest = manifest;
}

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
