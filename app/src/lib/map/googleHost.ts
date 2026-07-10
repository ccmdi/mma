// Google Maps (opensv) MapHost. Wraps google.maps.Map + GoogleMapsOverlay behind the host contract.

import { GoogleMapsOverlay } from "@deck.gl/google-maps";
import type { GoogleMapsOverlayProps } from "@deck.gl/google-maps";
import type { PickingInfo } from "@deck.gl/core";
import { google } from "@/lib/sv/opensv";
import { resolveStackForPrefs } from "@/lib/geo/mapStack";
import { getStyleBackgroundColor } from "@/lib/geo/mapStyles";
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
		google: google.maps.Map;
	}
}

type GmEvent = { srcEvent?: { domEvent?: Event } };

const EVENT_NAMES: Record<keyof MapHostEvents, string> = {
	mousemove: "mousemove",
	mousedown: "mousedown",
	mouseup: "mouseup",
	mouseout: "mouseout",
	zoom: "zoom_changed",
	camera: "bounds_changed",
	tilesloaded: "tilesloaded",
};

const LATLNG_EVENTS = new Set<keyof MapHostEvents>(["mousemove", "mousedown", "mouseup"]);

class GoogleDeckOverlay implements DeckOverlayHandle {
	private overlay: GoogleMapsOverlay | null = null;
	private pending: Partial<DeckOverlayProps> = {};
	private raf = 0;
	private finalized = false;
	props: Partial<DeckOverlayProps> = {};

	constructor(
		map: google.maps.Map,
		private onFinalize: (self: GoogleDeckOverlay) => void,
	) {
		// GoogleMapsOverlay needs a rAF delay before creation (deck.gl + Google Maps interop).
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			if (this.finalized) return;
			this.overlay = new GoogleMapsOverlay({ layers: [], pickingRadius: 2 });
			this.overlay.setMap(map);
			if (Object.keys(this.pending).length > 0) this.setProps(this.pending);
			this.pending = {};
		});
	}

	setProps(props: Partial<DeckOverlayProps>) {
		Object.assign(this.props, props);
		if (!this.overlay) {
			Object.assign(this.pending, props);
			return;
		}
		const out: Partial<GoogleMapsOverlayProps> = {};
		if (props.layers) out.layers = props.layers;
		if ("onError" in props) out.onError = props.onError as GoogleMapsOverlayProps["onError"];
		if ("onClick" in props) {
			const fn = props.onClick;
			out.onClick = (
				fn ? (info: PickingInfo, ev: GmEvent) => fn(info, ev?.srcEvent?.domEvent) : undefined
			) as GoogleMapsOverlayProps["onClick"];
		}
		if ("onHover" in props) {
			const fn = props.onHover;
			out.onHover = (
				fn ? (info: PickingInfo, ev: GmEvent) => fn(info, ev?.srcEvent?.domEvent) : undefined
			) as GoogleMapsOverlayProps["onHover"];
		}
		this.overlay.setProps(out);
	}

	finalize() {
		this.finalized = true;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.overlay?.setMap(null);
		this.overlay?.finalize();
		this.overlay = null;
		this.onFinalize(this);
	}
}

class GoogleMapHost implements MapHostContract<"google"> {
	readonly kind = "google" as const;
	readonly map: google.maps.Map;
	private svLayer: google.maps.ImageMapType | null = null;
	private svOpacity: number;
	private overlays = new Set<GoogleDeckOverlay>();

	constructor(container: HTMLElement, prefs: MapEmbedPrefs, opts: CreateHostOpts) {
		this.svOpacity = prefs.svOpacity;
		this.map = new google.maps.Map(container, {
			center: opts.camera?.center ?? { lat: 0, lng: 0 },
			zoom: opts.camera?.zoom ?? 2,
			minZoom: 1,
			disableDefaultUI: true,
			scaleControl: opts.scaleControl ?? true,
			cameraControl: false,
			zoomControl: false,
			streetViewControl: false,
			fullscreenControl: false,
			mapTypeControl: false,
			clickableIcons: false,
			gestureHandling: "greedy",
			draggableCursor: "crosshair",
			backgroundColor: getStyleBackgroundColor(prefs.mapStyleName),
			styles: [{ stylers: [{ visibility: "off" }] }],
		});
		this.applyPrefs(prefs, opts);
	}

	get container(): HTMLElement {
		return this.map.getDiv();
	}

	getHostInstance(): google.maps.Map {
		return this.map;
	}

	getZoom() {
		return this.map.getZoom() ?? 2;
	}

	setZoom(zoom: number) {
		this.map.setZoom(zoom);
	}

	getCenter(): LatLng | null {
		const c = this.map.getCenter();
		return c ? { lat: c.lat(), lng: c.lng() } : null;
	}

	getBounds(): Bounds | null {
		return this.map.getBounds()?.toJSON() ?? null;
	}

	panTo(p: LatLng) {
		this.map.panTo(p);
	}

	moveCamera(opts: { center?: LatLng; zoom?: number }) {
		this.map.moveCamera(opts);
	}

	fitBounds(bounds: Bounds, padding?: number, opts?: { snap?: boolean }) {
		this.map.fitBounds(bounds, padding);
		if (opts?.snap) {
			google.maps.event.addListenerOnce(this.map, "bounds_changed", () => {
				const center = this.map.getCenter();
				const zoom = this.map.getZoom();
				if (center && zoom != null) this.map.moveCamera({ center, zoom });
			});
		}
	}

	on<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void {
		const listener = this.map.addListener(EVENT_NAMES[event], (e?: google.maps.MapMouseEvent) => {
			if (LATLNG_EVENTS.has(event)) {
				if (!e?.latLng) return;
				(fn as (arg: LatLng) => void)({ lat: e.latLng.lat(), lng: e.latLng.lng() });
			} else {
				(fn as () => void)();
			}
		});
		return () => google.maps.event.removeListener(listener);
	}

	once<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void {
		const off = this.on(event, (arg) => {
			off();
			fn(arg);
		});
		return off;
	}

	containerPxToLatLng(x: number, y: number): LatLng | null {
		const projection = this.projector?.getProjection();
		if (!projection) return null;
		const ll = projection.fromContainerPixelToLatLng(new google.maps.Point(x, y));
		return ll ? { lat: ll.lat(), lng: ll.lng() } : null;
	}

	// A bare OverlayView purely to borrow the live container-pixel <-> latLng projection.
	private projector: google.maps.OverlayView | null = null;
	private ensureProjector() {
		if (this.projector) return;
		const p = new google.maps.OverlayView();
		p.onAdd = () => {};
		p.onRemove = () => {};
		p.draw = () => {};
		p.setMap(this.map);
		this.projector = p;
	}

	setDraggable(v: boolean) {
		this.map.setOptions({ draggable: v });
	}

	setDoubleClickZoom(v: boolean) {
		this.map.setOptions({ disableDoubleClickZoom: !v });
	}

	createDeckOverlay(): DeckOverlayHandle {
		this.ensureProjector();
		const handle = new GoogleDeckOverlay(this.map, (self) => this.overlays.delete(self));
		this.overlays.add(handle);
		return handle;
	}

	triggerClickAt(latLng: LatLng) {
		// deck.gl/google-maps picks off the Maps 'click' event (latLng), not DOM events.
		google.maps.event.trigger(this.map, "click", { latLng: new google.maps.LatLng(latLng) });
	}

	applyPrefs(prefs: MapEmbedPrefs, opts: BasemapOpts) {
		const { mapType: stack, svLayer } = resolveStackForPrefs(prefs, {
			useBlobby: opts.useBlobby,
			customStyles: opts.customStyles,
		});
		this.svLayer = svLayer;
		this.svLayer.setOpacity(this.svOpacity);
		this.map.mapTypes.set("stack", stack);
		this.map.setMapTypeId("stack");
		const bg = getStyleBackgroundColor(prefs.mapStyleName);
		this.map.setOptions({ backgroundColor: bg });
		const mapDiv = this.map.getDiv();
		mapDiv.style.backgroundColor = bg;
		const inner = mapDiv.querySelector<HTMLElement>("div[style*='background-color']");
		if (inner) inner.style.backgroundColor = bg;
	}

	setSvOpacity(v: number) {
		this.svOpacity = v;
		this.svLayer?.setOpacity(v);
	}

	resize() {
		google.maps.event.trigger(this.map, "resize");
	}

	destroy() {
		for (const o of [...this.overlays]) o.finalize();
		this.projector?.setMap(null);
		this.projector = null;
		google.maps.event.clearInstanceListeners(this.map);
		this.map.getDiv().replaceChildren();
	}
}

export function createGoogleMapHost(
	container: HTMLElement,
	prefs: MapEmbedPrefs,
	opts: CreateHostOpts,
): MapHost {
	return new GoogleMapHost(container, prefs, opts);
}
