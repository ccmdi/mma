/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useRef, type ComponentProps } from "react";
import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import clsx from "clsx";
import { Icon } from "@/components/primitives/Icon";
import { mdiClose } from "@mdi/js";

const CloseContext = createContext<(() => void) | null>(null);

/** Controlled open/close pair every dialog component takes. */
export interface DialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function useCloseDialog() {
	const close = useContext(CloseContext);
	if (!close) throw new Error("useCloseDialog: not in a dialog context");
	return close;
}

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

export const DialogTrigger = BaseDialog.Trigger;

export function DialogContent({
	className,
	title,
	initialFocus,
	children,
	...props
}: ComponentProps<typeof BaseDialog.Popup> & { title: string }) {
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
				<div className={clsx("modal__dialog", className)}>
					<header className={clsx("modal__header", className ? `${className}__header` : null)}>
						<BaseDialog.Title className="modal__title">{title}</BaseDialog.Title>
						<BaseDialog.Close className="icon-button modal__close">
							<Icon path={mdiClose} />
						</BaseDialog.Close>
					</header>
					<div className="modal__content">{children}</div>
				</div>
			</BaseDialog.Popup>
		</BaseDialog.Portal>
	);
}
