/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useRef, type ComponentProps } from "react";
import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import clsx from "clsx";
import { Icon } from "@/components/primitives/Icon";
import { mdiClose } from "@mdi/js";

const CloseContext = createContext<(() => void) | null>(null);

export const RESIZE_MS = 220;
export const RESIZE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/** Where a modal's top edge sits for its height: centred when it opens or the window resizes
 *  (`anchor` null). Growth holds the top so it runs downward; shrinking settles back toward
 *  centre, never above it. Either way it stays on screen. */
export function modalTop(anchor: number | null, height: number, viewport: number): number {
	const gap = Math.round(viewport * 0.05);
	const centred = Math.round((viewport - height) / 2);
	const wanted = anchor === null ? centred : Math.max(anchor, centred);
	return Math.max(gap, Math.min(wanted, viewport - height - gap));
}

/** Eases a modal's frame between the heights its content lays out at, holding the top edge
 *  where `modalTop` puts it. */
function followContentHeight(frame: HTMLDivElement | null) {
	const popup = frame?.parentElement;
	const body = frame?.firstElementChild;
	if (!frame || !popup || !(body instanceof HTMLElement)) return;

	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	const style = getComputedStyle(frame);
	const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
	let height: number | null = null;
	let top: number | null = null;
	let resize: Animation | null = null;

	const place = (next: number, animate: boolean) => {
		const nextTop = modalTop(top, next, window.innerHeight);
		if (nextTop === top) return;
		if (animate && top !== null) {
			popup.animate([{ marginTop: `${top}px` }, { marginTop: `${nextTop}px` }], {
				duration: RESIZE_MS,
				easing: RESIZE_EASING,
			});
		}
		top = nextTop;
		popup.style.marginTop = `${nextTop}px`;
	};

	const observer = new ResizeObserver(() => {
		const next = body.offsetHeight + borderY;
		if (next === height) return;
		const from = resize ? parseFloat(getComputedStyle(frame).height) : height;
		resize?.cancel();
		resize = null;
		height = next;
		const animate = from !== null && !reducedMotion.matches;
		place(next, animate);
		if (!animate) {
			frame.classList.remove("is-resizing");
			return;
		}
		frame.classList.add("is-resizing");
		const animation = frame.animate([{ height: `${from}px` }, { height: `${next}px` }], {
			duration: RESIZE_MS,
			easing: RESIZE_EASING,
		});
		animation.onfinish = () => {
			if (resize !== animation) return;
			resize = null;
			frame.classList.remove("is-resizing");
		};
		resize = animation;
	});
	const onViewportResize = () => {
		if (height === null) return;
		top = null;
		place(height, false);
	};

	observer.observe(body);
	window.addEventListener("resize", onViewportResize);
	return () => {
		observer.disconnect();
		window.removeEventListener("resize", onViewportResize);
		resize?.cancel();
	};
}

/** Controlled open/close pair every dialog component takes. */
export interface DialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** @unstable */
export function useCloseDialog() {
	const close = useContext(CloseContext);
	if (!close) throw new Error("useCloseDialog: not in a dialog context");
	return close;
}

/** @unstable */
export function Dialog({
	open,
	onOpenChange,
	children,
	...props
}: Omit<ComponentProps<typeof BaseDialog.Root>, "onOpenChange"> & {
	onOpenChange?: (open: boolean) => void;
}) {
	return (
		<CloseContext.Provider value={() => onOpenChange?.(false)}>
			<BaseDialog.Root
				open={open}
				onOpenChange={(next, details) => {
					if (
						!next &&
						details.reason === "outside-press" &&
						(details.event.target as Element | null)?.closest?.(
							".suggest-portal, .picker-positioner",
						)
					) {
						details.cancel();
						return;
					}
					onOpenChange?.(next);
				}}
				{...props}
			>
				{children}
			</BaseDialog.Root>
		</CloseContext.Provider>
	);
}

/** @unstable */
export const DialogTrigger = BaseDialog.Trigger;

/** @unstable */
export function DialogContent({
	className,
	title,
	size = "md",
	initialFocus,
	children,
	...props
}: ComponentProps<typeof BaseDialog.Popup> & {
	title: string;
	/** The dialog's fixed width: small, medium, large or extra large. */
	size?: "sm" | "md" | "lg" | "xl";
}) {
	const popupRef = useRef<HTMLDivElement>(null);
	return (
		<BaseDialog.Portal>
			<BaseDialog.Backdrop className="modal__backdrop" />
			<BaseDialog.Popup
				{...props}
				ref={popupRef}
				className="modal"
				initialFocus={
					// Landing on the first tabbable would put a focus ring on the close X.
					// Park focus on the popup instead unless a child already claimed it (autoFocus).
					initialFocus ??
					(() => {
						const popup = popupRef.current;
						return popup && !popup.contains(document.activeElement) ? popup : false;
					})
				}
			>
				<div className="modal__frame" ref={followContentHeight}>
					<div className={clsx("modal__dialog", `modal__dialog--${size}`, className)}>
						<header className={clsx("modal__header", className ? `${className}__header` : null)}>
							<BaseDialog.Title className="modal__title">{title}</BaseDialog.Title>
							<BaseDialog.Close className="icon-button modal__close">
								<Icon path={mdiClose} />
							</BaseDialog.Close>
						</header>
						<div className="modal__content">{children}</div>
					</div>
				</div>
			</BaseDialog.Popup>
		</BaseDialog.Portal>
	);
}
