import { cloneElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactElement } from "react";
import { clamp } from "@/types/util";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

const OFFSET = 5;
const ARROW_W = 10;
const ARROW_H = 5;
const MARGIN = 4;

interface Shown {
	content: string;
	side: Side;
	align: Align;
	trigger: HTMLElement;
}

/** Marks its child as a tooltip trigger. Adds attributes to the existing element instead of
 *  wrapping it, so a trigger costs no extra fibers and hovering re-renders only the single
 *  host below -- one portal for the whole app rather than one per trigger. */
export function Tooltip({
	content,
	side = "top",
	align = "center",
	children,
}: {
	content: string;
	side?: Side;
	align?: Align;
	children: ReactElement;
}) {
	return cloneElement(children as ReactElement<Record<string, unknown>>, {
		"data-tooltip": content,
		"data-tooltip-side": side,
		"data-tooltip-align": align,
	});
}

function place(trigger: DOMRect, tip: DOMRect, side: Side, align: Align) {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const fits = (s: Side) =>
		s === "top"
			? trigger.top - tip.height - OFFSET >= MARGIN
			: s === "bottom"
				? trigger.bottom + tip.height + OFFSET <= vh - MARGIN
				: s === "left"
					? trigger.left - tip.width - OFFSET >= MARGIN
					: trigger.right + tip.width + OFFSET <= vw - MARGIN;

	const opposite: Record<Side, Side> = {
		top: "bottom",
		bottom: "top",
		left: "right",
		right: "left",
	};
	const resolved = fits(side) ? side : fits(opposite[side]) ? opposite[side] : side;
	const vertical = resolved === "top" || resolved === "bottom";

	let x: number;
	let y: number;
	if (vertical) {
		y = resolved === "top" ? trigger.top - tip.height - OFFSET : trigger.bottom + OFFSET;
		x =
			align === "start"
				? trigger.left
				: align === "end"
					? trigger.right - tip.width
					: trigger.left + trigger.width / 2 - tip.width / 2;
		x = clamp(x, MARGIN, vw - tip.width - MARGIN);
	} else {
		x = resolved === "left" ? trigger.left - tip.width - OFFSET : trigger.right + OFFSET;
		y =
			align === "start"
				? trigger.top
				: align === "end"
					? trigger.bottom - tip.height
					: trigger.top + trigger.height / 2 - tip.height / 2;
		y = clamp(y, MARGIN, vh - tip.height - MARGIN);
	}

	const arrowX = vertical
		? clamp(trigger.left + trigger.width / 2 - x, ARROW_W, tip.width - ARROW_W)
		: resolved === "left"
			? tip.width
			: -ARROW_H;
	const arrowY = vertical
		? resolved === "top"
			? tip.height
			: -ARROW_H
		: clamp(trigger.top + trigger.height / 2 - y, ARROW_W, tip.height - ARROW_W);

	return { x, y, resolved, arrowX, arrowY, vertical };
}

function TooltipHost() {
	const [shown, setShown] = useState<Shown | null>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const arrowRef = useRef<SVGSVGElement>(null);

	useEffect(() => {
		const show = (e: Event) => {
			const target = e.target as HTMLElement | null;
			const trigger = target?.closest?.("[data-tooltip]") as HTMLElement | null;
			const content = trigger?.getAttribute("data-tooltip");
			if (!trigger || !content) return;
			setShown((prev) =>
				prev?.trigger === trigger && prev.content === content
					? prev
					: {
							content,
							side: (trigger.getAttribute("data-tooltip-side") as Side) ?? "top",
							align: (trigger.getAttribute("data-tooltip-align") as Align) ?? "center",
							trigger,
						},
			);
		};
		// pointerout fires on every boundary inside the trigger (button -> svg -> path), so a
		// transition landing anywhere within the same trigger is not a leave.
		const hide = (e: Event) => {
			const to = (e as PointerEvent).relatedTarget as Node | null;
			setShown((prev) => {
				if (!prev) return prev;
				if (to && prev.trigger.contains(to)) return prev;
				return null;
			});
		};
		// Focus reaching a trigger without the keyboard (a dialog handing focus back to the
		// button that opened it) is not a hover; only keyboard focus earns the tooltip.
		const showOnKeyboardFocus = (e: Event) => {
			const target = e.target as HTMLElement | null;
			if (target?.matches?.(":focus-visible")) show(e);
		};
		const hideAll = () => setShown(null);

		const ac = new AbortController();
		const { signal } = ac;
		document.addEventListener("pointerover", show, { signal });
		document.addEventListener("pointerout", hide, { signal });
		document.addEventListener("focusin", showOnKeyboardFocus, { signal });
		document.addEventListener("focusout", hide, { signal });
		document.addEventListener("pointerdown", hideAll, { capture: true, signal });
		window.addEventListener("scroll", hideAll, { capture: true, signal });
		window.addEventListener("blur", hideAll, { signal });
		return () => ac.abort();
	}, []);

	useLayoutEffect(() => {
		const tip = tipRef.current;
		if (!shown || !tip) return;
		if (!shown.trigger.isConnected) {
			setShown(null);
			return;
		}
		const { x, y, resolved, arrowX, arrowY, vertical } = place(
			shown.trigger.getBoundingClientRect(),
			tip.getBoundingClientRect(),
			shown.side,
			shown.align,
		);
		tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
		tip.dataset.side = resolved;
		tip.style.visibility = "visible";
		const arrow = arrowRef.current;
		if (!arrow) return;
		const rotate =
			resolved === "top" ? 0 : resolved === "bottom" ? 180 : resolved === "left" ? 270 : 90;
		const ax = Math.round(arrowX - (vertical ? ARROW_W / 2 : 0));
		const ay = Math.round(arrowY - (vertical ? 0 : ARROW_W / 2));
		arrow.style.transform = `translate3d(${ax}px, ${ay}px, 0) rotate(${rotate}deg)`;
	}, [shown]);

	if (!shown) return null;

	return createPortal(
		<div
			ref={tipRef}
			className="tooltip"
			role="tooltip"
			style={{ position: "fixed", top: 0, left: 0, visibility: "hidden" }}
		>
			{shown.content}
			<svg
				ref={arrowRef}
				className="tooltip__arrow"
				width={ARROW_W}
				height={ARROW_H}
				viewBox="0 0 10 5"
				style={{ position: "absolute", top: 0, left: 0, transformOrigin: "center" }}
			>
				<polygon points="0,0 10,0 5,5" />
			</svg>
		</div>,
		document.body,
	);
}

export function TooltipProvider({ children }: { children: React.ReactNode }) {
	return (
		<>
			{children}
			<TooltipHost />
		</>
	);
}
