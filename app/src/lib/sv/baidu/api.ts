import { BAIDU_META_URL, BAIDU_SEARCH_URL } from "./endpoints";
import { baiduCmToMap, mapToBaiduMeters } from "./crs";
import { supportsBaiduAt } from "./chinaPolygon";
import { stripBaidu } from "./prefix";

export interface BaiduLink {
	pid: string;
	lng: number;
	lat: number;
	heading: number;
	/** Road name when the link came from Roads[]. */
	description?: string;
}

export interface BaiduTimeEntry {
	id: string;
	year: number;
	month: number;
	/** True when Baidu marks this TimeLine row as the live capture. */
	isCurrent?: boolean;
}

export interface BaiduPanoMeta {
	id: string;
	lng: number;
	lat: number;
	heading: number;
	pitch: number;
	roll: number;
	/** YYYYMMDD */
	date: string;
	/** Camera altitude in metres (from sdata `Z`, already metres). */
	altitude: number | null;
	/** Rname — road name for Street View description only (not uploader). */
	roadName: string | null;
	/** Navigable links for arrows (altproviders: Links[] + ≤2 nearest per Roads[]). */
	links: BaiduLink[];
	/**
	 * All nearby captures for clickToGo target overlays
	 * (altproviders: every Links[] + every Roads[].Panos).
	 */
	neighbors: BaiduLink[];
	timeline: BaiduTimeEntry[];
}

interface SdataPanoLink {
	PID: string;
	X: number;
	Y: number;
}

interface SdataPanoRoadPano {
	PID: string;
	X: number;
	Y: number;
	Order?: number;
	DIR?: number;
}

interface SdataPano {
	ID: string;
	X: number;
	Y: number;
	/** Camera height in metres. */
	Z?: number;
	Heading?: number;
	Pitch?: number;
	Roll?: number;
	Date?: string;
	Rname?: string;
	Links?: SdataPanoLink[];
	Roads?: { Name?: string; Panos?: SdataPanoRoadPano[] }[];
	TimeLine?: { ID: string; Year: string; TimeLine: string; IsCurrent?: number }[];
}

const metaCache = new Map<string, BaiduPanoMeta>();
const metaInflight = new Map<string, Promise<BaiduPanoMeta | null>>();
const SEARCH_RADIUS_M = 200;

function bearingDeg(
	fromLng: number,
	fromLat: number,
	toLng: number,
	toLat: number,
): number {
	const toRad = (d: number) => (d * Math.PI) / 180;
	const φ1 = toRad(fromLat);
	const φ2 = toRad(toLat);
	const Δλ = toRad(toLng - fromLng);
	const y = Math.sin(Δλ) * Math.cos(φ2);
	const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function haversineM(lng1: number, lat1: number, lng2: number, lat2: number): number {
	const R = 6371000;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function headingDelta(a: number, b: number): number {
	let d = Math.abs(a - b) % 360;
	if (d > 180) d = 360 - d;
	return d;
}

export { headingDelta, haversineM, bearingDeg };

/**
 * Pick the navigable link whose bearing best matches `heading`, within
 * `maxDelta` degrees. Used when a 100m jump still snaps to the current pano.
 */
export function pickBaiduLinkToward(
	links: BaiduLink[],
	heading: number,
	maxDelta = 70,
): BaiduLink | null {
	let best: BaiduLink | null = null;
	let bestDelta = maxDelta;
	for (const link of links) {
		if (!link.pid) continue;
		const d = headingDelta(link.heading, heading);
		if (d < bestDelta) {
			bestDelta = d;
			best = link;
		}
	}
	return best;
}

/** Destination point ~`distM` metres from (lat,lng) along `headingDeg` (GCJ-02 / short hops). */
export function offsetLatLng(
	lat: number,
	lng: number,
	headingDeg: number,
	distM: number,
): { lat: number; lng: number } {
	const R = 6371000;
	const δ = distM / R;
	const θ = (headingDeg * Math.PI) / 180;
	const φ1 = (lat * Math.PI) / 180;
	const λ1 = (lng * Math.PI) / 180;
	const φ2 = Math.asin(
		Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
	);
	const λ2 =
		λ1 +
		Math.atan2(
			Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
			Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
		);
	return {
		lat: (φ2 * 180) / Math.PI,
		lng: ((((λ2 * 180) / Math.PI + 540) % 360) - 180),
	};
}

function linkFromPano(
	fromLng: number,
	fromLat: number,
	p: SdataPanoRoadPano | SdataPanoLink,
	description?: string,
): BaiduLink {
	const pos = baiduCmToMap(p.X, p.Y);
	return {
		pid: p.PID,
		lng: pos.lng,
		lat: pos.lat,
		heading: bearingDeg(fromLng, fromLat, pos.lng, pos.lat),
		...(description ? { description } : {}),
	};
}

/**
 * Link selection (altproviders.js Baidu getOneMetadata):
 * 1. Keep every `Links[]` entry.
 * 2. Per `Roads[]`, add up to 2 nearest Panos whose bearing is ≥5° from any
 *    link already chosen.
 */
function selectNavigableLinks(baidu: SdataPano, lng: number, lat: number): BaiduLink[] {
	const links: BaiduLink[] = [];
	const seen = new Set<string>();

	for (const raw of baidu.Links ?? []) {
		if (!raw?.PID || seen.has(raw.PID)) continue;
		seen.add(raw.PID);
		links.push(linkFromPano(lng, lat, raw));
	}

	for (const road of baidu.Roads ?? []) {
		if (!road.Panos?.length) continue;
		const roadName = road.Name || undefined;
		const candidates: { dist: number; link: BaiduLink }[] = [];
		for (const p of road.Panos) {
			if (!p?.PID || p.PID === baidu.ID || seen.has(p.PID)) continue;
			const pos = baiduCmToMap(p.X, p.Y);
			if (pos.lat === lat && pos.lng === lng) continue;
			candidates.push({
				dist: haversineM(lng, lat, pos.lng, pos.lat),
				link: linkFromPano(lng, lat, p, roadName),
			});
		}
		candidates.sort((a, b) => a.dist - b.dist);
		let added = 0;
		for (const { link } of candidates) {
			if (added >= 2) break;
			if (links.some((l) => headingDelta(l.heading, link.heading) < 5)) continue;
			seen.add(link.pid);
			links.push(link);
			added += 1;
		}
	}

	return links;
}

/** Every Links[] + Roads[].Panos — clickToGo targets (not just arrow links). */
function collectNeighbors(baidu: SdataPano, lng: number, lat: number): BaiduLink[] {
	const out: BaiduLink[] = [];
	const seen = new Set<string>();

	for (const raw of baidu.Links ?? []) {
		if (!raw?.PID || seen.has(raw.PID)) continue;
		seen.add(raw.PID);
		out.push(linkFromPano(lng, lat, raw));
	}

	for (const road of baidu.Roads ?? []) {
		if (!road.Panos?.length) continue;
		const roadName = road.Name || undefined;
		for (const p of road.Panos) {
			if (!p?.PID || p.PID === baidu.ID || seen.has(p.PID)) continue;
			const pos = baiduCmToMap(p.X, p.Y);
			if (pos.lat === lat && pos.lng === lng) continue;
			seen.add(p.PID);
			out.push(linkFromPano(lng, lat, p, roadName));
		}
	}

	return out;
}

/**
 * Parse Baidu sdata: all neighbors (clickToGo) + navigable links + TimeLine.
 */
function parseSdata(baidu: SdataPano): BaiduPanoMeta {
	const { lng, lat } = baiduCmToMap(baidu.X, baidu.Y);
	const neighbors = collectNeighbors(baidu, lng, lat);
	const links = selectNavigableLinks(baidu, lng, lat);

	const timeline: BaiduTimeEntry[] = (baidu.TimeLine ?? [])
		.filter((t) => t?.ID)
		.map((t) => ({
			id: String(t.ID),
			year: Number(t.Year) || Number(String(t.TimeLine).slice(0, 4)) || 0,
			month: Number(String(t.TimeLine).slice(4)) || 1,
			isCurrent: t.IsCurrent === 1,
		}))
		.filter((t) => t.year > 0);

	return {
		id: baidu.ID,
		lng,
		lat,
		heading: baidu.Heading ?? 0,
		pitch: baidu.Pitch ?? 0,
		roll: baidu.Roll ?? 0,
		date: baidu.Date ?? "",
		altitude: Number.isFinite(baidu.Z) ? (baidu.Z as number) : null,
		roadName: baidu.Rname ?? null,
		links,
		neighbors,
		timeline,
	};
}

export async function fetchBaiduMeta(sid: string): Promise<BaiduPanoMeta | null> {
	const id = stripBaidu(sid);
	if (!id) return null;
	const hit = metaCache.get(id);
	if (hit) return hit;
	const pending = metaInflight.get(id);
	if (pending) return pending;

	const work = (async (): Promise<BaiduPanoMeta | null> => {
		const url = new URL(BAIDU_META_URL);
		url.searchParams.set("sid", id);
		const res = await fetch(url.href, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) return null;
		const data = (await res.json()) as { content?: SdataPano[] };
		const raw = data.content?.[0];
		if (!raw?.ID) return null;
		const meta = parseSdata(raw);
		metaCache.set(id, meta);
		return meta;
	})().finally(() => {
		metaInflight.delete(id);
	});

	metaInflight.set(id, work);
	return work;
}

/** Nearest pano id near map lat/lng, or null. */
export async function searchBaiduPano(
	lat: number,
	lng: number,
	radiusM = SEARCH_RADIUS_M,
): Promise<string | null> {
	if (!supportsBaiduAt(lng, lat)) return null;
	const { x, y } = mapToBaiduMeters(lng, lat);
	const url = new URL(BAIDU_SEARCH_URL);
	url.searchParams.set("x", String(x));
	url.searchParams.set("y", String(y));
	url.searchParams.set("r", String(radiusM));
	const res = await fetch(url.href, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) return null;
	const data = (await res.json()) as { content?: { id?: string } };
	return data.content?.id ?? null;
}

export async function resolveBaiduNear(
	lat: number,
	lng: number,
	radiusM = SEARCH_RADIUS_M,
): Promise<BaiduPanoMeta | null> {
	const id = await searchBaiduPano(lat, lng, radiusM);
	if (!id) return null;
	return fetchBaiduMeta(id);
}

export function getCachedBaiduMeta(sid: string): BaiduPanoMeta | null {
	return metaCache.get(stripBaidu(sid)) ?? null;
}

export function clearBaiduMetaCache(): void {
	metaCache.clear();
	metaInflight.clear();
}
