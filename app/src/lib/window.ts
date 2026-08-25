import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { log } from "@/lib/util/log";
import { t } from "@/lib/i18n";

const MAP_LABEL_PREFIX = "map-";

export async function openMapWindow(id: string, name: string): Promise<void> {
	const label = `${MAP_LABEL_PREFIX}${id}`;
	const existing = await WebviewWindow.getByLabel(label);
	if (existing) {
		if (await existing.isMinimized()) await existing.unminimize();
		await existing.setFocus();
		return;
	}

	const win = new WebviewWindow(label, {
		url: `#map/${id}`,
		title: name || t("Map Editor"),
		width: 1400,
		height: 900,
		resizable: true,
		visible: false,
		zoomHotkeysEnabled: true,
		backgroundColor: "#252521",
	});

	void win.once("tauri://error", (e) => {
		log.error("Failed to create map window:", e);
	});
}

/** Ids of the map windows currently open (label `map-<id>`). */
export async function openMapWindowIds(): Promise<string[]> {
	const wins = await getAllWebviewWindows();
	return wins
		.map((w) => w.label)
		.filter((l) => l.startsWith(MAP_LABEL_PREFIX))
		.map((l) => l.slice(MAP_LABEL_PREFIX.length));
}

/** Request close on every map window (each flushes + destroys itself; see main.tsx). */
export async function closeAllMapWindows(): Promise<void> {
	const wins = await getAllWebviewWindows();
	await Promise.all(
		wins
			.filter((w) => w.label.startsWith(MAP_LABEL_PREFIX))
			.map((w) => w.close().catch((e) => log.error(`Failed to close ${w.label}:`, e))),
	);
}
