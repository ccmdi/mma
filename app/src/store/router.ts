// Single source of truth for URL <-> app state. The URL has two orthogonal
// dimensions, both encoded in the hash:
//   #map/<id>                  -> a map is open
//   #manual/<chapter?>         -> the manual overlay is open (over the list)
//   #map/<id>/manual/<chapter?> -> manual open over a map
// This module owns all pushState and the popstate/hashchange listeners, so
// navigation (incl. browser back/forward) flows through one place.
//
// `route` is the parsed URL — the intent. It is the render authority (set
// synchronously from the hash at module load, so it's correct on the very first
// render, before any async map load). The store (currentMap) is the data;
// applyRoute reconciles the store to the URL.
import { useSyncExternalStore } from "react";
import {
	openMap,
	closeMap,
	getCurrentMapId,
	getCurrentMap,
	subscribeStore,
} from "@/store/useMapStore";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Route {
	mapId: string | null;
	manual: string | null; // null = closed, "" = default chapter, "<id>" = chapter
}

export function parse(hash: string): Route {
	const parts = hash.replace(/^#/, "").split("/").filter(Boolean);
	let mapId: string | null = null;
	let i = 0;
	if (parts[0] === "map") {
		mapId = parts[1] ?? null;
		i = 2;
	}
	const manual = parts[i] === "manual" ? (parts[i + 1] ?? "") : null;
	return { mapId, manual };
}

export function build(r: Route): string {
	let h = r.mapId ? `#map/${r.mapId}` : "#";
	if (r.manual !== null) {
		h += r.mapId ? "/manual" : "manual";
		if (r.manual) h += `/${r.manual}`;
	}
	return h;
}

// Parsed synchronously at module load (before first render) so the URL is the
// render authority from frame one — no dependency on openMap's timing.
let route: Route = parse(location.hash);
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
	listeners.add(cb);
	return () => listeners.delete(cb);
};

/** The map the URL says should be open (intent), independent of load state. */
export function useTargetMapId(): string | null {
	return useSyncExternalStore(subscribe, () => route.mapId);
}

/** Manual overlay chapter from the URL, or null when closed. */
export function useManualChapter(): string | null {
	return useSyncExternalStore(subscribe, () => route.manual);
}

function applyRoute() {
	const next = parse(location.hash);
	const changed = next.mapId !== route.mapId || next.manual !== route.manual;
	route = next;
	// Reconcile the store's open map to the URL.
	if (next.mapId !== getCurrentMapId()) {
		if (next.mapId) void openMap(next.mapId);
		else void closeMap();
	}
	if (changed) for (const l of listeners) l();
}

function navigate(next: Route) {
	history.pushState({}, "", build(next));
	applyRoute();
}

export const goToMap = (id: string) => navigate({ mapId: id, manual: route.manual });
export const goToList = () => navigate({ mapId: null, manual: route.manual });
export const openManual = (chapter = "") => navigate({ ...route, manual: chapter });
export const gotoManualChapter = (chapter: string) => navigate({ ...route, manual: chapter });
export const closeManual = () => navigate({ ...route, manual: null });

// The window/tab title follows the open map's name. The URL carries the id, not
// the name (which loads async and changes on rename), so derive it from the store.
// web-serve mirrors setTitle to the browser tab.
let lastTitle = "";
function syncTitle() {
	const map = getCurrentMap();
	const title = map ? `${map.meta.name} · Map Making App` : "Map Making App";
	if (title === lastTitle) return;
	lastTitle = title;
	void getCurrentWindow().setTitle(title);
}

export function initRouter() {
	window.addEventListener("popstate", applyRoute);
	window.addEventListener("hashchange", applyRoute);
	subscribeStore(syncTitle);
	applyRoute();
}
