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
	const clamped = Math.min(Math.max(value, 0), 1);
	return (
		<span
			className={clsx("bar", `bar--${size}`, `bar--${tone}`, className)}
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={1}
			aria-valuenow={clamped}
		>
			<span className="bar__fill" style={{ width: `${clamped * 100}%` }} />
		</span>
	);
}
