import { updateMapMeta, useMapState } from "@/store/useMapStore";
import { deleteMap } from "@/store/mapList";
import { useEffect, useId, useState } from "react";
import { mdiRestore } from "@mdi/js";
import { cmd } from "@/lib/commands";
import { useCloseDialog } from "../primitives/Dialog";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { TextInput } from "../primitives/TextInput";
import { ScoreBoundsEditor } from "./ScoreBoundsEditor";
import { t } from "@/lib/i18n";

/** The built-in survivor ranking, written in the expression syntax. Shown as the
 *  placeholder; leaving the field blank is what actually selects it. */
const DEFAULT_DUPLICATE_SCORE = "tagCount";

function DeleteMapSection({ mapId, name }: { mapId: string; name: string }) {
	const [confirming, setConfirming] = useState(false);

	if (!confirming) {
		return (
			<Button variant="destructive" onClick={() => setConfirming(true)}>
				{t("Delete map")}
			</Button>
		);
	}

	return (
		<div className="edit-map-modal__delete">
			<span>
				{t("Delete “{name}”? This permanently removes the map and its history.", {
					name: name || t("(unnamed)"),
				})}
			</span>
			<Button onClick={() => setConfirming(false)}>{t("Cancel")}</Button>
			<Button variant="destructive" onClick={() => void deleteMap(mapId)}>
				{t("Delete map")}
			</Button>
		</div>
	);
}

export function MapSettingsForm({ mapId, currentName }: { mapId: string; currentName: string }) {
	const id = useId();
	const close = useCloseDialog();
	const settings = useMapState((s) => s.map?.meta.settings);
	const [name, setName] = useState(currentName);
	const [score, setScore] = useState(settings?.duplicateScore ?? "");
	const [scoreError, setScoreError] = useState<string | null>(null);

	useEffect(() => {
		if (score.trim() === "") {
			setScoreError(null);
			return;
		}
		let live = true;
		void cmd.fieldExprError(score).then((err) => {
			if (live) setScoreError(err);
		});
		return () => {
			live = false;
		};
	}, [score]);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void updateMapMeta({
					name: name || currentName,
					...(settings && {
						settings: { ...settings, duplicateScore: score.trim() || null },
					}),
				});
				close();
			}}
		>
			<p className="edit-map-modal__name">
				<label htmlFor={`${id}name`}>{t("Map name:")}</label>
				<TextInput
					id={`${id}name`}
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					minLength={1}
					maxLength={100}
					autoFocus
				/>
			</p>
			<p className="edit-map-modal__name">
				<label htmlFor={`${id}dup`}>{t("Duplicate preference:")}</label>
				<span className="edit-map-modal__expr">
					<TextInput
						id={`${id}dup`}
						type="text"
						className="mono"
						value={score}
						onChange={(e) => setScore(e.target.value)}
						placeholder={DEFAULT_DUPLICATE_SCORE}
						spellCheck={false}
					/>
					<button
						type="button"
						className="icon-button"
						onClick={() => setScore("")}
						disabled={score === ""}
						title={t("Reset to default")}
						aria-label={t("Reset to default")}
					>
						<Icon path={mdiRestore} />
					</button>
				</span>
			</p>
			<p className="edit-map-modal__hint">
				{scoreError
					? t("Invalid expression: {error}", { error: scoreError })
					: t("Highest score survives a merge; ties go to the oldest.")}
			</p>
			<ScoreBoundsEditor />
			<div className="edit-map-modal__actions">
				<DeleteMapSection mapId={mapId} name={currentName} />
				<Button
					variant="primary"
					type="submit"
					disabled={name.trim().length === 0 || scoreError != null}
				>
					{t("Save")}
				</Button>
			</div>
		</form>
	);
}
