// The generator's own deck.gl overlay for the search-coverage "fog of war".
// Mirrors the heatmap plugin: get the map host, stack our own deck overlay on
// it, render into it, tear it down on deactivate. Core is never touched.
import { BitmapLayer } from "@deck.gl/layers";
import type { DeckOverlayHandle } from "@/lib/map/host";
import { subscribe, getCoverageImage } from "./searchCoverage";

let overlay: DeckOverlayHandle | null = null;

function redraw(): void {
	const data = getCoverageImage();
	if (!data) {
		// Fully tear down: an idle deck overlay still renders every map frame and
		// keeps the last texture alive, dragging fps long after coverage is cleared.
		if (overlay) {
			overlay.finalize();
			overlay = null;
		}
		return;
	}
	if (!overlay) {
		const host = MMA.MapHost.get();
		if (!host) return; // no map yet; the next probe's redraw will retry
		overlay = host.createDeckOverlay();
	}
	overlay.setProps({
		layers: [
			new BitmapLayer({
				id: "mma-generator-coverage",
				image: data.image,
				bounds: data.bounds,
				opacity: 0.35,
				pickable: false,
				_imageCoordinateSystem: "lnglat" as const,
			}),
		],
	});
}

/** Mount the plugin's own coverage overlay. Returns a teardown for activate()'s cleanup. */
export function mountCoverageOverlay(): () => void {
	const unsub = subscribe(redraw);
	redraw();
	return () => {
		unsub();
		if (overlay) {
			overlay.finalize();
			overlay = null;
		}
	};
}
