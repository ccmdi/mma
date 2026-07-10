// A cursor-following circle showing the exact radius a click would search for SV coverage.
// Self-contained overlay (own deck overlay + listeners) so the high-frequency updates
// never touch the core scene render.
//
// We track the cursor as a container *pixel* (not a frozen lat/lng): on every zoom/pan we
// reproject that pixel to a fresh lat/lng, so the ring stays under the cursor and resizes
// live mid-zoom instead of waiting for the next mousemove.

import { ScatterplotLayer } from "@deck.gl/layers";
import { clickSearchRadius } from "@/lib/sv/lookup";
import { getMapHost } from "@/lib/map/mapState";
import { getCurrentMap } from "@/store/useMapStore";
import type { LatLng } from "@/types";

const LAYER_ID = "mma-search-radius-cursor";

/** Mount the cursor picker. Returns a teardown for the caller's effect cleanup. */
export function mountSearchRadiusCursor(): () => void {
	const host = getMapHost();
	if (!host) return () => {};

	const overlay = host.createDeckOverlay();

	let pixel: { x: number; y: number } | null = null;

	function render() {
		if (!pixel || !host) return;
		const latLng = host.containerPxToLatLng(pixel.x, pixel.y);
		if (!latLng) return;
		const zoom = host.getZoom();
		const minRadius = getCurrentMap()?.meta.settings.searchRadius ?? undefined;
		const radius = clickSearchRadius(latLng.lat, zoom, minRadius);
		overlay.setProps({
			layers: [
				new ScatterplotLayer<LatLng>({
					id: LAYER_ID,
					data: [{ lat: latLng.lat, lng: latLng.lng }],
					getPosition: (d) => [d.lng, d.lat],
					getRadius: radius,
					radiusUnits: "meters",
					getFillColor: [0, 140, 255, 40],
					getLineColor: [0, 140, 255, 170],
					stroked: true,
					filled: true,
					lineWidthMinPixels: 1,
					pickable: false,
				}),
			],
		});
	}

	const div = host.container;
	const onMove = (e: MouseEvent) => {
		const rect = div.getBoundingClientRect();
		pixel = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		render();
	};
	const onLeave = () => {
		pixel = null;
		overlay.setProps({ layers: [] });
	};
	div.addEventListener("mousemove", onMove);
	div.addEventListener("mouseleave", onLeave);

	// Reproject the held pixel as the camera moves so the ring tracks the cursor mid-zoom/pan.
	const offCamera = host.on("camera", render);

	return () => {
		div.removeEventListener("mousemove", onMove);
		div.removeEventListener("mouseleave", onLeave);
		offCamera();
		overlay.finalize();
	};
}
