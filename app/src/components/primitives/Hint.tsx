import type { ReactNode } from "react";
import clsx from "clsx";
import { mdiInformationOutline } from "@mdi/js";
import { IconButton } from "@/components/primitives/IconButton";

/** A line of secondary text, optionally marked as a warning or an error. */
export function Hint({ tone, children }: { tone?: "warning" | "error"; children?: ReactNode }) {
	return <span className={clsx("hint", tone && `hint--${tone}`)}>{children}</span>;
}

/** An info icon beside a label, explaining it on hover instead of in a line of text under it. */
export function InfoButton({ text }: { text: string }) {
	return (
		<IconButton
			className="icon-button--inline info-button"
			icon={mdiInformationOutline}
			size={16}
			label={text}
		/>
	);
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
