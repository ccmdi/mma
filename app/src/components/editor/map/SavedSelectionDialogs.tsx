import { useEffect, useState } from "react";
import { useMapState } from "@/store/useMapStore";
import { selectionDisplayName } from "@/store/selections";
import {
	saveCurrentSelections,
	applySavedSelection,
	deleteSavedSelection,
	isSaveable,
	loadAllSavedSelections,
	savedParts,
	type SavedPart,
} from "@/store/savedSelections";
import type { SavedSelection } from "@/bindings.gen";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { mdiClose } from "@mdi/js";
import { t } from "@/lib/i18n";
import { log } from "@/lib/util/log";

/** One chip per part of a rule, colored the way its selection was when it was saved. */
function RuleChips({ parts }: { parts: Pick<SavedPart, "label" | "color">[] }) {
	return (
		<div className="saved-selection-row__rules">
			{parts.map((part, i) => (
				<span key={i} className="saved-selection-row__chip">
					<span
						className="saved-selection-row__dot"
						style={{ background: `rgb(${part.color[0]},${part.color[1]},${part.color[2]})` }}
					/>
					{part.label}
				</span>
			))}
		</div>
	);
}

export function SaveSelectionsDialog({
	open,
	onOpenChange,
	name,
	onNameChange,
}: DialogProps & { name: string; onNameChange: (v: string) => void }) {
	const map = useMapState((s) => s.map);
	const selections = useMapState((s) => s.selections);
	const saveable = map
		? selections
				.filter((s) => isSaveable(s.selector))
				.map((s) => ({ label: selectionDisplayName(s), color: s.color }))
		: [];

	const handleSave = async () => {
		if (!name.trim() || !map) return;
		if (await saveCurrentSelections(name.trim(), selections)) {
			onNameChange("");
			onOpenChange(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Save current selections")}>
				{saveable.length === 0 ? (
					<p>{t("No saveable selections active.")}</p>
				) : (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void handleSave();
						}}
						style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}
					>
						<TextInput
							value={name}
							onChange={(e) => onNameChange(e.target.value)}
							placeholder={t("Name this selection...")}
							autoFocus
						/>
						<RuleChips parts={saveable} />
						<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
							<Button onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
							<Button variant="primary" type="submit" disabled={!name.trim()}>
								{t("Save")}
							</Button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function ApplySavedSelectionDialog({ open, onOpenChange }: DialogProps) {
	const map = useMapState((s) => s.map);
	const [saved, setSaved] = useState<SavedSelection[] | null>(null);

	useEffect(() => {
		let live = true;
		loadAllSavedSelections()
			.then((rules) => {
				if (live) setSaved(rules);
			})
			.catch((e) => {
				log.error("[saved-selections] could not read rules:", e);
				if (live) setSaved([]);
			});
		return () => {
			live = false;
		};
	}, []);

	if (saved === null) return null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Apply saved selection")}>
				{saved.length === 0 ? (
					<p>{t("No saved selections.")}</p>
				) : (
					<div className="saved-selection-list">
						{saved.map((s) => (
							<div
								key={s.id}
								className="saved-selection-row"
								onClick={() => {
									if (map) {
										applySavedSelection(s);
										onOpenChange(false);
									}
								}}
							>
								<div className="saved-selection-row__header">
									<span className="saved-selection-row__name">{s.name}</span>
									<button
										className="saved-selection-row__delete"
										onClick={(e) => {
											e.stopPropagation();
											void deleteSavedSelection(s.id);
											setSaved(saved.filter((r) => r.id !== s.id));
										}}
										title={t("Delete")}
									>
										<Icon path={mdiClose} size={14} />
									</button>
								</div>
								<RuleChips parts={savedParts(s)} />
							</div>
						))}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
