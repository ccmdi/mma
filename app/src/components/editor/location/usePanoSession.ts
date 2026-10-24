import { useEffect } from "react";
import { getSettings } from "@/store/settings";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import { sendHideCar } from "./PanoControls";
import { usePano } from "@/lib/hooks/usePano";
import { Editor } from "@/store/editor";
import { isPinned } from "@/types";
import { t } from "@/lib/i18n";
import { debounce } from "@/lib/util/concurrent";

const VIEW_SETTLE_MS = 200;

/** The pano session for the open location: resolve and show its pano, feed viewer walks
 *  into the draft, and walks and settled views into the trail. */
export function usePanoSession() {
	const open = Editor.use((s) => s.open);
	const location = open?.location ?? null;
	const layer = open?.layer;
	const hasLocation = location !== null;
	const { edit } = Editor.draft();
	const pano = usePano();

	useEffect(() => {
		if (!location) return;
		let cancelled = false;
		const settle = debounce(() => Editor.trail.face(pano.pov().heading), VIEW_SETTLE_MS);

		const offStatus = pano.on("status_changed", () => {
			if (!pano.isLoaded()) return;
			const panoId = pano.panoId();
			const position = pano.position();
			if (!panoId || !position) return;
			void edit({ panoId, ...position });
			Editor.trail.push(position.lng, position.lat);
			settle.cancel();
			Editor.trail.face(pano.pov().heading);
		});
		const offLock = pano.on("pano_changed", () => void pano.applyLock());
		const offPov = pano.on("pov_changed", settle.schedule);

		void loadOpenSV().then(async () => {
			if (cancelled || !google?.maps) return;
			sendHideCar(!getSettings().showCar);
			Editor.trail.reset(location.lng, location.lat, location.heading);

			const shown = await pano.show(location);
			if (cancelled || shown.status === "cancelled") return;
			if (isPinned(location) && shown.value !== location.panoId) {
				pano.toast(t("Configured pano ID could not be found. Falling back to lat/lng."), 3000);
			}
			// From the resolve result directly: setPano() with the same id fires no status_changed.
			void edit({ panoId: shown.value ?? location.panoId ?? null });
		});

		return () => {
			cancelled = true;
			Editor.trail.clear();
			settle.cancel();
			offStatus();
			offLock();
			offPov();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- initialize the pano once per opening, not on draft updates
	}, [pano, layer, hasLocation]);
}
