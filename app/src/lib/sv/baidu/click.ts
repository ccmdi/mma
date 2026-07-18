/**
 * Create / activate Baidu Street View locations from map blank-clicks.
 * Toasts are owned by mapClick after every enabled provider has been tried.
 */
import type { Location } from "@/bindings.gen";
import { resolveBaiduNear } from "@/lib/sv/baidu/api";
import { buildBaiduExtra } from "@/lib/sv/baidu/panoExtra";
import { log } from "@/lib/util/log";
import { addLocations, setActiveLocation } from "@/store/useMapStore";
import { createLocation } from "@/types";

/** Create a Baidu Street View location at lat/lng, or null if no coverage. */
export async function createBaiduLocationAtLatLng(
	lat: number,
	lng: number,
): Promise<Location | null> {
	let meta;
	try {
		meta = await resolveBaiduNear(lat, lng);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log.warn("[baidu] search failed:", msg);
		return null;
	}
	if (!meta) return null;

	const loc = createLocation({
		lat: meta.lat,
		lng: meta.lng,
		heading: meta.heading,
		pitch: meta.pitch,
		panoId: meta.id,
		provider: "baidu",
		extra: buildBaiduExtra(meta),
	});

	await addLocations([loc], { hideInDelta: true });
	setActiveLocation(loc);
	return loc;
}
