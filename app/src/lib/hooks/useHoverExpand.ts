import { useEffect, useRef, useState, type RefObject } from "react";
import type React from "react";
import { useDomEvent } from "./useDomEvent";

/** Short edge of the display the `base` sizes are authored against. */
const BASELINE_SHORT_EDGE = 1080;

/** An expanded panel dimension: a px floor that grows with the viewport's short edge.
 *  `base` is the size at scale 1 on a baseline display. */
export function panelSize(base: number, scale: number): string {
	const vmin = ((base / BASELINE_SHORT_EDGE) * scale * 100).toFixed(2);
	return `max(${Math.round(base * scale)}px, ${vmin}vmin)`;
}

/**
 * Hover-to-expand panel state. A drag that starts inside the panel holds it open until the
 * release, which then decides: still inside stays open, outside closes after the usual
 * delay. Leaving mid-drag can't be trusted either way -- the dragged surface captures the
 * pointer, so pointerleave fires late, or never.
 */
export function useHoverExpand(ref: RefObject<HTMLElement | null>, closeDelay: number) {
	const [expanded, setExpanded] = useState(false);
	const closeTimer = useRef<number | null>(null);
	const dragging = useRef(false);

	const open = () => {
		if (closeTimer.current !== null) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		setExpanded(true);
	};

	const scheduleClose = () => {
		if (dragging.current) return;
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		closeTimer.current = window.setTimeout(() => {
			setExpanded(false);
			closeTimer.current = null;
		}, closeDelay);
	};

	useDomEvent("pointerup", (e) => {
		dragging.current = false;
		const el = ref.current;
		if (!expanded || !el) return;
		const { clientX, clientY } = e as PointerEvent;
		const r = el.getBoundingClientRect();
		const inside =
			clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
		if (!inside) scheduleClose();
	});

	useEffect(() => {
		return () => {
			if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		};
	}, []);

	return {
		expanded,
		hoverProps: {
			// Panning the pano across the map must not expand it, same as the basemap menu.
			onPointerEnter: (e: React.PointerEvent) => {
				if (e.buttons === 0) open();
			},
			onPointerLeave: scheduleClose,
			onPointerDown: () => {
				dragging.current = true;
			},
		},
	};
}
