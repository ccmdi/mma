import { useEffect } from "react";
import { getSettings } from "@/store/settings";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import { isPanoFallback } from "@/lib/sv/lookup";
import { sendHideCar } from "./PanoControls";
import { resetTrail, pushTrail, clearTrail } from "@/lib/sv/svTrail";
import { usePano } from "@/lib/hooks/usePano";
import { applyViewportLock } from "@/lib/sv/viewportLock";
import { Editor } from "@/store/editor";
import { t } from "@/lib/i18n";

/** The pano session for the open location: resolve and show its pano, feed viewer walks
 *  into the draft and the trail. */
export function usePanoSession() {
	const open = Editor.use((s) => s.open);
	const location = open?.location ?? null;
	const layer = open?.layer;
	const hasLocation = location !== null;
	const { edit } = Editor;
	const pano = usePano();

	useEffect(() => {
		if (!location) return;
		let cancelled = false;

		const offStatus = pano.on("status_changed", () => {
			if (cancelled || !pano.isLoaded()) return;
			const panoId = pano.panoId();
			const position = pano.position();
			if (!panoId || !position) return;
			void edit({ panoId, ...position });
			pushTrail(position.lng, position.lat);
		});
		const offLock = pano.on("pano_changed", () => void applyViewportLock(pano));

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
			void edit({ panoId: shown.pano?.id ?? location.panoId ?? null });
		});

		return () => {
			cancelled = true;
			clearTrail();
			offStatus();
			offLock();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- initialize the pano once per opening, not on draft updates
	}, [pano, layer, hasLocation]);
}
