import { useEffect, useRef, useState, useEffectEvent } from "react";
import { google } from "@/lib/sv/opensv";
import { Icon, polygonOutline, rectangleOutline } from "@/components/primitives/Icon";
import { mdiPencil } from "@mdi/js";

type DrawMode = "polygon" | "rectangle" | "freehand" | null;

function perpDist(p: number[], a: number[], b: number[]): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplify(pts: number[][], eps: number): number[][] {
	if (pts.length <= 2) return pts;
	let maxD = 0,
		maxI = 0;
	for (let i = 1; i < pts.length - 1; i++) {
		const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
		if (d > maxD) {
			maxD = d;
			maxI = i;
		}
	}
	if (maxD > eps) {
		const l = simplify(pts.slice(0, maxI + 1), eps);
		const r = simplify(pts.slice(maxI), eps);
		return [...l.slice(0, -1), ...r];
	}
	return [pts[0], pts[pts.length - 1]];
}

export function PolygonTools({
	map,
	onDraw,
	freehandPathRef,
	requestOverlayUpdate,
}: {
	map: google.maps.Map | null;
	onDraw: (rings: number[][][]) => void;
	freehandPathRef: React.RefObject<number[][] | null>;
	requestOverlayUpdate: () => void;
}) {
	const [mode, setMode] = useState<DrawMode>(null);
	const managerRef = useRef<google.maps.drawing.DrawingManager>(null);
	const isDrawingRef = useRef(false);
	const emitDraw = useEffectEvent((rings: number[][][]) => onDraw(rings));
	const emitUpdate = useEffectEvent(() => requestOverlayUpdate());

	useEffect(() => {
		if (!map) return;
		if (!google?.maps) return;

		let cancelled = false;
		let listener: google.maps.MapsEventListener | null = null;
		let dm: google.maps.drawing.DrawingManager | null = null;

		(async () => {
			try {
				await google.maps.importLibrary("drawing");
			} catch {
				return;
			}
			if (cancelled || !google.maps.drawing?.DrawingManager) return;

			dm = new google.maps.drawing.DrawingManager({
				drawingControl: false,
				polygonOptions: { editable: true },
			});
			dm.setMap(map);
			managerRef.current = dm;

			listener = google.maps.event.addListener(
				dm,
				"overlaycomplete",
				(e: google.maps.drawing.OverlayCompleteEvent) => {
					const Ym = google.maps.drawing.OverlayType;
					e.overlay?.setMap(null);
					dm!.setDrawingMode(null);
					setMode(null);

					if (e.type === Ym.POLYGON) {
						const path = (e.overlay as google.maps.Polygon).getPath().getArray();
						const ring = path.map((ll) => [ll.lng(), ll.lat()]);
						if (ring.length > 0) {
							const first = ring[0];
							const last = ring[ring.length - 1];
							if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
						}
						emitDraw([ring]);
					} else if (e.type === Ym.RECTANGLE) {
						const b = (e.overlay as google.maps.Rectangle).getBounds()!.toJSON();
						let east = b.east;
						const west = b.west;
						if (east < west) east += 360;
						const ring = [
							[west, b.south],
							[east, b.south],
							[east, b.north],
							[west, b.north],
							[west, b.south],
						];
						emitDraw([ring]);
					}
				},
			);
		})();

		return () => {
			cancelled = true;
			if (listener) google.maps.event.removeListener(listener);
			if (dm) dm.setMap(null);
			managerRef.current = null;
		};
	}, [map]);

	useEffect(() => {
		const dm = managerRef.current;
		if (!dm) return;
		const Ym = google?.maps?.drawing?.OverlayType;
		if (!Ym) return;
		if (mode === "polygon") dm.setDrawingMode(Ym.POLYGON);
		else if (mode === "rectangle") dm.setDrawingMode(Ym.RECTANGLE);
		else dm.setDrawingMode(null);
	}, [mode]);

	useEffect(() => {
		if (!map || mode !== "freehand") return;
		if (!google?.maps) return;

		map.setOptions({ draggable: false });
		const points: number[][] = [];

		const down = google.maps.event.addListener(map, "mousedown", (e: google.maps.MapMouseEvent) => {
			if (!e.latLng) return;
			isDrawingRef.current = true;
			points.length = 0;
			points.push([e.latLng.lng(), e.latLng.lat()]);
			freehandPathRef.current = points;
			emitUpdate();
		});

		const move = google.maps.event.addListener(map, "mousemove", (e: google.maps.MapMouseEvent) => {
			if (!isDrawingRef.current || !e.latLng) return;
			points.push([e.latLng.lng(), e.latLng.lat()]);
			emitUpdate();
		});

		const up = google.maps.event.addListener(map, "mouseup", () => {
			if (!isDrawingRef.current) return;
			isDrawingRef.current = false;
			freehandPathRef.current = null;
			emitUpdate();

			if (points.length < 3) return;

			const simplified = simplify(points, 0.0001);
			const first = simplified[0];
			const last = simplified[simplified.length - 1];
			if (first[0] !== last[0] || first[1] !== last[1]) {
				simplified.push([first[0], first[1]]);
			}

			setMode(null);
			emitDraw([simplified]);
		});

		return () => {
			google.maps.event.removeListener(down);
			google.maps.event.removeListener(move);
			google.maps.event.removeListener(up);
			map.setOptions({ draggable: true });
			isDrawingRef.current = false;
			freehandPathRef.current = null;
		};
	}, [map, mode, freehandPathRef]);

	return (
		<div className="map-control map-control--button white">
			<button
				type="button"
				onClick={() => setMode((m) => (m === "polygon" ? null : "polygon"))}
				className={mode === "polygon" ? "is-active" : undefined}
				aria-label="Draw a polygon selection"
			>
				<Icon path={polygonOutline} />
			</button>
			<button
				type="button"
				onClick={() => setMode((m) => (m === "rectangle" ? null : "rectangle"))}
				className={mode === "rectangle" ? "is-active" : undefined}
				aria-label="Draw a rectangle selection"
			>
				<Icon path={rectangleOutline} />
			</button>
			<button
				type="button"
				onClick={() => setMode((m) => (m === "freehand" ? null : "freehand"))}
				className={mode === "freehand" ? "is-active" : undefined}
				aria-label="Freehand polygon selection"
			>
				<Icon path={mdiPencil} />
			</button>
		</div>
	);
}
