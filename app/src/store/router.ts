// URL <-> app state. The hash is the window's own segments (lib/window owns that codec)
// followed by an optional manual overlay:
//   #map/<id>                   -> a map is open
//   #manual/<chapter?>          -> the manual overlay is open (over the list)
//   #map/<id>/manual/<chapter?> -> manual open over a map
// This module owns every pushState and the popstate/hashchange listeners, so navigation
// (including browser back/forward) flows through one place. `route` is the parsed URL,
// the intent, and the render authority from the first frame; applyRoute reconciles the
// store's open map to it.
import { openMap, closeMap, getMapState } from "@/store/useMapStore";
import { emit, useEventValue, subscribe as subscribeEvent } from "@/lib/events";
import { hashOf, identityFromHash, syncTitle, type WindowIdentity } from "@/lib/window";

interface Route {
	window: WindowIdentity;
	manual: string | null; // null = closed, "" = default chapter, "<id>" = chapter
}

export function parse(hash: string): Route {
	const { window, rest } = identityFromHash(hash);
	const manual = rest[0] === "manual" ? (rest[1] ?? "") : null;
	return { window, manual };
}

export function build(r: Route): string {
	const parts = hashOf(r.window);
	if (r.manual !== null) parts.push("manual", ...(r.manual ? [r.manual] : []));
	return `#${parts.join("/")}`;
}

let route: Route = parse(location.hash);

const mapIdOf = (r: Route) => (r.window.type === "editor" ? r.window.mapId : null);

/** The map the URL says should be open (intent), independent of load state. */
export function useTargetMapId(): string | null {
	return useEventValue("route:changed", () => mapIdOf(route));
}

/** Manual overlay chapter from the URL, or null when closed. */
export function useManualChapter(): string | null {
	return useEventValue("route:changed", () => route.manual);
}

function applyRoute() {
	const next = parse(location.hash);
	const changed = mapIdOf(next) !== mapIdOf(route) || next.manual !== route.manual;
	route = next;
	const mapId = mapIdOf(next);
	if (mapId !== getMapState().mapId) {
		if (mapId) void openMap(mapId);
		else void closeMap();
	}
	if (changed) emit("route:changed");
}

function navigate(next: Route) {
	history.pushState({}, "", build(next));
	applyRoute();
}

export const goTo = (window: WindowIdentity) => navigate({ window, manual: route.manual });
export const openManual = (chapter = "") => navigate({ ...route, manual: chapter });
export const gotoManualChapter = (chapter: string) => navigate({ ...route, manual: chapter });
export const closeManual = () => navigate({ ...route, manual: null });

export function initRouter() {
	window.addEventListener("popstate", applyRoute);
	window.addEventListener("hashchange", applyRoute);
	subscribeEvent("store:changed", () => syncTitle(getMapState().map?.name ?? null));
	applyRoute();
}
