import { useState, useSyncExternalStore } from "react";
import { useActivePluginId, exitPluginMode } from "@/store/useMapStore";
import {
	getPlugin,
	isPluginEnabled,
	subscribeRegistry,
	getRegistrySnapshot,
} from "@/plugins/registry";

/** Always mounted while a map is open. Normal plugin sidebars mount/unmount with
 *  plugin mode; keepAlive sidebars stay mounted after first open, hidden via
 *  display:none, so state living in DOM we don't own (e.g. iframes) survives. */
export function PluginSidebarHost() {
	const pluginId = useActivePluginId();
	useSyncExternalStore(subscribeRegistry, getRegistrySnapshot);
	const [kept, setKept] = useState<string[]>([]);

	const active = pluginId ? getPlugin(pluginId) : null;
	if (active?.keepAlive && pluginId && !kept.includes(pluginId)) {
		setKept([...kept, pluginId]);
	}

	const ActiveSidebar = active && !active.keepAlive ? active.sidebar : undefined;

	return (
		<>
			{kept.map((id) => {
				const plugin = getPlugin(id);
				if (!plugin?.sidebar || !isPluginEnabled(id)) return null;
				const KeptSidebar = plugin.sidebar;
				return (
					<div key={id} style={{ display: id === pluginId ? "contents" : "none" }}>
						<KeptSidebar onClose={exitPluginMode} />
					</div>
				);
			})}
			{ActiveSidebar && <ActiveSidebar onClose={exitPluginMode} />}
		</>
	);
}
