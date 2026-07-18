/**
 * Sibling hits from a parallel inject-provider race (map click or SIS).
 * First success becomes the active pano; later successes land here so the
 * date picker can offer cross-provider switching.
 *
 * Not China-specific — any inject provider that races can contribute.
 */
import type { PanoDateEntry } from "@/lib/sv/panoProvider";
import type { BaiduPanoMeta } from "@/lib/sv/baidu/api";
import { baiduDateToUnix } from "@/lib/sv/baidu/panoExtra";
import { prefixBaidu } from "@/lib/sv/baidu/prefix";
import type { TencentPanoMeta } from "@/lib/sv/tencent/api";
import { prefixTencent } from "@/lib/sv/tencent/prefix";
import type { AltSvProviderId } from "./types";

export interface InjectAlternateHit {
	provider: AltSvProviderId;
	/** Prefixed viewer pano id (BAIDU: / TENCENT: / …). */
	pano: string;
	lat: number;
	lng: number;
	timestamp: number;
	cameraType: string;
}

type Listener = () => void;

const hits = new Map<string, InjectAlternateHit[]>();
const listeners = new Set<Listener>();

function cellKey(lat: number, lng: number): string {
	return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function emit(): void {
	for (const l of listeners) l();
}

export function subscribeInjectAlternates(cb: Listener): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/** @deprecated Use subscribeInjectAlternates */
export const subscribeChinaAlternates = subscribeInjectAlternates;

export function rememberInjectAlternate(hit: InjectAlternateHit): void {
	const key = cellKey(hit.lat, hit.lng);
	const list = hits.get(key) ?? [];
	if (list.some((h) => h.pano === hit.pano)) return;
	list.push(hit);
	hits.set(key, list);
	emit();
}

/** @deprecated Use rememberInjectAlternate */
export const rememberChinaAlternate = rememberInjectAlternate;

export function getInjectAlternatesNear(lat: number, lng: number): InjectAlternateHit[] {
	return hits.get(cellKey(lat, lng)) ?? [];
}

/** @deprecated Use getInjectAlternatesNear */
export const getChinaAlternatesNear = getInjectAlternatesNear;

/** Convert stored siblings into date-picker entries (excludes `excludePano`). */
export function injectAlternatesAsDateEntries(
	lat: number,
	lng: number,
	excludePano?: string | null,
): PanoDateEntry[] {
	return getInjectAlternatesNear(lat, lng)
		.filter((h) => h.pano !== excludePano)
		.map((h) => ({
			pano: h.pano,
			timestamp: h.timestamp,
			cameraType: h.cameraType,
		}));
}

/** @deprecated Use injectAlternatesAsDateEntries */
export const chinaAlternatesAsDateEntries = injectAlternatesAsDateEntries;

export function alternateHitFromBaiduMeta(meta: BaiduPanoMeta): InjectAlternateHit {
	const unix = baiduDateToUnix(meta.date);
	return {
		provider: "baidu",
		pano: prefixBaidu(meta.id),
		lat: meta.lat,
		lng: meta.lng,
		timestamp: unix != null ? unix * 1000 : Date.now(),
		cameraType: "baidu",
	};
}

/** @deprecated Use alternateHitFromBaiduMeta */
export const chinaHitFromBaiduMeta = alternateHitFromBaiduMeta;

export function alternateHitFromTencentMeta(meta: TencentPanoMeta): InjectAlternateHit {
	return {
		provider: "tencent",
		pano: prefixTencent(meta.id),
		lat: meta.lat,
		lng: meta.lng,
		timestamp: meta.captureDate.getTime(),
		cameraType: "tencent",
	};
}

/** @deprecated Use alternateHitFromTencentMeta */
export const chinaHitFromTencentMeta = alternateHitFromTencentMeta;

export function clearInjectAlternates(): void {
	hits.clear();
	emit();
}

/** @deprecated Use clearInjectAlternates */
export const clearChinaAlternates = clearInjectAlternates;
