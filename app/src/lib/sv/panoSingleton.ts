import type { Location, SeenEntry } from "@/bindings.gen";
import { createLocation } from "@/types";
import { getMapState, setActiveLocation, addLocations, fetchLocations } from "@/store/useMapStore";
import { getSettings, panoDisplayOptions } from "@/store/settings";
import { google } from "@/lib/sv/opensv";
import { patchOpenSV, setPanoHovered } from "@/lib/sv/opensvPatch";
import { seenSkipNext } from "@/lib/seen/seen";
import type { Pano } from "@/types";
import { displayZoom } from "@/lib/sv/constants";

export let singletonPano: google.maps.StreetViewPanorama | null = null;

export const singletonDiv = (() => {
	const el = document.createElement("div");
	Object.assign(el.style, { width: "100%", height: "100%" });
	el.addEventListener("pointerenter", () => setPanoHovered(true));
	el.addEventListener("pointerleave", () => setPanoHovered(false));
	const BLOCKED = new Set([
		"arrowleft",
		"arrowright",
		"arrowup",
		"arrowdown",
		"w",
		"a",
		"s",
		"d",
		"+",
		"-",
		"=",
	]);
	el.addEventListener(
		"keydown",
		(e) => {
			if (BLOCKED.has(e.key.toLowerCase())) e.stopPropagation();
		},
		true,
	);
	el.addEventListener(
		"keyup",
		(e) => {
			if (BLOCKED.has(e.key.toLowerCase())) e.stopPropagation();
		},
		true,
	);
	return el;
})();

export function getPanorama(): google.maps.StreetViewPanorama | null {
	if (singletonPano) return singletonPano;
	if (!google?.maps) return null;
	singletonPano = new google.maps.StreetViewPanorama(singletonDiv, {
		disableDefaultUI: true,
		...panoDisplayOptions(getSettings()),
		motionTracking: false,
		visible: false,
	});
	patchOpenSV(singletonPano);
	const root = Object.values(singletonPano).find((v) => v instanceof HTMLElement) as
		HTMLElement | undefined;
	if (root) root.style.backgroundColor = "#000";
	return singletonPano;
}

export function clearSingletonPano() {
	if (singletonPano) singletonPano.setVisible(false);
	singletonPano = null;
}

export function applyResolved(sv: google.maps.StreetViewPanorama, resolved: Pano | null, loc: Location) {
	if (resolved?.pano) {
		sv.setPano(resolved.pano);
	} else {
		sv.setPosition({ lat: loc.lat, lng: loc.lng });
	}
	sv.setZoom(displayZoom(loc.zoom));
	sv.setPov({ heading: loc.heading, pitch: loc.pitch });
	sv.setVisible(true);
	sv.focus();
}

/** Open a seen entry's panorama in the Street View viewer. */
export async function loadSeenPano(entry: SeenEntry) {
	seenSkipNext(entry.panoId);

	const [fetched] =
		entry.locationId != null
			? await fetchLocations({ type: "Locations", locations: [entry.locationId], name: null })
			: [];
	const existing = fetched && fetched.panoId === entry.panoId ? fetched : null;

	if (existing) {
		const active = getMapState().activeLocation;
		if (active?.id !== existing.id) {
			await setActiveLocation(existing.id);
			return;
		}
	} else {
		const loc = createLocation({
			lat: entry.lat,
			lng: entry.lng,
			heading: entry.heading,
			pitch: entry.pitch,
			zoom: entry.zoom,
			panoId: entry.panoId,
			extra: entry.countryCode ? { countryCode: entry.countryCode } : undefined,
		});
		await addLocations([loc]);
		await setActiveLocation(loc.id, false);
		return;
	}

	if (!singletonPano) return;
	singletonPano.setPano(entry.panoId);
	singletonPano.setPov({ heading: entry.heading, pitch: entry.pitch });
	singletonPano.setZoom(entry.zoom);
}
