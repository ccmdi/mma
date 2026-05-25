import "@/lib/sv/shaderPatch";
import {} from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@/styles.css";
import App from "@/App.tsx";
import { initLogging, log } from "@/lib/util/log";
import { initStore, openMap, flushSave } from "@/store/useMapStore";
import { cmd } from "@/lib/commands";
import { exposeTestApi } from "@/lib/testApi.add";
import { checkForUpdateOnStartup } from "@/lib/util/updateCheck";
import "@/store/commandDefs.add";

if (import.meta.env.DEV || import.meta.env.VITE_E2E) exposeTestApi();

async function boot() {
	await initLogging();
	await initStore();

	const hashMatch = location.hash.match(/^#map\/(.+)$/);
	if (hashMatch) {
		await openMap(hashMatch[1], false);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test harness bridge
	if ((window as any).__TEST_API__) (window as any).__TEST_API__.ready = true;
	log.info("App booted");

	getCurrentWindow().onCloseRequested(async (event) => {
		event.preventDefault();
		log.info("Window close requested, closing map...");
		await flushSave();
		await cmd.storeCloseMap().catch((e) => log.error("[close] store_close_map failed:", e));
		log.info("Map closed, destroying window");
		getCurrentWindow().destroy();
	});

	window.addEventListener("beforeunload", () => {
		cmd.storeCloseMap().catch(() => {});
	});

	const win = getCurrentWindow();
	document.addEventListener("keydown", (e) => {
		if (e.key === "F11") {
			e.preventDefault();
			win.isFullscreen().then((fs) => win.setFullscreen(!fs));
		}
	});

	createRoot(document.getElementById("root")!).render(<App />);

	getCurrentWindow().show();

	setTimeout(checkForUpdateOnStartup, 5000);
}

boot();
