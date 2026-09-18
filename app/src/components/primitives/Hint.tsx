import type { ReactNode } from "react";
import clsx from "clsx";

/** A line of secondary text, optionally marked as a warning or an error. */
export function Hint({ tone, children }: { tone?: "warning" | "error"; children?: ReactNode }) {
	return <span className={clsx("hint", tone && `hint--${tone}`)}>{children}</span>;
}

/** A boxed message that informs, warns, reports an error or confirms a success. */
export function Notice({
	tone,
	children,
}: {
	tone: "info" | "warning" | "error" | "success";
	children: ReactNode;
}) {
	return (
		<div
			className={`notice notice--${tone}`}
			role={tone === "error" ? "alert" : tone === "success" ? "status" : undefined}
		>
			{children}
		</div>
	);
}
