// Earth MapHost: a 3D terrain view on a standalone deck.gl instance. No basemap
// library underneath; the host IS the deck. TerrainLayer meshes open elevation
// tiles (AWS Terrarium, keyless) textured with Google satellite tiles (keyless),
// and every DeckOverlayHandle's layers composite into the same deck on top,
// depth-test disabled so markers stay visible over mountains.
//
// Camera: right-drag (or ctrl-drag) tilts/orbits. Zoom is normalized to Google
// scale (deck's 512px world = google zoom - 1). Coordinate lookups raycast the
// pixel against the CPU-side rocktree meshes (so clicks/readouts land on the
// 3D surface actually under the cursor) and fall back to a sea-level unproject
// where no mesh is drawn.

import { Deck, MapView, WebMercatorViewport } from "@deck.gl/core";
import type { PickingInfo, Layer, MapViewState } from "@deck.gl/core";
import { TerrainLayer } from "@deck.gl/geo-layers";
import { fetchBulk, fetchNode, fetchPlanetoid } from "@/lib/render/rocktree/fetch";
import type { FoundNode } from "@/lib/render/rocktree/traverse";
import { makeView } from "@/lib/render/rocktree/lod";
import { RocktreeStream, type DrawnNode } from "@/lib/render/rocktree/stream";
import RocktreeMeshLayer, {
	composeNodeModel,
	mul4,
	type RocktreeNodeData,
} from "@/lib/render/rocktree/layer";
import {
	invert4,
	localRay,
	ndcHitsNodeBounds,
	raycastMesh,
	type LocalRay,
} from "@/lib/render/rocktree/raycast";
import { commonToLngLat, coverageGrid, uvAltMatrix } from "@/lib/render/rocktree/coverage";
import { rasterizeHeights, type HeightMesh } from "@/lib/render/rocktree/heightmap";
import type { CoverageTexture } from "@/lib/render/rocktree/layer";
import { MeshHeightExtension, type MeshHeights } from "@/lib/map/meshHeightExtension";
import SDFMarkerLayer from "@/lib/render/sdf-marker-layer/SDFMarkerLayer";
import { ScatterplotLayer } from "@deck.gl/layers";
import { createSvConfigForPrefs } from "@/lib/geo/mapStack";
import { buildTileUrl, serializeTileUrl, type TileConfig } from "@/lib/geo/tiles";
import type { Device } from "@luma.gl/core";
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
// Also re-cover DURING camera motion at this cadence (stale loads are aborted
// by the stream), so tiles start arriving before the camera settles.
const ROCKTREE_MOTION_MS = 400;
// Staged nodes promoted to drawable per frame: bounds GPU model/texture
// creation so a burst of arrivals cannot hitch a single frame.
const ROCKTREE_PROMOTE_PER_FRAME = 4;
// SV coverage decal: GRID x GRID tiles composited into one texture draped over
// the mesh, spanning this many viewport widths around the camera target.
const COVERAGE_GRID = 8;
const COVERAGE_SPAN_FACTOR = 2.5;
// Marker heightmap: mesh rasterized top-down over this rect so markers sit on
// the 3D surface. Rebuilt (debounced) as tiles arrive and on camera settle.
const HEIGHT_SIZE = 1024;
const HEIGHT_SPAN_FACTOR = 1.5;
const HEIGHT_DEBOUNCE_MS = 500;

const MESH_HEIGHT_EXTENSION = new MeshHeightExtension();

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
	private lastRocktreeUpdate = 0;
	private lastDrawn: DrawnNode<RocktreeNodeData>[] = [];
	// per-node MVPs for picking, valid for one (camera, drawn set) pair
	private raycastCache: {
		viewState: MapViewState;
		drawn: DrawnNode<RocktreeNodeData>[];
		viewport: WebMercatorViewport;
		entries: { node: DrawnNode<RocktreeNodeData>; model: Float64Array; mvp: Float64Array }[];
	} | null = null;
	private covCfg: TileConfig;
	private covSeq = 0;
	private covKey: string | null = null;
	private coverage: CoverageTexture | null = null;
	private svOpacity: number;
	private device: Device | null = null;
	private heights: MeshHeights | null = null;
	private heightTimer: ReturnType<typeof setTimeout> | null = null;
	private destroyed = false;
	private draggable = true;
	private dblClickZoom = true;
	private lastRightDown: { x: number; y: number } | null = null;

	constructor(container: HTMLElement, prefs: MapEmbedPrefs, opts: CreateHostOpts) {
		this.outer = container;
		this.svOpacity = prefs.svOpacity;
		this.covCfg = createSvConfigForPrefs(prefs, opts.useBlobby);
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
				loadNode: (found, signal, priority) => this.prepareNode(found, signal, priority),
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
			onDeviceInitialized: (device) => {
				this.device = device;
			},
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
				const fixed = this.withMeshCoordinate(info);
				for (const o of this.overlays) o.props.onClick?.(fixed, ev?.srcEvent);
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

	// Live octree streaming (M4/M5): re-cover during motion (throttled) plus a
	// trailing settle pass; the stream fetches/aborts/evicts and we recompose.
	private scheduleRocktreeUpdate() {
		if (this.rocktreeTimer) clearTimeout(this.rocktreeTimer);
		this.rocktreeTimer = setTimeout(() => {
			this.rocktreeTimer = null;
			this.fireRocktreeUpdate();
			void this.updateCoverage();
		}, ROCKTREE_SETTLE_MS);
		if (Date.now() - this.lastRocktreeUpdate >= ROCKTREE_MOTION_MS) this.fireRocktreeUpdate();
	}

	// Re-render the SV coverage decal for the settled camera. The texture is
	// world-anchored, so a stale one stays geographically correct while moving.
	private async updateCoverage() {
		if (this.destroyed || this.svOpacity <= 0) return;
		const vs = this.viewState;
		const viewport = this.viewport();
		const [cx, cy] = viewport.projectPosition([vs.longitude, vs.latitude, 0]);
		const span =
			(Math.max(this.outer.clientWidth, this.outer.clientHeight) / 2 ** vs.zoom) *
			COVERAGE_SPAN_FACTOR;
		const { tileZ, tx0, ty0, rect } = coverageGrid([cx, cy], span, COVERAGE_GRID);
		const key = `${serializeTileUrl(this.covCfg)}|${tileZ}:${tx0}:${ty0}`;
		if (key === this.covKey) return;
		this.covKey = key;
		const seq = ++this.covSeq;

		const n = 2 ** tileZ;
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = COVERAGE_GRID * 256;
		const ctx = canvas.getContext("2d")!;
		const loadTile = (url: string) =>
			new Promise<HTMLImageElement | null>((resolve) => {
				const img = new Image();
				img.crossOrigin = "anonymous";
				img.onload = () => resolve(img);
				img.onerror = () => resolve(null);
				img.src = url;
			});
		const jobs: Promise<void>[] = [];
		for (let col = 0; col < COVERAGE_GRID; col++) {
			for (let row = 0; row < COVERAGE_GRID; row++) {
				const tx = (((tx0 + col) % n) + n) % n;
				const ty = ty0 + row;
				if (ty < 0 || ty >= n) continue;
				jobs.push(
					loadTile(buildTileUrl(this.covCfg, tx, ty, tileZ)).then((img) => {
						if (img && seq === this.covSeq) ctx.drawImage(img, col * 256, row * 256, 256, 256);
					}),
				);
			}
		}
		await Promise.all(jobs);
		if (seq !== this.covSeq || this.destroyed) return;
		const bitmap = await createImageBitmap(canvas);
		if (seq !== this.covSeq || this.destroyed) {
			bitmap.close();
			return;
		}
		this.coverage?.bitmap.close();
		this.coverage = { bitmap, rect, version: seq };
		this.composeLayers();
	}

	private fireRocktreeUpdate() {
		if (this.destroyed) return;
		this.lastRocktreeUpdate = Date.now();
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
	}

	private onRocktreeChange() {
		if (this.destroyed) return;
		this.scheduleHeightmap();
		if (this.rocktreeRaf != null) return;
		this.rocktreeRaf = requestAnimationFrame(() => {
			this.rocktreeRaf = null;
			if (!this.destroyed) this.composeLayers();
		});
	}

	private scheduleHeightmap() {
		if (this.heightTimer) clearTimeout(this.heightTimer);
		this.heightTimer = setTimeout(() => {
			this.heightTimer = null;
			this.rebuildHeightmap();
		}, HEIGHT_DEBOUNCE_MS);
	}

	// Rasterize the drawn mesh into a top-down heightmap so markers can sit on
	// the surface. Debounced; a stale map is world-anchored and stays correct.
	private rebuildHeightmap() {
		if (this.destroyed || !this.device) return;
		const cache = this.raycastEntries();
		if (cache.entries.length === 0) return;
		const vs = this.viewState;
		const [cx, cy] = cache.viewport.projectPosition([vs.longitude, vs.latitude, 0]);
		const span =
			(Math.max(this.outer.clientWidth, this.outer.clientHeight) / 2 ** vs.zoom) *
			HEIGHT_SPAN_FACTOR;
		const rect: [number, number, number, number] = [cx - span / 2, cy + span / 2, span, span];
		const meshes: HeightMesh[] = [];
		for (const { node, model } of cache.entries) {
			const uvAlt = uvAltMatrix(rect, model, node.data.enuModel, node.data.origin[2]);
			for (const mesh of node.data.meshes)
				meshes.push({ uvAlt, positions: mesh.positions, indices: mesh.indices });
		}
		const data = rasterizeHeights(meshes, HEIGHT_SIZE);
		const texture = this.device.createTexture({
			format: "r32float",
			width: HEIGHT_SIZE,
			height: HEIGHT_SIZE,
			data,
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
		const [west, north] = commonToLngLat(rect[0], rect[1]);
		const [east, south] = commonToLngLat(rect[0] + rect[2], rect[1] - rect[3]);
		this.heights?.texture.destroy();
		this.heights = { texture, bounds: [west, north, 1 / (east - west), 1 / (north - south)] };
		this.composeLayers();
	}

	private async prepareNode(
		found: FoundNode,
		signal: AbortSignal,
		priority: number,
	): Promise<RocktreeNodeData> {
		const node = await fetchNode(found.path, found.epoch, found.imageryEpoch, signal, priority);
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
		this.lastDrawn = drawn;
		// fade coverage out at low zooms where line width in meters dwarfs roads
		const covFade = Math.min(1, Math.max(0, (this.viewState.zoom - 11.5) / 2.5));
		const rocktreeLayer = new RocktreeMeshLayer({
			id: "rocktree",
			nodes: drawn.map((d) => d.data),
			masks: new Map(drawn.map((d) => [d.path, d.mask])),
			coverage: this.coverage,
			svOpacity: this.svOpacity * covFade,
			pickable: false,
		});
		// Overlay content renders on top of terrain regardless of depth, so markers
		// never sink into mountains. Point markers additionally lift onto the mesh
		// surface via the heightmap extension (parallax fix).
		const overlayLayers = [...this.overlays].flatMap((o) =>
			(o.props.layers ?? []).map((l) => {
				const lift =
					l instanceof SDFMarkerLayer || l instanceof ScatterplotLayer
						? { extensions: [MESH_HEIGHT_EXTENSION], meshHeights: this.heights }
						: {};
				return l.clone({
					parameters: { ...l.props.parameters, depthCompare: "always", depthWriteEnabled: false },
					...lift,
				} as Partial<typeof l.props>);
			}),
		);
		return [terrain, rocktreeLayer as unknown as Layer, ...overlayLayers];
	}

	private composeLayers() {
		const staged = this.rocktree.promote(ROCKTREE_PROMOTE_PER_FRAME);
		this.deck.setProps({ layers: this.buildLayers() });
		// spread remaining GPU uploads over subsequent frames
		if (staged > 0) this.onRocktreeChange();
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
		const hit = this.meshLatLngAt(x, y);
		if (hit) return hit;
		try {
			const [lng, lat] = this.viewport().unproject([x, y]);
			return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
		} catch {
			return null;
		}
	}

	private raycastEntries() {
		let c = this.raycastCache;
		if (!c || c.viewState !== this.viewState || c.drawn !== this.lastDrawn) {
			const viewport = this.viewport();
			const vp = viewport.viewProjectionMatrix;
			const entries = [];
			for (const node of this.lastDrawn) {
				if (node.mask === 0xff) continue;
				const model = composeNodeModel(
					viewport.projectPosition(node.data.origin),
					viewport.getDistanceScales(node.data.origin).unitsPerMeter,
					node.data.enuModel,
				);
				entries.push({ node, model, mvp: mul4(vp, model) });
			}
			c = { viewState: this.viewState, drawn: this.lastDrawn, viewport, entries };
			this.raycastCache = c;
		}
		return c;
	}

	/** Nearest mesh surface under the pixel; null when no mesh is hit. */
	private meshLatLngAt(x: number, y: number): LatLng | null {
		const width = Math.max(1, this.outer.clientWidth);
		const height = Math.max(1, this.outer.clientHeight);
		const ndcX = (2 * x) / width - 1;
		const ndcY = 1 - (2 * y) / height;
		const cache = this.raycastEntries();
		let bestT: number | null = null;
		let bestModel: Float64Array | null = null;
		let bestRay: LocalRay | null = null;
		for (const { node, model, mvp } of cache.entries) {
			if (!ndcHitsNodeBounds(mvp, ndcX, ndcY)) continue;
			const inv = invert4(mvp);
			if (!inv) continue;
			const ray = localRay(inv, ndcX, ndcY);
			if (!ray) continue;
			for (const mesh of node.data.meshes) {
				const t = raycastMesh(ray, mesh.positions, mesh.indices, mesh.octants, node.mask);
				if (t !== null && (bestT === null || t < bestT)) {
					bestT = t;
					bestModel = model;
					bestRay = ray;
				}
			}
		}
		if (bestT === null || !bestModel || !bestRay) return null;
		const lx = bestRay.p0[0] + bestRay.dir[0] * bestT;
		const ly = bestRay.p0[1] + bestRay.dir[1] * bestT;
		const lz = bestRay.p0[2] + bestRay.dir[2] * bestT;
		const m = bestModel;
		const common: [number, number, number] = [
			m[0] * lx + m[4] * ly + m[8] * lz + m[12],
			m[1] * lx + m[5] * ly + m[9] * lz + m[13],
			m[2] * lx + m[6] * ly + m[10] * lz + m[14],
		];
		const [lng, lat] = cache.viewport.unprojectPosition(common);
		return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
	}

	/** For unpicked clicks, replace deck's sea-level coordinate with the mesh hit. */
	private withMeshCoordinate(info: PickingInfo): PickingInfo {
		if (info.picked) return info;
		const ll = this.meshLatLngAt(info.x, info.y);
		return ll ? { ...info, coordinate: [ll.lng, ll.lat] } : info;
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

	applyPrefs(prefs: MapEmbedPrefs, opts: BasemapOpts) {
		// No basemap variants on the 3D view; only the SV coverage decal reacts.
		this.covCfg = createSvConfigForPrefs(prefs, opts.useBlobby);
		void this.updateCoverage();
	}

	setSvOpacity(v: number) {
		this.svOpacity = v;
		void this.updateCoverage();
		this.composeLayers();
	}

	resize() {
		this.deck.setProps({ viewState: this.viewState });
	}

	destroy() {
		this.destroyed = true;
		if (this.rocktreeTimer) clearTimeout(this.rocktreeTimer);
		if (this.rocktreeRaf != null) cancelAnimationFrame(this.rocktreeRaf);
		this.covSeq++;
		this.coverage?.bitmap.close();
		if (this.heightTimer) clearTimeout(this.heightTimer);
		this.heights?.texture.destroy();
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
