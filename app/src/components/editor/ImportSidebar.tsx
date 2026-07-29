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
import { TagPill, TagPillButton } from "@/components/primitives/TagPill";

const FIELD_PREFS_KEY = "import-field-prefs";
const AUTOCOMMIT_ACK_KEY = "import-autocommit-ack";

function autoCommitAcked(): boolean {
	return localStorage.getItem(AUTOCOMMIT_ACK_KEY) === "1";
}

function loadDroppedFields(): Set<string> {
	try {
		const stored = localStorage.getItem(FIELD_PREFS_KEY);
		if (stored) return new Set(JSON.parse(stored));
	} catch {
		// ignored
	}
	return new Set();
}

/** Placeholder pill color for a not-yet-created tag; Rust assigns the real one on commit. */
function previewColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return `hsl(${h % 360} 60% 55%)`;
}

/** Import staging sidebar: field picker, file tags, bulk tag, and warnings. */
export function ImportSidebar() {
	const staging = useEventValue("import-markers:changed", getImportStaging);
	const visibleTags = useMapState(getVisibleTags);
	const [droppedFields, setDroppedFields] = useState(loadDroppedFields);
	const [bulkTag, setBulkTag] = useState<string | null>(null);
	const [tagInput, setTagInput] = useState("");
	const [importing, setImporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmAutoCommit, setConfirmAutoCommit] = useState(false);
	const [dontWarnAgain, setDontWarnAgain] = useState(false);

	if (!staging) return null;
	const { preview } = staging;

	const toggleField = (key: string) => {
		setDroppedFields((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			localStorage.setItem(FIELD_PREFS_KEY, JSON.stringify([...next]));
			return next;
		});
	};

	const commitBulkTag = (e: React.FormEvent) => {
		e.preventDefault();
		const name = tagInput.trim();
		if (!name) return;
		setBulkTag(name);
		setTagInput("");
	};

	// Large imports autocommit (not undoable) -- warn first unless the user opted out.
	const requestImport = () => {
		if (preview.willAutoCommit && !autoCommitAcked()) {
			setConfirmAutoCommit(true);
			return;
		}
		handleImport();
	};

	const proceedAutoCommit = () => {
		if (dontWarnAgain) localStorage.setItem(AUTOCOMMIT_ACK_KEY, "1");
		setConfirmAutoCommit(false);
		handleImport();
	};

	const handleImport = async () => {
		setImporting(true);
		setError(null);
		const t = trace("import");
		try {
			const r = await confirmImport([...droppedFields], bulkTag ?? tagInput);
			t.end({ imported: r?.importedCount ?? 0 });
		} catch (e: unknown) {
			log.error("[import] failed:", e);
			setError(e instanceof Error ? e.message : String(e));
			setImporting(false);
		}
	};

	const sortedFields = [...preview.fields].sort((a, b) => a.key.localeCompare(b.key));

	// Reuse an existing tag's color if the name matches; else a placeholder.
	const existing = bulkTag
		? visibleTags.find((t) => t.name.toLowerCase() === bulkTag.toLowerCase())
		: undefined;
	const bulkColor = existing?.color ?? (bulkTag ? previewColor(bulkTag) : "");

	return (
		<section className="importer import-sidebar">
			<header className="import-sidebar__header">
				<h2 className="import-sidebar__title">Import</h2>
				<span className="import-sidebar__count">
					<span className="mono">{fmt.format(preview.locationCount)}</span> location
					{preview.locationCount !== 1 ? "s" : ""}
				</span>
			</header>

			{preview.tags.length > 0 && (
				<div className="import-sidebar__section">
					<span className="import-sidebar__label">Tags in file</span>
					<ul className="tag-list">
						{preview.tags.map((t) => (
							<TagPill as="li" key={t.id} small color={t.color} label={t.name} />
						))}
					</ul>
				</div>
			)}

			{sortedFields.length > 0 && (
				<div className="import-sidebar__section">
					<span className="import-sidebar__label">Fields</span>
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
				<span className="import-sidebar__label">Tag all imported locations</span>
				<ul className="tag-list">
					{bulkTag ? (
						<TagPill
							as="li"
							small
							color={bulkColor}
							label={bulkTag}
							button={<TagPillButton variant="delete" onClick={() => setBulkTag(null)} />}
						/>
					) : (
						<li>
							<form className="form-add-tag" onSubmit={commitBulkTag}>
								<input
									className="form-add-tag__input"
									type="text"
									placeholder="Add a tag…"
									value={tagInput}
									onChange={(e) => setTagInput(e.target.value)}
								/>
							</form>
						</li>
					)}
				</ul>
			</div>

			{preview.warnings.length > 0 && (
				<details className="import-sidebar__section">
					<summary>{preview.warnings.length} warning(s)</summary>
					<ul>
						{preview.warnings.map((w, i) => (
							<li key={i}>{w}</li>
						))}
					</ul>
				</details>
			)}

			{error && <p className="importer__error">Error: {error}</p>}

			<div className="import-sidebar__actions">
				<Button variant="primary" onClick={requestImport} disabled={importing}>
					{importing ? "Importing…" : "Import"}
				</Button>
				<Button onClick={cancelImport} disabled={importing}>
					Discard
				</Button>
			</div>

			<Dialog open={confirmAutoCommit} onOpenChange={setConfirmAutoCommit}>
				<DialogContent title="Large import">
					<p>
						This import has {fmt.format(preview.locationCount)} locations, which is too many to keep
						as an undoable change. It will be committed automatically and cannot be undone
						afterward. You can still restore it later from history.
					</p>
					<label className="import-sidebar__ack">
						<Checkbox
							checked={dontWarnAgain}
							onChange={(e) => setDontWarnAgain(e.target.checked)}
						/>
						Don't warn me again
					</label>
					<div className="import-sidebar__actions">
						<Button variant="primary" onClick={proceedAutoCommit}>
							Import and commit
						</Button>
						<Button onClick={() => setConfirmAutoCommit(false)}>Cancel</Button>
					</div>
				</DialogContent>
			</Dialog>
		</section>
	);
}
