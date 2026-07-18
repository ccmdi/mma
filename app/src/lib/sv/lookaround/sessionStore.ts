/**
 * Click→open hot path: reuse the pano already fetched on map click.
 */
import type { LookaroundPano } from "./api";

let hot: LookaroundPano | null = null;

export function setHotPano(pano: LookaroundPano) {
	hot = pano;
}

/** Reuse the click-time pano when LocationPreview opens the same id. */
export function takeHotPano(panoId: string | null): LookaroundPano | null {
	if (!hot || !panoId) return null;
	if (hot.panoid !== panoId) return null;
	return hot;
}

export function clearSession() {
	hot = null;
}
