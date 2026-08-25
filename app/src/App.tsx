import { useState, useEffect } from "react";
import type { ComponentType, CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { useMapState } from "@/store/useMapStore";
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
import { SettingsPage, UnreadReplyDot } from "@/components/dialogs/SettingsPage";
import { PluginMarketplace } from "@/components/dialogs/PluginMarketplace";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Manual } from "@/components/manual/Manual";
import { ManualSearch } from "@/components/manual/ManualSearch";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useSetting, useSettings, setSetting, CSS_VAR_SETTINGS } from "@/store/settings";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { MAP_EMBED_PREFS } from "@/store/mapEmbedPrefs";
import "@/lib/render/renderStats"; // installs the window.__mmaPerf harness bridge
import { applyAccentColor, resolveSvColorHex } from "@/lib/util/color";
import { Icon, mdiDiscord } from "@/components/primitives/Icon";
import { mdiCog, mdiPuzzle, mdiClose, mdiBookOpenPageVariantOutline } from "@mdi/js";
import { ToastContainer } from "@/components/primitives/Toast";
import { TooltipProvider } from "@/components/primitives/Tooltip";
import { useUpdateState, dismissUpdate, installUpdate, relaunchApp } from "@/lib/util/updateCheck";
import { APP_NAME } from "@/lib/util/format";
import { appVersion } from "@/lib/version";
import { useDiscordPresence } from "@/lib/discord/presence";
import { initRemoteHost } from "@/lib/remote/host";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import "@/plugins";
import { t } from "@/lib/i18n";
import { ReportDialog } from "@/components/dialogs/ReportDialog";
import { useDialogState } from "@/store/dialogBus";
import { Button } from "@/components/primitives/Button";

// Dynamic import (deck.gl/luma.gl out of the initial bundle) WITHOUT React.lazy/Suspense —
// a Suspense boundary makes React 19 render the editor in a low-priority lane (~260ms/open).
// We preload the chunk in the background and render it as a plain component in the urgent lane.
const mapEditorModule = import("@/components/editor/MapEditor");

// A real Tauri sub-window for a single map (label "map-<id>"). Always false on web, where
// every tab reports label "main" — there the URL (targetMapId) alone picks editor vs list.
const isEditorWindow = getCurrentWindow().label.startsWith("map-");

// tauri-plugin-window-state flags, matching lib.rs: all() minus VISIBLE (bit 3).
const WINDOW_STATE_FLAGS = 0b110111;

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
	const map = useMapState((s) => s.map);
	const [MapEditor, setMapEditor] = useState<ComponentType | null>(null);
	useEffect(() => {
		void mapEditorModule.then((m) => setMapEditor(() => m.MapEditor));
	}, []);
	if (!map || !MapEditor) return <Blank />;
	return <MapEditor />;
}

/** Floating UI shared by both window roles: settings/plugins gears, update pill, and the
 *  app-level dialogs. Hidden by App while a window is self-destructing. */
function AppChrome() {
	const map = useMapState((s) => s.map);
	const isMapList = !useTargetMapId();
	const manualChapter = useManualChapter();

	const update = useUpdateState();
	const [showStats, setShowStats] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [feedbackOpen, setFeedbackOpen] = useDialogState("feedback");
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
						title={t("Join the Discord")}
					>
						<Icon path={mdiDiscord} />
					</a>
					<button className="settings-gear" onClick={() => openManual()} title={t("Manual")}>
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
									<button className="update-pill__label" onClick={() => void installUpdate()}>
										{t("v{version} - download update", { version: update.version ?? "" })}
									</button>
									<button
										className="update-pill__dismiss"
										onClick={dismissUpdate}
										title={t("Dismiss")}
									>
										<Icon path={mdiClose} size={14} />
									</button>
								</>
							)}
							{update.phase === "downloading" && (
								<span className="update-pill__label">
									{t("Downloading")} {update.percent}%
								</span>
							)}
							{update.phase === "ready" && (
								<button className="update-pill__label" onClick={() => void relaunchApp()}>
									{t("Restart to update")}
								</button>
							)}
							{update.phase === "error" && (
								<>
									<button className="update-pill__label" onClick={() => void installUpdate()}>
										{t("Update failed - retry")}
									</button>
									<button
										className="update-pill__dismiss"
										onClick={dismissUpdate}
										title={t("Dismiss")}
									>
										<Icon path={mdiClose} size={14} />
									</button>
								</>
							)}
						</div>
					)}
					{isMapList && <BulkActions />}
					<button
						className="settings-gear"
						onClick={() => setShowPlugins(true)}
						title={t("Plugins")}
					>
						<Icon path={mdiPuzzle} />
					</button>
					<button
						className="settings-gear"
						onClick={() => setShowSettings(true)}
						title={t("Settings")}
					>
						<Icon path={mdiCog} />
						<UnreadReplyDot />
					</button>
				</div>
			)}
			{showStats && <StatsForNerds onClose={() => setShowStats(false)} />}
			<SettingsPage open={showSettings} onOpenChange={setShowSettings} />
			{feedbackOpen && <ReportDialog onClose={() => setFeedbackOpen(false)} />}
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
		void WebviewWindow.getByLabel("main")
			.then(async (main) => {
				await main?.unminimize();
				await main?.setFocus();
			})
			.finally(async () => {
				await invoke("plugin:window-state|save_window_state", {
					flags: WINDOW_STATE_FLAGS,
				}).catch(() => {});
				void getCurrentWindow().destroy();
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
	const [prefs] = useLocalStorage(MAP_EMBED_PREFS);
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
			<DialogContent title={t("Welcome to {app}", { app: APP_NAME })} className="welcome-dialog">
				<div className="welcome-dialog__hero">
					<img src="/icon-1024.png" alt="" width={80} height={80} draggable={false} />
					<div className="welcome-dialog__name">{APP_NAME}</div>
					<div className="welcome-dialog__version">v{appVersion() ?? "dev"}</div>
				</div>
				<div className="welcome-dialog__links">
					<button
						type="button"
						className="welcome-dialog__link"
						onClick={() => {
							onDismiss();
							openManual();
						}}
					>
						<Icon path={mdiBookOpenPageVariantOutline} />
						<span>
							<strong>{t("Read the manual")}</strong>
							<small>
								{t("Every feature, explained. A recommended read and reference point.")}
							</small>
						</span>
					</button>
					<a
						className="welcome-dialog__link"
						href="https://discord.gg/4wPNJTuzD8"
						target="_blank"
						rel="noopener noreferrer"
					>
						<Icon path={mdiDiscord} />
						<span>
							<strong>{t("Join the Discord")}</strong>
							<small>{t("Questions, feedback, and release news.")}</small>
						</span>
					</a>
				</div>
				<Button variant="primary" className="welcome-dialog__cta" onClick={onDismiss}>
					{t("Got it")}
				</Button>
			</DialogContent>
		</Dialog>
	);
}
