import { useId } from "react";
import type { SelectorPickController } from "@/store/selectorPick";
import { Radio } from "@/components/primitives/Radio";
import { t } from "@/lib/i18n";
export function SelectorPicker({
	ctl,
	className,
}: {
	ctl: SelectorPickController;
	className?: string;
}) {
	const { choice, setChoice, allCount, selectionCount } = ctl;
	const name = useId();
	const hasSelection = selectionCount > 0;
	return (
		<div className={`selector-picker${className ? ` ${className}` : ""}`}>
			<Radio
				name={name}
				checked={choice.pick === "all"}
				onChange={() => setChoice({ pick: "all" })}
			>
				{t("All locations ({n})", { n: allCount })}
			</Radio>
			<Radio
				name={name}
				checked={choice.pick === "selection"}
				disabled={!hasSelection}
				onChange={() => setChoice({ pick: "selection" })}
			>
				{t("Current selection ({n})", { n: selectionCount })}
			</Radio>
		</div>
	);
}
