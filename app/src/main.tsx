import "@/lib/sv/shaderPatch";
import {} from "react";
import { createRoot } from "react-dom/client";
import { appWindow } from "@/lib/window";
import "@/styles.css";
import App from "@/App.tsx";
import { initLogging, log } from "@/lib/util/log";
import { initLocale } from "@/lib/i18n";
import { initStore, flushSave } from "@/store/useMapStore";
import { getMapList } from "@/store/mapList";
import { initRouter } from "@/store/router";
import { getSettings } from "@/store/settings";
import { loadSession, saveSession } from "@/store/session";
import { openWindow, openWindows, closeWindows } from "@/lib/window";
import { cmd } from "@/lib/commands";
import { checkForUpdate } from "@/lib/util/updateCheck";
import { refreshStoredReports } from "@/lib/feedback/submit";
import { blockBrowserAccelerators } from "@/lib/hooks/useHotkey";
import "@/api";
import "@/store/commandDefs";

async function boot() {
	// react-scan must load before the React root renders. Dev-only and flag-gated, so the
	// whole branch tree-shakes out of production builds.
	if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN) {
		const { scan } = await import("react-scan");
		scan({ enabled: true });
	}

	const t0 = performance.now();
	let tPrev = t0;
	const mark = (label: string) => {
		const now = performance.now();
		log.info(`[boot] ${label}: +${(now - tPrev).toFixed(0)}ms`);
		tPrev = now;
	};

	await initLogging();
	mark("initLogging");
	await initLocale(getSettings().language);
	mark("initLocale");
	await initStore();
	mark("initStore");

	initRouter();
	mark("initRouter");

	if (window.MMA) window.MMA.ready = true;
	log.info("App booted");

	

	void appWindow.onCloseRequested(async (event) => {
		event.preventDefault();
		log.info("Window close requested, closing map...");
		if (appWindow.type === "list" && getSettings().restoreSession) {
			const openIds = (await openWindows("editor")).map((w) => w.mapId);
			saveSession(openIds);
			log.info(`[session] saved ${openIds.length} open map(s): ${openIds.join(", ")}`);
			await closeWindows("editor");
		}
		await flushSave();
		await cmd.storeCloseMap().catch((e) => log.error("[close] store_close_map failed:", e));
		log.info("Map closed, destroying window");
		void appWindow.destroy();
	});

	window.addEventListener("beforeunload", () => {
		cmd.storeCloseMap().catch(() => {});
	});

	document.addEventListener("contextmenu", (e) => e.preventDefault());

	document.addEventListener("keydown", (e) => {
		if (e.key === "F11") {
			void appWindow.isFullscreen().then((fs) => appWindow.setFullscreen(!fs));
		}
	});
	blockBrowserAccelerators();

	createRoot(document.getElementById("root")!).render(<App />);
	mark("render");

	void appWindow.show();
	const jsTotal = performance.now();
	mark("show");

	if (appWindow.type === "list" && getSettings().restoreSession) restoreSession();

	cmd
		.appReady()
		.then((rustTotal) =>
			log.info(
				`[boot] js-load(nav->boot)=${t0.toFixed(0)}ms js-total=${jsTotal.toFixed(0)}ms rust-total=${rustTotal}ms pre-js(webview+bundle)=${(rustTotal - jsTotal).toFixed(0)}ms`,
			),
		)
		.catch(() => {});

	setTimeout(() => void checkForUpdate(), 5000);
	// Every window shares the same stored reports, so one window refreshes them.
	if (appWindow.type === "list") setTimeout(() => void refreshStoredReports(), 5000);
}

/** Reopen the maps recorded when the session last ended, skipping any since deleted. */
function restoreSession() {
	const ids = loadSession();
	if (!ids.length) return;
	log.info(`[session] restoring ${ids.length} map(s): ${ids.join(", ")}`);
	const names = new Map(getMapList().map((m) => [m.id, m.name]));
	for (const id of ids) {
		const name = names.get(id);
		if (name !== undefined) void openWindow({ type: "editor", mapId: id }, name);
	}
}

void boot();
