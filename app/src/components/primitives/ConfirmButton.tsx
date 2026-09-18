import { useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { Button } from "@/components/primitives/Button";
import { t } from "@/lib/i18n";

/** A button that asks "Are you sure?" on the first click and acts on the second. Moving focus
 *  away disarms it. @unstable */
export function ConfirmButton({
	onConfirm,
	confirmLabel,
	variant,
	children,
	onBlur,
	...props
}: Omit<ComponentPropsWithRef<typeof Button>, "onClick"> & {
	onConfirm: () => void;
	/** The label while armed. Defaults to "Are you sure?". */
	confirmLabel?: ReactNode;
}) {
	const [armed, setArmed] = useState(false);
	return (
		<Button
			{...props}
			variant={armed ? "destructive" : variant}
			onClick={(e) => {
				e.stopPropagation();
				setArmed(!armed);
				if (armed) onConfirm();
			}}
			onBlur={(e) => {
				setArmed(false);
				onBlur?.(e);
			}}
		>
			{armed ? (confirmLabel ?? t("Are you sure?")) : children}
		</Button>
	);
}
