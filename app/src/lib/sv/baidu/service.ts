/**
 * Baidu Street View service helpers for the official opensv pipeline:
 * zoom-0 expand, tile URL rewrite, link/timeline adapters.
 */
import type { BaiduLink, BaiduPanoMeta } from "./api";
import { baiduPanoTileUrl } from "./endpoints";
import { baiduDateToUnix } from "./panoExtra";
import { prefixBaidu, stripBaidu } from "./prefix";
import type { PanoDateEntry } from "@/lib/sv/panoProvider";

const TILE = 512;

const locationByPano = new Map<string, { lat: number; lng: number }>();
const zoom0Cache = new Map<string, string>();
const zoom0Inflight = new Map<string, Promise<string>>();

export function rememberBaiduMeta(meta: BaiduPanoMeta): void {
	locationByPano.set(meta.id, { lat: meta.lat, lng: meta.lng });
	for (const l of meta.links) {
		if (!l.pid) continue;
		if (!locationByPano.has(l.pid)) {
			locationByPano.set(l.pid, { lat: l.lat, lng: l.lng });
		}
	}
}

export function getCachedBaiduLocation(
	sid: string,
): { lat: number; lng: number } | null {
	return locationByPano.get(stripBaidu(sid)) ?? null;
}

/**
 * altproviders expandedThumbnails: pdata z=1 (512×256) → 512×512 JPEG blob
 * with TILE/4 horizontal wrap (bottom half left empty).
 */
export async function buildExpandedZoom0(sid: string): Promise<string> {
	const raw = stripBaidu(sid);
	const hit = zoom0Cache.get(raw);
	if (hit) return hit;
	const pending = zoom0Inflight.get(raw);
	if (pending) return pending;

	const work = (async () => {
		const res = await fetch(baiduPanoTileUrl(raw, 0, 0, 0), {
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`Baidu z1 ${res.status}`);
		// Force image/jpeg — mapsv returns Content-Type: text.
		const jpeg = new Blob([await res.arrayBuffer()], { type: "image/jpeg" });
		const bitmap = await createImageBitmap(jpeg);
		try {
			const canvas = document.createElement("canvas");
			canvas.width = TILE;
			canvas.height = TILE;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("2d unavailable");

			const w = TILE;
			const h = TILE / 2;
			const offset = TILE / 4;
			ctx.drawImage(bitmap, -offset, 0, w, h);
			ctx.drawImage(bitmap, TILE - offset, 0, w, h);

			const outBlob = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob(
					(b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
					"image/jpeg",
					0.92,
				);
			});
			const url = URL.createObjectURL(outBlob);
			zoom0Cache.set(raw, url);
			return url;
		} finally {
			bitmap.close();
		}
	})().finally(() => {
		zoom0Inflight.delete(raw);
	});

	zoom0Inflight.set(raw, work);
	return work;
}

/** altproviders getTileUrl for zoom > 0 (degreeAdjust when zoomWidth/4 is integer). */
export function baiduTileUrlAtZoom(
	panoId: string,
	zoom: number,
	x: number,
	y: number,
): string {
	const raw = stripBaidu(panoId);
	const zoomWidth = 2 ** zoom;
	const degreeAdjust = zoomWidth / 4;
	const tx =
		Math.floor(degreeAdjust) === degreeAdjust ? (x + degreeAdjust) % zoomWidth : x;
	return baiduPanoTileUrl(raw, zoom, tx, y);
}

export function streetViewLinksFromMeta(links: BaiduLink[]): google.maps.StreetViewLink[] {
	return links
		.filter((l) => l.pid)
		.map((l) => ({
			pano: prefixBaidu(l.pid),
			heading: Number.isFinite(l.heading) ? l.heading : 0,
			description: l.description ?? "",
		}));
}

export function baiduTimelineEntries(
	anchor: BaiduPanoMeta,
	defaultPano: BaiduPanoMeta | null,
): PanoDateEntry[] {
	const byPano = new Map<string, PanoDateEntry>();
	const add = (m: BaiduPanoMeta) => {
		const selfTs = baiduDateToUnix(m.date);
		if (selfTs != null) {
			byPano.set(m.id, {
				pano: prefixBaidu(m.id),
				timestamp: selfTs * 1000,
				cameraType: "baidu",
			});
		}
		for (const t of m.timeline) {
			if (!t.id) continue;
			if (byPano.has(t.id) && t.id === m.id) continue;
			if (!byPano.has(t.id)) {
				byPano.set(t.id, {
					pano: prefixBaidu(t.id),
					timestamp: Date.UTC(t.year, Math.max(0, t.month - 1), 1),
					cameraType: "baidu",
				});
			}
		}
	};
	add(anchor);
	if (defaultPano) add(defaultPano);
	return [...byPano.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function warmBaiduPanoAssets(panoId: string, viewZoom: number): void {
	const raw = stripBaidu(panoId);
	void buildExpandedZoom0(raw).catch(() => {});
	const z = Math.max(1, Math.min(3, Math.round(viewZoom)));
	const cols = 2 ** z;
	const rows = Math.max(1, 2 ** (z - 1));
	for (let y = 0; y < rows; y += 1) {
		for (let x = 0; x < cols; x += 1) {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.src = baiduTileUrlAtZoom(raw, z, x, y);
		}
	}
}

export function clearBaiduServiceCaches(): void {
	locationByPano.clear();
	zoom0Cache.clear();
	zoom0Inflight.clear();
}
