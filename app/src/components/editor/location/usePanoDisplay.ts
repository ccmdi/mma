import { useEffect, useLayoutEffect, type RefObject } from "react";
import { useSettings, getSettings, panoDisplayOptions } from "@/store/settings";
import { usePano, usePanoEvent } from "@/lib/hooks/usePano";
import { sendHideCar } from "./PanoControls";

/** Keeps the pano presentable: display options follow settings, the car and
 *  crosshair overlays follow theirs, its persistent div is parented into the live
 *  container, and it redraws whenever its box changes. */
export function usePanoDisplay(
	panoContainerRef: RefObject<HTMLDivElement | null>,
	chipMode: boolean,
) {
	const appSettings = useSettings();
	const pano = usePano();

	useEffect(() => {
		pano.configure(panoDisplayOptions(getSettings()));
	}, [
		pano,
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
	}, [pano, appSettings.showCrosshair]);

	// Mount/unmount: move the persistent div in/out of the container.
	// useLayoutEffect so appendChild runs before paint.
	useLayoutEffect(() => {
		const container = panoContainerRef.current;
		if (!container) return;
		return pano.mount(container);
	}, [pano, chipMode]);
}
