// Photometa API for fetching Street View panorama dots.

import type { Location } from "@/bindings.gen";
import type { LatLng } from "@/types";
import type { RequireNonNull } from "@/types/util";

const TILE_ZOOM = 17;
const TILE_SIZE = 256;

export type PanoDot = LatLng & RequireNonNull<Pick<Location, "panoId">>;

export function latLngToWorldCoord(lat: number, lng: number) {
	let n = Math.sin((lat * Math.PI) / 180);
	n = Math.min(Math.max(n, -0.9999), 0.9999);
	return {
		x: TILE_SIZE * (0.5 + lng / 360),
		y: TILE_SIZE * (0.5 - Math.log((1 + n) / (1 - n)) / (4 * Math.PI)),
	};
}

export function worldToTile(wx: number, wy: number) {
	return {
		x: Math.floor((wx * 2 ** TILE_ZOOM) / TILE_SIZE),
		y: Math.floor((wy * 2 ** TILE_ZOOM) / TILE_SIZE),
	};
}

export function boundsToTiles(west: number, south: number, east: number, north: number) {
	const tl = worldToTile(...(Object.values(latLngToWorldCoord(north, west)) as [number, number]));
	const br = worldToTile(...(Object.values(latLngToWorldCoord(south, east)) as [number, number]));
	const tiles: { x: number; y: number }[] = [];
	for (let x = tl.x; x <= br.x; x++) for (let y = tl.y; y <= br.y; y++) tiles.push({ x, y });
	return tiles;
}

export function tileKey(t: { x: number; y: number }) {
	return `${t.x},${t.y}`;
}

function buildPhotometaUrl(tx: number, ty: number): string {
	// Protobuf request: context { client: "apiv3", language: "en" }, tile { x, y, zoom: 17 }
	// Field layout for context (field 1): 1s = client, 5s = language
	// Field layout for tile (field 6): 1i = x, 2i = y, 3i = zoom
	const ctx = `1sapiv3!5sen`;
	const tile = `1i${tx}!2i${ty}!3i${TILE_ZOOM}`;
	const pb = `!1m2!${ctx}!6m3!${tile}`;
	return `https://www.google.com/maps/photometa/ac/v1?pb=${pb}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protobuf response
function parsePanoDots(data: any): PanoDot[] {
	try {
		const container = data?.[1];
		if (!container) return [];
		const entries = container?.[1];
		if (!Array.isArray(entries)) return [];
		const dots: PanoDot[] = [];
		for (const entry of entries) {
			const info = entry?.[0];
			const pos = info?.[2]?.[0];
			const panoId = info?.[0]?.[1];
			if (!pos) continue;
			const lat = pos[2];
			const lng = pos[3];
			if (typeof lat === "number" && typeof lng === "number") {
				dots.push({ lat, lng, panoId });
			}
		}
		return dots;
	} catch {
		return [];
	}
}

export async function fetchPanoDotsWithIds(tile: { x: number; y: number }): Promise<PanoDot[]> {
	const dots = await fetchPanoDots(tile);
	return dots.filter((d): d is PanoDot => typeof d.panoId === "string");
}

const cache = new Map<string, PanoDot[] | Promise<PanoDot[]>>();

export async function fetchPanoDots(tile: { x: number; y: number }): Promise<PanoDot[]> {
	const key = tileKey(tile);
	const cached = cache.get(key);
	if (cached) return cached;

	const promise = (async () => {
		try {
			const url = buildPhotometaUrl(tile.x, tile.y);
			const res = await fetch(url, { referrerPolicy: "no-referrer" });
			if (!res.ok) return [];
			const text = await res.text();
			const json = JSON.parse(text.replace(/^\)\]\}'\n/, ""));
			const dots = parsePanoDots(json);
			cache.set(key, dots);
			return dots;
		} catch {
			cache.delete(key);
			return [];
		}
	})();

	cache.set(key, promise);
	return promise;
}
