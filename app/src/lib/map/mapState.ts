import type { Bounds } from "@/types";
import { type MapHost } from "@/lib/map/host";

let mapHost: MapHost | null = null;
let hostReady: PromiseWithResolvers<MapHost> | null = null;

/** Set or clear the main editor map host. */
export function setMapHost(host: MapHost | null) {
	mapHost = host;
	if (host) {
		hostReady?.resolve(host);
		hostReady = null;
	}
}

/** Return the main editor map host, or null if not mounted. */
export function getMapHost(): MapHost | null {
	return mapHost;
}

/** Wait for the main editor map to be ready. */
export function waitForMapHost(): Promise<MapHost> {
	if (mapHost) return Promise.resolve(mapHost);
	hostReady ??= Promise.withResolvers<MapHost>();
	return hostReady.promise;
}

/** Expand any axis narrower than `2 * minExtent` (degrees) to that span, centered.
 *  A single-point paste has zero-area bounds; without this, fitBounds maxes out the zoom. */
function padBoundsToMin(b: Bounds, minExtent: number): Bounds {
	const pad = (lo: number, hi: number): [number, number] => {
		if (hi - lo >= minExtent * 2) return [lo, hi];
		const mid = (lo + hi) / 2;
		return [mid - minExtent, mid + minExtent];
	};
	const [south, north] = pad(b.south, b.north);
	const [west, east] = pad(b.west, b.east);
	return { west, south, east, north };
}

/** Fit the editor map's viewport to `bounds`. A `minExtent` prevents over-zoom on tiny areas. */
export function fitMapToBounds(bounds: Bounds | null, padding = 0, minExtent?: number) {
	if (!bounds) return;
	if (minExtent != null) bounds = padBoundsToMin(bounds, minExtent);
	mapHost?.fitBounds(bounds, padding);
}

type ClickInterceptor = (lat: number, lng: number, shiftKey: boolean) => boolean;
const clickInterceptors = new Set<ClickInterceptor>();

/** Register a map-click interceptor. Returns a removal function. The most recently
 *  added interceptor that returns true consumes the click. */
export function addClickInterceptor(fn: ClickInterceptor): () => void {
	clickInterceptors.add(fn);
	return () => clickInterceptors.delete(fn);
}

/** Run registered click interceptors (newest first). True if one consumed the click. */
export function tryInterceptClick(lat: number, lng: number, shiftKey = false): boolean {
	// Latest registered wins: a transient tool (measure, polygon draw) outranks the
	// always-armed held-hotkey gestures registered at editor mount.
	const fns = [...clickInterceptors];
	for (let i = fns.length - 1; i >= 0; i--) {
		if (fns[i](lat, lng, shiftKey)) return true;
	}
	return false;
}

type DrawInterceptor = (rings: number[][][]) => boolean;
let drawInterceptor: DrawInterceptor | null = null;

/** Set the callback for completed polygon draws. Null clears it. */
export function setDrawInterceptor(fn: DrawInterceptor | null) {
	drawInterceptor = fn;
}

/** Pass completed polygon rings to the draw interceptor. True if it consumed them. */
export function tryInterceptDraw(rings: number[][][]): boolean {
	return drawInterceptor ? drawInterceptor(rings) : false;
}
