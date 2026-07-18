/**
 * Baidu UI helpers for the native Google Street View lifecycle.
 * Rendering / navigation patches live in inject.ts — this module only adapts
 * app chrome (spawn id, badge, save extra, date-picker entries).
 */
import type { Location } from "@/bindings.gen";
import type { PanoCameraBadge, PanoDateEntry } from "@/lib/sv/panoProvider";
import { getLocationPanoId } from "@/lib/sv/providers/types";
import { fetchBaiduMeta, getCachedBaiduMeta, type BaiduPanoMeta } from "./api";
import { buildBaiduExtra } from "./panoExtra";
import { isBaiduPanoId, prefixBaidu, stripBaidu } from "./prefix";
import { baiduTimelineEntries, rememberBaiduMeta } from "./service";

export const BAIDU_CAMERA_BADGE: PanoCameraBadge = {
	id: "baidu",
	label: "Baidu",
	className: "badge--baidu",
};

/** Viewer/runtime pano id (`BAIDU:` prefixed) for the saved location pin. */
export function baiduSpawnPanoId(location: Location): string | null {
	const raw = getLocationPanoId(location);
	return raw ? prefixBaidu(raw) : null;
}

/**
 * Live / "Default" capture at this spot: TimeLine IsCurrent, else the anchor itself.
 * Updates as the user moves — not the original spawn pin.
 */
export function baiduSpotDefaultPanoId(meta: BaiduPanoMeta): string {
	const live = meta.timeline.find((t) => t.isCurrent)?.id;
	return prefixBaidu(live || meta.id);
}

export function baiduSaveExtra(panoId: string): Record<string, unknown> {
	const meta = getCachedBaiduMeta(stripBaidu(panoId));
	return meta ? buildBaiduExtra(meta) : {};
}

/** Load meta for the current BAIDU: pano and build date-picker entries for that spot. */
export async function loadBaiduDateEntries(panoId: string): Promise<{
	entries: PanoDateEntry[];
	meta: BaiduPanoMeta | null;
	defaultPanoId: string | null;
}> {
	const meta = await fetchBaiduMeta(panoId);
	if (!meta) return { entries: [], meta: null, defaultPanoId: null };
	rememberBaiduMeta(meta);

	const defaultPanoId = baiduSpotDefaultPanoId(meta);
	let defaultMeta: BaiduPanoMeta = meta;
	if (stripBaidu(defaultPanoId) !== meta.id) {
		defaultMeta = (await fetchBaiduMeta(defaultPanoId)) ?? meta;
		if (defaultMeta) rememberBaiduMeta(defaultMeta);
	}

	return {
		entries: baiduTimelineEntries(meta, defaultMeta),
		meta,
		defaultPanoId,
	};
}

export function isBaiduViewerPano(panoId: string | null | undefined): boolean {
	return isBaiduPanoId(panoId);
}
