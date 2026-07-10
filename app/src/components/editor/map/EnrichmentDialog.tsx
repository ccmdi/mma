import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/primitives/Dialog";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Icon } from "@/components/primitives/Icon";
import { Switch } from "@/components/primitives/Switch";
import { NSelect } from "@/components/primitives/NSelect";
import { openManual } from "@/store/router";
import { getEnrichFieldOptions, getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { getFieldDef, fieldLabel } from "@/lib/data/fieldDefRegistry";
import {
	setMapExtraFields,
	getKnownFieldKeys,
	getCurrentMap,
	renameField,
	deleteField,
	fetchAllLocations,
} from "@/store/useMapStore";
import { useMapSetting } from "@/store/useMapSetting";
import type { ExtraFieldDef } from "@/bindings.gen";
import type { MergeWinner } from "@/lib/data/fieldOps";
import { mdiClose, mdiDatabasePlusOutline, mdiInformationOutline } from "@mdi/js";

type Comparison = NonNullable<ExtraFieldDef["comparison"]>;
const FIELD_TYPES: ExtraFieldDef["type"][] = ["string", "number", "date", "month", "enum", "array"];
const TYPE_LABELS: Record<ExtraFieldDef["type"], string> = {
	string: "Text",
	number: "Number",
	date: "Date/time",
	month: "Month (YYYY-MM)",
	enum: "Enum",
	array: "Array",
};

// How a field is compared during disambiguation. "auto" = inferred from type.
type CompToken = "auto" | "linear" | "circular" | "categorical";
const COMP_OPTIONS: { token: CompToken; label: string }[] = [
	{ token: "auto", label: "Auto" },
	{ token: "linear", label: "Numeric" },
	{ token: "circular", label: "Circular" },
	{ token: "categorical", label: "Categorical" },
];
const DEFAULT_PERIOD = 360;

function compToToken(c: ExtraFieldDef["comparison"]): CompToken {
	if (!c) return "auto";
	return c.type;
}

function tokenToComp(t: CompToken, period: number): Comparison | undefined {
	switch (t) {
		case "auto":
			return undefined;
		case "linear":
			return { type: "linear" };
		case "categorical":
			return { type: "categorical" };
		case "circular":
			return { type: "circular", period };
	}
}

interface FieldRow {
	key: string;
	draftKey: string;
	label: string;
	type: ExtraFieldDef["type"];
	comparison: ExtraFieldDef["comparison"];
	/** Field exists on this map (renameable, deletable, def-editable). */
	present: boolean;
	/** Field can be written by enrichment (has an Enrich checkbox). */
	enrichable: boolean;
}

/** Union of fields present on the map and fields enrichment could add. */
function buildRows(): FieldRow[] {
	const known = new Set(getKnownFieldKeys());
	const enrichable = new Map(getEnrichFieldOptions().map((f) => [f.key, f]));
	const keys = [...new Set([...known, ...enrichable.keys()])].sort();
	return keys.map((key) => {
		const def = getFieldDef(key);
		const present = known.has(key);
		return {
			key,
			draftKey: key,
			label: present ? fieldLabel(key) : (def?.label ?? enrichable.get(key)?.label ?? key),
			type: def?.type ?? "string",
			comparison: def?.comparison ?? null,
			present,
			enrichable: enrichable.has(key),
		};
	});
}

function CoverageIcon({ ratio }: { ratio: number }) {
	const pct = Math.round(ratio * 100);
	return (
		<svg className="manage-fields-table__coverage" width="18" height="18" viewBox="0 0 14 14">
			<title>{pct}% of locations</title>
			<circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3" />
			{ratio > 0 && (
				<circle
					cx="7"
					cy="7"
					r="6"
					fill="currentColor"
					opacity="0.5"
					style={{ clipPath: `inset(${(1 - ratio) * 100}% 0 0 0)` }}
				/>
			)}
		</svg>
	);
}

interface RenamePrompt {
	key: string;
	target: string;
	winner: MergeWinner;
	affected: number;
	merge: boolean;
}

/** Header-level home for enrichment and metadata fields: the enrich-on-add toggle
 *  plus one live table covering which fields to enrich and how each field is
 *  defined (label, type, comparison, rename, delete). Every edit applies
 *  immediately; destructive ones confirm first. */
export function EnrichmentButton() {
	const [open, setOpen] = useState(false);
	const [enrichMetadata, setEnrichMetadata] = useMapSetting("enrichMetadata");
	const [enrichFields, setEnrichFields] = useMapSetting("enrichFields");

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<Tooltip content="Enrichment" side="bottom">
				<DialogTrigger asChild>
					<button className="icon-button" type="button" aria-label="Enrichment">
						<Icon path={mdiDatabasePlusOutline} />
					</button>
				</DialogTrigger>
			</Tooltip>
			<DialogContent title="Enrichment" className="enrichment-modal">
				<label className="enrichment-modal__toggle">
					<Switch checked={enrichMetadata} onChange={setEnrichMetadata} label="Enrich locations" />
					Automatically save metadata to locations
					<button
						className="icon-button icon-button--inline"
						type="button"
						title="Open manual chapter"
						style={{ marginLeft: "0.4rem" }}
						onClick={(e) => {
							e.preventDefault();
							setOpen(false);
							openManual("enrichment");
						}}
					>
						<Icon path={mdiInformationOutline} size={18} />
					</button>
				</label>
				{open && <FieldsTable enrichFields={enrichFields} setEnrichFields={setEnrichFields} />}
			</DialogContent>
		</Dialog>
	);
}

function FieldsTable({
	enrichFields,
	setEnrichFields,
}: {
	enrichFields: string[] | null;
	setEnrichFields: (v: string[] | null) => void;
}) {
	const [rows, setRows] = useState(buildRows);
	const [renamePrompt, setRenamePrompt] = useState<RenamePrompt | null>(null);
	const [deleteKey, setDeleteKey] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [periodPrompt, setPeriodPrompt] = useState<{ key: string; value: string } | null>(null);
	const [coverage, setCoverage] = useState<Map<string, number>>(new Map());
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [coverageEpoch, setCoverageEpoch] = useState(0);
	const skipBlurRef = useRef(false);

	useEffect(() => {
		const total = getCurrentMap()?.meta.locationCount ?? 0;
		if (total === 0) return;
		fetchAllLocations().then((locs) => {
			const counts = new Map<string, number>();
			for (const loc of locs) {
				if (!loc.extra) continue;
				for (const key of Object.keys(loc.extra)) {
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
			}
			const ratios = new Map<string, number>();
			for (const [key, count] of counts) ratios.set(key, count / total);
			setCoverage(ratios);
		});
	}, [coverageEpoch]);

	const existingKeys = new Set(rows.filter((r) => r.present).map((r) => r.key));

	const refresh = () => {
		setRows(buildRows());
		setCoverageEpoch((n) => n + 1);
	};

	// Live commit: field defs apply on every edit (blur for text, change for selects).
	const commitDefs = async (next: FieldRow[]) => {
		const fields: Record<string, ExtraFieldDef> = {};
		for (const row of next.filter((r) => r.present)) {
			const entry: ExtraFieldDef = { type: row.type, label: row.label };
			const existing = getFieldDef(row.key);
			if (existing?.values) entry.values = existing.values;
			if (existing?.labels) entry.labels = existing.labels;
			if (row.comparison) entry.comparison = row.comparison;
			fields[row.key] = entry;
		}
		await setMapExtraFields(fields);
	};

	const updateRow = (key: string, patch: Partial<FieldRow>, commit = false) => {
		setRows((prev) => {
			const next = prev.map((r) => (r.key === key ? { ...r, ...patch } : r));
			if (commit) commitDefs(next);
			return next;
		});
	};

	const isEnrichOn = (key: string) => {
		if (enrichFields) return enrichFields.includes(key);
		return !getEnrichFieldOptions().find((f) => f.key === key)?.defaultOff;
	};

	const toggleEnrich = (key: string, on: boolean) => {
		const defaultKeys = getDefaultEnrichKeys();
		const current = enrichFields ?? [...defaultKeys];
		const next = on ? [...current, key] : current.filter((k) => k !== key);
		const isDefault =
			next.length === defaultKeys.length && next.every((k) => defaultKeys.includes(k));
		setEnrichFields(isDefault ? null : next);
	};

	const confirmPeriod = () => {
		if (!periodPrompt) return;
		const period = parseFloat(periodPrompt.value);
		updateRow(
			periodPrompt.key,
			{
				comparison: {
					type: "circular",
					period: Number.isFinite(period) && period > 0 ? period : DEFAULT_PERIOD,
				},
			},
			true,
		);
		setPeriodPrompt(null);
	};

	const proposeRename = async (row: FieldRow) => {
		const target = row.draftKey.trim();
		if (!target || target === row.key) {
			updateRow(row.key, { draftKey: row.key });
			return;
		}
		const locs = await fetchAllLocations();
		const affected = locs.filter((l) => l.extra && row.key in l.extra).length;
		setRenamePrompt({
			key: row.key,
			target,
			winner: "from",
			affected,
			merge: existingKeys.has(target),
		});
	};

	const confirmRename = async () => {
		if (!renamePrompt) return;
		setBusy(true);
		try {
			await renameField(renamePrompt.key, renamePrompt.target, renamePrompt.winner);
		} finally {
			setBusy(false);
		}
		setRenamePrompt(null);
		refresh();
	};

	const cancelRename = () => {
		if (renamePrompt) updateRow(renamePrompt.key, { draftKey: renamePrompt.key });
		setRenamePrompt(null);
	};

	const confirmDelete = async () => {
		if (!deleteKey) return;
		setBusy(true);
		try {
			await deleteField(deleteKey);
		} finally {
			setBusy(false);
		}
		setDeleteKey(null);
		refresh();
	};

	return (
		<>
			<table className="manage-fields-table">
				<thead>
					<tr>
						<th />
						<th>Enrich</th>
						<th>Field</th>
						<th>Label</th>
						<th>Type</th>
						<th>Compare as</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.key}>
							<td className="manage-fields-table__coverage-cell">
								<CoverageIcon ratio={coverage.get(row.key) ?? 0} />
							</td>
							<td className="manage-fields-table__enrich">
								<input
									type="checkbox"
									checked={row.enrichable && isEnrichOn(row.key)}
									disabled={!row.enrichable}
									title={row.enrichable ? undefined : "Not an enrichment field"}
									onChange={(e) => toggleEnrich(row.key, e.target.checked)}
								/>
							</td>
							<td className="manage-fields-table__key">
								{editingKey === row.key ? (
									<input
										className="input"
										value={row.draftKey}
										disabled={busy}
										autoFocus
										onChange={(e) => updateRow(row.key, { draftKey: e.target.value })}
										onFocus={(e) => e.target.select()}
										onBlur={() => {
											if (skipBlurRef.current) {
												skipBlurRef.current = false;
												updateRow(row.key, { draftKey: row.key });
												setEditingKey(null);
												return;
											}
											setEditingKey(null);
											proposeRename(row);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") e.currentTarget.blur();
											else if (e.key === "Escape") {
												skipBlurRef.current = true;
												e.currentTarget.blur();
											}
										}}
									/>
								) : (
									<span
										className="manage-fields-table__key-text"
										onClick={row.present ? () => setEditingKey(row.key) : undefined}
									>
										{row.key}
									</span>
								)}
							</td>
							<td>
								<input
									className="input"
									value={row.label}
									disabled={!row.present}
									onChange={(e) => updateRow(row.key, { label: e.target.value })}
									onBlur={() => commitDefs(rows)}
								/>
							</td>
							<td>
								<NSelect
									value={row.type}
									disabled={!row.present}
									onChange={(e) =>
										updateRow(row.key, { type: e.target.value as ExtraFieldDef["type"] }, true)
									}
								>
									{FIELD_TYPES.map((t) => (
										<option key={t} value={t}>
											{TYPE_LABELS[t]}
										</option>
									))}
								</NSelect>
							</td>
							<td>
								<NSelect
									value={compToToken(row.comparison)}
									disabled={!row.present}
									onChange={(e) => {
										const token = e.target.value as CompToken;
										// Circular needs a period: prompt for it instead of committing inline,
										// so the cell never grows. Cancelling leaves the select on its old value.
										if (token === "circular") {
											const current =
												row.comparison?.type === "circular"
													? row.comparison.period
													: DEFAULT_PERIOD;
											setPeriodPrompt({ key: row.key, value: String(current) });
										} else {
											updateRow(
												row.key,
												{ comparison: tokenToComp(token, DEFAULT_PERIOD) ?? null },
												true,
											);
										}
									}}
								>
									{COMP_OPTIONS.map((o) => (
										<option key={o.token} value={o.token}>
											{o.token === "circular" && row.comparison?.type === "circular"
												? `Circular · ${row.comparison.period}`
												: o.label}
										</option>
									))}
								</NSelect>
							</td>
							<td className="manage-fields-table__actions">
								<button
									className="manage-fields-table__delete"
									type="button"
									title={row.present ? "Delete field" : undefined}
									disabled={busy || !row.present}
									onClick={() => setDeleteKey(row.key)}
								>
									<Icon path={mdiClose} size={18} />
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			<Dialog open={renamePrompt !== null} onOpenChange={(open) => !open && cancelRename()}>
				<DialogContent
					title={renamePrompt?.merge ? "Merge field" : "Rename field"}
					className="period-prompt"
				>
					{renamePrompt && (
						<>
							<p className="period-prompt__help">
								{renamePrompt.merge ? (
									<>
										Merge <code>{renamePrompt.key}</code> into existing field{" "}
										<code>{renamePrompt.target}</code> across {renamePrompt.affected} location
										{renamePrompt.affected === 1 ? "" : "s"}. This cannot be undone.
									</>
								) : (
									<>
										Rename <code>{renamePrompt.key}</code> to <code>{renamePrompt.target}</code>{" "}
										across {renamePrompt.affected} location
										{renamePrompt.affected === 1 ? "" : "s"}. This cannot be undone.
									</>
								)}
							</p>
							{renamePrompt.merge && (
								<fieldset className="manage-fields-action__winner">
									<legend>On conflict, keep:</legend>
									<label>
										<input
											type="radio"
											checked={renamePrompt.winner === "from"}
											onChange={() => setRenamePrompt({ ...renamePrompt, winner: "from" })}
										/>{" "}
										<code>{renamePrompt.key}</code>&apos;s values
									</label>
									<label>
										<input
											type="radio"
											checked={renamePrompt.winner === "to"}
											onChange={() => setRenamePrompt({ ...renamePrompt, winner: "to" })}
										/>{" "}
										<code>{renamePrompt.target}</code>&apos;s values
									</label>
								</fieldset>
							)}
							<div className="period-prompt__actions">
								<button
									className="button button--primary"
									type="button"
									disabled={busy}
									onClick={confirmRename}
								>
									{renamePrompt.merge ? "Merge" : "Rename"}
								</button>
								<button className="button" type="button" disabled={busy} onClick={cancelRename}>
									Cancel
								</button>
							</div>
						</>
					)}
				</DialogContent>
			</Dialog>

			<Dialog open={deleteKey !== null} onOpenChange={(open) => !open && setDeleteKey(null)}>
				<DialogContent title="Delete field" className="period-prompt">
					<p className="period-prompt__help">
						Delete <code>{deleteKey}</code> and clear its values from every location? This cannot be
						undone.
					</p>
					<div className="period-prompt__actions">
						<button
							className="button button--danger"
							type="button"
							disabled={busy}
							onClick={confirmDelete}
						>
							Delete field
						</button>
						<button
							className="button"
							type="button"
							disabled={busy}
							onClick={() => setDeleteKey(null)}
						>
							Cancel
						</button>
					</div>
				</DialogContent>
			</Dialog>

			<Dialog open={periodPrompt !== null} onOpenChange={(open) => !open && setPeriodPrompt(null)}>
				<DialogContent title="Circular period" className="period-prompt">
					<p className="period-prompt__help">
						Value at which this field wraps around (e.g. 360 for degrees, 24 for hours, 12 for
						months).
					</p>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							confirmPeriod();
						}}
					>
						<input
							className="input"
							type="number"
							min="0"
							step="any"
							autoFocus
							value={periodPrompt?.value ?? ""}
							onChange={(e) => setPeriodPrompt((p) => (p ? { ...p, value: e.target.value } : p))}
						/>
						<div className="period-prompt__actions">
							<button className="button button--primary" type="submit">
								Set
							</button>
							<button className="button" type="button" onClick={() => setPeriodPrompt(null)}>
								Cancel
							</button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
