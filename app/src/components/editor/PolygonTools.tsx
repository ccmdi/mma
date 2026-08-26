import { useEffect, useState, useEffectEvent } from "react";
import { Icon, polygonOutline, rectangleOutline } from "@/components/primitives/Icon";
import { mdiPencil } from "@mdi/js";
import type { MapHost } from "@/lib/map/host";
import { addClickInterceptor } from "@/lib/map/mapState";
import { latLngToWorld } from "@/lib/geo/mercator";
import { densifyRing, unwrapLng } from "@/lib/geo/geo";
import { POLYGON_CLOSE_VERTEX_PX } from "@/lib/render/buildSceneLayers";
import { clamp } from "@/types/util";
import type { LatLng } from "@/types";
import { t } from "@/lib/i18n";

type DrawMode = "polygon" | "rectangle" | "freehand" | null;

function perpDist(p: number[], a: number[], b: number[]): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq, 0, 1);
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

/** Close the ring and split any edge of 180 degrees or more so `unwrapRing` can't fold it. */
function finishRing(ring: number[][]): number[][] {
	if (ring.length === 0) return ring;
	const first = ring[0];
	const last = ring[ring.length - 1];
	const closed =
		first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [first[0], first[1]]];
	return densifyRing(closed);
}

/** Take the primary-button drag away from the engine so it draws instead of panning.
 *  Only that gesture is claimed: the engine's `draggable` flag would resolve to
 *  gestureHandling "none" and take wheel zoom and the keyboard with it. Clicks are
 *  swallowed too, so a stroke can't also place a marker or double-click-zoom. */
function claimDrag(
	host: MapHost,
	on: { down: (ll: LatLng) => void; move: (ll: LatLng) => void; up: (ll: LatLng) => void },
): () => void {
	const div = host.container;
	const at = (e: MouseEvent): LatLng | null => {
		const r = div.getBoundingClientRect();
		return host.containerPxToLatLng(e.clientX - r.left, e.clientY - r.top);
	};
	let last: LatLng | null = null;
	const swallow = (e: Event) => e.stopPropagation();
	const onDown = (e: MouseEvent) => {
		if (e.button !== 0) return;
		swallow(e);
		e.preventDefault();
		const ll = at(e);
		if (!ll) return;
		last = ll;
		on.down(ll);
	};
	const onMove = (e: MouseEvent) => {
		if (!last) return;
		const ll = at(e);
		if (!ll) return;
		last = ll;
		on.move(ll);
	};
	const onUp = (e: MouseEvent) => {
		if (!last) return;
		const ll = at(e) ?? last;
		last = null;
		on.up(ll);
	};
	const ac = new AbortController();
	const { signal } = ac;
	// Capture phase: the engine's own handlers sit on inner elements and never see these.
	const capture = { capture: true, signal };
	div.addEventListener("mousedown", onDown, capture);
	div.addEventListener("click", swallow, capture);
	div.addEventListener("dblclick", swallow, capture);
	// On window, so a stroke that runs past the map edge keeps tracking.
	window.addEventListener("mousemove", onMove, { signal });
	window.addEventListener("mouseup", onUp, { signal });
	return () => ac.abort();
}

export function PolygonTools({
	host,
	onDraw,
	freehandPathRef,
	polygonVerticesRef,
	requestOverlayUpdate,
}: {
	host: MapHost | null;
	onDraw: (rings: number[][][]) => void;
	freehandPathRef: React.RefObject<number[][] | null>;
	polygonVerticesRef: React.RefObject<number[][] | null>;
	requestOverlayUpdate: () => void;
}) {
	const [mode, setMode] = useState<DrawMode>(null);
	const emitDraw = useEffectEvent((rings: number[][][]) => onDraw(rings));
	const emitUpdate = useEffectEvent(() => requestOverlayUpdate());

	// Freehand: one primary-button stroke.
	useEffect(() => {
		if (!host || mode !== "freehand") return;

		const points: number[][] = [];
		const off = claimDrag(host, {
			down: (ll) => {
				points.length = 0;
				points.push([ll.lng, ll.lat]);
				freehandPathRef.current = points;
				emitUpdate();
			},
			move: (ll) => {
				// Host longitudes are normalized; unwrap so a seam crossing isn't a jump.
				points.push([unwrapLng(ll.lng, points[points.length - 1][0]), ll.lat]);
				emitUpdate();
			},
			up: () => {
				freehandPathRef.current = null;
				emitUpdate();
				if (points.length < 3) return;
				const simplified = simplify(points, 0.0001);
				setMode(null);
				emitDraw([finishRing(simplified)]);
			},
		});

		return () => {
			off();
			freehandPathRef.current = null;
		};
	}, [host, mode, freehandPathRef]);

	// Click-vertex polygon (click the first vertex or double-click to close, Escape cancels).
	useEffect(() => {
		if (!host || mode !== "polygon") return;

		const points: number[][] = [];
		let cursor: number[] | null = null;

		const preview = () => {
			freehandPathRef.current =
				points.length > 0 ? (cursor ? [...points, cursor] : [...points]) : null;
			polygonVerticesRef.current = points.length > 0 ? [...points] : null;
			emitUpdate();
		};
		const finish = (commit: boolean) => {
			const ring = [...points];
			points.length = 0;
			cursor = null;
			freehandPathRef.current = null;
			polygonVerticesRef.current = null;
			emitUpdate();
			setMode(null);
			if (commit && ring.length >= 3) emitDraw([finishRing(ring)]);
		};

		const nextVertex = (lng: number, lat: number): number[] => {
			const prev = points[points.length - 1];
			return [prev ? unwrapLng(lng, prev[0]) : lng, lat];
		};

		const offClick = addClickInterceptor((lat, lng) => {
			const v = nextVertex(lng, lat);
			if (points.length >= 3) {
				const start = points[0];
				const scale = 2 ** host.getZoom();
				const a = latLngToWorld({ lat, lng: unwrapLng(lng, start[0]) });
				const b = latLngToWorld({ lat: start[1], lng: start[0] });
				if (Math.hypot((a.x - b.x) * scale, (a.y - b.y) * scale) <= POLYGON_CLOSE_VERTEX_PX) {
					finish(true);
					return true;
				}
			}
			const prev = points[points.length - 1];
			if (!prev || prev[0] !== v[0] || prev[1] !== v[1]) points.push(v);
			preview();
			return true;
		});
		const offMove = host.on("mousemove", (ll) => {
			cursor = nextVertex(ll.lng, ll.lat);
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
			polygonVerticesRef.current = null;
			emitUpdate();
		};
	}, [host, mode, freehandPathRef, polygonVerticesRef]);

	// Drag rectangle.
	useEffect(() => {
		if (!host || mode !== "rectangle") return;

		let anchor: number[] | null = null;
		// Accumulated across mousemove so the drag's width and direction survive the seam.
		let cursorLng = 0;

		const rectRing = (a: number[], b: number[]) =>
			finishRing([
				[a[0], a[1]],
				[b[0], a[1]],
				[b[0], b[1]],
				[a[0], b[1]],
			]);

		const off = claimDrag(host, {
			down: (ll) => {
				anchor = [ll.lng, ll.lat];
				cursorLng = ll.lng;
			},
			move: (ll) => {
				if (!anchor) return;
				cursorLng = unwrapLng(ll.lng, cursorLng);
				freehandPathRef.current = rectRing(anchor, [cursorLng, ll.lat]);
				emitUpdate();
			},
			up: (ll) => {
				if (!anchor) return;
				cursorLng = unwrapLng(ll.lng, cursorLng);
				const ring = rectRing(anchor, [cursorLng, ll.lat]);
				const degenerate = cursorLng === anchor[0] || ll.lat === anchor[1];
				anchor = null;
				freehandPathRef.current = null;
				emitUpdate();
				setMode(null);
				if (!degenerate) emitDraw([ring]);
			},
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
			off();
			document.removeEventListener("keydown", onKey, true);
			freehandPathRef.current = null;
		};
	}, [host, mode, freehandPathRef]);

	return (
		<div className="map-control map-control--button white">
			<button
				type="button"
				onClick={() => setMode((m) => (m === "polygon" ? null : "polygon"))}
				className={mode === "polygon" ? "is-active" : undefined}
				aria-label={t("Draw a polygon selection")}
			>
				<Icon path={polygonOutline} />
			</button>
			<button
				type="button"
				onClick={() => setMode((m) => (m === "rectangle" ? null : "rectangle"))}
				className={mode === "rectangle" ? "is-active" : undefined}
				aria-label={t("Draw a rectangle selection")}
			>
				<Icon path={rectangleOutline} />
			</button>
			<button
				type="button"
				onClick={() => setMode((m) => (m === "freehand" ? null : "freehand"))}
				className={mode === "freehand" ? "is-active" : undefined}
				aria-label={t("Freehand polygon selection")}
			>
				<Icon path={mdiPencil} />
			</button>
		</div>
	);
}
