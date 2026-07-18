import { useState, useEffect } from "react";
import type { ComponentType, CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { useCurrentMap } from "@/store/useMapStore";
import {
	useTargetMapId,
	useManualChapter,
	closeManual,
	gotoManualChapter,
	goToList,
	openManual,
} from "@/store/router";
import { MapList, BulkActions } from "@/components/map-list/MapList";
import { StatsForNerds } from "@/components/dialogs/StatsForNerds";
import { SettingsPage } from "@/components/dialogs/SettingsPage";
import { PluginMarketplace } from "@/components/dialogs/PluginMarketplace";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Manual } from "@/components/manual/Manual";
import { ManualSearch } from "@/components/manual/ManualSearch";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useSetting, useSettings, setSetting, CSS_VAR_SETTINGS } from "@/store/settings";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { type MapEmbedPrefs, DEFAULT_PREFS } from "@/store/mapEmbedPrefs";
import "@/lib/render/renderStats"; // installs the window.__mmaPerf harness bridge
import { applyAccentColor, resolveSvColorHex } from "@/lib/util/color";
import { Icon, mdiDiscord } from "@/components/primitives/Icon";
import { mdiCog, mdiPuzzle, mdiClose, mdiBookOpenPageVariantOutline } from "@mdi/js";
import { ToastContainer } from "@/components/primitives/Toast";
import { TooltipProvider } from "@/components/primitives/Tooltip";
import { useUpdateState, dismissUpdate, installUpdate, relaunchApp } from "@/lib/util/updateCheck";
import { APP_NAME } from "@/lib/util/format";
import { useDiscordPresence } from "@/lib/discord/presence";
import { initRemoteHost } from "@/lib/remote/host";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import "@/plugins";

// Dynamic import (deck.gl/luma.gl out of the initial bundle) WITHOUT React.lazy/Suspense —
// a Suspense boundary makes React 19 render the editor in a low-priority lane (~260ms/open).
// We preload the chunk in the background and render it as a plain component in the urgent lane.
const mapEditorModule = import("@/components/editor/MapEditor");

// A real Tauri sub-window for a single map (label "map-<id>"). Always false on web, where
// every tab reports label "main" — there the URL (targetMapId) alone picks editor vs list.
const isEditorWindow = getCurrentWindow().label.startsWith("map-");

// tauri-plugin-window-state StateFlags::all() — size|position|maximized|visible|decorations|fullscreen
const WINDOW_STATE_ALL = 0b111111;

const BLANK_STYLE: CSSProperties = { position: "fixed", inset: 0, background: "var(--surface-0)" };
const Blank = () => <div style={BLANK_STYLE} />;

// The URL is the role authority — `targetMapId` picks editor vs list on BOTH Tauri and web.
// The window label only adds Tauri's "close my window when I back out" behavior.
export default function App() {
	const targetMapId = useTargetMapId();
	const manualOpen = useManualChapter() !== null;
	// A Tauri map window whose map was backed out of: focus the list window, persist this
	// window's geometry, then destroy it. Never true on web (no sub-window to close).
	const closing = isEditorWindow && !targetMapId;

	useSelfDestruct(closing);
	useCustomCss();
	useCssVarSettings();
	useDiscordPresence();
	useRemoteApi();

	return (
		<TooltipProvider>
			{closing ? (
				<Blank />
			) : targetMapId ? (
				<EditorRoot />
			) : (
				!manualOpen && (
					<div className="page-scroll">
						<MapList />
					</div>
				)
			)}
			{!closing && <AppChrome />}
			<AccentSync />
			<ToastContainer />
		</TooltipProvider>
	);
}

/** Editor window content: the map data + the lazily-loaded editor chunk, with a blank
 *  placeholder while either is still resolving. */
function EditorRoot() {
	const map = useCurrentMap();
	const [MapEditor, setMapEditor] = useState<ComponentType | null>(null);
	useEffect(() => {
		mapEditorModule.then((m) => setMapEditor(() => m.MapEditor));
	}, []);
	if (!map || !MapEditor) return <Blank />;
	return <MapEditor />;
}

/** Floating UI shared by both window roles: settings/plugins gears, update pill, and the
 *  app-level dialogs. Hidden by App while a window is self-destructing. */
function AppChrome() {
	const map = useCurrentMap();
	const isMapList = !useTargetMapId();
	const manualChapter = useManualChapter();

	const update = useUpdateState();
	const [showStats, setShowStats] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [showPlugins, setShowPlugins] = useState(false);
	const [manualSearchOpen, setManualSearchOpen] = useState(false);

	useHotkey(useBinding("toggleStats"), () => setShowStats((s) => !s));
	useHotkey(useBinding("openManualSearch"), () => setManualSearchOpen((v) => !v));
	useHotkey(useBinding("closeMap"), () => {
		if (map) goToList();
	});

	const hasSeenWelcome = useSetting("hasSeenWelcome");
	const fullscreenMap = useSetting("fullscreenMap");

	return (
		<>
			{isMapList && !showSettings && !showPlugins && (
				<div className="bottom-bar bottom-bar--left">
					<a
						className="settings-gear"
						href="https://discord.gg/4wPNJTuzD8"
						target="_blank"
						rel="noopener noreferrer"
						title="Join the Discord"
					>
						<Icon path={mdiDiscord} />
					</a>
					<button className="settings-gear" onClick={() => openManual()} title="Manual">
						<Icon path={mdiBookOpenPageVariantOutline} />
					</button>
				</div>
			)}
			<WelcomeDialog
				open={isMapList && !hasSeenWelcome}
				onDismiss={() => setSetting("hasSeenWelcome", true)}
			/>
			{!showSettings && !showPlugins && !(map && fullscreenMap) && (
				<div className="bottom-bar">
					{update.version && !update.dismissed && (
						<div className="update-pill">
							{update.phase === "available" && (
								<>
									<button className="update-pill__label" onClick={installUpdate}>
										v{update.version} - download update
									</button>
									<button className="update-pill__dismiss" onClick={dismissUpdate} title="Dismiss">
										<Icon path={mdiClose} size={14} />
									</button>
								</>
							)}
							{update.phase === "downloading" && (
								<span className="update-pill__label">Downloading {update.percent}%</span>
							)}
							{update.phase === "ready" && (
								<button className="update-pill__label" onClick={relaunchApp}>
									Restart to update
								</button>
							)}
							{update.phase === "error" && (
								<>
									<button className="update-pill__label" onClick={installUpdate}>
										Update failed - retry
									</button>
									<button className="update-pill__dismiss" onClick={dismissUpdate} title="Dismiss">
										<Icon path={mdiClose} size={14} />
									</button>
								</>
							)}
						</div>
					)}
					{isMapList && <BulkActions />}
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
			<ManualSearch open={manualSearchOpen} onOpenChange={setManualSearchOpen} />
			{manualChapter !== null && (
				<Manual chapterId={manualChapter} onNavigate={gotoManualChapter} onClose={closeManual} />
			)}
		</>
	);
}

/** Tauri-only: a map sub-window persists its geometry and destroys itself once its map is
 *  backed out of. destroy() never fires CloseRequested, so the window-state plugin wouldn't
 *  save geometry — we save it explicitly first. */
function useSelfDestruct(closing: boolean) {
	useEffect(() => {
		if (!closing) return;
		WebviewWindow.getByLabel("main")
			.then(async (main) => {
				await main?.unminimize();
				await main?.setFocus();
			})
			.finally(async () => {
				await invoke("plugin:window-state|save_window_state", { flags: WINDOW_STATE_ALL }).catch(
					() => {},
				);
				getCurrentWindow().destroy();
			});
	}, [closing]);
}

/** Start/stop the local MMA REST transport with its setting, and host incoming
 *  calls in this window. Start is idempotent across windows (re-keys if running). */
function useRemoteApi() {
	const enabled = useSetting("remoteApi");
	const key = useSetting("remoteApiKey");
	useEffect(() => initRemoteHost(), []);
	useEffect(() => {
		const call = enabled && key ? cmd.remoteApiStart(key) : cmd.remoteApiStop();
		call.catch((e) => log.warn(`[remote-api] ${e}`));
	}, [enabled, key]);
}

/** Mirror the CSS-var-backed app settings (see `CSS_VAR_SETTINGS`) onto `:root`. */
function useCssVarSettings() {
	const settings = useSettings();
	useEffect(() => {
		for (const [cssVar, value] of CSS_VAR_SETTINGS) {
			document.documentElement.style.setProperty(cssVar, value(settings));
		}
	}, [settings]);
}

/** Renders nothing. The accent follows the SV coverage line color; this isolates
 *  the mapEmbedPrefs subscription so pref churn (opacity slider drags write prefs
 *  per tick) re-renders only this component, never the App tree. */
function AccentSync() {
	const [prefs] = useLocalStorage<MapEmbedPrefs>("mapEmbedPrefs", DEFAULT_PREFS);
	useEffect(() => {
		applyAccentColor(resolveSvColorHex(prefs.svColor));
	}, [prefs.svColor]);
	return null;
}

function useCustomCss() {
	const customCss = useSetting("customCss");
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
}

function WelcomeDialog({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (!v) onDismiss();
			}}
		>
			<DialogContent title={`Welcome to ${APP_NAME}`} className="welcome-dialog">
				<p>
					If you're new, the{" "}
					<a
						href="#"
						onClick={(e) => {
							e.preventDefault();
							onDismiss();
							openManual();
						}}
					>
						manual
					</a>{" "}
					covers every feature. It's a recommended read and reference point!
				</p>
				<p>
					Got questions or feedback?{" "}
					<a href="https://discord.gg/4wPNJTuzD8" target="_blank" rel="noopener noreferrer">
						Join the Discord
					</a>
					.
				</p>
				<div style={{ display: "flex", justifyContent: "flex-end" }}>
					<button className="button button--primary" onClick={onDismiss}>
						Got it
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
