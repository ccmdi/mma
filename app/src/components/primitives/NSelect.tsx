import type { ComponentPropsWithRef } from "react";
import clsx from "clsx";

/** A dropdown. `compact` shrinks it to fit its value; `limited` caps the height of its option list.
 *  @unstable */
export function NSelect({
	className,
	compact,
	limited,
	onWheel,
	...props
}: ComponentPropsWithRef<"select"> & { compact?: boolean; limited?: boolean }) {
	return (
		<select
			{...props}
			className={clsx(
				"nselect",
				compact && "nselect--compact",
				limited && "nselect--limited",
				className,
			)}
			onWheel={(e) => {
				e.stopPropagation();
				onWheel?.(e);
			}}
		/>
	);
}
