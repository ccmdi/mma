import { memo, useState, createElement } from "react";
import { useSyncExternalStore } from "react";
import { getEnabledPlugins, subscribeRegistry, getRegistrySnapshot } from "@/plugins/registry";
import { useCurrentMap } from "@/store/useMapStore";
import { setPluginMode } from "@/store/useMapStore";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";

export function PluginToolbar() {
	useSyncExternalStore(subscribeRegistry, getRegistrySnapshot);
	useCurrentMap();

	const plugins = getEnabledPlugins();
	const [modalId, setModalId] = useState<string | null>(null);

	if (plugins.length === 0) return null;

	const toolbarPlugins = plugins
		.filter((p) => p.modal || p.sidebar)
		.sort((a, b) => a.name.localeCompare(b.name));
	const modalPlugin = modalId ? plugins.find((p) => p.id === modalId && p.modal) : null;

	if (toolbarPlugins.length === 0 && !modalPlugin) return null;

	return (
		<>
			{toolbarPlugins.map((p) => (
				<Tooltip key={p.id} content={p.name} side="bottom">
					<button
						className="icon-button"
						onClick={() => {
							if (p.sidebar) {
								setPluginMode(p.id);
							} else if (p.modal) {
								setModalId(modalId === p.id ? null : p.id);
							}
						}}
						aria-label={p.name}
					>
						<Icon path={p.icon} />
					</button>
				</Tooltip>
			))}
			{modalPlugin &&
				modalPlugin.modal &&
				createElement(modalPlugin.modal, {
					onClose: () => setModalId(null),
				})}
		</>
	);
}

export const PluginLocationPanels = memo(function PluginLocationPanels() {
	useSyncExternalStore(subscribeRegistry, getRegistrySnapshot);

	const plugins = getEnabledPlugins().filter((p) => p.locationPanel);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

	if (plugins.length === 0) return null;

	return (
		<>
			{plugins.map((p) => (
				<div key={p.id} style={{ borderTop: "1px solid var(--stone-3)", paddingTop: 8 }}>
					<button
						onClick={() => setCollapsed((s) => ({ ...s, [p.id]: !s[p.id] }))}
						style={{
							background: "none",
							border: "none",
							cursor: "pointer",
							padding: 0,
							display: "flex",
							alignItems: "center",
							gap: 4,
							fontSize: "12px",
							fontWeight: 600,
							color: "inherit",
							marginBottom: collapsed[p.id] ? 0 : 6,
						}}
					>
						<Icon path={p.icon} size={16} />
						{p.name}
						<span style={{ opacity: 0.4, fontSize: 10 }}>{collapsed[p.id] ? "+" : "-"}</span>
					</button>
					{!collapsed[p.id] && createElement(p.locationPanel!)}
				</div>
			))}
		</>
	);
});
