/**
 * Baidu Street View blue-line coverage as ImageMapType layers.
 * WebMercator tile corners (Google CN = GCJ-02) → BD09MC → Baidu coverage tiles.
 *
 * Load semantics match altproviders BaiduTileLayer: fire "load" immediately so the
 * composite map stack (basemap / Google SV / labels) is not blocked by CRS warp;
 * canvas paints in asynchronously afterward.
 */
import { worldToLatLng } from "@/lib/geo/mercator";
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
import { baiduCoverageTileUrl } from "./endpoints";
import { supportsBaiduAt } from "./chinaPolygon";
import { mapToBaiduMeters } from "./crs";
import { baiduMetersToTile, BAIDU_TILE_PX } from "./tileMath";

const TILE = BAIDU_TILE_PX;

/** Native Baidu coverage tiles are ~cyan; rotate hue toward the configured lineColor. */
const BAIDU_NATIVE_HUE = 195;
/** Representative pixel from Baidu's blue-line tiles (pre-filter). */
const BAIDU_NATIVE_RGB = { r: 26, g: 159, b: 176 };

/** 1×1 transparent GIF — cancel in-flight Image.decode (altproviders). */
const ABORT_IMG =
	"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAI=";

const COMPOSED_CACHE_MAX = 384;

let settingsUnsub: (() => void) | null = null;
let registryUnsub: (() => void) | null = null;
let styleGen = 0;

type Bbox = [west: number, south: number, east: number, north: number];

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

/** Composed Google-mercator tiles (never appended to DOM — clone on hit). */
const composedCache = new LruCache<HTMLCanvasElement>(COMPOSED_CACHE_MAX);

function parseRgb(color: string): { r: number; g: number; b: number } | null {
	const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
	if (!m) return null;
	return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function rgbToHue(r: number, g: number, b: number): number {
	const R = r / 255;
	const G = g / 255;
	const B = b / 255;
	const max = Math.max(R, G, B);
	const min = Math.min(R, G, B);
	if (max === min) return 0;
	const d = max - min;
	let h : number;
	switch (max) {
		case R:
			h = (G - B) / d + (G < B ? 6 : 0);
			break;
		case G:
			h = (B - R) / d + 2;
			break;
		default:
			h = (R - G) / d + 4;
			break;
	}
	return h * 60;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
	const R = r / 255;
	const G = g / 255;
	const B = b / 255;
	const max = Math.max(R, G, B);
	const min = Math.min(R, G, B);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h : number;
	switch (max) {
		case R:
			h = (G - B) / d + (G < B ? 6 : 0);
			break;
		case G:
			h = (B - R) / d + 2;
			break;
		default:
			h = (R - G) / d + 4;
			break;
	}
	return { h: h * 60, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
	const H = ((h % 360) + 360) % 360;
	if (s === 0) {
		const v = Math.round(l * 255);
		return { r: v, g: v, b: v };
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const hk = H / 360;
	const channel = (t: number) => {
		let T = t;
		if (T < 0) T += 1;
		if (T > 1) T -= 1;
		if (T < 1 / 6) return p + (q - p) * 6 * T;
		if (T < 1 / 2) return q;
		if (T < 2 / 3) return p + (q - p) * (2 / 3 - T) * 6;
		return p;
	};
	return {
		r: Math.round(channel(hk + 1 / 3) * 255),
		g: Math.round(channel(hk) * 255),
		b: Math.round(channel(hk - 1 / 3) * 255),
	};
}

/** CSS filter that recolors Baidu's cyan coverage toward `lineColor`. */
export function baiduLineColorFilter(lineColor: string): string {
	const rgb = parseRgb(lineColor);
	if (!rgb) return "hue-rotate(0deg) saturate(120%)";
	const targetHue = rgbToHue(rgb.r, rgb.g, rgb.b);
	const rot = ((targetHue - BAIDU_NATIVE_HUE) % 360 + 360) % 360;
	return `hue-rotate(${rot.toFixed(1)}deg) saturate(120%)`;
}

/**
 * Approximate on-map color after applying {@link baiduLineColorFilter} to a
 * native Baidu cyan sample — use this in the settings color picker so the
 * swatch matches what users see on the coverage layer.
 */
export function baiduApparentCoverageColor(lineColor: string): string {
	const filter = baiduLineColorFilter(lineColor);
	const rot = Number(filter.match(/hue-rotate\(([-\d.]+)deg\)/)?.[1] ?? 0);
	const sat = Number(filter.match(/saturate\((\d+(?:\.\d+)?)%\)/)?.[1] ?? 120) / 100;
	const { h, s, l } = rgbToHsl(BAIDU_NATIVE_RGB.r, BAIDU_NATIVE_RGB.g, BAIDU_NATIVE_RGB.b);
	const { r, g, b } = hslToRgb(h + rot, Math.min(1, s * sat), l);
	return `rgba(${r}, ${g}, ${b}, 1)`;
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

/** Load one Baidu coverage tile via Image.decode (browser HTTP + decode cache). */
function loadCoverageImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			return;
		}
		const img = new Image();
		img.width = TILE;
		img.height = TILE;
		const onabort = () => {
			img.src = ABORT_IMG;
		};
		signal.addEventListener("abort", onabort);
		img.src = url;
		img
			.decode()
			.then(() => {
				signal.removeEventListener("abort", onabort);
				if (signal.aborted) {
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					return;
				}
				resolve(img);
			})
			.catch((err: unknown) => {
				signal.removeEventListener("abort", onabort);
				if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					return;
				}
				// EncodingError after abort — same as altproviders
				if (
					err instanceof Error &&
					err.name === "EncodingError" &&
					signal.aborted
				) {
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					return;
				}
				reject(err);
			});
	});
}

async function renderBaiduCoverageTile(
	bbox: Bbox,
	zoom: number,
	signal: AbortSignal,
): Promise<HTMLCanvasElement> {
	const topLeftMc = mapToBaiduMeters(bbox[0], bbox[3]);
	const bottomRightMc = mapToBaiduMeters(bbox[2], bbox[1]);
	const topLeftTile = baiduMetersToTile(topLeftMc.x, topLeftMc.y, zoom);
	const bottomRightTile = baiduMetersToTile(bottomRightMc.x, bottomRightMc.y, zoom);

	const topLeftOffset = [
		(topLeftTile[0] - Math.floor(topLeftTile[0])) * TILE,
		(1 - (topLeftTile[1] - Math.floor(topLeftTile[1]))) * TILE,
	];
	const horzTileOffset = Math.floor(bottomRightTile[0]) - Math.floor(topLeftTile[0]);
	const vertTileOffset = Math.floor(topLeftTile[1]) - Math.floor(bottomRightTile[1]);
	const bottomRightOffset = [
		(horzTileOffset + bottomRightTile[0] - Math.floor(bottomRightTile[0])) * TILE,
		(vertTileOffset + 1 - (bottomRightTile[1] - Math.floor(bottomRightTile[1]))) * TILE,
	];

	const x0 = Math.floor(topLeftTile[0]);
	const x1 = Math.floor(bottomRightTile[0]);
	const y0 = Math.floor(topLeftTile[1]);
	const y1 = Math.floor(bottomRightTile[1]);

	const jobs: { x: number; y: number; url: string }[] = [];
	for (let x = x0; x <= x1; x += 1) {
		for (let y = y0; y >= y1; y -= 1) {
			jobs.push({ x, y, url: baiduCoverageTileUrl(x, y, zoom) });
		}
	}

	const images = await Promise.all(jobs.map((j) => loadCoverageImage(j.url, signal)));
	if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });

	const helper = new OffscreenCanvas(TILE * (horzTileOffset + 1), TILE * (vertTileOffset + 1));
	const helpCtx = helper.getContext("2d");
	if (!helpCtx) throw new Error("2d context unavailable");

	for (let i = 0; i < jobs.length; i += 1) {
		const { x, y } = jobs[i]!;
		helpCtx.drawImage(images[i]!, (x - x0) * TILE, (y - y0) * -TILE);
	}

	const final = document.createElement("canvas");
	final.width = TILE;
	final.height = TILE;
	final.getContext("2d")?.drawImage(
		helper,
		topLeftOffset[0]!,
		topLeftOffset[1]!,
		bottomRightOffset[0]! - topLeftOffset[0]!,
		Math.abs(bottomRightOffset[1]! - topLeftOffset[1]!),
		0,
		0,
		TILE,
		TILE,
	);
	return final;
}

function createBaiduLineLayer(): google.maps.ImageMapType {
	const controllers = new WeakMap<Element, AbortController>();
	const s = getProviderSettings("baidu");
	const opacity = s.lineOpacity;
	const colorFilter = baiduLineColorFilter(s.lineColor);
	const cacheGen = styleGen;

	const layer = new google.maps.ImageMapType({
		name: "Baidu SV lines",
		alt: "Baidu Street View coverage",
		minZoom: 3,
		// Map host allows up to z21; overzoom by resampling Baidu z≤19 tiles.
		maxZoom: 21,
		opacity,
		tileSize: new google.maps.Size(TILE, TILE),
		getTileUrl: () => "",
	});

	layer.getTile = (coord, zoom, ownerDocument) => {
		if (!coord || !ownerDocument) return null as unknown as Element;
		const scale = 2 ** zoom;
		const topLeft = worldToLatLng((coord.x * TILE) / scale, (coord.y * TILE) / scale);
		const bottomRight = worldToLatLng(
			((coord.x + 1) * TILE) / scale,
			((coord.y + 1) * TILE) / scale,
		);

		const wrap = ownerDocument.createElement("div");
		wrap.style.width = `${TILE}px`;
		wrap.style.height = `${TILE}px`;
		// Absolute so sibling provider tiles overlay (relative would stack in flow
		// and shift Baidu by 256px when Look Around MVT is also enabled).
		wrap.style.position = "absolute";
		wrap.style.top = "0";
		wrap.style.left = "0";
		wrap.style.opacity = String(getProviderSettings("baidu").lineOpacity);
		wrap.style.filter = colorFilter;

		// Unblock composite stack immediately (altproviders parity).
		triggerTileLoad(wrap);

		if (
			!supportsBaiduAt(topLeft.lng, topLeft.lat) &&
			!supportsBaiduAt(bottomRight.lng, bottomRight.lat)
		) {
			return wrap;
		}

		const baiduZoom = Math.min(zoom + 1, 19);
		const cacheKey = `${cacheGen}/${baiduZoom}/${coord.x}/${coord.y}`;
		const hit = composedCache.get(cacheKey);
		if (hit) {
			const canvas = cloneCanvas(hit);
			canvas.style.width = `${TILE}px`;
			canvas.style.height = `${TILE}px`;
			wrap.appendChild(canvas);
			return wrap;
		}

		const controller = new AbortController();
		controllers.set(wrap, controller);

		void renderBaiduCoverageTile(
			[topLeft.lng, bottomRight.lat, bottomRight.lng, topLeft.lat],
			baiduZoom,
			controller.signal,
		)
			.then((canvas) => {
				if (controller.signal.aborted) return;
				composedCache.set(cacheKey, cloneCanvas(canvas));
				canvas.style.width = `${TILE}px`;
				canvas.style.height = `${TILE}px`;
				wrap.appendChild(canvas);
			})
			.catch((err: unknown) => {
				if (
					err instanceof Error &&
					(err.name === "AbortError" || controller.signal.aborted)
				) {
					return;
				}
				if (
					err instanceof Error &&
					err.name === "EncodingError" &&
					controller.signal.aborted
				) {
					return;
				}
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

export function createBaiduLineLayers(): google.maps.ImageMapType[] {
	if (!isProviderEnabled("baidu") || !getProviderSettings("baidu").showLines) return [];
	if (typeof google === "undefined" || !google?.maps?.ImageMapType) return [];
	void styleGen;
	return [createBaiduLineLayer()];
}

export function rebuildBaiduStyledLayers(): void {
	styleGen++;
	composedCache.clear();
	bumpProviderCoverageLayers();
}

export function initBaiduCoverage(): () => void {
	settingsUnsub?.();
	settingsUnsub = subscribeProvidersSettings(() => {
		bumpProviderCoverageLayers();
	});

	registryUnsub?.();
	registryUnsub = registerProviderLineLayers(createBaiduLineLayers);

	return () => {
		settingsUnsub?.();
		settingsUnsub = null;
		registryUnsub?.();
		registryUnsub = null;
	};
}
