import type { LatLng } from "@/types";
import { MapHost } from "@/lib/map/mapHost";
import { latLngToWorld } from "@/lib/geo/mercator";
import { unwrapLng } from "@/lib/geo/geo";
import { isEditableElement, pluginOverlayOwnsInput } from "@/lib/hooks/useHotkey";

/** Screen-pixel hit radius of a placed node -- also its drawn radius, so what you see is
 *  what you can grab. */
export const NODE_PX = 6;

// A press on a node that never travels past this many pixels is a click, which deletes it.
const CLICK_SLOP_PX = 3;

/** Screen-pixel distance between `ll` and a placed `[lng, lat]` node, unwrapped so an
 *  antimeridian seam between them doesn't separate them in world space. */
export function nodeDistancePx(host: MapHost, ll: LatLng, [lng, lat]: number[]): number {
	const scale = 2 ** host.getZoom();
	const a = latLngToWorld({ lat: ll.lat, lng: unwrapLng(ll.lng, lng) });
	const b = latLngToWorld({ lat, lng });
	return Math.hypot((a.x - b.x) * scale, (a.y - b.y) * scale);
}

/** Map clicks belong to the armed tool: `handle` sees them and none reaches the map.
 *  The engine raises its own click after a stroke, from its map object
 *  rather than the DOM, so stopping DOM propagation cannot reach it and the claim instead
 *  outlives the tool by one click. That click carries no mousedown of its own, so a real
 *  gesture releases the claim before its click lands. */
export function claimClicks(
	handle?: (lat: number, lng: number, shiftKey: boolean) => void,
): () => void {
	let lingering = false;
	let off: (() => void) | null = null;
	const release = () => {
		off?.();
		off = null;
		window.removeEventListener("mousedown", release, true);
		window.removeEventListener("pointerdown", release, true);
	};
	off = MapHost.addClickInterceptor((lat, lng, shiftKey) => {
		if (lingering) release();
		else handle?.(lat, lng, shiftKey);
		return true;
	});
	return () => {
		if (!off) return;
		lingering = true;
		window.addEventListener("mousedown", release, true);
		window.addEventListener("pointerdown", release, true);
	};
}

export interface NodePathSpec {
	points: () => readonly number[][];
	/** Whether node `index` can be grabbed (moved on drag, removed on click). */
	grabbable?: (index: number) => boolean;
	add: (ll: LatLng) => void;
	move: (index: number, ll: LatLng) => void;
	remove: (index: number) => void;
	cursor?: (ll: LatLng) => void;
	cancel: () => void;
}

/** Bind the shared node-path interaction: click to place a node, drag a node to move it,
 *  click a node or press Backspace to remove one, Escape to cancel. */
export function bindNodePath(host: MapHost, spec: NodePathSpec): () => void {
	let dragIndex: number | null = null;
	let suppressClick = false;

	const hitNode = (ll: LatLng): number | null => {
		const pts = spec.points();
		const i = pts.findLastIndex(
			(pt, idx) => (spec.grabbable?.(idx) ?? true) && nodeDistancePx(host, ll, pt) <= NODE_PX,
		);
		return i === -1 ? null : i;
	};

	const releaseClicks = claimClicks((lat, lng) => {
		if (suppressClick) suppressClick = false;
		else spec.add({ lat, lng });
	});

	// Raw DOM events, not host events: the engine's gesture handler stops emitting map
	// mousemove the instant a button goes down, which strands dragged nodes and preview lines.
	const div = host.container;
	const at = (e: MouseEvent): LatLng | null => {
		const r = div.getBoundingClientRect();
		return host.containerPxToLatLng(e.clientX - r.left, e.clientY - r.top);
	};

	// Panning is disabled on hover rather than on press: by mousedown the engine has
	// already claimed the gesture and won't give it up.
	let armed = false;
	const arm = (v: boolean) => {
		if (armed === v) return;
		armed = v;
		host.setDraggable(!v);
		host.setCursor(v ? "pointer" : null);
	};

	let pressedAt: { x: number; y: number } | null = null;

	const onDown = (e: PointerEvent) => {
		// A drag's click doesn't always fire (the engine drops it after real movement);
		// a new gesture starting means the stale flag must not eat this one's click.
		suppressClick = false;
		if (e.button !== 0) return;
		const ll = at(e);
		dragIndex = ll ? hitNode(ll) : null;
		pressedAt = { x: e.clientX, y: e.clientY };
	};

	const onMove = (e: MouseEvent) => {
		const ll = at(e);
		if (!ll) return;
		if (dragIndex === null) {
			arm(hitNode(ll) !== null);
			spec.cursor?.(ll);
			return;
		}
		if (pressedAt) {
			if (Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) <= CLICK_SLOP_PX) return;
			pressedAt = null;
		}
		spec.move(dragIndex, ll);
		spec.cursor?.(ll);
	};

	const onUp = (e: PointerEvent) => {
		if (dragIndex === null) return;
		if (pressedAt) {
			spec.remove(dragIndex);
			const ll = at(e);
			if (ll) arm(hitNode(ll) !== null);
		}
		dragIndex = null;
		pressedAt = null;
		suppressClick = true;
	};

	// Bubble phase: an Escape aimed at something above us (dialogs preventDefault in
	// capture, open inputs stopPropagation) must not also discard the path.
	const onKey = (e: KeyboardEvent) => {
		if (e.defaultPrevented || pluginOverlayOwnsInput()) return;
		if (e.key === "Escape") {
			e.preventDefault();
			spec.cancel();
			return;
		}
		if (
			e.key === "Backspace" &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			!isEditableElement(e.target)
		) {
			const n = spec.points().length;
			if (n > 0) {
				e.preventDefault();
				spec.remove(n - 1);
			}
		}
	};

	const ac = new AbortController();
	const { signal } = ac;
	div.addEventListener("pointerdown", onDown, { signal });
	window.addEventListener("pointermove", onMove, { signal });
	window.addEventListener("pointerup", onUp, { signal });
	document.addEventListener("keydown", onKey, { signal });

	return () => {
		releaseClicks();
		ac.abort();
		dragIndex = null;
		if (armed) {
			host.setDraggable(true);
			host.setCursor(null);
		}
	};
}
