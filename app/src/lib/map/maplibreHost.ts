// MapLibre GL MapHost: vector-tile basemaps (OpenFreeMap styles) with the SV
// coverage raster layered on top and deck.gl markers via MapboxOverlay.
//
// Zoom normalization: MapLibre's zoom 0 fits the world in 512px, Google's in
// 256px, so googleZoom = maplibreZoom + 1. The host contract is Google-scale;
// every camera call converts at the boundary.
//
// SV tiles: MapLibre raster sources take URL templates, not functions, so the
// source uses a fake `mma-sv://{z}/{x}/{y}` template and `transformRequest`
// rewrites each request through buildTileUrl with the current coverage config.

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { PickingInfo } from "@deck.gl/core";
import { buildTileUrl, type TileConfig } from "@/lib/geo/tiles";
import { createSvConfigForPrefs } from "@/lib/geo/mapStack";
import { vectorStyleUrl } from "@/lib/geo/mapStyles";
import type { MapEmbedPrefs } from "@/store/mapEmbedPrefs";
import type { LatLng, Bounds } from "@/types";
import type {
	MapHost,
	MapHostContract,
	MapHostEvents,
	BasemapOpts,
	CreateHostOpts,
	DeckOverlayHandle,
	DeckOverlayProps,
} from "@/lib/map/host";

declare module "@/lib/map/host" {
	interface HostInstances {
		maplibre: maplibregl.Map;
	}
}

const ZOOM_OFFSET = 1;
const SV_SOURCE = "mma-sv";
const SV_SCHEME = "mma-sv://";

const PREFETCH_MARGIN = 256;

type MlEventName = "mousemove" | "mousedown" | "mouseup" | "mouseout" | "zoom" | "move" | "load";

const EVENT_NAMES: Record<keyof MapHostEvents, MlEventName> = {
	mousemove: "mousemove",
	mousedown: "mousedown",
	mouseup: "mouseup",
	mouseout: "mouseout",
	zoom: "zoom",
	camera: "move",
	tilesloaded: "load",
};

const LATLNG_EVENTS = new Set<keyof MapHostEvents>(["mousemove", "mousedown", "mouseup"]);

// MapboxOverlay proxies map events, so srcEvent is MapLibre's wrapper; the native
// DOM event lives at srcEvent.originalEvent.
// TODO
type DeckEvent = { srcEvent?: Event | { originalEvent?: Event } };

function domEventOf(ev: DeckEvent): Event | undefined {
	const src = ev?.srcEvent;
	if (src && "originalEvent" in src) return src.originalEvent;
	return src as Event | undefined;
}

class MapLibreDeckOverlay implements DeckOverlayHandle {
	overlay: MapboxOverlay;
	props: Partial<DeckOverlayProps> = {};
	private finalized = false;

	constructor(
		private map: maplibregl.Map,
		private onFinalize: (self: MapLibreDeckOverlay) => void,
	) {
		this.overlay = new MapboxOverlay({ interleaved: false, layers: [], pickingRadius: 2 });
		map.addControl(this.overlay);
	}

	setProps(props: Partial<DeckOverlayProps>) {
		if (this.finalized) return;
		Object.assign(this.props, props);
		const out: Record<string, unknown> = {};
		if (props.layers) out.layers = props.layers;
		if ("onError" in props) out.onError = props.onError;
		if ("onClick" in props) {
			const fn = props.onClick;
			out.onClick = fn ? (info: PickingInfo, ev: DeckEvent) => fn(info, domEventOf(ev)) : undefined;
		}
		if ("onHover" in props) {
			const fn = props.onHover;
			out.onHover = fn ? (info: PickingInfo, ev: DeckEvent) => fn(info, domEventOf(ev)) : undefined;
		}
		this.overlay.setProps(out);
	}

	pickAt(x: number, y: number, lngLat: { lng: number; lat: number }): PickingInfo {
		const picked = this.overlay.pickObject({ x, y, radius: 2 });
		if (picked) return picked;
		return {
			coordinate: [lngLat.lng, lngLat.lat],
			x,
			y,
			index: -1,
			picked: false,
		} as unknown as PickingInfo;
	}

	finalize() {
		if (this.finalized) return;
		this.finalized = true;
		this.map.removeControl(this.overlay);
		this.onFinalize(this);
	}
}

class MapLibreHost implements MapHostContract<"maplibre"> {
	readonly kind = "maplibre" as const;
	readonly map: maplibregl.Map;
	private overlays = new Set<MapLibreDeckOverlay>();
	private svCfg: TileConfig;
	private svRev = 0;
	private svOpacity: number;
	private styleName: string;

	private outer: HTMLElement;
	private mapDiv: HTMLDivElement;

	constructor(container: HTMLElement, prefs: MapEmbedPrefs, opts: CreateHostOpts) {
		this.svOpacity = prefs.svOpacity;
		this.svCfg = createSvConfigForPrefs(prefs, opts.useBlobby);
		this.styleName = prefs.vectorStyleName;
		// Oversized, clipped inner container = tile prefetch margin (see PREFETCH_MARGIN).
		this.outer = container;
		if (!container.style.position) container.style.position = "relative";
		container.style.overflow = "hidden";
		this.mapDiv = document.createElement("div");
		this.mapDiv.style.cssText = `position:absolute;inset:-${PREFETCH_MARGIN}px`;
		container.appendChild(this.mapDiv);
		const camera = opts.camera ?? { center: { lat: 0, lng: 0 }, zoom: 2 };
		this.map = new maplibregl.Map({
			container: this.mapDiv,
			style: vectorStyleUrl(prefs.vectorStyleName),
			center: [camera.center.lng, camera.center.lat],
			zoom: camera.zoom - ZOOM_OFFSET,
			minZoom: 0,
			maxZoom: 21,
			maxPitch: 0,
			dragRotate: false,
			pitchWithRotate: false,
			attributionControl: false,
			renderWorldCopies: true,
			fadeDuration: 0,
			maxTileCacheZoomLevels: 10,
			transformRequest: (url) => {
				if (!url.startsWith(SV_SCHEME)) return undefined;
				const m = url.match(/^mma-sv:\/\/(\d+)\/(\d+)\/(\d+)/);
				if (!m) return undefined;
				return { url: buildTileUrl(this.svCfg, Number(m[2]), Number(m[3]), Number(m[1])) };
			},
		});
		this.map.touchZoomRotate.disableRotation();
		this.map.keyboard.disable();
		// Cursor comes from a CSS class so handleMapHover's inline pointer/"" toggling
		// layers over it (inline "" must fall back to crosshair, not the engine default).
		this.map.getCanvas().classList.add("mma-vector-canvas");
		// Re-add the SV overlay after every style (re)load: setStyle wipes custom sources.
		this.map.on("style.load", () => this.addSvLayer());

		this.map.on("contextmenu", (e) => {
			e.preventDefault();
			e.originalEvent?.preventDefault();
			for (const o of this.overlays) {
				const onClick = o.props.onClick;
				if (!onClick) continue;
				onClick(o.pickAt(e.point.x, e.point.y, e.lngLat), e.originalEvent);
			}
		});
	}

	// The visible container: DOM listeners and toasts anchor here. Events from the
	// inner map canvas bubble up to it. Pixel math converts via PREFETCH_MARGIN.
	get container(): HTMLElement {
		return this.outer;
	}

	getHostInstance(): maplibregl.Map {
		return this.map;
	}

	private svTileTemplate(): string {
		return `${SV_SCHEME}{z}/{x}/{y}?r=${this.svRev}`;
	}

	private addSvLayer() {
		if (this.map.getSource(SV_SOURCE)) return;
		this.map.addSource(SV_SOURCE, {
			type: "raster",
			tiles: [this.svTileTemplate()],
			tileSize: 256,
			maxzoom: 20,
		});
		// Below the style's labels (first symbol layer), above its geometry.
		const firstSymbol = this.map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
		this.map.addLayer(
			{
				id: SV_SOURCE,
				type: "raster",
				source: SV_SOURCE,
				paint: { "raster-opacity": this.svOpacity, "raster-fade-duration": 0 },
			},
			firstSymbol,
		);
	}

	getZoom() {
		return this.map.getZoom() + ZOOM_OFFSET;
	}

	setZoom(zoom: number) {
		this.map.setZoom(zoom - ZOOM_OFFSET);
	}

	getCenter(): LatLng | null {
		const c = this.map.getCenter();
		return { lat: c.lat, lng: c.lng };
	}

	getBounds(): Bounds | null {
		// Bounds of the visible window, not the oversized map container.
		const m = PREFETCH_MARGIN;
		const nw = this.map.unproject([m, m]);
		const se = this.map.unproject([m + this.outer.clientWidth, m + this.outer.clientHeight]);
		return { west: nw.lng, south: se.lat, east: se.lng, north: nw.lat };
	}

	panTo(p: LatLng) {
		this.map.panTo([p.lng, p.lat]);
	}

	moveCamera(opts: { center?: LatLng; zoom?: number }) {
		this.map.jumpTo({
			...(opts.center ? { center: [opts.center.lng, opts.center.lat] as [number, number] } : {}),
			...(opts.zoom != null ? { zoom: opts.zoom - ZOOM_OFFSET } : {}),
		});
	}

	fitBounds(bounds: Bounds, padding?: number, opts?: { snap?: boolean }) {
		this.map.fitBounds(
			[
				[bounds.west, bounds.south],
				[bounds.east, bounds.north],
			],
			// Padding fits the bounds inside the visible window, past the prefetch bleed.
			{ padding: (padding ?? 45) + PREFETCH_MARGIN, animate: !opts?.snap },
		);
	}

	on<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void {
		const name = EVENT_NAMES[event];
		const handler = (e?: maplibregl.MapMouseEvent) => {
			if (LATLNG_EVENTS.has(event)) {
				if (!e?.lngLat) return;
				(fn as (arg: LatLng) => void)({ lat: e.lngLat.lat, lng: e.lngLat.lng });
			} else {
				(fn as () => void)();
			}
		};
		this.map.on(name, handler);
		return () => this.map.off(name, handler);
	}

	once<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void {
		const off = this.on(event, (arg) => {
			off();
			fn(arg);
		});
		return off;
	}

	containerPxToLatLng(x: number, y: number): LatLng | null {
		// Callers pass pixels relative to the visible container; shift into map space.
		const ll = this.map.unproject([x + PREFETCH_MARGIN, y + PREFETCH_MARGIN]);
		return { lat: ll.lat, lng: ll.lng };
	}

	setDraggable(v: boolean) {
		if (v) this.map.dragPan.enable();
		else this.map.dragPan.disable();
	}

	setDoubleClickZoom(v: boolean) {
		if (v) this.map.doubleClickZoom.enable();
		else this.map.doubleClickZoom.disable();
	}

	createDeckOverlay(): DeckOverlayHandle {
		const handle = new MapLibreDeckOverlay(this.map, (self) => this.overlays.delete(self));
		this.overlays.add(handle);
		return handle;
	}

	triggerClickAt(latLng: LatLng) {
		const px = this.map.project([latLng.lng, latLng.lat]);
		for (const o of this.overlays) {
			o.props.onClick?.(o.pickAt(px.x, px.y, { lng: latLng.lng, lat: latLng.lat }), undefined);
		}
	}

	applyPrefs(prefs: MapEmbedPrefs, opts: BasemapOpts) {
		const next = createSvConfigForPrefs(prefs, opts.useBlobby);
		// Refetch SV tiles only when the coverage config actually changed.
		if (buildTileUrl(next, 0, 0, 0) !== buildTileUrl(this.svCfg, 0, 0, 0)) {
			this.svCfg = next;
			this.svRev++;
			const src = this.map.getSource(SV_SOURCE) as maplibregl.RasterTileSource | undefined;
			if (src) src.setTiles([this.svTileTemplate()]);
		}
		if (prefs.vectorStyleName !== this.styleName) {
			this.styleName = prefs.vectorStyleName;
			this.map.setStyle(vectorStyleUrl(prefs.vectorStyleName));
		}
	}

	setSvOpacity(v: number) {
		this.svOpacity = v;
		if (this.map.getLayer(SV_SOURCE)) {
			this.map.setPaintProperty(SV_SOURCE, "raster-opacity", v);
		}
	}

	resize() {
		this.map.resize();
	}

	destroy() {
		for (const o of [...this.overlays]) o.finalize();
		this.map.remove();
		this.mapDiv.remove();
	}
}

export function createMapLibreHost(
	container: HTMLElement,
	prefs: MapEmbedPrefs,
	opts: CreateHostOpts,
): MapHost {
	return new MapLibreHost(container, prefs, opts);
}
