import clsx from "clsx";

/** Determinate fill bar. `value` runs 0 to 1 and is clamped to it. */
export function ProgressBar({ value, className }: { value: number; className?: string }) {
	const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
	return (
		<div className={clsx("progress-bar", className)}>
			<div className="progress-bar__fill" style={{ width: `${pct}%` }} />
		</div>
	);
}
