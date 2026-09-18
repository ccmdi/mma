import type { ComponentPropsWithRef } from "react";
import clsx from "clsx";

export type PillTone = "neutral" | "accent" | "warning" | "destructive" | "action";

/** A small rounded label, with an optional count after its text. */
export function Pill({
	tone = "neutral",
	count,
	className,
	children,
	...props
}: ComponentPropsWithRef<"span"> & { tone?: PillTone; count?: number }) {
	return (
		<span {...props} className={clsx("pill", `pill--${tone}`, className)}>
			{children}
			{count !== undefined && <span className="pill__count">{count}</span>}
		</span>
	);
}
