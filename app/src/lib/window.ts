import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { log } from "@/lib/util/log";
import { t } from "@/lib/i18n";

// A window type is a codec: how its identity reads as a Tauri label, as URL hash
// segments, and as a title. Everything below is generic over the table.

export type WindowIdentity = { type: "list" } | { type: "editor"; mapId: string };
export type WindowType = WindowIdentity["type"];
type Of<K extends WindowType> = Extract<WindowIdentity, { type: K }>;

interface WindowDef<W extends WindowIdentity> {
	label(w: W): string;
	fromLabel(label: string): W | null;
	/** Hash path segments, without the leading `#`. */
	hash(w: W): string[];
	/** Consumes this window's segments; `rest` is whatever follows (the router's overlay). */
	fromHash(parts: string[]): { window: W; rest: string[] } | null;
	title(w: W, mapName: string | null): string;
}

const APP_TITLE = "Map Making App";
const withApp = (mapName: string) => `${mapName} · ${APP_TITLE}`;

// Parsers run in table order and the list window accepts anything, so it stays last.
export const WINDOWS: { [K in WindowType]: WindowDef<Of<K>> } = {
	editor: {
		label: (w) => `map-${w.mapId}`,
		fromLabel: (label) =>
			label.startsWith("map-") && label.length > 4
				? { type: "editor", mapId: label.slice(4) }
				: null,
		hash: (w) => ["map", w.mapId],
		fromHash: (parts) =>
			parts[0] === "map" && parts[1]
				? { window: { type: "editor", mapId: parts[1] }, rest: parts.slice(2) }
				: null,
		title: (_w, mapName) => (mapName ? withApp(mapName) : t("Map Editor")),
	},
	list: {
		label: () => "main",
		fromLabel: (label) => (label === "main" ? { type: "list" } : null),
		hash: () => [],
		fromHash: (parts) => ({ window: { type: "list" }, rest: parts }),
		title: (_w, mapName) => (mapName ? withApp(mapName) : APP_TITLE),
	},
};

const def = <W extends WindowIdentity>(w: W) => WINDOWS[w.type] as WindowDef<W>;
const defs = Object.values(WINDOWS) as WindowDef<WindowIdentity>[];

export const labelOf = (w: WindowIdentity) => def(w).label(w);
export const hashOf = (w: WindowIdentity) => def(w).hash(w);
export const titleOf = (w: WindowIdentity, mapName: string | null) => def(w).title(w, mapName);

export function identityOf(label: string): WindowIdentity | null {
	for (const d of defs) {
		const w = d.fromLabel(label);
		if (w) return w;
	}
	return null;
}

export function identityFromHash(hash: string): { window: WindowIdentity; rest: string[] } {
	const parts = hash.replace(/^#/, "").split("/").filter(Boolean);
	for (const d of defs) {
		const hit = d.fromHash(parts);
		if (hit) return hit;
	}
	throw new Error("unreachable: the list window accepts any hash");
}

// --- This window: Tauri handle plus its identity, one object ---

export type AppWindow = TauriWindow & WindowIdentity;

/** False outside a Tauri or webserve host (vitest, a bare browser): `appWindow` is then
 *  a list-window stub whose Tauri methods must not be called. */
export const hasWindowHost = (() => {
	try {
		getCurrentWindow();
		return true;
	} catch {
		return false;
	}
})();

export const appWindow: AppWindow = (() => {
	if (!hasWindowHost) return { type: "list", label: labelOf({ type: "list" }) } as AppWindow;
	const win = getCurrentWindow();
	return Object.assign(win, identityOf(win.label) ?? { type: "list" as const });
})();

// --- Window operations, all generic over the table ---

const DEFAULTS = {
	width: 1400,
	height: 900,
	resizable: true,
	visible: false,
	zoomHotkeysEnabled: true,
	backgroundColor: "#252521",
};

/** Open `w` in its own window, or focus it if it is already open. */
export async function openWindow(w: WindowIdentity, mapName: string | null = null): Promise<void> {
	const label = labelOf(w);
	const existing = await WebviewWindow.getByLabel(label);
	if (existing) {
		if (await existing.isMinimized()) await existing.unminimize();
		await existing.setFocus();
		return;
	}
	const win = new WebviewWindow(label, {
		...DEFAULTS,
		url: `#${hashOf(w).join("/")}`,
		title: titleOf(w, mapName),
	});
	void win.once("tauri://error", (e) => log.error("Failed to create window:", e));
}

export async function focusWindow(w: WindowIdentity): Promise<void> {
	const win = await WebviewWindow.getByLabel(labelOf(w));
	await win?.unminimize();
	await win?.setFocus();
}

async function windowsOf<K extends WindowType>(type: K): Promise<[Of<K>, WebviewWindow][]> {
	const out: [Of<K>, WebviewWindow][] = [];
	for (const win of await getAllWebviewWindows()) {
		const w = identityOf(win.label);
		if (w?.type === type) out.push([w as Of<K>, win]);
	}
	return out;
}

/** Identities of every open window of `type`. */
export async function openWindows<K extends WindowType>(type: K): Promise<Of<K>[]> {
	return (await windowsOf(type)).map(([w]) => w);
}

/** Request close on every window of `type`; each one flushes and destroys itself (main.tsx). */
export async function closeWindows(type: WindowType): Promise<void> {
	await Promise.all(
		(await windowsOf(type)).map(([, win]) =>
			win.close().catch((e) => log.error(`Failed to close ${win.label}:`, e)),
		),
	);
}

let lastTitle = "";
/** This window's title follows the map open in it. webserve mirrors setTitle to the tab. */
export function syncTitle(mapName: string | null): void {
	const title = titleOf(appWindow, mapName);
	if (title === lastTitle) return;
	lastTitle = title;
	void appWindow.setTitle(title);
}

// tauri-plugin-window-state flags: all() minus VISIBLE (bit 3).
const WINDOW_STATE_FLAGS = 0b110111;

/** Hand focus to the list window, persist this window's geometry (destroy() never fires
 *  CloseRequested, so the window-state plugin would not), then destroy it. */
export async function closeAndDestroy(): Promise<void> {
	await focusWindow({ type: "list" });
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("plugin:window-state|save_window_state", { flags: WINDOW_STATE_FLAGS }).catch(
		() => {},
	);
	void appWindow.destroy();
}
