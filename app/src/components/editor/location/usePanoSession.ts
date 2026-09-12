import { useEffect } from "react";
import { useMapState } from "@/store/useMapStore";
import { getSettings } from "@/store/settings";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import { isPanoFallback } from "@/lib/sv/lookup";
import { sendHideCar } from "./PanoControls";
import { resetTrail, pushTrail, clearTrail } from "@/lib/sv/svTrail";
import { pano } from "@/lib/sv/pano";
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

		const offStatus = pano.on("status_changed", () => {
			if (cancelled || !pano.isLoaded()) return;
			const panoId = pano.panoId();
			const position = pano.position();
			if (!panoId || !position) return;
			edit({ panoId, ...position });
			pushTrail(position.lng, position.lat);
		});
		const offLock = pano.on("pano_changed", () => void applyViewportLock());

		void loadOpenSV().then(async () => {
			if (cancelled || !google?.maps) return;
			sendHideCar(!getSettings().showCar);
			resetTrail(location.lng, location.lat);

			const shown = await pano.show(location);
			if (cancelled || shown.status === "superseded") return;
			if (isPanoFallback(location, shown.pano)) {
				pano.toast(t("Configured pano ID could not be found. Falling back to lat/lng."), 3000);
			}
			// From the resolve result directly: setPano() with the same id fires no status_changed.
			open(location, shown.pano?.id ?? null);
		});

		return () => {
			cancelled = true;
			clearTrail();
			offStatus();
			offLock();
		};
	}, [location?.id]);
}
