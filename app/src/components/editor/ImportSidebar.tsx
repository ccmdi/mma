import { useState } from "react";
import { useMapState, getVisibleTags } from "@/store/useMapStore";
import { getImportStaging, confirmImport, cancelImport } from "@/store/importStaging";
import { useEventValue } from "@/lib/events";
import { fmt } from "@/lib/util/format";
import { colorForName } from "@/lib/util/color";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { ConfirmDialog } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { Section, Sidebar } from "@/components/primitives/Sidebar";
import { AddTagForm } from "@/components/editor/tags/AddTagForm";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Notice } from "@/components/primitives/Hint";
import { TagPill, TagPillButton } from "@/components/primitives/TagPill";
import { tagColorFor, toggleInSet } from "@/lib/util/util";
import { errText } from "@/lib/util/format";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { t } from "@/lib/i18n";
import { Trans } from "@/components/primitives/Trans";

const FIELD_PREFS_KEY = "import-field-prefs";
const AUTOCOMMIT_ACK_KEY = "import-autocommit-ack";

function autoCommitAcked(): boolean {
	return localStorage.getItem(AUTOCOMMIT_ACK_KEY) === "1";
}

function loadDroppedFields(): Set<string> {
	return new Set(getLocal<string[]>(FIELD_PREFS_KEY, []));
}

/** Import staging sidebar: field picker, file tags, bulk tag, and warnings. */
export function ImportSidebar() {
	const staging = useEventValue("import-markers:changed", getImportStaging);
	const visibleTags = useMapState(getVisibleTags);
	const [droppedFields, setDroppedFields] = useState(loadDroppedFields);
	const [bulkTags, setBulkTags] = useState<string[]>([]);
	const [tagInput, setTagInput] = useState("");
	const [importing, setImporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmAutoCommit, setConfirmAutoCommit] = useState(false);
	const [dontWarnAgain, setDontWarnAgain] = useState(false);

	if (!staging) return null;
	const { preview } = staging;
	const typed = tagInput.trim();
	const typedIsNew = typed !== "" && !bulkTags.some((n) => n.toLowerCase() === typed.toLowerCase());
	// The typed tag applies too, added or not (#105).
	const importTags = typedIsNew ? [...bulkTags, typed] : bulkTags;
	const addTag = () => {
		if (typedIsNew) setBulkTags(importTags);
		setTagInput("");
	};

	const toggleField = (key: string) => {
		setDroppedFields((prev) => {
			const next = toggleInSet(prev, key);
			setLocal(FIELD_PREFS_KEY, [...next]);
			return next;
		});
	};

	// Large imports autocommit (not undoable) -- warn first unless the user opted out.
	const requestImport = () => {
		if (preview.willAutoCommit && !autoCommitAcked()) {
			setConfirmAutoCommit(true);
			return;
		}
		void handleImport();
	};

	const proceedAutoCommit = () => {
		if (dontWarnAgain) localStorage.setItem(AUTOCOMMIT_ACK_KEY, "1");
		setConfirmAutoCommit(false);
		void handleImport();
	};

	const handleImport = async () => {
		setImporting(true);
		setError(null);
		const t = trace("import");
		try {
			const r = await confirmImport([...droppedFields], importTags);
			t.end({ imported: r?.importedCount ?? 0 });
		} catch (e: unknown) {
			log.error("[import] failed:", e);
			setError(errText(e));
			setImporting(false);
		}
	};

	const sortedFields = [...preview.fields].sort((a, b) => a.key.localeCompare(b.key));

	return (
		<Sidebar
			title={t("Import")}
			actions={
				<span className="text-muted">
					<Trans
						msg={{ one: "{count} location", other: "{count} locations" }}
						n={preview.locationCount}
						count={<span className="mono">{fmt.format(preview.locationCount)}</span>}
					/>
				</span>
			}
		>
			{preview.tags.length > 0 && (
				<Section title={t("Tags in file")}>
					<ul className="tag-list">
						{preview.tags.map((rec, i) => {
							const name = typeof rec.name === "string" ? rec.name : "";
							const color = typeof rec.color === "string" ? rec.color : colorForName(name);
							return <TagPill as="li" key={name || i} small color={color} label={name} />;
						})}
					</ul>
				</Section>
			)}

			{sortedFields.length > 0 && (
				<Section title={t("Fields")}>
					<div className="importer__fields">
						{sortedFields.map((f) => (
							<Checkbox
								key={f.key}
								checked={!droppedFields.has(f.key)}
								onChange={() => toggleField(f.key)}
							>
								{f.key.startsWith("extra.") ? f.key.slice(6) : f.key}{" "}
								<span className="mono text-muted">({fmt.format(f.count)})</span>
							</Checkbox>
						))}
					</div>
				</Section>
			)}

			<Section title={t("Tag all imported locations")}>
				<ul className="tag-list">
					<li>
						<AddTagForm value={tagInput} onChange={setTagInput} onAdd={addTag} />
					</li>
					{bulkTags.map((name) => (
						<TagPill
							as="li"
							key={name}
							small
							color={tagColorFor(name, visibleTags)}
							label={name}
							button={
								<TagPillButton
									variant="delete"
									onClick={() => setBulkTags(bulkTags.filter((n) => n !== name))}
								/>
							}
						/>
					))}
					{typedIsNew && (
						<TagPill as="li" small color={tagColorFor(typed, visibleTags)} label={typed} />
					)}
				</ul>
			</Section>

			{preview.warnings.length > 0 && (
				<Notice tone="warning">
					<details className="import-preview__warnings">
						<summary>
							{t({ one: "{n} warning", other: "{n} warnings" }, { n: preview.warnings.length })}
						</summary>
						<ul>
							{preview.warnings.map((w, i) => (
								<li key={i}>{w}</li>
							))}
						</ul>
					</details>
				</Notice>
			)}

			{error && (
				<Notice tone="error">
					{t("Error:")} {error}
				</Notice>
			)}

			<div className="importer__actions">
				<Button variant="primary" onClick={requestImport} disabled={importing}>
					{importing ? t("Importing...") : t("Import")}
				</Button>
				<Button onClick={cancelImport} disabled={importing}>
					{t("Discard")}
				</Button>
			</div>

			<ConfirmDialog
				open={confirmAutoCommit}
				onOpenChange={setConfirmAutoCommit}
				title={t("Large import")}
				size="md"
				message={t(
					"This import has {n} locations, which is too many to keep as an undoable change. It will be committed automatically and cannot be undone afterward. You can still restore it later from history.",
					{ n: preview.locationCount },
				)}
				confirmLabel={t("Import and commit")}
				onConfirm={proceedAutoCommit}
			>
				<Checkbox checked={dontWarnAgain} onChange={(e) => setDontWarnAgain(e.target.checked)}>
					{t("Don't warn me again")}
				</Checkbox>
			</ConfirmDialog>
		</Sidebar>
	);
}
