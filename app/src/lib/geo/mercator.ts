// Web Mercator projection, Google Maps convention: a raster tile is 256px square and the
// whole world is exactly one tile at zoom 0, so the two are the same number.

import type { Bounds, LatLng } from "@/types";
import { clamp } from "@/types/util";

export const TILE_SIZE = 256;

export function latLngToWorld(p: LatLng): { x: number; y: number } {
	const siny = clamp(Math.sin((p.lat * Math.PI) / 180), -0.9999, 0.9999);
	return {
		x: (p.lng / 360 + 0.5) * TILE_SIZE,
		y: (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * TILE_SIZE,
	};
}

export function worldToLatLng(x: number, y: number): LatLng {
	const n = Math.PI * (1 - (2 * y) / TILE_SIZE);
	return {
		lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
		lng: (x / TILE_SIZE - 0.5) * 360,
	};
}

export function worldToTile(wx: number, wy: number, zoom: number): { x: number; y: number } {
	const scale = 2 ** zoom;
	return {
		x: Math.floor((wx * scale) / TILE_SIZE),
		y: Math.floor((wy * scale) / TILE_SIZE),
	};
}

export function pixelToLatLng(globalPx: number, globalPy: number, zoom: number): LatLng {
	const scale = 2 ** zoom;
	return worldToLatLng(globalPx / scale, globalPy / scale);
}

/** The copy of world `x` nearest `from`, so a path from `from` crosses the antimeridian the short way. */
export function unwrapWorldX(x: number, from: number): number {
	return x - TILE_SIZE * Math.round((x - from) / TILE_SIZE);
}

/** Where a map showing `bounds` is centered: their middle in world space. */
export function middleOf({ west, south, east, north }: Bounds): LatLng {
	const sw = latLngToWorld({ lat: south, lng: west });
	const ne = latLngToWorld({ lat: north, lng: east < west ? east + 360 : east });
	const x = (sw.x + ne.x) / 2;
	return worldToLatLng(((x % TILE_SIZE) + TILE_SIZE) % TILE_SIZE, (sw.y + ne.y) / 2);
}
