import clsx from "clsx";
import { Bar, type BarSize } from "@/components/primitives/Bar";
import { t } from "@/lib/i18n";

/** Share of locations holding a value as a bar and a percentage, colored by whether every location is covered when `status` is set. */
export function CoverageBar({
	ratio,
	size = "md",
	status = false,
	className,
}: {
	ratio: number;
	size?: BarSize;
	status?: boolean;
	className?: string;
}) {
	const complete = ratio >= 1;
	// An incomplete share never reads as 100%.
	const pct = complete ? 100 : Math.min(99, Math.round(Math.max(ratio, 0) * 100));
	const tone = !status ? "accent" : complete ? "complete" : "incomplete";
	return (
		<span
			className={clsx("coverage-bar", `coverage-bar--${tone}`, className)}
			title={t("{pct}% of locations", { pct })}
		>
			<Bar value={ratio} size={size} tone={tone} className="coverage-bar__bar" />
			<span className="coverage-bar__pct mono">{pct}%</span>
		</span>
	);
}
