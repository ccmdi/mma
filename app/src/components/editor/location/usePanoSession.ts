import { useEffect } from "react";
import { useMapState } from "@/store/useMapStore";
import { getSettings } from "@/store/settings";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import { isPanoFallback, resolvePano } from "@/lib/sv/lookup";
import { toast } from "@/lib/util/toast";
import { sendHideCar } from "./PanoControls";
import { resetTrail, pushTrail, clearTrail } from "@/lib/sv/svTrail";
import { getPanorama, applyResolved } from "@/lib/sv/panoSingleton";
import { applyViewportLock } from "@/lib/sv/viewportLock";
import { usePanoViewer } from "./PanoViewerContext";
import { t } from "@/lib/i18n";

/** The pano session for the open location: resolve and show its pano, feed viewer walks
 *  into the draft and the trail. */
export function usePanoSession() {
	const location = useMapState((s) => s.activeLocation);
	const { edit, open } = usePanoViewer();

	useEffect(() => {
		if (!location) return;
		let cancelled = false;
		let statusListener: google.maps.MapsEventListener | null = null;
		let lockListener: google.maps.MapsEventListener | null = null;

		void loadOpenSV().then(async () => {
			if (cancelled) return;
			if (!google?.maps) return;
			const pano = getPanorama();
			if (!pano) return;

			statusListener = pano.addListener("status_changed", () => {
				if (cancelled || pano.getStatus() !== "OK") return;
				const panoId = pano.getPano();
				const pos = pano.getPosition();
				if (!panoId || !pos) return;
				edit({ panoId, lat: pos.lat(), lng: pos.lng() });
				pushTrail(pos.lng(), pos.lat());
			});

			lockListener = pano.addListener("pano_changed", () => {
				void applyViewportLock(pano);
			});

			sendHideCar(!getSettings().showCar);
			resetTrail(location.lng, location.lat);

			const result = await resolvePano(location);
			if (cancelled) return;
			applyResolved(pano, result, location);
			google.maps.event.trigger(pano, "resize");
			if (isPanoFallback(location, result)) {
				const root = Object.values(pano).find((v) => v instanceof HTMLElement) as
					HTMLElement | undefined;
				if (root)
					toast(t("Configured pano ID could not be found. Falling back to lat/lng."), 3000, root);
			}
			// From the resolve result directly: setPano() with the same id fires no status_changed.
			open(location, result?.id ?? null);
		});

		return () => {
			cancelled = true;
			clearTrail();
			if (statusListener) google?.maps?.event?.removeListener(statusListener);
			if (lockListener) google?.maps?.event?.removeListener(lockListener);
		};
	}, [location?.id]);
}
