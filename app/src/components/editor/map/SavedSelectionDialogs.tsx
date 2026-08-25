import { useMapState } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import {
	saveCurrentSelections,
	applySavedSelection,
	deleteSavedSelection,
	selectorToSaved,
	describeRule,
	type SavedSelectionItem,
} from "@/store/savedSelections";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { mdiClose } from "@mdi/js";
import { t } from "@/lib/i18n";

export function SaveSelectionsDialog({
	open,
	onOpenChange,
	name,
	onNameChange,
}: DialogProps & { name: string; onNameChange: (v: string) => void }) {
	const map = useMapState((s) => s.map);
	const selections = useMapState((s) => s.selections);
	const saveableItems: SavedSelectionItem[] = (() => {
		if (!map) return [];
		return selections
			.map((s) => {
				const saved = selectorToSaved(s.selector);
				if (!saved) return null;
				return { props: saved, color: s.color } as SavedSelectionItem;
			})
			.filter((item): item is SavedSelectionItem => item !== null);
	})();

	const handleSave = () => {
		if (!name.trim() || !map) return;
		const ok = saveCurrentSelections(name.trim(), selections);
		if (ok) {
			onNameChange("");
			onOpenChange(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Save current selections")}>
				{saveableItems.length === 0 ? (
					<p>{t("No saveable selections active.")}</p>
				) : (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							handleSave();
						}}
						style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}
					>
						<TextInput
							value={name}
							onChange={(e) => onNameChange(e.target.value)}
							placeholder={t("Name this selection...")}
							autoFocus
						/>
						<div className="saved-selection-row__rules">
							{saveableItems.map((item, i) => (
								<span key={i} className="saved-selection-row__chip">
									<span
										className="saved-selection-row__dot"
										style={{
											background: `rgb(${item.color[0]},${item.color[1]},${item.color[2]})`,
										}}
									/>
									{describeRule(item.props)}
								</span>
							))}
						</div>
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
	const saved = useSetting("savedSelections");

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
											deleteSavedSelection(s.id);
										}}
										title={t("Delete")}
									>
										<Icon path={mdiClose} size={14} />
									</button>
								</div>
								<div className="saved-selection-row__rules">
									{s.items.map((item, i) => (
										<span key={i} className="saved-selection-row__chip">
											<span
												className="saved-selection-row__dot"
												style={{
													background: `rgb(${item.color[0]},${item.color[1]},${item.color[2]})`,
												}}
											/>
											{describeRule(item.props)}
										</span>
									))}
								</div>
							</div>
						))}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
