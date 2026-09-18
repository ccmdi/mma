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
import {
	Dialog,
	DialogActions,
	DialogContent,
	PromptDialog,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { ConfirmButton } from "@/components/primitives/ConfirmButton";
import { Icon } from "@/components/primitives/Icon";
import { EmptyState } from "@/components/primitives/EmptyState";
import { mdiClose } from "@mdi/js";
import { t } from "@/lib/i18n";
import { log } from "@/lib/util/log";
import { Swatch } from "@/components/primitives/Swatch";

/** One chip per part of a rule, colored the way its selection was when it was saved. */
function RuleChips({ parts }: { parts: Pick<SavedPart, "label" | "color">[] }) {
	return (
		<div className="saved-selection-row__rules">
			{parts.map((part, i) => (
				<span key={i} className="saved-selection-row__chip">
					<Swatch color={part.color} size="sm" round />
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

	if (saveable.length === 0) {
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent title={t("Save current selections")} size="sm">
					<EmptyState>{t("No saveable selections active.")}</EmptyState>
					<DialogActions cancel={{ label: t("Close") }} />
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<PromptDialog
			open={open}
			onOpenChange={onOpenChange}
			title={t("Save current selections")}
			value={name}
			onChange={onNameChange}
			placeholder={t("Name this selection...")}
			submitLabel={t("Save")}
			onSubmit={() => void handleSave()}
		>
			<RuleChips parts={saveable} />
		</PromptDialog>
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
					<>
						<EmptyState>{t("No saved selections.")}</EmptyState>
						<DialogActions cancel={{ label: t("Close") }} />
					</>
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
									<ConfirmButton
										small
										variant="ghost"
										title={t("Delete")}
										aria-label={t("Delete")}
										data-reveal
										onConfirm={() => {
											void deleteSavedSelection(s.id);
											setSaved(saved.filter((r) => r.id !== s.id));
										}}
									>
										<Icon path={mdiClose} size={14} />
									</ConfirmButton>
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
