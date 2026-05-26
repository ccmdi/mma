import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCurrentMap, openMap, closeMap, getCurrentMapId } from "@/store/useMapStore";
import { MapList, BulkActions } from "@/components/map-list/MapList";
import { MapEditor } from "@/components/editor/MapEditor";
import { StatsForNerds } from "@/components/dialogs/StatsForNerds.add";
import { SettingsPage } from "@/components/dialogs/SettingsPage.add";
import { PluginMarketplace } from "@/components/dialogs/PluginMarketplace.add";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys.add";
import { useSetting } from "@/store/settings.add";
import { Icon } from "@/components/primitives/Icon";
import { mdiCog, mdiPuzzle, mdiClose } from "@mdi/js";
import { ToastContainer } from "@/components/primitives/Toast.add";
import { useUpdateAvailable, dismissUpdate } from "@/lib/util/updateCheck";
import "@/plugins";

const isEditorWindow = getCurrentWindow().label.startsWith("map-");

export default function App() {
	const map = useCurrentMap();
	const [showStats, setShowStats] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [showPlugins, setShowPlugins] = useState(false);
	const customCss = useSetting("customCss");
	const updateInfo = useUpdateAvailable();

	useHotkey(useBinding("toggleStats"), () => setShowStats((s) => !s));

	useEffect(() => {
		if (isEditorWindow && !map) {
			WebviewWindow.getByLabel("main").then(async (main) => {
				await main?.unminimize();
				await main?.setFocus();
			}).finally(() => {
				getCurrentWindow().destroy();
			});
			return;
		}
	}, [map]);

	useEffect(() => {
		const onPopState = (e: PopStateEvent) => {
			const targetId = e.state?.mapId ?? null;
			if (targetId && targetId !== getCurrentMapId()) {
				openMap(targetId, false);
			} else if (!targetId && getCurrentMapId()) {
				closeMap(false);
			}
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	useEffect(() => {
		let el = document.getElementById("mma-custom-css") as HTMLStyleElement | null;
		if (!el) {
			el = document.createElement("style");
			el.id = "mma-custom-css";
			document.head.appendChild(el);
		}
		el.textContent = customCss;
		return () => {
			el!.textContent = "";
		};
	}, [customCss]);

	return (
		<>
			{map ? <MapEditor /> : <MapList />}
			{!showSettings && !showPlugins && (
				<div
					className="bottom-bar"
					style={{ position: "fixed", bottom: 12, right: 12, zIndex: 5, display: "flex", gap: 4 }}
				>
					{updateInfo && !updateInfo.dismissed && (
						<div className="update-pill">
							<button
								className="update-pill__label"
								onClick={() => setShowSettings(true)}
							>
								v{updateInfo.version} available
							</button>
							<button
								className="update-pill__dismiss"
								onClick={dismissUpdate}
								title="Dismiss"
							>
								<Icon path={mdiClose} size={14} />
							</button>
						</div>
					)}
					{!map && <BulkActions />}
					<button className="settings-gear" onClick={() => setShowPlugins(true)} title="Plugins">
						<Icon path={mdiPuzzle} />
					</button>
					<button className="settings-gear" onClick={() => setShowSettings(true)} title="Settings">
						<Icon path={mdiCog} />
					</button>
				</div>
			)}
			{showStats && <StatsForNerds onClose={() => setShowStats(false)} />}
			<SettingsPage open={showSettings} onOpenChange={setShowSettings} />
			<PluginMarketplace open={showPlugins} onOpenChange={setShowPlugins} />
			<ToastContainer />
		</>
	);
}
