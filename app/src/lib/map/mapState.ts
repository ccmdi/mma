import type { Bounds } from "@/types";
import { hostInstance, type MapHost } from "@/lib/map/host";

let mapHost: MapHost | null = null;
let hostReadyResolve: ((host: MapHost) => void) | null = null;
let hostReadyPromise: Promise<MapHost> | null = null;

export function setMapHost(host: MapHost | null) {
	mapHost = host;
	if (host && hostReadyResolve) {
		hostReadyResolve(host);
		hostReadyResolve = null;
	}
	if (!host) {
		hostReadyPromise = null;
	}
}

/**
 * This refers to the main editor map only.
 */
export function getMapHost(): MapHost | null {
	return mapHost;
}

export function waitForMapHost(): Promise<MapHost> {
	if (mapHost) return Promise.resolve(mapHost);
	if (!hostReadyPromise) {
		hostReadyPromise = new Promise((resolve) => {
			hostReadyResolve = resolve;
		});
	}
	return hostReadyPromise;
}

/** Raw Google map of the editor surface; null on non-Google hosts (plugin API compat). */
export function getGoogleMap(): google.maps.Map | null {
	return hostInstance(mapHost, "google");
}

/** Resolves with the editor's Google map. On non-Google hosts this resolves null
 *  once the host is ready (plugins that draw on the raw map should degrade). */
export function waitForGoogleMap(): Promise<google.maps.Map | null> {
	return waitForMapHost().then((host) => hostInstance(host, "google"));
}

export function fitMapToBounds(bounds: Bounds | null | undefined, padding = 0) {
	if (!bounds) return;
	mapHost?.fitBounds(bounds, padding);
}

type ClickInterceptor = (lat: number, lng: number, shiftKey: boolean) => boolean;
const clickInterceptors = new Set<ClickInterceptor>();

export function addClickInterceptor(fn: ClickInterceptor): () => void {
	clickInterceptors.add(fn);
	return () => clickInterceptors.delete(fn);
}

export function tryInterceptClick(lat: number, lng: number, shiftKey = false): boolean {
	for (const fn of clickInterceptors) {
		if (fn(lat, lng, shiftKey)) return true;
	}
	return false;
}

type DrawInterceptor = (rings: number[][][]) => boolean;
let drawInterceptor: DrawInterceptor | null = null;

export function setDrawInterceptor(fn: DrawInterceptor | null) {
	drawInterceptor = fn;
}

export function tryInterceptDraw(rings: number[][][]): boolean {
	return drawInterceptor ? drawInterceptor(rings) : false;
}
