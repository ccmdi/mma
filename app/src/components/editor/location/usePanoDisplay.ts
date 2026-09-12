import { useEffect, useLayoutEffect, type RefObject } from "react";
import { useSettings, getSettings, panoDisplayOptions } from "@/store/settings";
import { usePanoEvent } from "@/lib/hooks/usePanoEvent";
import { google } from "@/lib/sv/opensv";
import { singletonPano, singletonDiv } from "@/lib/sv/panoSingleton";
import { CrosshairOverlay, sendHideCar } from "./PanoControls";

/** Keeps the singleton pano presentable: display options follow settings, the car and
 *  crosshair overlays follow theirs, its persistent div is parented into the live
 *  container, and it redraws whenever its box changes. */
export function usePanoDisplay(
	panoContainerRef: RefObject<HTMLDivElement | null>,
	chipMode: boolean,
) {
	const appSettings = useSettings();

	useEffect(() => {
		if (!singletonPano) return;
		singletonPano.setOptions(panoDisplayOptions(getSettings()));
	}, [
		appSettings.showLinksControl,
		appSettings.clickToGo,
		appSettings.showRoadLabels,
		appSettings.defaultMovementMode,
		appSettings.hidePanoUI,
		appSettings.hideNavWithUI,
	]);

	usePanoEvent(singletonPano, "status_changed", () => sendHideCar(!appSettings.showCar), [
		appSettings.showCar,
	]);

	useEffect(() => {
		if (!singletonPano || !appSettings.showCrosshair) return;
		const overlay = new CrosshairOverlay(singletonPano);
		return () => overlay.dispose();
	}, [appSettings.showCrosshair]);

	// Mount/unmount: move the persistent div in/out of the container.
	// useLayoutEffect so appendChild runs before paint.
	useLayoutEffect(() => {
		const container = panoContainerRef.current;
		if (!container) return;
		container.appendChild(singletonDiv);
		if (singletonPano && google?.maps) google.maps.event.trigger(singletonPano, "resize");
		return () => {
			if (container.contains(singletonDiv)) container.removeChild(singletonDiv);
		};
	}, [chipMode]);

	// The pano redraws whenever its box changes, whatever changed the box; at most once a frame.
	useEffect(() => {
		const el = panoContainerRef.current;
		if (!el) return;
		let raf = 0;
		const obs = new ResizeObserver(() => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				if (singletonPano && google?.maps) google.maps.event.trigger(singletonPano, "resize");
			});
		});
		obs.observe(el);
		return () => {
			obs.disconnect();
			cancelAnimationFrame(raf);
		};
	}, [chipMode]);
}
