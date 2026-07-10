// Earth MapHost: a 3D terrain view on a standalone deck.gl instance. No basemap
// library underneath; the host IS the deck. TerrainLayer meshes open elevation
// tiles (AWS Terrarium, keyless) textured with Google satellite tiles (keyless),
// and every DeckOverlayHandle's layers composite into the same deck on top,
// depth-test disabled so markers stay visible over mountains.
//
// Camera: right-drag (or ctrl-drag) tilts/orbits. Zoom is normalized to Google
// scale (deck's 512px world = google zoom - 1). Clicks on empty ground unproject
// at sea level, so at high pitch on tall terrain the created location can land
// slightly off; fine for v1.

import { Deck, MapView, WebMercatorViewport } from "@deck.gl/core";
import type { PickingInfo, Layer, MapViewState } from "@deck.gl/core";
import { TerrainLayer } from "@deck.gl/geo-layers";
import { fetchBulk, fetchNode, fetchPlanetoid } from "@/lib/render/rocktree/fetch";
import type { FoundNode } from "@/lib/render/rocktree/traverse";
import { makeView } from "@/lib/render/rocktree/lod";
import { RocktreeStream } from "@/lib/render/rocktree/stream";
import RocktreeMeshLayer, { type RocktreeNodeData } from "@/lib/render/rocktree/layer";
import {
	enuAnchor,
	meshOctants,
	meshPositions,
	meshUvs,
	stripToTriangles,
} from "@/lib/render/rocktree/mesh";
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
		earth: Deck<MapView>;
	}
}

const ZOOM_OFFSET = 1;
const ELEVATION_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const SATELLITE_TILES = "https://mts1.googleapis.com/vt?hl=en-US&lyrs=s&x={x}&y={y}&z={z}";
const TERRARIUM_DECODER = { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 };
const INITIAL_PITCH = 45;
// ENU anchoring only holds for small nodes; shallower picks (zoomed way out)
// are left to the terrain backdrop.
const MIN_ROCKTREE_LEVEL = 12;
const ROCKTREE_SETTLE_MS = 250;

type DeckEvent = { srcEvent?: Event };

class EarthDeckOverlay implements DeckOverlayHandle {
	props: Partial<DeckOverlayProps> = {};
	private finalized = false;

	constructor(
		private onChange: () => void,
		private onFinalize: (self: EarthDeckOverlay) => void,
	) {}

	setProps(props: Partial<DeckOverlayProps>) {
		if (this.finalized) return;
		Object.assign(this.props, props);
		this.onChange();
	}

	finalize() {
		if (this.finalized) return;
		this.finalized = true;
		this.onFinalize(this);
	}
}

class EarthHost implements MapHostContract<"earth"> {
	readonly kind = "earth" as const;
	readonly deck: Deck<MapView>;
	private outer: HTMLElement;
	private viewState: MapViewState;
	private overlays = new Set<EarthDeckOverlay>();
	private listeners = new Map<keyof MapHostEvents, Set<(arg: never) => void>>();
	private domOffs: (() => void)[] = [];
	private tilesLoadedFired = false;
	private rocktree: RocktreeStream<RocktreeNodeData>;
	private rocktreeTimer: ReturnType<typeof setTimeout> | null = null;
	private rocktreeRaf: number | null = null;
	private destroyed = false;
	private draggable = true;
	private dblClickZoom = true;
	private lastRightDown: { x: number; y: number } | null = null;

	constructor(container: HTMLElement, _prefs: MapEmbedPrefs, opts: CreateHostOpts) {
		this.outer = container;
		const camera = opts.camera ?? { center: { lat: 0, lng: 0 }, zoom: 2 };
		this.viewState = {
			longitude: camera.center.lng,
			latitude: camera.center.lat,
			zoom: camera.zoom - ZOOM_OFFSET,
			pitch: INITIAL_PITCH,
			bearing: 0,
		};

		let planetoid: Promise<{ rootEpoch: number }> | null = null;
		this.rocktree = new RocktreeStream<RocktreeNodeData>(
			{
				getRootEpoch: () => (planetoid ??= fetchPlanetoid()).then((p) => p.rootEpoch),
				getBulk: fetchBulk,
				loadNode: (found, signal) => this.prepareNode(found, signal),
				disposeNode: (data) => {
					for (const m of data.meshes) m.texture.close();
				},
				onChange: () => this.onRocktreeChange(),
			},
			{
				minLevel: MIN_ROCKTREE_LEVEL,
				// 0.25 = two levels deeper than 1 texel/px; matches what Google's
				// client shows up close (trees/cars stop being blobs)
				texelBudget: 0.25 / Math.min(2, window.devicePixelRatio || 1),
				maxLevel: 22,
				maxNodes: 2048,
			},
		);

		this.deck = new Deck({
			parent: container as HTMLDivElement,
			views: new MapView({ repeat: true }),
			viewState: this.viewState,
			controller: this.controllerProps(),
			layers: this.buildLayers(),
			pickingRadius: 2,
			getCursor: ({ isHovering }) => (isHovering ? "pointer" : "crosshair"),
			onViewStateChange: ({ viewState }) => {
				const prevZoom = this.viewState.zoom;
				this.viewState = viewState as MapViewState;
				this.deck.setProps({ viewState: this.viewState });
				if (this.viewState.zoom !== prevZoom) this.emit("zoom", undefined);
				this.emit("camera", undefined);
				this.scheduleRocktreeUpdate();
			},
			onClick: (info: PickingInfo, ev: DeckEvent) => {
				for (const o of this.overlays) o.props.onClick?.(info, ev?.srcEvent);
			},
			onHover: (info: PickingInfo, ev: DeckEvent) => {
				for (const o of this.overlays) o.props.onHover?.(info, ev?.srcEvent);
			},
			onError: (e: Error) => {
				for (const o of this.overlays) o.props.onError?.(e);
			},
		});

		this.wireDomEvents(container);
		this.scheduleRocktreeUpdate();
	}

	// Live octree streaming (M4): recompute the covering when the camera
	// settles; the stream fetches/aborts/evicts and we just recompose.
	private scheduleRocktreeUpdate() {
		if (this.rocktreeTimer) clearTimeout(this.rocktreeTimer);
		this.rocktreeTimer = setTimeout(() => {
			this.rocktreeTimer = null;
			if (this.destroyed) return;
			this.rocktree.update(
				makeView({
					lat: this.viewState.latitude,
					lng: this.viewState.longitude,
					zoom: this.viewState.zoom,
					pitch: this.viewState.pitch ?? INITIAL_PITCH,
					bearing: this.viewState.bearing ?? 0,
					width: Math.max(1, this.outer.clientWidth),
					height: Math.max(1, this.outer.clientHeight),
				}),
			);
		}, ROCKTREE_SETTLE_MS);
	}

	private onRocktreeChange() {
		if (this.rocktreeRaf != null || this.destroyed) return;
		this.rocktreeRaf = requestAnimationFrame(() => {
			this.rocktreeRaf = null;
			if (!this.destroyed) this.composeLayers();
		});
	}

	private async prepareNode(found: FoundNode, signal: AbortSignal): Promise<RocktreeNodeData> {
		const node = await fetchNode(found.path, found.epoch, found.imageryEpoch, signal);
		const { origin, modelMatrix } = enuAnchor(node.matrix);
		const meshes: RocktreeNodeData["meshes"] = [];
		for (const mesh of node.meshes) {
			meshes.push({
				positions: meshPositions(mesh),
				uvs: meshUvs(mesh),
				octants: meshOctants(mesh),
				indices: stripToTriangles(mesh.strip, mesh.layerBounds[3]),
				texture: await createImageBitmap(
					new Blob([mesh.texture.data as BlobPart], { type: "image/jpeg" }),
				),
			});
		}
		return { path: found.path, origin, enuModel: modelMatrix, meshes };
	}

	private controllerProps() {
		return {
			dragPan: this.draggable,
			dragRotate: true,
			touchRotate: true,
			doubleClickZoom: this.dblClickZoom,
			inertia: 300,
			minZoom: 0,
			maxZoom: 19,
			maxPitch: 85,
		};
	}

	private wireDomEvents(container: HTMLElement) {
		const listen = <K extends keyof HTMLElementEventMap>(
			name: K,
			fn: (e: HTMLElementEventMap[K]) => void,
		) => {
			container.addEventListener(name, fn);
			this.domOffs.push(() => container.removeEventListener(name, fn));
		};
		const latLngAt = (e: MouseEvent): LatLng | null => {
			const rect = this.outer.getBoundingClientRect();
			return this.containerPxToLatLng(e.clientX - rect.left, e.clientY - rect.top);
		};
		listen("mousemove", (e) => {
			const ll = latLngAt(e);
			if (ll) this.emit("mousemove", ll);
		});
		listen("mousedown", (e) => {
			if (e.button === 2) this.lastRightDown = { x: e.clientX, y: e.clientY };
			const ll = latLngAt(e);
			if (ll) this.emit("mousedown", ll);
		});
		listen("mouseup", (e) => {
			const ll = latLngAt(e);
			if (ll) this.emit("mouseup", ll);
		});
		listen("mouseleave", () => this.emit("mouseout", undefined));
		// Right-drag orbits; only a stationary right-click opens the context menu.
		listen("contextmenu", (e) => {
			e.preventDefault();
			const down = this.lastRightDown;
			if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
			const rect = this.outer.getBoundingClientRect();
			const x = e.clientX - rect.left;
			const y = e.clientY - rect.top;
			const picked = this.deck.pickObject({ x, y, radius: 2 });
			const ll = this.containerPxToLatLng(x, y);
			const info =
				picked ??
				({
					coordinate: ll ? [ll.lng, ll.lat] : undefined,
					x,
					y,
					index: -1,
					picked: false,
				} as unknown as PickingInfo);
			for (const o of this.overlays) o.props.onClick?.(info, e);
		});
	}

	private emit<K extends keyof MapHostEvents>(event: K, arg: MapHostEvents[K]) {
		this.listeners.get(event)?.forEach((fn) => (fn as (a: MapHostEvents[K]) => void)(arg));
	}

	private viewport(): WebMercatorViewport {
		return new WebMercatorViewport({
			width: Math.max(1, this.outer.clientWidth),
			height: Math.max(1, this.outer.clientHeight),
			...this.viewState,
		});
	}

	private buildLayers(): Layer[] {
		const terrain = new TerrainLayer({
			id: "earth-terrain",
			elevationData: ELEVATION_TILES,
			texture: SATELLITE_TILES,
			elevationDecoder: TERRARIUM_DECODER,
			meshMaxError: 4.5,
			tileSize: 256,
			maxZoom: 15,
			pickable: false,
			loadOptions: { terrain: { worker: false } },
			// Backdrop only: the terrarium surface and the rocktree mesh disagree by
			// tens of meters and interpenetrate. Without depth writes the mesh only
			// depth-tests against itself and draws cleanly over the terrain.
			parameters: { depthWriteEnabled: false },
			onViewportLoad: () => {
				if (this.tilesLoadedFired) return;
				this.tilesLoadedFired = true;
				this.emit("tilesloaded", undefined);
			},
		});
		const drawn = this.rocktree.drawnNodes();
		const rocktreeLayer = new RocktreeMeshLayer({
			id: "rocktree",
			nodes: drawn.map((d) => d.data),
			masks: new Map(drawn.map((d) => [d.path, d.mask])),
			pickable: false,
		});
		// Overlay content renders on top of terrain regardless of depth, so markers
		// never sink into mountains.
		const overlayLayers = [...this.overlays].flatMap((o) =>
			(o.props.layers ?? []).map((l) =>
				l.clone({
					parameters: { ...l.props.parameters, depthCompare: "always", depthWriteEnabled: false },
				}),
			),
		);
		return [terrain, rocktreeLayer as unknown as Layer, ...overlayLayers];
	}

	private composeLayers() {
		this.deck.setProps({ layers: this.buildLayers() });
	}

	get container(): HTMLElement {
		return this.outer;
	}

	getHostInstance(): Deck<MapView> {
		return this.deck;
	}

	getZoom() {
		return this.viewState.zoom + ZOOM_OFFSET;
	}

	setZoom(zoom: number) {
		this.setViewState({ zoom: zoom - ZOOM_OFFSET });
	}

	getCenter(): LatLng | null {
		return { lat: this.viewState.latitude, lng: this.viewState.longitude };
	}

	getBounds(): Bounds | null {
		const [west, south, east, north] = this.viewport().getBounds();
		return { west, south, east, north };
	}

	panTo(p: LatLng) {
		this.setViewState({ latitude: p.lat, longitude: p.lng });
	}

	moveCamera(opts: { center?: LatLng; zoom?: number }) {
		this.setViewState({
			...(opts.center ? { latitude: opts.center.lat, longitude: opts.center.lng } : {}),
			...(opts.zoom != null ? { zoom: opts.zoom - ZOOM_OFFSET } : {}),
		});
	}

	fitBounds(bounds: Bounds, padding?: number) {
		// Fit in a flat frame; keep the current tilt for the actual camera.
		const flat = new WebMercatorViewport({
			width: Math.max(1, this.outer.clientWidth),
			height: Math.max(1, this.outer.clientHeight),
			...this.viewState,
			pitch: 0,
			bearing: 0,
		});
		const { longitude, latitude, zoom } = flat.fitBounds(
			[
				[bounds.west, bounds.south],
				[bounds.east, bounds.north],
			],
			{ padding: padding ?? 45 },
		);
		this.setViewState({ longitude, latitude, zoom });
	}

	private setViewState(patch: Partial<MapViewState>) {
		const prevZoom = this.viewState.zoom;
		this.viewState = { ...this.viewState, ...patch };
		this.deck.setProps({ viewState: this.viewState });
		if (this.viewState.zoom !== prevZoom) this.emit("zoom", undefined);
		this.emit("camera", undefined);
		this.scheduleRocktreeUpdate();
	}

	on<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(fn as (arg: never) => void);
		return () => set!.delete(fn as (arg: never) => void);
	}

	once<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void {
		const off = this.on(event, (arg) => {
			off();
			fn(arg);
		});
		return off;
	}

	containerPxToLatLng(x: number, y: number): LatLng | null {
		try {
			const [lng, lat] = this.viewport().unproject([x, y]);
			return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
		} catch {
			return null;
		}
	}

	setDraggable(v: boolean) {
		this.draggable = v;
		this.deck.setProps({ controller: this.controllerProps() });
	}

	setDoubleClickZoom(v: boolean) {
		this.dblClickZoom = v;
		this.deck.setProps({ controller: this.controllerProps() });
	}

	createDeckOverlay(): DeckOverlayHandle {
		const handle = new EarthDeckOverlay(
			() => this.composeLayers(),
			(self) => {
				this.overlays.delete(self);
				this.composeLayers();
			},
		);
		this.overlays.add(handle);
		return handle;
	}

	triggerClickAt(latLng: LatLng) {
		const [x, y] = this.viewport().project([latLng.lng, latLng.lat]);
		const picked = this.deck.pickObject({ x, y, radius: 2 });
		const info =
			picked ??
			({
				coordinate: [latLng.lng, latLng.lat],
				x,
				y,
				index: -1,
				picked: false,
			} as unknown as PickingInfo);
		for (const o of this.overlays) o.props.onClick?.(info, undefined);
	}

	applyPrefs(_prefs: MapEmbedPrefs, _opts: BasemapOpts) {
		// No basemap variants and no SV coverage layer on the 3D view (yet).
	}

	setSvOpacity(_v: number) {}

	resize() {
		this.deck.setProps({ viewState: this.viewState });
	}

	destroy() {
		this.destroyed = true;
		if (this.rocktreeTimer) clearTimeout(this.rocktreeTimer);
		if (this.rocktreeRaf != null) cancelAnimationFrame(this.rocktreeRaf);
		this.rocktree.dispose();
		for (const o of [...this.overlays]) o.finalize();
		this.domOffs.forEach((off) => off());
		this.deck.finalize();
	}
}

export function createEarthHost(
	container: HTMLElement,
	prefs: MapEmbedPrefs,
	opts: CreateHostOpts,
): MapHost {
	return new EarthHost(container, prefs, opts);
}
