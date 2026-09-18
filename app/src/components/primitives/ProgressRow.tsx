import type { ReactNode } from "react";
import clsx from "clsx";
import { Bar, type BarSize } from "@/components/primitives/Bar";

/** A progress bar under its label and count, with any extra detail below it. */
export function ProgressRow({
	label,
	count,
	value,
	size = "sm",
	className,
	children,
}: {
	label: ReactNode;
	count?: ReactNode;
	value: number;
	size?: BarSize;
	className?: string;
	children?: ReactNode;
}) {
	return (
		<div className={clsx("progress-row", className)}>
			<div className="progress-row__head">
				<span className="progress-row__label">{label}</span>
				{count != null && <span className="progress-row__count mono">{count}</span>}
			</div>
			<Bar value={value} size={size} />
			{children}
		</div>
	);
}
