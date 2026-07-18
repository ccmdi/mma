/**
 * Apple Look Around blue-line coverage as Google-SV-style ImageMapType layers
 * (inserted in the composite stack after SV, under labels).
 *
 * Panorama points are a separate deck.gl layer (see LookAroundPanoCoverageLayer),
 * matching Google's PanoCoverageLayer.
 *
 * MVT tiles fire "load" immediately (Baidu / altproviders parity) so the composite
 * stack is not blocked by vector paint; canvases fill in asynchronously.
 * Raster tiles use native getTileUrl and need no custom load timing.
 */
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { google } from "@/lib/sv/opensv";
import {
	getProviderSettings,
	isProviderEnabled,
	subscribeProvidersSettings,
} from "@/lib/sv/providers/settings";
import {
	bumpProviderCoverageLayers,
	registerProviderLineLayers,
} from "@/lib/sv/providers/coverageLayers";

const TILE = 256;
const RASTER_MAX_Z = 7;
const MVT_MIN_Z = 8;
const MVT_MAX_Z = 15;
const MVT_NATIVE_Z = 14;
const CoverageTypeCar = 2;
const COMPOSED_CACHE_MAX = 384;

class LruCache<V> {
	private map = new Map<string, V>();
	constructor(private readonly max: number) {}
	get(key: string): V | undefined {
		const v = this.map.get(key);
		if (v === undefined) return undefined;
		this.map.delete(key);
		this.map.set(key, v);
		return v;
	}
	set(key: string, value: V) {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, value);
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next().value!;
			this.map.delete(oldest);
		}
	}
	clear() {
		this.map.clear();
	}
}

const mvtCache = new LruCache<ArrayBuffer>(512);
/** Painted Google tiles (never appended — clone on hit). */
const composedCache = new LruCache<HTMLCanvasElement>(COMPOSED_CACHE_MAX);

let settingsUnsub: (() => void) | null = null;
let registryUnsub: (() => void) | null = null;
let styleGen = 0;

const BLUE_RASTER_URL = (z: number, x: number, y: number) =>
	`https://lookmap.skzk.dev/bluelines_raster_2x/${z}/${x}/${y}.png`;
const BLUE_MVT_URL = (z: number, x: number, y: number) =>
	`https://lookmap.skzk.dev/bluelines2/${z}/${x}/${y}/`;

function wrapX(x: number, z: number): number {
	const n = 1 << z;
	return ((x % n) + n) % n;
}

function lineWidthForZoom(zoom: number): number {
	const base = zoom > 13 ? 2 : zoom > 9 ? 1.5 : 1;
	return base * Math.max(0.25, getProviderSettings("apple").lineWidthScale);
}

function triggerTileLoad(el: Element): void {
	queueMicrotask(() => {
		try {
			google.maps.event.trigger(el, "load");
		} catch {
			/* ignore */
		}
	});
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
	const out = document.createElement("canvas");
	out.width = src.width;
	out.height = src.height;
	out.getContext("2d")?.drawImage(src, 0, 0);
	return out;
}

async function fetchMvt(
	z: number,
	x: number,
	y: number,
	signal: AbortSignal,
): Promise<ArrayBuffer | null> {
	const key = `${z}/${x}/${y}`;
	const hit = mvtCache.get(key);
	if (hit) return hit;
	try {
		const res = await fetch(BLUE_MVT_URL(z, x, y), {
			signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
		});
		if (!res.ok) return null;
		const buf = await res.arrayBuffer();
		if (signal.aborted) return null;
		mvtCache.set(key, buf);
		return buf;
	} catch {
		return null;
	}
}

async function paintMvtTile(
	canvas: HTMLCanvasElement,
	x: number,
	y: number,
	zoom: number,
	signal: AbortSignal,
): Promise<void> {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const s = getProviderSettings("apple");

	let srcZ = zoom;
	let srcX = x;
	let srcY = y;
	let scale = 1;
	let offsetX = 0;
	let offsetY = 0;

	if (zoom > MVT_NATIVE_Z) {
		const dz = zoom - MVT_NATIVE_Z;
		scale = 1 << dz;
		srcZ = MVT_NATIVE_Z;
		srcX = Math.floor(x / scale);
		srcY = Math.floor(y / scale);
		offsetX = (x % scale) * TILE;
		offsetY = (y % scale) * TILE;
	}

	const buf = await fetchMvt(srcZ, wrapX(srcX, srcZ), srcY, signal);
	if (!buf || signal.aborted) return;

	const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
	const layer = tile.layers.panos;
	if (!layer) return;

	const extent = layer.extent;
	const pxScale = (TILE * scale) / extent;
	ctx.clearRect(0, 0, TILE, TILE);
	ctx.globalAlpha = 1;
	ctx.lineCap = "butt";
	ctx.lineWidth = lineWidthForZoom(zoom);

	for (let i = 0; i < layer.length; i++) {
		if (signal.aborted) return;
		const feature = layer.feature(i);
		if (feature.type !== 2) continue;
		const coverageType = Number(feature.properties.coverage_type ?? CoverageTypeCar);
		ctx.strokeStyle =
			coverageType === CoverageTypeCar ? s.lineColor : s.trekkerLineColor;
		const geom = feature.loadGeometry();
		ctx.beginPath();
		for (const ring of geom) {
			for (let j = 0; j < ring.length; j++) {
				const px = ring[j].x * pxScale - offsetX;
				const py = ring[j].y * pxScale - offsetY;
				if (j === 0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
			}
		}
		ctx.stroke();
	}
}

function createRasterBlueLines(): google.maps.ImageMapType {
	return new google.maps.ImageMapType({
		name: "Look Around BLUE_RASTER",
		alt: "Apple Look Around blue lines (raster)",
		minZoom: 1,
		maxZoom: RASTER_MAX_Z,
		opacity: getProviderSettings("apple").lineOpacity,
		tileSize: new google.maps.Size(TILE, TILE),
		getTileUrl: (coord, zoom) => {
			if (zoom < 1 || zoom > RASTER_MAX_Z) return "";
			return BLUE_RASTER_URL(zoom, wrapX(coord.x, zoom), coord.y);
		},
	});
}

/** MVT painter typed as ImageMapType so it sits in the same composite stack as Google SV. */
function createMvtBlueLines(): google.maps.ImageMapType {
	const controllers = new WeakMap<Element, AbortController>();
	const cacheGen = styleGen;

	const layer = new google.maps.ImageMapType({
		name: "Look Around BLUE_MVT",
		alt: "Apple Look Around blue lines (vector)",
		minZoom: MVT_MIN_Z,
		maxZoom: MVT_MAX_Z,
		opacity: getProviderSettings("apple").lineOpacity,
		tileSize: new google.maps.Size(TILE, TILE),
		getTileUrl: () => "",
	});
	layer.getTile = (coord, zoom, ownerDocument) => {
		if (!coord || !ownerDocument) return null as unknown as Element;
		const wrap = ownerDocument.createElement("div");
		wrap.style.width = `${TILE}px`;
		wrap.style.height = `${TILE}px`;
		// Absolute overlay — relative siblings in the composite stack take flow
		// space and shift later layers (e.g. Baidu) by a full tile.
		wrap.style.position = "absolute";
		wrap.style.top = "0";
		wrap.style.left = "0";
		wrap.style.opacity = String(getProviderSettings("apple").lineOpacity);

		// Unblock composite stack immediately (Baidu / altproviders parity).
		triggerTileLoad(wrap);

		if (zoom < MVT_MIN_Z || zoom > MVT_MAX_Z) {
			return wrap;
		}

		const tx = wrapX(coord.x, zoom);
		const ty = coord.y;
		const cacheKey = `${cacheGen}/${zoom}/${tx}/${ty}`;
		const hit = composedCache.get(cacheKey);
		if (hit) {
			const canvas = cloneCanvas(hit);
			canvas.style.width = `${TILE}px`;
			canvas.style.height = `${TILE}px`;
			wrap.appendChild(canvas);
			return wrap;
		}

		const canvas = ownerDocument.createElement("canvas");
		canvas.width = TILE;
		canvas.height = TILE;
		canvas.style.width = `${TILE}px`;
		canvas.style.height = `${TILE}px`;
		wrap.appendChild(canvas);

		const controller = new AbortController();
		controllers.set(wrap, controller);

		void paintMvtTile(canvas, tx, ty, zoom, controller.signal)
			.then(() => {
				if (controller.signal.aborted) return;
				composedCache.set(cacheKey, cloneCanvas(canvas));
			})
			.catch(() => {
				/* aborted / network — leave empty tile */
			});

		return wrap;
	};
	layer.releaseTile = (tile) => {
		const controller = controllers.get(tile as Element);
		if (controller) {
			controller.abort();
			controllers.delete(tile as Element);
		}
	};
	return layer;
}

/** Build Apple line layers the same way Google SV is built (fresh ImageMapType[]). */
export function createAppleLineLayers(): google.maps.ImageMapType[] {
	if (!isProviderEnabled("apple") || !getProviderSettings("apple").showLines) return [];
	if (typeof google === "undefined" || !google?.maps?.ImageMapType) return [];
	void styleGen;
	return [createRasterBlueLines(), createMvtBlueLines()];
}

/** Color / scale change — bump epoch so hosts rebuild the stack. */
export function rebuildStyledLayers() {
	styleGen++;
	composedCache.clear();
	bumpProviderCoverageLayers();
}

export function initCoverage(): () => void {
	settingsUnsub?.();
	settingsUnsub = subscribeProvidersSettings(() => {
		bumpProviderCoverageLayers();
	});

	registryUnsub?.();
	registryUnsub = registerProviderLineLayers(createAppleLineLayers);

	return () => {
		settingsUnsub?.();
		settingsUnsub = null;
		registryUnsub?.();
		registryUnsub = null;
		mvtCache.clear();
		composedCache.clear();
	};
}

export function clearCoverageCache() {
	mvtCache.clear();
	composedCache.clear();
}
