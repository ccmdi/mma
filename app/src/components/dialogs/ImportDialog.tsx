import { useState, useEffect } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { importFile } from "@/store/useMapStore";
import { fmt } from "@/lib/util/format";
import { cmd } from "@/lib/commands";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { log } from "@/lib/util/log";
import { debugSpan } from "@/lib/util/debug";
import { type ImportResult, type ImportPreview } from "@/types"

interface Props {
	onClose: () => void;
}

const FIELD_PREFS_KEY = "import-field-prefs";

function loadDroppedFields(): Set<string> {
	try {
		const stored = localStorage.getItem(FIELD_PREFS_KEY);
		if (stored) return new Set(JSON.parse(stored));
	} catch {
		// ignored
	}
	return new Set();
}

export function ImportDialog({ onClose }: Props) {
	const [status, setStatus] = useState<"picking" | "preview" | "importing" | "done">("picking");
	const [preview, setPreview] = useState<ImportPreview | null>(null);
	const [result, setResult] = useState<ImportResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [droppedFields, setDroppedFields] = useState(loadDroppedFields);

	useEffect(() => {
		let cancelled = false;

		(async () => {
			const path = await openDialog({
				multiple: false,
				filters: [{ name: "Map data", extensions: ["json", "csv"] }],
			});
			if (!path || cancelled) {
				onClose();
				return;
			}

			setStatus("preview");
			try {
				const p = await cmd.storeImportPreview(path);
				if (cancelled) return;
				setPreview(p);
			} catch (e: unknown) {
				log.error("[import] preview failed:", e);
				setError(e instanceof Error ? e.message : String(e));
				setStatus("done");
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	const toggleField = (key: string) => {
		setDroppedFields((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			localStorage.setItem(FIELD_PREFS_KEY, JSON.stringify([...next]));
			return next;
		});
	};

	const handleImport = async () => {
		if (!preview) return;
		setStatus("importing");
		const span = debugSpan("import:rust");
		try {
			const r = await importFile([...droppedFields]);
			span.end(`${r.importedCount} locs imported`);
			setResult(r);
			setStatus("done");
		} catch (e: unknown) {
			log.error("[import] failed:", e);
			setError(e instanceof Error ? e.message : String(e));
			setStatus("done");
		}
	};

	if (status === "picking") return null;

	if (status === "preview" && !preview) {
		return (
			<Dialog open onOpenChange={(open) => !open && onClose()}>
				<DialogContent title="Import file" className="export-modal">
					<div className="importer">
						<p>Parsing...</p>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	if (status === "preview" && preview) {
		const sortedFields = [...preview.fields].sort((a, b) => a.key.localeCompare(b.key));
		return (
			<Dialog open onOpenChange={(open) => !open && onClose()}>
				<DialogContent title="Import file" className="export-modal">
					<div className="importer">
						<p>
							{fmt.format(preview.locationCount)} locations, {preview.tags.length} tags
						</p>
						{sortedFields.length > 0 && (
							<div className="importer__field-picker">
								<strong>Fields:</strong>
								<div className="importer__fields">
									{sortedFields.map((f) => (
										<label key={f.key} className="importer__field">
											<input
												type="checkbox"
												checked={!droppedFields.has(f.key)}
												onChange={() => toggleField(f.key)}
											/>
											{f.key.startsWith("extra.") ? f.key.slice(6) : f.key}
											<small>({fmt.format(f.count)})</small>
										</label>
									))}
								</div>
							</div>
						)}
						{preview.warnings.length > 0 && (
							<details>
								<summary>{preview.warnings.length} warning(s)</summary>
								<ul>
									{preview.warnings.map((w, i) => (
										<li key={i}>{w}</li>
									))}
								</ul>
							</details>
						)}
						<p className="importer__actions">
							<button className="button button--primary" onClick={handleImport}>
								Import
							</button>
							<button className="button button--destructive" onClick={onClose}>
								Discard
							</button>
						</p>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	if (status === "importing") {
		return (
			<Dialog open onOpenChange={() => {}}>
				<DialogContent title="Import file" className="export-modal">
					<div className="importer">
						<p>Importing...</p>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title="Import file" className="export-modal">
				<div className="importer">
					{error ? (
						<p>Error: {error}</p>
					) : result ? (
						<>
							<p>
								Imported {fmt.format(result.importedCount)} locations.
							</p>
							{result.warnings.length > 0 && (
								<details>
									<summary>{result.warnings.length} warning(s)</summary>
									<ul>
										{result.warnings.map((w, i) => (
											<li key={i}>{w}</li>
										))}
									</ul>
								</details>
							)}
						</>
					) : null}
					<p className="importer__actions">
						<button className="button button--primary" onClick={onClose}>
							Close
						</button>
					</p>
				</div>
			</DialogContent>
		</Dialog>
	);
}
