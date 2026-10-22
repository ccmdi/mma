import { memo, useState, createElement } from "react";
import { Editor } from "@/store/editor";
import { getEnabledPlugins } from "@/plugins/registry";
import { PluginBoundary } from "@/plugins/PluginBoundary";
import { useEvent } from "@/lib/events";
import { openDialog, useDialog } from "@/store/dialogBus";
import { Icon } from "@/components/primitives/Icon";
import { Section } from "@/components/primitives/Sidebar";
import { IconButton } from "@/components/primitives/IconButton";

/** A button for each enabled plugin with a modal or a sidebar, carrying its badge; on the map list,
 *  only those that open a modal and ask to be there. */
export function PluginButtons({ mapList }: { mapList?: boolean }) {
	useEvent("plugins:changed");
	return getEnabledPlugins()
		.filter((p) => (mapList ? p.onMapList && p.modal : p.modal || p.sidebar))
		.map((p) => (
			<IconButton
				key={p.id}
				icon={p.icon}
				label={p.name}
				size={mapList ? 18 : undefined}
				tooltipSide={mapList ? undefined : "bottom"}
				onClick={() =>
					!mapList && p.sidebar ? Editor.openPlugin(p.id) : openDialog("plugin-modal", p.id)
				}
			>
				{p.badge && <PluginBoundary pluginId={p.id}>{createElement(p.badge)}</PluginBoundary>}
			</IconButton>
		));
}

/** The modal of the plugin the app last asked to show, until it closes. */
export function PluginModal() {
	useEvent("plugins:changed");
	const [id, setId] = useState<string | null>(null);
	useDialog("plugin-modal", setId);
	const modal = getEnabledPlugins().find((p) => p.id === id)?.modal;
	return (
		modal && (
			<PluginBoundary pluginId={id!}>
				{createElement(modal, { onClose: () => setId(null) })}
			</PluginBoundary>
		)
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
					<PluginBoundary pluginId={p.id}>{createElement(p.locationPanel!)}</PluginBoundary>
				</Section>
			))}
		</>
	);
});

/** Each enabled plugin's component for `slot`. */
export function PluginSlot({ slot }: { slot: "layer" | "headerItem" }) {
	useEvent("plugins:changed");
	return getEnabledPlugins().map((p) => {
		const item = p[slot];
		return (
			item && (
				<PluginBoundary key={p.id} pluginId={p.id}>
					{createElement(item)}
				</PluginBoundary>
			)
		);
	});
}
