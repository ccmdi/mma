import { useCallback, useRef } from "react";

/** One pickup of an item, from the moment the pointer moves far enough to count as a drag. */
export interface ItemDrag {
	/** The press moved past the threshold: the item is being dragged from here on. */
	onStart?(ev: MouseEvent): void;
	/** A move while dragging. */
	onMove?(ev: MouseEvent): void;
	/** The button was released while dragging. */
	onDrop?(ev: MouseEvent): void;
	/** A key went down or up while dragging, other than the Escape that cancels. */
	onKey?(ev: KeyboardEvent): void;
	/** The gesture is over: dropped, cancelled with Escape, or released without dragging. */
	onEnd?(): void;
}

const THRESHOLD_PX = 4;

/** Drag an item across other elements: returns an onMouseDown for the item. `begin`
 *  runs on a left press and returns the drag's handlers, or null to leave the press alone.
 *  The drag starts once the pointer moves past a small threshold, so a click stays a click.
 *  Listeners are window-wide and nothing is captured, so drop targets see their own hover. */
export function useItemDrag<A extends unknown[]>(
	begin: (e: React.MouseEvent, ...args: A) => ItemDrag | null,
): (e: React.MouseEvent, ...args: A) => void {
	const beginRef = useRef(begin);
	beginRef.current = begin;
	return useCallback((e: React.MouseEvent, ...args: A) => {
		if (e.button !== 0) return;
		const drag = beginRef.current(e, ...args);
		if (!drag) return;
		e.preventDefault();
		const x0 = e.clientX;
		const y0 = e.clientY;
		let started = false;
		const ac = new AbortController();
		const { signal } = ac;
		const end = () => {
			ac.abort();
			if (started) document.body.style.userSelect = "";
			drag.onEnd?.();
		};
		window.addEventListener(
			"mousemove",
			(ev) => {
				if (!started) {
					if (Math.max(Math.abs(ev.clientX - x0), Math.abs(ev.clientY - y0)) <= THRESHOLD_PX)
						return;
					started = true;
					document.body.style.userSelect = "none";
					drag.onStart?.(ev);
				}
				drag.onMove?.(ev);
			},
			{ signal },
		);
		window.addEventListener(
			"mouseup",
			(ev) => {
				if (started) drag.onDrop?.(ev);
				end();
			},
			{ signal },
		);
		window.addEventListener(
			"keydown",
			(ev) => {
				if (!started) return;
				if (ev.key === "Escape") end();
				else drag.onKey?.(ev);
			},
			{ signal },
		);
		window.addEventListener("keyup", (ev) => started && drag.onKey?.(ev), { signal });
	}, []);
}
