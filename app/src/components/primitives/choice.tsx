import type { ReactNode } from "react";

export interface ChoiceLabelProps {
	/** Text shown beside the control. Clicking the text acts like clicking the control. */
	children?: ReactNode;
	/** Secondary text shown under the label. */
	hint?: ReactNode;
}

export function ChoiceLabel({
	control,
	children,
	hint,
	disabled,
	title,
}: ChoiceLabelProps & { control: ReactNode; disabled?: boolean; title?: string }) {
	if (children == null) return control;
	return (
		<label
			className={hint == null ? "choice" : "choice choice--hint"}
			aria-disabled={disabled || undefined}
			title={title}
		>
			{control}
			<span className="choice__text">
				{children}
				{hint != null && <span className="choice__hint">{hint}</span>}
			</span>
		</label>
	);
}
