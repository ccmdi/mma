/**
 * Coverage tiles (z17) and closest-pano helpers � all via lookmap.skzk.dev.
 */
import { log } from "@/lib/util/log";
import type { LookaroundPano } from "./api";
import { getApi, META_OPEN } from "./api";

const TILE_CACHE_MAX = 256;
const PANO_CACHE_MAX = 512;
/** Default search radius for map clicks (lookmap max is typically 100 m). */
export const CLOSEST_RADIUS_M = 100;
/** Radius when resolving a saved panoid near its spawn. */
export const RESOLVE_RADIUS_M = 100;

const tileCache = new Map<string, LookaroundPano[]>();
const inflight = new Map<string, Promise<LookaroundPano[]>>();
/** Hot metadata by panoid � speeds history switch / revisit without re-fetch. */
const panoCache = new Map<string, LookaroundPano>();

function tileKey(x: number, y: number): string {
	return `${x}/${y}`;
}

function cacheSet(key: string, value: LookaroundPano[]) {
	if (tileCache.has(key)) tileCache.delete(key);
	tileCache.set(key, value);
	while (tileCache.size > TILE_CACHE_MAX) {
		const oldest = tileCache.keys().next().value!;
		tileCache.delete(oldest);
	}
}

function cachePano(pano: LookaroundPano) {
	if (panoCache.has(pano.panoid)) panoCache.delete(pano.panoid);
	panoCache.set(pano.panoid, pano);
	while (panoCache.size > PANO_CACHE_MAX) {
		const oldest = panoCache.keys().next().value!;
		panoCache.delete(oldest);
	}
}

function cachePanos(panos: LookaroundPano[]) {
	for (const p of panos) cachePano(p);
}

/** z17 coverage panos via lookmap `/tiles/coverage/{x}/{y}/`. */
export async function getCoverageInMapTile(x: number, y: number): Promise<LookaroundPano[]> {
	const key = tileKey(x, y);
	const hit = tileCache.get(key);
	if (hit) return hit;

	let pending = inflight.get(key);
	if (pending) return pending;

	pending = (async () => {
		try {
			const tile = await getApi().fetchCoverageTile(x, y);
			cacheSet(key, tile.panos);
			return tile.panos;
		} catch (e) {
			log.warn("[lookaround] coverage tile failed", x, y, e);
			return [];
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, pending);
	return pending;
}

/** Resolved coverage panos for a tile, or undefined while unfetched/in flight. */
export function peekCoverageInMapTile(x: number, y: number): LookaroundPano[] | undefined {
	return tileCache.get(tileKey(x, y));
}

/** Nearest pano via lookmap `/closest?limit=1&meta=�`. */
export async function getClosestPano(
	lat: number,
	lng: number,
	meta: readonly string[] = META_OPEN,
	radius = CLOSEST_RADIUS_M,
): Promise<LookaroundPano | null> {
	const panos = await getApi().getClosestPanos(lat, lng, radius, 1, meta);
	cachePanos(panos);
	return panos[0] ?? null;
}

/**
 * Resolve the pano for a saved location.
 * Prefer limit=1; expand only when the saved panoid mismatches.
 */
export async function resolvePanoForLocation(
	lat: number,
	lng: number,
	savedPanoId?: string | null,
	meta: readonly string[] = META_OPEN,
): Promise<LookaroundPano | null> {
	if (savedPanoId) {
		const cached = panoCache.get(savedPanoId);
		if (cached?.cameraMetadata?.length && cached.heading != null) {
			return cached;
		}
	}

	const api = getApi();
	const nearest = await api.getClosestPanos(lat, lng, RESOLVE_RADIUS_M, 1, meta);
	cachePanos(nearest);
	if (!nearest.length) return null;
	if (!savedPanoId || nearest[0].panoid === savedPanoId) return nearest[0];

	const panos = await api.getClosestPanos(lat, lng, RESOLVE_RADIUS_M, 40, meta);
	cachePanos(panos);
	if (!panos.length) return nearest[0];
	const match = panos.find((p) => p.panoid === savedPanoId);
	return match ?? panos[0];
}

export function rememberPanos(panos: LookaroundPano[]) {
	cachePanos(panos);
}

export function clearAppleTileCache() {
	tileCache.clear();
	inflight.clear();
	panoCache.clear();
}
