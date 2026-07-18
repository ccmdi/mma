/**
 * Tencent Street View blue-line coverage from PMTiles vector layer `sv`.
 *
 * Perf notes (no mapStack / StackedMapType changes):
 * - minZoom gate: skip world-scale tiles (huge feature counts)
 * - LRU caches for raw MVT bytes and painted canvases
 * - DPR capped at 1; single stroke; feature budget at low zooms
 * - Fire "load" immediately so the composite stack is not blocked
 */
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { PMTiles } from "pmtiles";
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
import { TENCENT_COVERAGE_PMTILES } from "./endpoints";

const TILE = 256;
const LAYER = "sv";
/** Below this zoom, skip PMTiles entirely — too many line features per tile. */
const MIN_COVERAGE_Z = 5;
const MAX_COVERAGE_Z = 20;
/** Cap overzoom parent fetches so we never paint a z≤7 archive tile into a viewport. */
const MIN_SOURCE_Z = 5;
const MVT_CACHE_MAX = 2048;
const COMPOSED_CACHE_MAX = 1536;
/** Soft cap: skip remaining features once painted this many rings in one tile. */
const FEATURE_BUDGET = 2_500;

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

const mvtCache = new LruCache<ArrayBuffer>(MVT_CACHE_MAX);
const composedCache = new LruCache<HTMLCanvasElement>(COMPOSED_CACHE_MAX);
const mvtInflight = new Map<string, Promise<ArrayBuffer | null>>();

let pmtiles: PMTiles | null = null;
let headerReady: Promise<{ maxZoom: number; minZoom: number }> | null = null;

function getPmtiles(): PMTiles {
	if (!pmtiles) pmtiles = new PMTiles(TENCENT_COVERAGE_PMTILES);
	return pmtiles;
}

function getHeader(): Promise<{ maxZoom: number; minZoom: number }> {
	if (!headerReady) {
		headerReady = getPmtiles()
			.getHeader()
			.then((h) => ({ maxZoom: h.maxZoom, minZoom: h.minZoom }));
	}
	return headerReady;
}

let settingsUnsub: (() => void) | null = null;
let registryUnsub: (() => void) | null = null;
let styleGen = 0;

function parseRgb(color: string): { r: number; g: number; b: number } | null {
	const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
	if (!m) return null;
	return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
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
	const pending = mvtInflight.get(key);
	if (pending) {
		const buf = await pending;
		if (signal.aborted) return null;
		return buf;
	}

	const work = (async (): Promise<ArrayBuffer | null> => {
		try {
			const result = await getPmtiles().getZxy(z, x, y, signal);
			if (!result?.data) return null;
			const raw = result.data as ArrayBuffer | Uint8Array;
			const buf =
				raw instanceof ArrayBuffer
					? raw
					: (raw.buffer.slice(
							raw.byteOffset,
							raw.byteOffset + raw.byteLength,
						) as ArrayBuffer);
			mvtCache.set(key, buf);
			return buf;
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") return null;
			return null;
		} finally {
			mvtInflight.delete(key);
		}
	})();

	mvtInflight.set(key, work);
	const buf = await work;
	if (signal.aborted) return null;
	return buf;
}

function resolveSourceTile(
	coordX: number,
	coordY: number,
	zoom: number,
	headerMax: number,
	headerMin: number,
): { z: number; x: number; y: number; dz: number } {
	let z = zoom;
	let x = coordX;
	let y = coordY;
	const floor = Math.max(MIN_SOURCE_Z, headerMin);
	const ceiling = headerMax;
	while (z > ceiling) {
		z -= 1;
		x = Math.floor(x / 2);
		y = Math.floor(y / 2);
	}
	while (z < floor && zoom > floor) {
		// Prefer fetching a denser parent only when the archive lacks this z.
		break;
	}
	if (z < floor) {
		// Archive tile below our paint floor — skip (caller treats as empty).
		return { z, x, y, dz: zoom - z };
	}
	return { z, x, y, dz: zoom - z };
}

function paintMvt(
	canvas: HTMLCanvasElement,
	buf: ArrayBuffer,
	coordX: number,
	coordY: number,
	zoom: number,
	srcZ: number,
	srcX: number,
	srcY: number,
	strokeStyle: string,
	lineWidthScale: number,
): void {
	const ctx = canvas.getContext("2d", { alpha: true });
	if (!ctx) return;

	const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
	const vectorLayer = tile.layers[LAYER];
	if (!vectorLayer) return;

	const dz = zoom - srcZ;
	const layerSize = vectorLayer.extent;
	const scale = layerSize / TILE / 2 ** Math.max(0, dz);
	const widthScale = lineWidthScale;

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	if (dz === 0) {
		ctx.scale(canvas.width / layerSize, canvas.height / layerSize);
	} else {
		const dx = coordX - srcX * 2 ** dz;
		const dy = coordY - srcY * 2 ** dz;
		ctx.scale((canvas.width / layerSize) * 2 ** dz, (canvas.height / layerSize) * 2 ** dz);
		ctx.translate(-dx * (layerSize / 2 ** dz), -dy * (layerSize / 2 ** dz));
	}

	ctx.beginPath();
	let rings = 0;
	const len = vectorLayer.length;
	// At lower zooms, stride features to keep paint cheap.
	const stride = zoom <= 12 ? 2 : 1;
	for (let i = 0; i < len; i += stride) {
		if (rings >= FEATURE_BUDGET) break;
		const feature = vectorLayer.feature(i);
		if (feature.type !== 2) continue;
		const geom = feature.loadGeometry();
		for (const line of geom) {
			if (line.length < 2) continue;
			ctx.moveTo(line[0]!.x, line[0]!.y);
			for (let j = 1; j < line.length; j += 1) {
				ctx.lineTo(line[j]!.x, line[j]!.y);
			}
			rings += 1;
			if (rings >= FEATURE_BUDGET) break;
		}
	}

	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.lineWidth = Math.max(1, 1.75 * scale * widthScale);
	ctx.strokeStyle = strokeStyle;
	ctx.stroke();
}

function createTencentLineLayer(): google.maps.ImageMapType {
	const controllers = new WeakMap<Element, AbortController>();
	const s = getProviderSettings("tencent");
	const fillRgb = parseRgb(s.lineColor) ?? { r: 0, g: 81, b: 218 };
	const strokeStyle = `rgb(${fillRgb.r}, ${fillRgb.g}, ${fillRgb.b})`;
	const lineWidthScale = Math.max(0.25, s.lineWidthScale);
	const cacheGen = styleGen;

	const layer = new google.maps.ImageMapType({
		name: "Tencent SV lines",
		alt: "Tencent Street View coverage",
		minZoom: MIN_COVERAGE_Z,
		maxZoom: MAX_COVERAGE_Z,
		opacity: s.lineOpacity,
		tileSize: new google.maps.Size(TILE, TILE),
		getTileUrl: () => "",
	});

	layer.getTile = (coord, zoom, ownerDocument) => {
		if (!coord || !ownerDocument) return null as unknown as Element;

		const wrap = ownerDocument.createElement("div");
		wrap.style.width = `${TILE}px`;
		wrap.style.height = `${TILE}px`;
		wrap.style.position = "absolute";
		wrap.style.left = "0";
		wrap.style.top = "0";
		wrap.style.opacity = String(getProviderSettings("tencent").lineOpacity);

		triggerTileLoad(wrap);

		if (zoom < MIN_COVERAGE_Z || zoom > MAX_COVERAGE_Z) {
			return wrap;
		}

		const cacheKey = `${cacheGen}/${zoom}/${coord.x}/${coord.y}`;
		const hit = composedCache.get(cacheKey);
		if (hit) {
			wrap.appendChild(cloneCanvas(hit));
			return wrap;
		}

		const canvas = ownerDocument.createElement("canvas");
		// Coverage lines don't need retina — halves pixel fill cost.
		canvas.width = TILE;
		canvas.height = TILE;
		canvas.style.width = `${TILE}px`;
		canvas.style.height = `${TILE}px`;
		canvas.style.position = "absolute";
		canvas.style.left = "0";
		canvas.style.top = "0";
		wrap.appendChild(canvas);

		const controller = new AbortController();
		controllers.set(wrap, controller);

		void getHeader()
			.then((header) => {
				if (controller.signal.aborted) return null;
				const src = resolveSourceTile(
					coord.x,
					coord.y,
					zoom,
					header.maxZoom,
					header.minZoom,
				);
				if (src.z < MIN_SOURCE_Z) return null;
				return fetchMvt(src.z, src.x, src.y, controller.signal).then((buf) =>
					buf ? { buf, src } : null,
				);
			})
			.then((payload) => {
				if (controller.signal.aborted || !payload) return;
				paintMvt(
					canvas,
					payload.buf,
					coord.x,
					coord.y,
					zoom,
					payload.src.z,
					payload.src.x,
					payload.src.y,
					strokeStyle,
					lineWidthScale,
				);
				if (!controller.signal.aborted) {
					composedCache.set(cacheKey, cloneCanvas(canvas));
				}
			})
			.catch(() => {
				/* ignore abort / decode errors */
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

export function createTencentLineLayers(): google.maps.ImageMapType[] {
	if (!isProviderEnabled("tencent") || !getProviderSettings("tencent").showLines) return [];
	if (typeof google === "undefined" || !google?.maps?.ImageMapType) return [];
	void styleGen;
	return [createTencentLineLayer()];
}

export function rebuildTencentStyledLayers(): void {
	styleGen++;
	composedCache.clear();
	bumpProviderCoverageLayers();
}

export function initTencentCoverage(): () => void {
	settingsUnsub?.();
	settingsUnsub = subscribeProvidersSettings(() => {
		rebuildTencentStyledLayers();
	});

	registryUnsub?.();
	registryUnsub = registerProviderLineLayers(createTencentLineLayers);

	return () => {
		settingsUnsub?.();
		settingsUnsub = null;
		registryUnsub?.();
		registryUnsub = null;
	};
}
