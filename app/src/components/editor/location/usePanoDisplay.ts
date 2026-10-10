import { useCallback, useEffect, type RefObject } from "react";
import { useSettings, getSettings, panoDisplayOptions } from "@/store/settings";
import { usePano, usePanoEvent } from "@/lib/hooks/usePano";
import { sendHideCar } from "./PanoControls";

/** Apply pano display settings and overlays, and attach the persistent viewer to its container. */
export function usePanoDisplay(panoContainerRef: RefObject<HTMLDivElement | null>) {
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

	// A ref, not an effect: a container that remounts must take the pano with it.
	return useCallback(
		(container: HTMLDivElement | null) => {
			panoContainerRef.current = container;
			if (!container) return;
			const unmount = pano.mount(container);
			return () => {
				unmount();
				panoContainerRef.current = null;
			};
		},
		[pano, panoContainerRef],
	);
}
