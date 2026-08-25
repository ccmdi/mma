import { useState } from "react";
import { useMapState, getVisibleTags } from "@/store/useMapStore";
import { getImportStaging, confirmImport, cancelImport } from "@/store/importStaging";
import { useEventValue } from "@/lib/events";
import { fmt } from "@/lib/util/format";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { TagPill } from "@/components/primitives/TagPill";
import { tagColorFor, errText, toggleInSet } from "@/lib/util/util";
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
	const [tagInput, setTagInput] = useState("");
	const [importing, setImporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmAutoCommit, setConfirmAutoCommit] = useState(false);
	const [dontWarnAgain, setDontWarnAgain] = useState(false);

	if (!staging) return null;
	const { preview } = staging;
	const bulkTag = tagInput.trim();

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
			const r = await confirmImport([...droppedFields], bulkTag);
			t.end({ imported: r?.importedCount ?? 0 });
		} catch (e: unknown) {
			log.error("[import] failed:", e);
			setError(errText(e));
			setImporting(false);
		}
	};

	const sortedFields = [...preview.fields].sort((a, b) => a.key.localeCompare(b.key));

	return (
		<section className="importer import-sidebar">
			<header className="import-sidebar__header">
				<h2 className="import-sidebar__title">{t("Import")}</h2>
				<span className="import-sidebar__count">
					<Trans
						msg={{ one: "{count} location", other: "{count} locations" }}
						n={preview.locationCount}
						count={<span className="mono">{fmt.format(preview.locationCount)}</span>}
					/>
				</span>
			</header>

			{preview.tags.length > 0 && (
				<div className="import-sidebar__section">
					<span className="import-sidebar__label">{t("Tags in file")}</span>
					<ul className="tag-list">
						{preview.tags.map((t) => (
							<TagPill as="li" key={t.id} small color={t.color} label={t.name} />
						))}
					</ul>
				</div>
			)}

			{sortedFields.length > 0 && (
				<div className="import-sidebar__section">
					<span className="import-sidebar__label">{t("Fields")}</span>
					<div className="importer__fields">
						{sortedFields.map((f) => (
							<label key={f.key} className="importer__field">
								<Checkbox checked={!droppedFields.has(f.key)} onChange={() => toggleField(f.key)} />
								{f.key.startsWith("extra.") ? f.key.slice(6) : f.key}
								<small className="mono">({fmt.format(f.count)})</small>
							</label>
						))}
					</div>
				</div>
			)}

			<div className="import-sidebar__section">
				<span className="import-sidebar__label">{t("Tag all imported locations")}</span>
				<ul className="tag-list">
					<li>
						<div className="form-add-tag">
							<input
								className="form-add-tag__input"
								type="text"
								placeholder={t("Add a tag…")}
								value={tagInput}
								onChange={(e) => setTagInput(e.target.value)}
							/>
						</div>
					</li>
					{bulkTag && (
						<TagPill as="li" small color={tagColorFor(bulkTag, visibleTags)} label={bulkTag} />
					)}
				</ul>
			</div>

			{preview.warnings.length > 0 && (
				<details className="import-sidebar__section">
					<summary>
						{t({ one: "{n} warning", other: "{n} warnings" }, { n: preview.warnings.length })}
					</summary>
					<ul>
						{preview.warnings.map((w, i) => (
							<li key={i}>{w}</li>
						))}
					</ul>
				</details>
			)}

			{error && (
				<p className="importer__error">
					{t("Error:")} {error}
				</p>
			)}

			<div className="import-sidebar__actions">
				<Button variant="primary" onClick={requestImport} disabled={importing}>
					{importing ? t("Importing…") : t("Import")}
				</Button>
				<Button onClick={cancelImport} disabled={importing}>
					{t("Discard")}
				</Button>
			</div>

			<Dialog open={confirmAutoCommit} onOpenChange={setConfirmAutoCommit}>
				<DialogContent title={t("Large import")}>
					<p>
						{t(
							"This import has {n} locations, which is too many to keep as an undoable change. It will be committed automatically and cannot be undone afterward. You can still restore it later from history.",
							{ n: preview.locationCount },
						)}
					</p>
					<label className="import-sidebar__ack">
						<Checkbox
							checked={dontWarnAgain}
							onChange={(e) => setDontWarnAgain(e.target.checked)}
						/>

						{t("Don't warn me again")}
					</label>
					<div className="import-sidebar__actions">
						<Button variant="primary" onClick={proceedAutoCommit}>
							{t("Import and commit")}
						</Button>
						<Button onClick={() => setConfirmAutoCommit(false)}>{t("Cancel")}</Button>
					</div>
				</DialogContent>
			</Dialog>
		</section>
	);
}
