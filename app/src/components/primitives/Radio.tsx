import type { ComponentPropsWithRef } from "react";
import clsx from "clsx";
import { ChoiceLabel, type ChoiceLabelProps } from "./choice";

/** A radio button, with its label and hint beside it when given. */
export function Radio({
	className,
	children,
	hint,
	...props
}: Omit<ComponentPropsWithRef<"input">, "children"> & ChoiceLabelProps) {
	return (
		<ChoiceLabel
			control={<input {...props} type="radio" className={clsx("radio", className)} />}
			hint={hint}
			disabled={props.disabled}
			title={props.title}
		>
			{children}
		</ChoiceLabel>
	);
}
