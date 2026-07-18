/**
 * Tencent Street View service helpers for the official opensv pipeline:
 * expanded thumb, tile URL rewrite, timeline adapters.
 */
import type { TencentLink, TencentPanoMeta } from "./api";
import { tencentPanoTileUrl, tencentThumbUrl } from "./endpoints";
import { prefixTencent, stripTencent } from "./prefix";
import type { PanoDateEntry } from "@/lib/sv/panoProvider";

const TILE = 512;

const locationByPano = new Map<string, { lat: number; lng: number }>();
const zoom0Cache = new Map<string, string>();
const zoom0Inflight = new Map<string, Promise<string>>();
const tileCache = new Map<string, Promise<HTMLImageElement>>();
const scaledCache = new Map<string, Promise<string>>();

let blackTileUrl: string | null = null;

export function blackTencentTileUrl(): string {
	if (blackTileUrl) return blackTileUrl;
	const canvas = document.createElement("canvas");
	canvas.width = TILE;
	canvas.height = TILE;
	const ctx = canvas.getContext("2d");
	if (ctx) {
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, TILE, TILE);
	}
	blackTileUrl = canvas.toDataURL("image/jpeg");
	return blackTileUrl;
}

export function rememberTencentMeta(meta: TencentPanoMeta): void {
	locationByPano.set(meta.id, { lat: meta.lat, lng: meta.lng });
	for (const n of meta.neighbors) {
		if (!locationByPano.has(n.svid)) {
			locationByPano.set(n.svid, { lat: n.lat, lng: n.lng });
		}
	}
	for (const l of meta.links) {
		if (!locationByPano.has(l.svid)) {
			locationByPano.set(l.svid, { lat: l.lat, lng: l.lng });
		}
	}
}

export function getCachedTencentLocation(
	svid: string,
): { lat: number; lng: number } | null {
	return locationByPano.get(stripTencent(svid)) ?? null;
}

export function streetViewLinksFromMeta(links: TencentLink[]): google.maps.StreetViewLink[] {
	return links
		.filter((l) => l.svid)
		.map((l) => ({
			pano: prefixTencent(l.svid),
			heading: Number.isFinite(l.heading) ? l.heading : 0,
			description: "",
		}));
}

/** altproviders expandedThumbnails: level-0 thumb (512×256) → 512×512 JPEG blob. */
export async function buildExpandedZoom0(svid: string): Promise<string> {
	const raw = stripTencent(svid);
	const hit = zoom0Cache.get(raw);
	if (hit) return hit;
	const pending = zoom0Inflight.get(raw);
	if (pending) return pending;

	const work = (async () => {
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.src = tencentThumbUrl(raw);
		await img.decode();
		const canvas =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(TILE, TILE)
				: (() => {
						const c = document.createElement("canvas");
						c.width = TILE;
						c.height = TILE;
						return c;
					})();
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("2d unavailable");
		const w = TILE;
		const h = TILE / 2;
		ctx.drawImage(img, 0, 0, w, h);
		let url: string;
		if (canvas instanceof OffscreenCanvas) {
			const blob = await canvas.convertToBlob({ type: "image/jpeg" });
			url = URL.createObjectURL(blob);
		} else {
			url = await new Promise<string>((resolve, reject) => {
				(canvas as HTMLCanvasElement).toBlob(
					(b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error("toBlob failed"))),
					"image/jpeg",
					0.92,
				);
			});
		}
		zoom0Cache.set(raw, url);
		return url;
	})().finally(() => {
		zoom0Inflight.delete(raw);
	});

	zoom0Inflight.set(raw, work);
	return work;
}

async function fetchTencentTileImage(
	svid: string,
	level: number,
	x: number,
	y: number,
): Promise<HTMLImageElement> {
	const key = `${svid}/${level}/${x}/${y}`;
	const hit = tileCache.get(key);
	if (hit) return hit;
	const work = (async () => {
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.src = tencentPanoTileUrl(svid, level, x, y);
		await img.decode();
		return img;
	})();
	tileCache.set(key, work);
	return work;
}

async function scaledTileUrl(svid: string, level: number, x: number, y: number): Promise<string> {
	const key = `${svid}/${level}/${x}/${y}`;
	const hit = scaledCache.get(key);
	if (hit) return hit;
	const work = (async () => {
		const parentX = Math.floor(x / 2);
		const parentY = Math.floor(y / 2);
		const image = await fetchTencentTileImage(svid, level, parentX, parentY);
		const canvas = new OffscreenCanvas(TILE, TILE);
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("2d unavailable");
		const sx = ((x % 2) * TILE) / 2;
		const sy = ((y % 2) * TILE) / 2;
		const sw = TILE / 2;
		const sh = TILE / 2;
		ctx.drawImage(image, sx, sy, sw, sh, 0, 0, TILE, TILE);
		const blob = await canvas.convertToBlob({ type: "image/jpeg" });
		return URL.createObjectURL(blob);
	})();
	scaledCache.set(key, work);
	return work;
}

/** Google opensv zoom → Tencent tile URL (string or blob URL promise). */
export function tencentTileUrlAtGoogleZoom(
	panoId: string,
	zoom: number,
	x: number,
	y: number,
): string | Promise<string> {
	const raw = stripTencent(panoId);
	if (zoom === 0 || zoom === 1) return buildExpandedZoom0(raw);
	if (zoom === 2 || zoom === 3) return tencentPanoTileUrl(raw, 0, x, y);
	if (zoom === 4) {
		if (y === 7) return blackTencentTileUrl();
		return scaledTileUrl(raw, 0, x, y);
	}
	if (zoom === 5) {
		if (Math.floor(y / 2) === 7) return blackTencentTileUrl();
		return scaledTileUrl(raw, 1, x, y);
	}
	return blackTencentTileUrl();
}

export function tencentTimelineEntries(anchor: TencentPanoMeta): PanoDateEntry[] {
	const byPano = new Map<string, PanoDateEntry>();
	const add = (svid: string, ts: number) => {
		if (!byPano.has(svid)) {
			byPano.set(svid, {
				pano: prefixTencent(svid),
				timestamp: ts,
				cameraType: "tencent",
			});
		}
	};
	add(anchor.id, anchor.captureDate.getTime());
	for (const t of anchor.timeline) {
		add(t.svid, Date.UTC(t.year, t.month, t.day));
	}
	return [...byPano.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function warmTencentPanoAssets(panoId: string): void {
	const raw = stripTencent(panoId);
	void buildExpandedZoom0(raw).catch(() => {});
	for (let y = 0; y < 2; y += 1) {
		for (let x = 0; x < 4; x += 1) {
			void fetchTencentTileImage(raw, 0, x, y).catch(() => {});
		}
	}
}

export function clearTencentServiceCaches(): void {
	locationByPano.clear();
	zoom0Cache.clear();
	zoom0Inflight.clear();
	tileCache.clear();
	scaledCache.clear();
}
