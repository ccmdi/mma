/**
 * Tencent UI helpers for the native Google Street View lifecycle.
 */
import type { Location } from "@/bindings.gen";
import type { PanoCameraBadge, PanoDateEntry } from "@/lib/sv/panoProvider";
import { getLocationPanoId } from "@/lib/sv/providers/types";
import { fetchTencentMeta, getCachedTencentMeta, type TencentPanoMeta } from "./api";
import { buildTencentExtra } from "./panoExtra";
import { isTencentPanoId, prefixTencent, stripTencent } from "./prefix";
import { rememberTencentMeta, tencentTimelineEntries } from "./service";

export const TENCENT_CAMERA_BADGE: PanoCameraBadge = {
	id: "tencent",
	label: "Tencent",
	className: "badge--tencent",
};

export function tencentSpawnPanoId(location: Location): string | null {
	const raw = getLocationPanoId(location);
	return raw ? prefixTencent(raw) : null;
}

export function tencentSpotDefaultPanoId(meta: TencentPanoMeta): string {
	return prefixTencent(meta.id);
}

export function tencentSaveExtra(panoId: string): Record<string, unknown> {
	const meta = getCachedTencentMeta(stripTencent(panoId));
	return meta ? buildTencentExtra(meta) : {};
}

export async function loadTencentDateEntries(panoId: string): Promise<{
	entries: PanoDateEntry[];
	meta: TencentPanoMeta | null;
	defaultPanoId: string | null;
}> {
	const meta = await fetchTencentMeta(panoId);
	if (!meta) return { entries: [], meta: null, defaultPanoId: null };
	rememberTencentMeta(meta);

	const defaultPanoId = tencentSpotDefaultPanoId(meta);
	return {
		entries: tencentTimelineEntries(meta),
		meta,
		defaultPanoId,
	};
}

export function isTencentViewerPano(panoId: string | null | undefined): boolean {
	return isTencentPanoId(panoId);
}
