/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
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

export function Dialog({ open, onOpenChange, children, ...props }: RadixDialog.DialogProps) {
	return (
		<CloseContext.Provider value={() => onOpenChange?.(false)}>
			<RadixDialog.Root open={open} onOpenChange={onOpenChange} {...props}>
				{children}
			</RadixDialog.Root>
		</CloseContext.Provider>
	);
}

export const DialogTrigger = RadixDialog.Trigger;

export function DialogContent({
	className,
	title,
	children,
	...props
}: RadixDialog.DialogContentProps & { title: string }) {
	return (
		<RadixDialog.Portal>
			<RadixDialog.Overlay className="modal__backdrop" />
			<RadixDialog.Content
				{...props}
				className="modal"
				aria-describedby={undefined}
				onInteractOutside={(e) => {
					// A portaled SuggestInput dropdown lives outside the content in the DOM;
					// interacting with it must not dismiss the dialog.
					if ((e.target as Element | null)?.closest?.(".suggest-portal")) e.preventDefault();
					else props.onInteractOutside?.(e);
				}}
				onOpenAutoFocus={(e) => {
					if (props.onOpenAutoFocus) return props.onOpenAutoFocus(e);
					// Radix would land on the first tabbable, the close X, wearing a focus ring.
					// Park focus on the content instead unless a child already claimed it
					// (autoFocus); Tab still reaches the X and everything after it.
					e.preventDefault();
					const content = e.currentTarget as HTMLElement;
					if (!content.contains(document.activeElement)) content.focus();
				}}
			>
				<div className={clsx("modal__dialog", className)}>
					<header className={clsx("modal__header", className ? `${className}__header` : null)}>
						<RadixDialog.Title className="modal__title">{title}</RadixDialog.Title>
						<RadixDialog.Close asChild>
							<button type="button" className="icon-button modal__close">
								<Icon path={mdiClose} />
							</button>
						</RadixDialog.Close>
					</header>
					<div className="modal__content">{children}</div>
				</div>
			</RadixDialog.Content>
		</RadixDialog.Portal>
	);
}
