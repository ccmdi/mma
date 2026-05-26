import {
	useStagedImport,
	updateStagedDroppedFields,
	updateStagedTag,
	commitStagedImport,
	discardStagedImport,
} from "@/store/useMapStore";
import { fmt } from "@/lib/util/format";
import { useState } from "react";

export function ImportSidebar() {
	const staged = useStagedImport();
	const [importing, setImporting] = useState(false);

	if (!staged) return null;

	const sortedFields = [...staged.preview.fields].sort((a, b) => a.key.localeCompare(b.key));

	const toggleField = (key: string) => {
		const next = new Set(staged.droppedFields);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		updateStagedDroppedFields(next);
	};

	const handleCommit = async () => {
		setImporting(true);
		try {
			await commitStagedImport();
		} finally {
			setImporting(false);
		}
	};

	return (
		<section className="importer">
			<h3>Importing {fmt.format(staged.locationCount)} locations</h3>
			<p style={{ color: "var(--stone-6)" }}>{staged.name} &middot; {staged.preview.tags.length} tags</p>

			<span className="tag-input">
				<input
					className="tag-input__value"
					type="text"
					placeholder="Tag all as..."
					value={staged.tagName}
					onChange={(e) => updateStagedTag(e.target.value)}
				/>
			</span>

			{sortedFields.length > 0 && (
				<div className="importer__field-picker">
					<strong>Fields:</strong>
					<div className="importer__fields">
						{sortedFields.map((f) => (
							<label key={f.key} className="importer__field">
								<input
									type="checkbox"
									checked={!staged.droppedFields.has(f.key)}
									onChange={() => toggleField(f.key)}
								/>
								{f.key.startsWith("extra.") ? f.key.slice(6) : f.key}
								<small style={{ color: "var(--stone-6)" }}>({fmt.format(f.count)})</small>
							</label>
						))}
					</div>
				</div>
			)}

			{staged.preview.warnings.length > 0 && (
				<details>
					<summary>{staged.preview.warnings.length} warning(s)</summary>
					<ul>
						{staged.preview.warnings.map((w, i) => (
							<li key={i}>{w}</li>
						))}
					</ul>
				</details>
			)}

			<p className="importer__actions">
				<button
					className="button button--primary"
					disabled={importing}
					onClick={handleCommit}
				>
					{importing ? "Importing..." : "Import"}
				</button>
				<button
					className="button button--destructive"
					disabled={importing}
					onClick={discardStagedImport}
				>
					Discard
				</button>
			</p>
		</section>
	);
}
