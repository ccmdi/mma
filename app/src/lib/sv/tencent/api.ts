import { TENCENT_META_URL, TENCENT_SEARCH_URL } from "./endpoints";
import { tencentToGcj02 } from "./crs";
import { supportsBaiduAt } from "@/lib/sv/baidu/chinaPolygon";
import { bearingDeg, haversineM } from "@/lib/sv/baidu/api";
import { stripTencent } from "./prefix";

export { supportsBaiduAt as supportsTencentAt };

/** Nearby capture used for clickToGo target overlays (all_scenes). */
export interface TencentNeighbor {
	svid: string;
	lng: number;
	lat: number;
	/** Bearing from the current pano toward this neighbor (degrees). */
	heading: number;
}

/**
 * Navigable arrow links (Google Street View `links` / locationEntry[6]).
 * Derived from all_scenes — Tencent has no separate Links[] like Baidu.
 */
export interface TencentLink {
	svid: string;
	lng: number;
	lat: number;
	heading: number;
}

export interface TencentTimeEntry {
	svid: string;
	year: number;
	month: number;
	day: number;
}

export interface TencentPanoMeta {
	id: string;
	lng: number;
	lat: number;
	heading: number;
	captureDate: Date;
	/** All nearby captures for clickToGo overlays. */
	neighbors: TencentNeighbor[];
	/** Arrow links: nearest pano + nearest pano ~180° from the first. */
	links: TencentLink[];
	timeline: TencentTimeEntry[];
}

interface TencentScene {
	svid: string;
	x: number;
	y: number;
}

interface TencentMetaDetail {
	basic: { svid: string; dir?: string | number };
	addr: { x_lng: number; y_lat: number };
	all_scenes?: TencentScene[];
	history?: { nodes?: { svid: string }[] };
}

const metaCache = new Map<string, TencentPanoMeta>();
const metaInflight = new Map<string, Promise<TencentPanoMeta | null>>();
const SEARCH_RADIUS_M = 200;
/** Second link: bearing separation from the first must be ~180° (±5°). */
const OPPOSITE_DELTA_MIN = 175;
const OPPOSITE_DELTA_MAX = 185;

function neighborToLink(n: TencentNeighbor): TencentLink {
	return { svid: n.svid, lng: n.lng, lat: n.lat, heading: n.heading };
}

function isNearOppositeHeading(a: number, b: number): boolean {
	const d = Math.abs(((a - b) % 360) + 360) % 360;
	const sep = Math.max(d, 360 - d);
	return sep >= OPPOSITE_DELTA_MIN && sep <= OPPOSITE_DELTA_MAX;
}

/**
 * Arrow links: (1) nearest all_scenes pano, (2) nearest pano whose bearing
 * is nearly opposite the first (175°–185° separation).
 */
function selectNavigableLinks(
	neighbors: TencentNeighbor[],
	selfId: string,
	fromLng: number,
	fromLat: number,
): TencentLink[] {
	const candidates = neighbors
		.filter((n) => n.svid && n.svid !== selfId)
		.map((n) => ({
			n,
			dist: haversineM(fromLng, fromLat, n.lng, n.lat),
		}))
		.filter((c) => c.dist > 0.5)
		.sort((a, b) => a.dist - b.dist);

	if (candidates.length === 0) return [];

	const first = candidates[0]!;
	const links = [neighborToLink(first.n)];

	const opposite = candidates
		.slice(1)
		.filter(({ n }) => isNearOppositeHeading(n.heading, first.n.heading))
		.sort((a, b) => a.dist - b.dist)[0];

	if (opposite) links.push(neighborToLink(opposite.n));
	return links;
}

/** Parse capture timestamp embedded in a Tencent svid. */
export function parseTencentDateFromSvid(svid: string): Date {
	const raw = stripTencent(svid);
	const year = 2000 + Number(raw.slice(8, 10));
	const month = Number(raw.slice(10, 12)) - 1;
	const day = Number(raw.slice(12, 14));
	const hour = Number(raw.slice(14, 16));
	const minute = Number(raw.slice(16, 18));
	return new Date(year, month, day, hour, minute, 0);
}

function sceneToNeighbor(
	fromLng: number,
	fromLat: number,
	scene: TencentScene,
): TencentNeighbor | null {
	if (!scene?.svid) return null;
	const pos = tencentToGcj02(scene.x, scene.y);
	return {
		svid: scene.svid,
		lng: pos.lng,
		lat: pos.lat,
		heading: bearingDeg(fromLng, fromLat, pos.lng, pos.lat),
	};
}

function parseDetail(qq: TencentMetaDetail): TencentPanoMeta {
	const lng = qq.addr.x_lng;
	const lat = qq.addr.y_lat;
	const id = qq.basic.svid;
	const captureDate = parseTencentDateFromSvid(id);

	const neighbors: TencentNeighbor[] = [];
	const seen = new Set<string>();
	for (const other of qq.all_scenes ?? []) {
		if (!other?.svid || seen.has(other.svid) || other.svid === id) continue;
		const n = sceneToNeighbor(lng, lat, other);
		if (!n) continue;
		seen.add(other.svid);
		neighbors.push(n);
	}

	const links = selectNavigableLinks(neighbors, id, lng, lat);

	const timeline: TencentTimeEntry[] = [];
	for (const node of qq.history?.nodes ?? []) {
		if (!node?.svid) continue;
		const d = parseTencentDateFromSvid(node.svid);
		timeline.push({
			svid: node.svid,
			year: d.getFullYear(),
			month: d.getMonth(),
			day: d.getDate(),
		});
	}

	return {
		id,
		lng,
		lat,
		heading: Number(qq.basic.dir) || 0,
		captureDate,
		neighbors,
		links,
		timeline,
	};
}

export async function fetchTencentMeta(svid: string): Promise<TencentPanoMeta | null> {
	const id = stripTencent(svid);
	if (!id) return null;
	const hit = metaCache.get(id);
	if (hit) return hit;
	const pending = metaInflight.get(id);
	if (pending) return pending;

	const work = (async (): Promise<TencentPanoMeta | null> => {
		const url = new URL(TENCENT_META_URL);
		url.searchParams.set("svid", id);
		const res = await fetch(url.href, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) return null;
		const data = (await res.json()) as { detail?: TencentMetaDetail };
		if (!data.detail?.basic?.svid) return null;
		const meta = parseDetail(data.detail);
		metaCache.set(id, meta);
		return meta;
	})().finally(() => {
		metaInflight.delete(id);
	});

	metaInflight.set(id, work);
	return work;
}

export async function searchTencentPano(
	lat: number,
	lng: number,
	radiusM = SEARCH_RADIUS_M,
): Promise<string | null> {
	if (!supportsBaiduAt(lng, lat)) return null;
	const url = new URL(TENCENT_SEARCH_URL);
	url.searchParams.set("lat", lat.toFixed(6));
	url.searchParams.set("lng", lng.toFixed(6));
	url.searchParams.set("r", String(radiusM));
	const res = await fetch(url.href, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) return null;
	const data = (await res.json()) as { detail?: { svid?: string } };
	return data.detail?.svid ?? null;
}

export async function resolveTencentNear(
	lat: number,
	lng: number,
	radiusM = SEARCH_RADIUS_M,
): Promise<TencentPanoMeta | null> {
	const id = await searchTencentPano(lat, lng, radiusM);
	if (!id) return null;
	return fetchTencentMeta(id);
}

export function getCachedTencentMeta(svid: string): TencentPanoMeta | null {
	return metaCache.get(stripTencent(svid)) ?? null;
}

export function clearTencentMetaCache(): void {
	metaCache.clear();
	metaInflight.clear();
}
