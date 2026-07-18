/**
 * Create / activate Tencent Street View locations from map blank-clicks.
 */
import type { Location } from "@/bindings.gen";
import { resolveTencentNear } from "@/lib/sv/tencent/api";
import { buildTencentExtra } from "@/lib/sv/tencent/panoExtra";
import { log } from "@/lib/util/log";
import { addLocations, setActiveLocation } from "@/store/useMapStore";
import { createLocation, LocationFlag } from "@/types";

export async function createTencentLocationAtLatLng(
	lat: number,
	lng: number,
): Promise<Location | null> {
	let meta;
	try {
		meta = await resolveTencentNear(lat, lng);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log.warn("[tencent] search failed:", msg);
		return null;
	}
	if (!meta) return null;

	const loc = createLocation({
		lat: meta.lat,
		lng: meta.lng,
		heading: meta.heading,
		pitch: 0,
		panoId: meta.id,
		provider: "tencent",
		flags: LocationFlag.LoadAsPanoId,
		extra: buildTencentExtra(meta),
	});

	await addLocations([loc], { hideInDelta: true });
	setActiveLocation(loc);
	return loc;
}
