import type { ReactNode } from "react";
import { Switch } from "@/components/primitives/Switch";

/** A compact row with a switch on the left. Clicking anywhere on the row toggles it. */
export function SwitchRow({
	checked,
	onChange,
	label,
	disabled,
	className = "settings-popup__item",
	children,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
	disabled?: boolean;
	className?: string;
	children?: ReactNode;
}) {
	return (
		<div
			className={`${className} switch-row`}
			aria-disabled={disabled || undefined}
			onClick={() => !disabled && onChange(!checked)}
		>
			<span className="switch-row__control" onClick={(e) => e.stopPropagation()}>
				<Switch checked={checked} onChange={onChange} disabled={disabled} label={label} />
			</span>
			{children ?? label}
		</div>
	);
}
