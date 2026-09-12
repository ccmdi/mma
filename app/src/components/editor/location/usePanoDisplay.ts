import { useEffect, useLayoutEffect, type RefObject } from "react";
import { useSettings, getSettings, panoDisplayOptions } from "@/store/settings";
import { usePanoEvent } from "@/lib/hooks/usePanoEvent";
import { pano } from "@/lib/sv/pano";
import { sendHideCar } from "./PanoControls";

/** Keeps the pano presentable: display options follow settings, the car and
 *  crosshair overlays follow theirs, its persistent div is parented into the live
 *  container, and it redraws whenever its box changes. */
export function usePanoDisplay(
	panoContainerRef: RefObject<HTMLDivElement | null>,
	chipMode: boolean,
) {
	const appSettings = useSettings();

	useEffect(() => {
		pano.configure(panoDisplayOptions(getSettings()));
	}, [
		appSettings.showLinksControl,
		appSettings.clickToGo,
		appSettings.showRoadLabels,
		appSettings.defaultMovementMode,
		appSettings.hidePanoUI,
		appSettings.hideNavWithUI,
	]);

	usePanoEvent("status_changed", () => sendHideCar(!appSettings.showCar), [appSettings.showCar]);

	useEffect(() => {
		if (!appSettings.showCrosshair) return;
		return pano.showCrosshair();
	}, [appSettings.showCrosshair]);

	// Mount/unmount: move the persistent div in/out of the container.
	// useLayoutEffect so appendChild runs before paint.
	useLayoutEffect(() => {
		const container = panoContainerRef.current;
		if (!container) return;
		return pano.mount(container);
	}, [chipMode]);
}
