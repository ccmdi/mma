import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/primitives/Dialog";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Icon } from "@/components/primitives/Icon";
import { Switch } from "@/components/primitives/Switch";
import { Radio } from "@/components/primitives/Radio";
import { NSelect } from "@/components/primitives/NSelect";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { Checkbox } from "@/components/primitives/Checkbox";
import { openManual } from "@/store/router";
import { getEnrichFieldOptions, getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { getFieldDef, fieldLabel } from "@/lib/data/fieldDefRegistry";
import {
	setMapExtraFields,
	getMapState,
	renameField,
	deleteField,
	fieldCoverage,
	fieldValues,
} from "@/store/useMapStore";
import { useMapSetting } from "@/store/useMapSetting";
import type { ExtraFieldDef, MergeWinner } from "@/bindings.gen";
import { mdiClose, mdiDatabasePlusOutline, mdiInformationOutline } from "@mdi/js";
import { msg, t } from "@/lib/i18n";
import { Trans } from "@/components/primitives/Trans";

type Comparison = NonNullable<ExtraFieldDef["comparison"]>;
const FIELD_TYPES: ExtraFieldDef["type"][] = ["string", "number", "date", "month", "enum", "array"];
const TYPE_LABELS: Record<ExtraFieldDef["type"], string> = {
	string: msg("Text"),
	number: msg("Number"),
	date: msg("Date/time"),
	month: msg("Month (YYYY-MM)"),
	enum: msg("Enum"),
	array: msg("Array"),
};

// How a field is compared during disambiguation. "auto" = inferred from type.
type CompToken = "auto" | "linear" | "circular" | "categorical";
const COMP_OPTIONS: { token: CompToken; label: string }[] = [
	{ token: "auto", label: msg("Auto") },
	{ token: "linear", label: msg("Numeric") },
	{ token: "circular", label: msg("Circular") },
	{ token: "categorical", label: msg("Categorical") },
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
	values: string[] | null;
	labels: Record<string, string> | null;
	/** Field exists on this map (renameable, deletable, def-editable). */
	present: boolean;
	/** Field can be written by enrichment (has an Enrich checkbox). */
	enrichable: boolean;
}

/** Union of fields present on the map and fields enrichment could add. */
function buildRows(): FieldRow[] {
	const known = new Set(getMapState().knownFieldKeys);
	const enrichable = new Map(getEnrichFieldOptions().map((f) => [f.key, f]));
	const keys = [...known.union(enrichable)].sort();
	return keys.map((key) => {
		const def = getFieldDef(key);
		const present = known.has(key);
		return {
			key,
			draftKey: key,
			label: present ? fieldLabel(key) : (def?.label ?? enrichable.get(key)?.label ?? key),
			type: def?.type ?? "string",
			comparison: def?.comparison ?? null,
			values: def?.values ?? null,
			labels: def?.labels ?? null,
			present,
			enrichable: enrichable.has(key),
		};
	});
}

function CoverageIcon({ ratio }: { ratio: number }) {
	const pct = Math.round(ratio * 100);
	return (
		<svg className="manage-fields-table__coverage" width="18" height="18" viewBox="0 0 14 14">
			<title>{t("{pct}% of locations", { pct })}</title>
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
			<Tooltip content={t("Enrichment")} side="bottom">
				<DialogTrigger asChild>
					<button className="icon-button" type="button" aria-label={t("Enrichment")}>
						<Icon path={mdiDatabasePlusOutline} />
					</button>
				</DialogTrigger>
			</Tooltip>
			<DialogContent title={t("Enrichment")} className="enrichment-modal">
				<label className="enrichment-modal__toggle">
					<Switch
						checked={enrichMetadata}
						onChange={setEnrichMetadata}
						label={t("Enrich locations")}
					/>

					{t("Automatically save metadata to locations")}
					<button
						className="icon-button icon-button--inline"
						type="button"
						title={t("Open manual chapter")}
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
	const [enumPrompt, setEnumPrompt] = useState<{
		key: string;
		rows: { value: string; label: string }[];
		candidates: string[];
	} | null>(null);
	const [coverage, setCoverage] = useState<Map<string, number>>(new Map());
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [coverageEpoch, setCoverageEpoch] = useState(0);
	const skipBlurRef = useRef(false);

	useEffect(() => {
		const total = getMapState().locationCount;
		if (total === 0) return;
		void fieldCoverage({ kind: "all" }).then((counts) => {
			setCoverage(new Map(counts.map(([key, n]) => [key, n / total])));
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
			if (row.values) entry.values = row.values;
			if (row.labels) entry.labels = row.labels;
			if (row.comparison) entry.comparison = row.comparison;
			fields[row.key] = entry;
		}
		await setMapExtraFields(fields);
	};

	const updateRow = (key: string, patch: Partial<FieldRow>, commit = false) => {
		setRows((prev) => {
			const next = prev.map((r) => (r.key === key ? { ...r, ...patch } : r));
			if (commit) void commitDefs(next);
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

	const openEnumValues = async (row: FieldRow) => {
		const valueRows = (row.values ?? []).map((v) => ({ value: v, label: row.labels?.[v] ?? "" }));
		if (valueRows.length === 0) valueRows.push({ value: "", label: "" });
		setEnumPrompt({ key: row.key, rows: valueRows, candidates: [] });
		const have = new Set(row.values ?? []);
		const values = await fieldValues({ kind: "all" }, row.key);
		const candidates = values.filter((v) => !have.has(v));
		setEnumPrompt((p) => (p && p.key === row.key ? { ...p, candidates } : p));
	};

	const setEnumRow = (i: number, patch: Partial<{ value: string; label: string }>) =>
		setEnumPrompt((p) =>
			p ? { ...p, rows: p.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : p,
		);

	const addCandidates = () =>
		setEnumPrompt((p) => {
			if (!p) return p;
			const present = new Set(p.rows.map((r) => r.value.trim()));
			const fresh = p.candidates.filter((v) => !present.has(v));
			const kept = p.rows.filter((r) => r.value.trim() !== "" || r.label.trim() !== "");
			return {
				...p,
				rows: [...kept, ...fresh.map((v) => ({ value: v, label: "" }))],
				candidates: [],
			};
		});

	const confirmEnumValues = () => {
		if (!enumPrompt) return;
		const values: string[] = [];
		const labels: Record<string, string> = {};
		for (const r of enumPrompt.rows) {
			const v = r.value.trim();
			if (!v || values.includes(v)) continue;
			values.push(v);
			const l = r.label.trim();
			if (l) labels[v] = l;
		}
		updateRow(
			enumPrompt.key,
			{
				values: values.length > 0 ? values : null,
				labels: Object.keys(labels).length > 0 ? labels : null,
			},
			true,
		);
		setEnumPrompt(null);
	};

	const proposeRename = async (row: FieldRow) => {
		const target = row.draftKey.trim();
		if (!target || target === row.key) {
			updateRow(row.key, { draftKey: row.key });
			return;
		}
		const counts = await fieldCoverage({ kind: "all" });
		const affected = counts.find(([key]) => key === row.key)?.[1] ?? 0;
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
						<th>{t("Enrich")}</th>
						<th>{t("Field")}</th>
						<th>{t("Label")}</th>
						<th>{t("Type")}</th>
						<th>{t("Compare as")}</th>
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
								<Checkbox
									checked={row.enrichable && isEnrichOn(row.key)}
									disabled={!row.enrichable}
									title={row.enrichable ? undefined : t("Not an enrichment field")}
									onChange={(e) => toggleEnrich(row.key, e.target.checked)}
								/>
							</td>
							<td className="manage-fields-table__key">
								{editingKey === row.key ? (
									<TextInput
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
											void proposeRename(row);
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
								<TextInput
									value={row.label}
									disabled={!row.present}
									onChange={(e) => updateRow(row.key, { label: e.target.value })}
									onBlur={() => void commitDefs(rows)}
								/>
							</td>
							<td>
								<div className="manage-fields-table__type">
									<NSelect
										value={row.type}
										disabled={!row.present}
										onChange={(e) =>
											updateRow(row.key, { type: e.target.value as ExtraFieldDef["type"] }, true)
										}
									>
										{FIELD_TYPES.map((fieldType) => (
											<option key={fieldType} value={fieldType}>
												{t(TYPE_LABELS[fieldType])}
											</option>
										))}
									</NSelect>
									{row.type === "enum" && row.present && (
										<button
											className="manage-fields-table__values"
											type="button"
											title={t("Edit allowed values")}
											onClick={() => void openEnumValues(row)}
										>
											{row.values?.length
												? t("Values ({n})", { n: row.values.length })
												: t("Values...")}
										</button>
									)}
								</div>
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
												? t("Circular · {period}", { period: row.comparison.period })
												: t(o.label)}
										</option>
									))}
								</NSelect>
							</td>
							<td className="manage-fields-table__actions">
								<button
									className="manage-fields-table__delete"
									type="button"
									title={row.present ? t("Delete field") : undefined}
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
					title={renamePrompt?.merge ? t("Merge field") : t("Rename field")}
					className="period-prompt"
				>
					{renamePrompt && (
						<>
							<p className="period-prompt__help">
								{renamePrompt.merge ? (
									<>
										<Trans
											msg={{
												one: "Merge {from} into existing field {to} across {n} location. This cannot be undone.",
												other:
													"Merge {from} into existing field {to} across {n} locations. This cannot be undone.",
											}}
											from={<code>{renamePrompt.key}</code>}
											to={<code>{renamePrompt.target}</code>}
											n={renamePrompt.affected}
										/>
									</>
								) : (
									<>
										<Trans
											msg={{
												one: "Rename {from} to {to} across {n} location. This cannot be undone.",
												other: "Rename {from} to {to} across {n} locations. This cannot be undone.",
											}}
											from={<code>{renamePrompt.key}</code>}
											to={<code>{renamePrompt.target}</code>}
											n={renamePrompt.affected}
										/>
									</>
								)}
							</p>
							{renamePrompt.merge && (
								<fieldset className="manage-fields-action__winner">
									<legend>{t("On conflict, keep:")}</legend>
									<label>
										<Radio
											checked={renamePrompt.winner === "from"}
											onChange={() => setRenamePrompt({ ...renamePrompt, winner: "from" })}
										/>{" "}
										<Trans msg={"{field}\u2019s values"} field={<code>{renamePrompt.key}</code>} />
									</label>
									<label>
										<Radio
											checked={renamePrompt.winner === "to"}
											onChange={() => setRenamePrompt({ ...renamePrompt, winner: "to" })}
										/>{" "}
										<Trans
											msg={"{field}\u2019s values"}
											field={<code>{renamePrompt.target}</code>}
										/>
									</label>
								</fieldset>
							)}
							<div className="period-prompt__actions">
								<Button variant="primary" disabled={busy} onClick={() => void confirmRename()}>
									{renamePrompt.merge ? t("Merge") : t("Rename")}
								</Button>
								<Button disabled={busy} onClick={cancelRename}>
									{t("Cancel")}
								</Button>
							</div>
						</>
					)}
				</DialogContent>
			</Dialog>

			<Dialog open={deleteKey !== null} onOpenChange={(open) => !open && setDeleteKey(null)}>
				<DialogContent title={t("Delete field")} className="period-prompt">
					<p className="period-prompt__help">
						<Trans
							msg="Delete {field} and clear its values from every location? This cannot be undone."
							field={<code>{deleteKey}</code>}
						/>
					</p>
					<div className="period-prompt__actions">
						<Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
							{t("Delete field")}
						</Button>
						<Button disabled={busy} onClick={() => setDeleteKey(null)}>
							{t("Cancel")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			<Dialog open={enumPrompt !== null} onOpenChange={(open) => !open && setEnumPrompt(null)}>
				<DialogContent title={t("Enum values")} className="enum-values">
					<p className="period-prompt__help">
						<Trans
							msg="Allowed values for {field}. Labels are optional display names; filters, pivots and bulk edits offer these values in this order."
							field={<code>{enumPrompt?.key}</code>}
						/>
					</p>
					{enumPrompt?.rows.map((r, i) => (
						<div className="enum-values__row" key={i}>
							<TextInput
								value={r.value}
								placeholder={t("value")}
								onChange={(e) => setEnumRow(i, { value: e.target.value })}
							/>
							<TextInput
								value={r.label}
								placeholder={t("label")}
								onChange={(e) => setEnumRow(i, { label: e.target.value })}
							/>
							<button
								className="manage-fields-table__delete"
								type="button"
								title={t("Remove value")}
								onClick={() =>
									setEnumPrompt((p) => (p ? { ...p, rows: p.rows.filter((_, j) => j !== i) } : p))
								}
							>
								<Icon path={mdiClose} size={18} />
							</button>
						</div>
					))}
					<div className="enum-values__add">
						<Button
							onClick={() =>
								setEnumPrompt((p) =>
									p ? { ...p, rows: [...p.rows, { value: "", label: "" }] } : p,
								)
							}
						>
							{t("Add value")}
						</Button>
						{enumPrompt && enumPrompt.candidates.length > 0 && (
							<Button onClick={addCandidates}>
								{t("Add {n} found in data", { n: enumPrompt.candidates.length })}
							</Button>
						)}
					</div>
					<div className="period-prompt__actions">
						<Button variant="primary" onClick={confirmEnumValues}>
							{t("Save")}
						</Button>
						<Button onClick={() => setEnumPrompt(null)}>{t("Cancel")}</Button>
					</div>
				</DialogContent>
			</Dialog>

			<Dialog open={periodPrompt !== null} onOpenChange={(open) => !open && setPeriodPrompt(null)}>
				<DialogContent title={t("Circular period")} className="period-prompt">
					<p className="period-prompt__help">
						{t(
							"Value at which this field wraps around (e.g. 360 for degrees, 24 for hours, 12 for\n\t\t\t\t\t\tmonths).",
						)}
					</p>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							confirmPeriod();
						}}
					>
						<TextInput
							type="number"
							min="0"
							step="any"
							autoFocus
							value={periodPrompt?.value ?? ""}
							onChange={(e) => setPeriodPrompt((p) => (p ? { ...p, value: e.target.value } : p))}
						/>
						<div className="period-prompt__actions">
							<Button variant="primary" type="submit">
								{t("Set")}
							</Button>
							<Button onClick={() => setPeriodPrompt(null)}>{t("Cancel")}</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
