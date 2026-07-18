/**
 * Create / activate Apple Look Around locations from map blank-clicks.
 * Pin clicks are handled by mapClick via location.provider — not here.
 * Toasts are owned by mapClick after every enabled provider has been tried.
 */
import type { Location } from "@/bindings.gen";
import { META_OPEN } from "@/lib/sv/lookaround/api";
import { getClosestPano } from "@/lib/sv/lookaround/tile";
import {
	buildPanoExtra,
	headingPitchDeg,
} from "@/lib/sv/lookaround/panoExtra";
import { setHotPano } from "@/lib/sv/lookaround/sessionStore";
import { log } from "@/lib/util/log";
import { addLocations, setActiveLocation } from "@/store/useMapStore";
import { createLocation } from "@/types";

/** Create an Apple Look Around location at lat/lng, or null if no coverage. */
export async function createAppleLocationAtLatLng(
	lat: number,
	lng: number,
): Promise<Location | null> {
	let pano;
	try {
		pano = await getClosestPano(lat, lng, META_OPEN);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log.warn("[lookaround] closest failed:", msg);
		return null;
	}
	if (!pano) return null;

	setHotPano(pano);

	const { heading, pitch } = headingPitchDeg(pano);
	const loc = createLocation({
		lat: pano.lat,
		lng: pano.lon,
		heading,
		pitch,
		panoId: pano.panoid,
		provider: "apple",
		extra: buildPanoExtra(pano),
	});

	await addLocations([loc], { hideInDelta: true });
	setActiveLocation(loc);
	return loc;
}
