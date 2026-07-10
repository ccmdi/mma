import { useEffect, useRef, useState, useEffectEvent } from "react";
import { google } from "@/lib/sv/opensv";
import { Icon, polygonOutline, rectangleOutline } from "@/components/primitives/Icon";
import { mdiPencil } from "@mdi/js";
import { hostInstance, type MapHost } from "@/lib/map/host";
import { addClickInterceptor } from "@/lib/map/mapState";

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

function closeRing(ring: number[][]): number[][] {
	if (ring.length === 0) return ring;
	const first = ring[0];
	const last = ring[ring.length - 1];
	if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, [first[0], first[1]]];
	return ring;
}

export function PolygonTools({
	host,
	onDraw,
	freehandPathRef,
	requestOverlayUpdate,
}: {
	host: MapHost | null;
	onDraw: (rings: number[][][]) => void;
	freehandPathRef: React.RefObject<number[][] | null>;
	requestOverlayUpdate: () => void;
}) {
	const [mode, setMode] = useState<DrawMode>(null);
	const managerRef = useRef<google.maps.drawing.DrawingManager>(null);
	const isDrawingRef = useRef(false);
	const emitDraw = useEffectEvent((rings: number[][][]) => onDraw(rings));
	const emitUpdate = useEffectEvent(() => requestOverlayUpdate());
	const gMap = hostInstance(host, "google");

	// Google host: polygon/rectangle via the native DrawingManager (editable rubber band).
	useEffect(() => {
		if (!gMap) return;
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
			dm.setMap(gMap);
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
						if (ring.length > 0) emitDraw([closeRing(ring)]);
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
	}, [gMap]);

	useEffect(() => {
		if (!gMap) return;
		const dm = managerRef.current;
		if (!dm) return;
		const Ym = google?.maps?.drawing?.OverlayType;
		if (!Ym) return;
		if (mode === "polygon") dm.setDrawingMode(Ym.POLYGON);
		else if (mode === "rectangle") dm.setDrawingMode(Ym.RECTANGLE);
		else dm.setDrawingMode(null);
	}, [gMap, mode]);

	// All hosts: freehand via host events.
	useEffect(() => {
		if (!host || mode !== "freehand") return;

		host.setDraggable(false);
		const points: number[][] = [];

		const offDown = host.on("mousedown", (ll) => {
			isDrawingRef.current = true;
			points.length = 0;
			points.push([ll.lng, ll.lat]);
			freehandPathRef.current = points;
			emitUpdate();
		});

		const offMove = host.on("mousemove", (ll) => {
			if (!isDrawingRef.current) return;
			points.push([ll.lng, ll.lat]);
			emitUpdate();
		});

		const offUp = host.on("mouseup", () => {
			if (!isDrawingRef.current) return;
			isDrawingRef.current = false;
			freehandPathRef.current = null;
			emitUpdate();

			if (points.length < 3) return;

			const simplified = simplify(points, 0.0001);
			setMode(null);
			emitDraw([closeRing(simplified)]);
		});

		return () => {
			offDown();
			offMove();
			offUp();
			host.setDraggable(true);
			isDrawingRef.current = false;
			freehandPathRef.current = null;
		};
	}, [host, mode, freehandPathRef]);

	// Non-Google hosts: click-vertex polygon (double-click closes, Escape cancels).
	useEffect(() => {
		if (!host || gMap || mode !== "polygon") return;

		const points: number[][] = [];
		let cursor: number[] | null = null;

		const preview = () => {
			freehandPathRef.current =
				points.length > 0 ? (cursor ? [...points, cursor] : [...points]) : null;
			emitUpdate();
		};
		const finish = (commit: boolean) => {
			const ring = [...points];
			points.length = 0;
			cursor = null;
			freehandPathRef.current = null;
			emitUpdate();
			setMode(null);
			if (commit && ring.length >= 3) emitDraw([closeRing(ring)]);
		};

		const offClick = addClickInterceptor((lat, lng) => {
			const prev = points[points.length - 1];
			if (!prev || prev[0] !== lng || prev[1] !== lat) points.push([lng, lat]);
			preview();
			return true;
		});
		const offMove = host.on("mousemove", (ll) => {
			cursor = [ll.lng, ll.lat];
			if (points.length > 0) preview();
		});
		const onDblClick = (e: MouseEvent) => {
			e.preventDefault();
			finish(true);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") finish(false);
		};
		host.setDoubleClickZoom(false);
		host.container.addEventListener("dblclick", onDblClick, true);
		document.addEventListener("keydown", onKey, true);

		return () => {
			offClick();
			offMove();
			host.container.removeEventListener("dblclick", onDblClick, true);
			document.removeEventListener("keydown", onKey, true);
			host.setDoubleClickZoom(true);
			freehandPathRef.current = null;
			emitUpdate();
		};
	}, [host, gMap, mode, freehandPathRef]);

	// Non-Google hosts: drag rectangle.
	useEffect(() => {
		if (!host || gMap || mode !== "rectangle") return;

		host.setDraggable(false);
		let anchor: number[] | null = null;

		const rectRing = (a: number[], b: number[]) => [
			[a[0], a[1]],
			[b[0], a[1]],
			[b[0], b[1]],
			[a[0], b[1]],
			[a[0], a[1]],
		];

		const offDown = host.on("mousedown", (ll) => {
			anchor = [ll.lng, ll.lat];
		});
		const offMove = host.on("mousemove", (ll) => {
			if (!anchor) return;
			freehandPathRef.current = rectRing(anchor, [ll.lng, ll.lat]);
			emitUpdate();
		});
		const offUp = host.on("mouseup", (ll) => {
			if (!anchor) return;
			const ring = rectRing(anchor, [ll.lng, ll.lat]);
			anchor = null;
			freehandPathRef.current = null;
			emitUpdate();
			setMode(null);
			if (ring[0][0] !== ring[1][0] && ring[0][1] !== ring[2][1]) emitDraw([ring]);
		});
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				anchor = null;
				freehandPathRef.current = null;
				emitUpdate();
				setMode(null);
			}
		};
		document.addEventListener("keydown", onKey, true);

		return () => {
			offDown();
			offMove();
			offUp();
			document.removeEventListener("keydown", onKey, true);
			host.setDraggable(true);
			freehandPathRef.current = null;
		};
	}, [host, gMap, mode, freehandPathRef]);

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
