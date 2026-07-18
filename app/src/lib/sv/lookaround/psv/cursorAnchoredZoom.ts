/**
 * Cursor-anchored wheel zoom for Photo Sphere Viewer.
 * Keeps the spherical point under the pointer fixed while FOV changes
 * (GSV-style), instead of PSV's default center-only zoom.
 */

type Spherical = { yaw: number; pitch: number };

type ZoomViewer = {
	container: HTMLElement;
	config: { zoomSpeed?: number; mousewheelCtrlKey?: boolean };
	dataHelper: {
		viewerCoordsToSphericalCoords: (p: { x: number; y: number }) => Spherical | null;
	};
	getZoomLevel: () => number;
	getPosition: () => Spherical;
	zoom: (level: number) => void;
	rotate: (pos: Spherical) => void;
	destroy: () => void;
};

const TWO_PI = Math.PI * 2;

function shortestArc(from: number, to: number): number {
	let d = to - from;
	while (d > Math.PI) d -= TWO_PI;
	while (d < -Math.PI) d += TWO_PI;
	return d;
}

/**
 * Replace PSV's center-only mousewheel with cursor-anchored zoom.
 * Call once after Viewer construction; cleans up on `viewer.destroy()`.
 */
export function installCursorAnchoredZoom(viewer: ZoomViewer): void {
	const onWheel = (evt: WheelEvent) => {
		if (!evt.deltaY) return;
		if (viewer.config.mousewheelCtrlKey && !evt.ctrlKey && !evt.metaKey) return;

		evt.preventDefault();
		evt.stopPropagation();

		const rect = viewer.container.getBoundingClientRect();
		const point = { x: evt.clientX - rect.left, y: evt.clientY - rect.top };

		const anchor = viewer.dataHelper.viewerCoordsToSphericalCoords(point);
		const speed = viewer.config.zoomSpeed ?? 1;
		const step = -(evt.deltaY / Math.abs(evt.deltaY)) * 5 * speed;
		const oldZoom = viewer.getZoomLevel();
		const newZoom = Math.max(0, Math.min(100, oldZoom + step));
		if (newZoom === oldZoom) return;

		viewer.zoom(newZoom);

		// No sphere hit (e.g. outside mesh) — fall back to center zoom only.
		if (!anchor) return;

		// One or two corrections: after FOV change the point under the cursor
		// drifts; pan so `anchor` stays under the pointer.
		for (let i = 0; i < 2; i++) {
			const under = viewer.dataHelper.viewerCoordsToSphericalCoords(point);
			if (!under) break;
			const center = viewer.getPosition();
			viewer.rotate({
				yaw: center.yaw + shortestArc(under.yaw, anchor.yaw),
				pitch: center.pitch + (anchor.pitch - under.pitch),
			});
		}
	};

	viewer.container.addEventListener("wheel", onWheel, { passive: false, capture: true });

	const origDestroy = viewer.destroy.bind(viewer);
	viewer.destroy = () => {
		viewer.container.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
		origDestroy();
	};
}
