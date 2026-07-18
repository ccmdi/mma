/**
 * Coarse China mainland gate for Baidu coverage / search.
 * Full GeoJSON from altproviders is huge; bbox + simple ring is enough.
 */

import { isInChinaBbox } from "@/lib/geo/chinaCrs";

/** Simplified mainland outline (lng, lat), closed. */
const MAINLAND_RING: readonly (readonly [number, number])[] = [
	[73.5, 39.4],
	[80.0, 30.0],
	[97.0, 18.0],
	[110.0, 18.5],
	[122.0, 21.0],
	[123.5, 31.0],
	[134.0, 48.0],
	[120.0, 53.5],
	[87.0, 49.0],
	[73.5, 39.4],
];

function pointInRing(lng: number, lat: number, ring: readonly (readonly [number, number])[]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		const intersect =
			yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

export function supportsBaiduAt(lng: number, lat: number): boolean {
	if (!isInChinaBbox(lng, lat)) return false;
	return pointInRing(lng, lat, MAINLAND_RING);
}
