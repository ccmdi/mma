import { memo, useState, createElement } from "react";
import { getEnabledPlugins } from "@/plugins/registry";
import { useEvent } from "@/lib/events";
import { useDialog } from "@/store/dialogBus";
import { useMapState, setPluginMode } from "@/store/useMapStore";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Section } from "@/components/primitives/Sidebar";

export function PluginToolbar() {
	useEvent("plugins:changed");
	useMapState((s) => s.map);

	const plugins = getEnabledPlugins();
	const [modalId, setModalId] = useState<string | null>(null);
	useDialog("plugin-modal", (id) => setModalId(id));

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
	useEvent("plugins:changed");

	const plugins = getEnabledPlugins().filter((p) => p.locationPanel);

	if (plugins.length === 0) return null;

	return (
		<>
			{plugins.map((p) => (
				<Section
					key={p.id}
					title={
						<>
							<Icon path={p.icon} size={16} />
							{p.name}
						</>
					}
				>
					{createElement(p.locationPanel!)}
				</Section>
			))}
		</>
	);
});
