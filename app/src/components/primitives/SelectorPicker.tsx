import { useId } from "react";
import type { SelectorPickController } from "@/store/selectorPick";
import { useSavedSelectionIndex } from "@/store/savedSelections";
import { NSelect } from "@/components/primitives/NSelect";
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
	const allSaved = useSavedSelectionIndex();
	const saved = ctl.saved ? allSaved : [];
	const savedMissing = choice.pick === "saved" && !saved.some((s) => s.id === choice.id);
	return (
		<div className={`selector-picker${className ? ` ${className}` : ""}`}>
			<label className="selector-picker__option">
				<Radio
					name={name}
					checked={choice.pick === "all"}
					onChange={() => setChoice({ pick: "all" })}
				/>
				{t("All locations ({n})", { n: allCount })}
			</label>
			<label
				className="selector-picker__option"
				style={!hasSelection ? { opacity: 0.5 } : undefined}
			>
				<Radio
					name={name}
					checked={choice.pick === "selection"}
					disabled={!hasSelection}
					onChange={() => setChoice({ pick: "selection" })}
				/>
				{t("Current selection ({n})", { n: selectionCount })}
			</label>
			{saved.length > 0 && (
				<label className="selector-picker__option">
					<Radio
						name={name}
						checked={choice.pick === "saved"}
						onChange={() => setChoice({ pick: "saved", id: saved[0].id })}
					/>

					{t("Saved")}
					<NSelect
						value={choice.pick === "saved" ? choice.id : ""}
						onChange={(e) => setChoice({ pick: "saved", id: e.target.value })}
					>
						{choice.pick !== "saved" && <option value="" disabled hidden />}
						{savedMissing && choice.pick === "saved" && (
							<option value={choice.id}>{t("(deleted selection)")}</option>
						)}
						{saved.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</NSelect>
				</label>
			)}
		</div>
	);
}
