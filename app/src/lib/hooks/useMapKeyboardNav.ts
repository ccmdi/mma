import { useEffect, useRef } from "react";
import { getSettings } from "@/store/settings";
import { useHeldKeys } from "@/lib/hooks/useHeldKeys";
import type { MapHost } from "@/lib/map/host";
import { latLngToWorld, worldToLatLng } from "@/lib/geo/mercator";

const ACTIONS = ["panLeft", "panRight", "panUp", "panDown", "mapZoomIn", "mapZoomOut"] as const;

/** Held-key map panning/zooming (pan*, mapZoomIn/Out), scoped to the given map.
 *  Speeds read live from app settings. */
export function useMapKeyboardNav(host: MapHost | null) {
	const zoomRef = useRef<number | null>(null);

	const held = useHeldKeys(ACTIONS, host !== null, {
		onTick(held, dt, alt) {
			const center = host?.getCenter();
			if (!host || !center) return false;
			zoomRef.current ??= host.getZoom();

			const s = getSettings();
			const slow = alt ? s.slowModifier : 1;
			const step = (s.mapPanSpeed * dt) / slow;
			let dx = 0,
				dy = 0;
			if (held.has("panLeft")) dx -= step;
			if (held.has("panRight")) dx += step;
			if (held.has("panUp")) dy -= step;
			if (held.has("panDown")) dy += step;

			const zoomStep = (0.02 * dt) / slow;
			if (held.has("mapZoomIn")) zoomRef.current += zoomStep;
			if (held.has("mapZoomOut")) zoomRef.current = Math.max(1, zoomRef.current - zoomStep);

			const scale = Math.pow(2, zoomRef.current);
			const worldPoint = latLngToWorld(center);
			worldPoint.x += dx / scale;
			worldPoint.y += dy / scale;
			host.moveCamera({
				center: worldToLatLng(worldPoint.x, worldPoint.y),
				zoom: zoomRef.current,
			});
		},
	});

	useEffect(() => {
		if (!host) return;
		return host.on("zoom", () => {
			if (held.size === 0) zoomRef.current = null;
		});
	}, [host, held]);
}
