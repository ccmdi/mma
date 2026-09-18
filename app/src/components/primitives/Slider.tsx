import type { ComponentPropsWithRef, CSSProperties, ReactNode } from "react";
import clsx from "clsx";

/** A range input whose track fills up to its value, followed by the value itself when `format` is given. */
export function Slider({
	className,
	format,
	...props
}: ComponentPropsWithRef<"input"> & { format?: (value: number) => ReactNode }) {
	const min = Number(props.min ?? 0);
	const max = Number(props.max ?? 100);
	const value = Number(props.value ?? min);
	const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
	const input = (
		<input
			{...props}
			type="range"
			className={clsx("slider", className)}
			style={{ ...props.style, "--fill": `${pct}%` } as CSSProperties}
		/>
	);
	if (!format) return input;
	return (
		<span className="slider-field">
			{input}
			<span className="slider__value mono">{format(value)}</span>
		</span>
	);
}
