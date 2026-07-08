import type { ComponentPropsWithRef } from "react";
import clsx from "clsx";

export function NSelect({ className, onWheel, ...props }: ComponentPropsWithRef<"select">) {
	return (
		<select
			{...props}
			className={clsx("nselect", className)}
			onWheel={(e) => {
				e.stopPropagation();
				onWheel?.(e);
			}}
		/>
	);
}
