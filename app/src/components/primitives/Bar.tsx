import clsx from "clsx";

export type BarSize = "sm" | "md" | "lg";
export type BarTone = "accent" | "complete" | "incomplete";

/** Determinate fill bar. `value` runs 0 to 1 and is clamped to it. */
export function Bar({
	value,
	size = "sm",
	tone = "accent",
	className,
}: {
	value: number;
	size?: BarSize;
	tone?: BarTone;
	className?: string;
}) {
	const pct = Math.min(Math.max(value, 0), 1) * 100;
	return (
		<span className={clsx("bar", `bar--${size}`, `bar--${tone}`, className)}>
			<span className="bar__fill" style={{ width: `${pct}%` }} />
		</span>
	);
}
