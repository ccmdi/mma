/* eslint-disable react-refresh/only-export-components */
import {
	createContext,
	useContext,
	useRef,
	type ComponentProps,
	type ComponentPropsWithRef,
	type ReactNode,
} from "react";
import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import clsx from "clsx";
import { Button } from "@/components/primitives/Button";
import { ConfirmButton } from "@/components/primitives/ConfirmButton";
import { TextInput } from "@/components/primitives/TextInput";
import { mdiClose } from "@mdi/js";
import { t } from "@/lib/i18n";
import { IconButton } from "@/components/primitives/IconButton";

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

/** A dialog's fixed width: small, medium, large or extra large. */
export type DialogSize = "sm" | "md" | "lg" | "xl";

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
	size?: DialogSize;
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
							<BaseDialog.Close render={<IconButton icon={mdiClose} label={t("Close")} />} />
						</header>
						<div className="modal__content">{children}</div>
					</div>
				</div>
			</BaseDialog.Popup>
		</BaseDialog.Portal>
	);
}

/** One button in a dialog footer. */
export interface DialogAction {
	label: ReactNode;
	/** Runs on click. Without it the button submits the form it sits in. */
	onClick?: () => void;
	disabled?: boolean;
	/** An identifier for automated tests. */
	"data-qa"?: string;
}

function actionProps({ onClick, disabled, "data-qa": qa }: DialogAction) {
	return { type: onClick ? "button" : "submit", onClick, disabled, "data-qa": qa } as const;
}

/** A dialog's footer: side content on the left, then Cancel, then the main action on the right.
 *  @unstable */
export function DialogActions({
	start,
	destructive,
	cancel,
	primary,
}: {
	/** Content held to the left: a summary, a meter, paging or secondary buttons. */
	start?: ReactNode;
	/** An action that destroys something, held to the far left. With `confirm` it asks "Are you
	 *  sure?" on the first click and acts on the second. */
	destructive?: DialogAction & { confirm?: boolean };
	/** The dismiss button, labelled Cancel and closing the dialog unless told otherwise. */
	cancel?: true | Partial<DialogAction>;
	/** The action the dialog exists for, always rightmost. */
	primary?: DialogAction & { tone?: "primary" | "destructive" };
}) {
	const close = useContext(CloseContext);
	const dismiss = cancel === true ? {} : cancel;
	return (
		<div className="modal__actions">
			{(destructive || start) && (
				<div className="modal__actions-start">
					{destructive?.confirm ? (
						<ConfirmButton
							variant="destructive"
							disabled={destructive.disabled}
							data-qa={destructive["data-qa"]}
							onConfirm={() => destructive.onClick?.()}
						>
							{destructive.label}
						</ConfirmButton>
					) : (
						destructive && (
							<Button variant="destructive" {...actionProps(destructive)}>
								{destructive.label}
							</Button>
						)
					)}
					{start}
				</div>
			)}
			{dismiss && (
				<Button
					onClick={dismiss.onClick ?? close ?? undefined}
					disabled={dismiss.disabled}
					data-qa={dismiss["data-qa"]}
				>
					{dismiss.label ?? t("Cancel")}
				</Button>
			)}
			{primary && (
				<Button variant={primary.tone ?? "primary"} {...actionProps(primary)}>
					{primary.label}
				</Button>
			)}
		</div>
	);
}

/** A dialog body laid out as a column that runs `onSubmit` when submitted, Enter included.
 *  @unstable */
export function DialogForm({
	onSubmit,
	className,
	...props
}: Omit<ComponentPropsWithRef<"form">, "onSubmit"> & { onSubmit: () => void }) {
	return (
		<form
			{...props}
			className={clsx("modal__stack", className)}
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
		/>
	);
}

/** A line of secondary text inside a dialog, optionally marked as a warning or an error.
 *  @unstable */
export function DialogHint({
	tone,
	children,
}: {
	tone?: "warning" | "error";
	children?: ReactNode;
}) {
	return <span className={clsx("modal__hint", tone && `modal__hint--${tone}`)}>{children}</span>;
}

/** Asks the user to confirm one action, with room for extra options under the message.
 *  @unstable */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	message,
	confirmLabel,
	cancelLabel,
	tone = "primary",
	busy = false,
	size = "sm",
	onConfirm,
	children,
}: DialogProps & {
	title: string;
	message: ReactNode;
	confirmLabel: ReactNode;
	cancelLabel?: ReactNode;
	/** Destructive for an action that cannot be taken back. */
	tone?: "primary" | "destructive";
	/** Disables both buttons while the action runs. */
	busy?: boolean;
	size?: DialogSize;
	onConfirm: () => void;
	children?: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={title} size={size}>
				<div className="modal__stack">
					<p className="modal__message">{message}</p>
					{children}
					<DialogActions
						cancel={{ label: cancelLabel, disabled: busy }}
						primary={{ label: confirmLabel, tone, disabled: busy, onClick: onConfirm }}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** Asks for one line of text, submitted with Enter or the submit button.
 *  @unstable */
export function PromptDialog({
	open,
	onOpenChange,
	title,
	value,
	onChange,
	placeholder,
	submitLabel,
	error,
	canSubmit,
	selectOnFocus = false,
	size = "sm",
	onSubmit,
	children,
}: DialogProps & {
	title: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	submitLabel: ReactNode;
	/** Shown under the field. Pass null to keep its line reserved while there is no error. */
	error?: ReactNode;
	/** Whether the value can be submitted. Defaults to the value not being blank. */
	canSubmit?: boolean;
	/** Selects the whole value when the field gains focus. */
	selectOnFocus?: boolean;
	size?: DialogSize;
	onSubmit: () => void;
	/** Extra content between the field and the buttons. */
	children?: ReactNode;
}) {
	const ready = canSubmit ?? value.trim() !== "";
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={title} size={size}>
				<DialogForm onSubmit={() => ready && onSubmit()}>
					<TextInput
						type="text"
						value={value}
						onChange={(e) => onChange(e.target.value)}
						onFocus={selectOnFocus ? (e) => e.currentTarget.select() : undefined}
						placeholder={placeholder}
						aria-invalid={error ? true : undefined}
						autoFocus
					/>
					{error !== undefined && <DialogHint tone="error">{error}</DialogHint>}
					{children}
					<DialogActions cancel primary={{ label: submitLabel, disabled: !ready }} />
				</DialogForm>
			</DialogContent>
		</Dialog>
	);
}
