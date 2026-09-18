import clsx from "clsx";
import { rgbCss, type RGB } from "@/lib/util/color";

/** A small block of color standing for a selection, a group or a series. */
export function Swatch({
	color,
	size = "md",
	round,
}: {
	color: RGB | string;
	size?: "sm" | "md";
	round?: boolean;
}) {
	return (
		<span
			className={clsx(
				"color-block",
				size === "sm" && "color-block--sm",
				round && "color-block--round",
			)}
			style={{ backgroundColor: typeof color === "string" ? color : rgbCss(color) }}
		/>
	);
}
