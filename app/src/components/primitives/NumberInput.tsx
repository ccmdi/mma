import { useState } from "react";
import type { ComponentPropsWithRef } from "react";
import { TextInput } from "@/components/primitives/TextInput";

/** A number field that commits only numbers within its range; leaving it clamps an out-of-range
 *  number and restores the last value in place of anything unreadable. */
export function NumberInput({
	value,
	onChange,
	min,
	max,
	onBlur,
	...props
}: Omit<ComponentPropsWithRef<"input">, "value" | "onChange" | "min" | "max" | "type"> & {
	value: number;
	onChange: (value: number) => void;
	min?: number;
	max?: number;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
	return (
		<TextInput
			{...props}
			type="number"
			min={min}
			max={max}
			value={draft ?? value}
			onChange={(e) => {
				setDraft(e.target.value);
				const v = e.target.valueAsNumber;
				if (Number.isFinite(v) && v === clamp(v)) onChange(v);
			}}
			onBlur={(e) => {
				const v = e.target.valueAsNumber;
				if (Number.isFinite(v) && v !== clamp(v)) onChange(clamp(v));
				setDraft(null);
				onBlur?.(e);
			}}
		/>
	);
}
