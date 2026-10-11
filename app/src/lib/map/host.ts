// MapHost: the single interface every map surface (editor map, minimap) binds to.
// Hosts wrap a concrete basemap engine (Google Maps via opensv, MapLibre GL for
// vector tiles) behind one camera/event/overlay contract so consumers never
// branch on the engine. Engine-only features reach the raw engine through
// `MapHost.instance(host, kind)` and degrade when the active host is a different engine.

import type { Layer, PickingInfo } from "@deck.gl/core";
import type * as maplibregl from "maplibre-gl";
import type { LatLng, Bounds, MapTypeKey } from "@/types";
import type { MapEmbedPrefs } from "@/store/mapEmbedPrefs";
import type { CustomStyle } from "@/lib/geo/mapStack";

export interface HostInstances {
	google: google.maps.Map;
	maplibre: maplibregl.Map;
}

export type MapHostKind = keyof HostInstances;

export interface DeckOverlayProps {
	layers: Layer[];
	// domEvent is the normalized native event (hosts unwrap their engine's wrapper).
	onClick?: (info: PickingInfo, domEvent?: Event) => void;
	onHover?: (info: PickingInfo, domEvent?: Event) => void;
	onError?: (e: unknown) => void;
}

export interface DeckOverlayHandle {
	setProps(props: Partial<DeckOverlayProps>): void;
	finalize(): void;
}

export interface MapHostEvents {
	mousemove: LatLng;
	mousedown: LatLng;
	mouseup: LatLng;
	mouseout: void;
	zoom: void;
	camera: void;
	/** The camera came to rest after a pan/zoom (Google `idle`, maplibre `idle`). */
	idle: void;
	tilesloaded: void;
}

export interface BasemapOpts {
	customStyles: CustomStyle[];
}

export interface MapHostContract<K extends MapHostKind = MapHostKind> {
	readonly kind: K;
	// The engine's visible map div: toasts anchor here, DOM listeners attach here.
	readonly container: HTMLElement;
	// Raw engine escape hatch; typed by `kind`. Prefer `MapHost.instance(host, kind)`.
	getHostInstance(): HostInstances[K];

	// Camera. Zoom is always Google-scale (world = 256px at z0); hosts normalize.
	getZoom(): number;
	setZoom(zoom: number): void;
	getCenter(): LatLng | null;
	getBounds(): Bounds | null;
	panTo(p: LatLng): void;
	moveCamera(opts: { center?: LatLng; zoom?: number }): void;
	fitBounds(bounds: Bounds, padding?: number, opts?: { snap?: boolean }): void;

	on<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void;
	once<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void;

	containerPxToLatLng(x: number, y: number): LatLng | null;
	setDraggable(v: boolean): void;
	/** CSS cursor over the map; null restores the host's default. */
	setCursor(v: string | null): void;
	setDoubleClickZoom(v: boolean): void;

	createDeckOverlay(): DeckOverlayHandle;
	// Route a synthetic click at the coordinate through the deck click pipeline.
	triggerClickAt(latLng: LatLng): void;

	applyPrefs(prefs: MapEmbedPrefs, opts: BasemapOpts): void;
	resize(): void;
	destroy(): void;
}

// Discriminated union over the registered kinds, so `host.kind === "x"` narrows
// getHostInstance() to that engine's type.
export type MapHost = { [K in MapHostKind]: MapHostContract<K> }[MapHostKind];

export interface CreateHostOpts extends BasemapOpts {
	camera?: { center: LatLng; zoom: number };
	// Show the engine's scale control (editor map only).
	scaleControl?: boolean;
}

let mapHost: MapHost | null = null;
let hostReady: PromiseWithResolvers<MapHost> | null = null;

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

type ClickInterceptor = (lat: number, lng: number, shiftKey: boolean) => boolean;
const clickInterceptors = new Set<ClickInterceptor>();

type DrawInterceptor = (rings: number[][][]) => boolean;
let drawInterceptor: DrawInterceptor | null = null;

export const MapHost = {
	/** Set or clear the main editor map host. @unstable */
	set: (host: MapHost | null) => {
		mapHost = host;
		if (host) {
			hostReady?.resolve(host);
			hostReady = null;
		}
	},
	/** Return the main editor map host, or null if not mounted. */
	get: (): MapHost | null => {
		return mapHost;
	},
	/** Wait for the main editor map to be ready. */
	wait: (): Promise<MapHost> => {
		if (mapHost) return Promise.resolve(mapHost);
		hostReady ??= Promise.withResolvers<MapHost>();
		return hostReady.promise;
	},
	/** Fit the editor map's viewport to `bounds`. A `minExtent` prevents over-zoom on tiny areas. */
	fitToBounds: (bounds: Bounds | null, padding = 0, minExtent?: number) => {
		if (!bounds) return;
		if (minExtent != null) bounds = padBoundsToMin(bounds, minExtent);
		mapHost?.fitBounds(bounds, padding);
	},
	/** Register a map-click interceptor. Returns a removal function. The most recently
	 *  added interceptor that returns true consumes the click. */
	addClickInterceptor: (fn: ClickInterceptor): (() => void) => {
		clickInterceptors.add(fn);
		return () => clickInterceptors.delete(fn);
	},
	/** Run registered click interceptors (newest first). True if one consumed the click. @unstable */
	tryInterceptClick: (lat: number, lng: number, shiftKey = false): boolean => {
		// Latest registered wins: a transient tool (measure, polygon draw) outranks the
		// always-armed held-hotkey gestures registered at editor mount.
		return [...clickInterceptors].toReversed().some((fn) => fn(lat, lng, shiftKey));
	},
	/** Set the callback for completed polygon draws. Null clears it. */
	setDrawInterceptor: (fn: DrawInterceptor | null) => {
		drawInterceptor = fn;
	},
	/** Pass completed polygon rings to the draw interceptor. True if it consumed them. @unstable */
	tryInterceptDraw: (rings: number[][][]): boolean => {
		return drawInterceptor ? drawInterceptor(rings) : false;
	},
	/** The raw engine instance if `host` is of the given kind, else null. */
	instance: <K extends MapHostKind>(host: MapHost | null, kind: K): HostInstances[K] | null => {
		return host?.kind === kind ? (host.getHostInstance() as HostInstances[K]) : null;
	},
	kindForMapType: (mapType: MapTypeKey): MapHostKind => {
		return mapType === "vector" ? "maplibre" : "google";
	},
	create: async (
		kind: MapHostKind,
		container: HTMLElement,
		prefs: MapEmbedPrefs,
		opts: CreateHostOpts,
	): Promise<MapHost> => {
		if (kind === "maplibre") {
			const { createMapLibreHost } = await import("@/lib/map/maplibreHost");
			return createMapLibreHost(container, prefs, opts);
		}
		const { createGoogleMapHost } = await import("@/lib/map/googleHost");
		return createGoogleMapHost(container, prefs, opts);
	},
};
