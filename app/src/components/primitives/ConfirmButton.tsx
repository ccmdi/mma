import { useState, type ComponentPropsWithRef, type MouseEvent, type ReactNode } from "react";
import { Button } from "@/components/primitives/Button";
import { IconButton } from "@/components/primitives/IconButton";
import { t } from "@/lib/i18n";

/** A button that asks "Are you sure?" on the first click and acts on the second. Moving focus
 *  away disarms it. @unstable */
export function ConfirmButton({
	onConfirm,
	confirmLabel,
	icon,
	variant,
	children,
	onBlur,
	...props
}: Omit<ComponentPropsWithRef<typeof Button>, "onClick"> & {
	onConfirm: () => void;
	/** The label while armed. Defaults to "Are you sure?". */
	confirmLabel?: ReactNode;
	/** An icon to show until the first click, with the button's text as its label. */
	icon?: string;
}) {
	const [armed, setArmed] = useState(false);
	const click = (e: MouseEvent) => {
		e.stopPropagation();
		setArmed(!armed);
		if (armed) onConfirm();
	};
	if (icon && !armed)
		return (
			<IconButton
				icon={icon}
				label={String(children)}
				tooltipSide="bottom"
				disabled={props.disabled}
				onClick={click}
			/>
		);
	return (
		<Button
			{...props}
			autoFocus={icon ? true : props.autoFocus}
			variant={armed ? "destructive" : variant}
			onClick={click}
			onBlur={(e) => {
				setArmed(false);
				onBlur?.(e);
			}}
		>
			{armed ? (confirmLabel ?? t("Are you sure?")) : children}
		</Button>
	);
}
