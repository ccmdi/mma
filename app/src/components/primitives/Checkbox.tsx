import type { ComponentPropsWithRef } from "react";
import clsx from "clsx";
import { ChoiceLabel, type ChoiceLabelProps } from "./choice";

/** A checkbox, with its label and hint beside it when given. */
export function Checkbox({
	className,
	children,
	hint,
	...props
}: Omit<ComponentPropsWithRef<"input">, "children"> & ChoiceLabelProps) {
	return (
		<ChoiceLabel
			control={<input {...props} type="checkbox" className={clsx("checkbox", className)} />}
			hint={hint}
			disabled={props.disabled}
			title={props.title}
		>
			{children}
		</ChoiceLabel>
	);
}
