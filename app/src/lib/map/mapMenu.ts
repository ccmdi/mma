import type { LatLng } from "@/types";
import type { Location } from "@/bindings.gen";

interface MapMenuTarget {
	location: Location | null;
	latLng: LatLng;
}

let target: MapMenuTarget = { location: null, latLng: { lat: 0, lng: 0 } };

/** What the map's context menu opens on: a location, or a bare point on the map. */
export const MapMenu = {
	target: (): MapMenuTarget => target,
	openAt: (latLng: LatLng) => {
		target = { location: null, latLng };
	},
	openOn: (loc: Location) => {
		target = { location: loc, latLng: { lat: loc.lat, lng: loc.lng } };
	},
};
