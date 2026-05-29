import { useState } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { setMapExtraFields, getKnownFieldKeys } from "@/store/useMapStore";
import type { ExtraFieldDef } from "@/types";
import type { ComparisonType } from "@/bindings.gen";
import { getFieldDef, getAllFieldDefs } from "@/lib/data/fieldDefRegistry";
const FIELD_TYPES: ExtraFieldDef["type"][] = ["string", "number", "date", "month", "enum"];
const TYPE_LABELS: Record<ExtraFieldDef["type"], string> = {
	string: "Text",
	number: "Number",
	date: "Date/time",
	month: "Month (YYYY-MM)",
	enum: "Enum",
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

function compToToken(c: ComparisonType | null | undefined): CompToken {
	if (!c) return "auto";
	return c.type;
}

function tokenToComp(t: CompToken, period: number): ComparisonType | undefined {
	switch (t) {
		case "auto": return undefined;
		case "linear": return { type: "linear" };
		case "categorical": return { type: "categorical" };
		case "circular": return { type: "circular", period };
	}
}

interface FieldRow {
	key: string;
	label: string;
	type: ExtraFieldDef["type"];
	comparison: ComparisonType | null;
	hasData: boolean;
}

export function ManageFieldsModal({ onClose }: { onClose: () => void }) {
	const knownKeys = getKnownFieldKeys();
	const allDefs = getAllFieldDefs();

	const allKeys = new Set<string>(knownKeys);
	for (const k of Object.keys(allDefs)) allKeys.add(k);

	const initialRows: FieldRow[] = [...allKeys].sort().map((key) => {
		const def = getFieldDef(key);
		return {
			key,
			label: def?.label ?? key,
			type: def?.type ?? "string",
			comparison: def?.comparison ?? null,
			hasData: knownKeys.has(key),
		};
	});

	const [rows, setRows] = useState(initialRows);

	const updateRow = (key: string, patch: Partial<FieldRow>) => {
		setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
	};

	const handleSave = async () => {
		const fields: Record<string, ExtraFieldDef> = {};
		for (const row of rows) {
			const entry: ExtraFieldDef = { type: row.type, label: row.label };
			const existing = getFieldDef(row.key);
			if (existing?.values) entry.values = existing.values;
			if (existing?.labels) entry.labels = existing.labels;
			if (row.comparison) entry.comparison = row.comparison;
			fields[row.key] = entry;
		}
		await setMapExtraFields(fields);
		onClose();
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent title="Manage metadata fields" className="manage-fields-modal">
				{rows.length === 0 ? (
					<p>No metadata fields found on this map.</p>
				) : (
					<table className="manage-fields-table">
						<thead>
							<tr>
								<th>Field</th>
								<th>Label</th>
								<th>Type</th>
								<th>Compare as</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.key}>
									<td className="manage-fields-table__key">
										{row.key}
										{!row.hasData && (
											<span className="manage-fields-table__no-data"> (no data)</span>
										)}
									</td>
									<td>
										<input
											className="input"
											value={row.label}
											onChange={(e) => updateRow(row.key, { label: e.target.value })}
										/>
									</td>
									<td>
										<select
											className="nselect"
											value={row.type}
											onChange={(e) =>
												updateRow(row.key, { type: e.target.value as ExtraFieldDef["type"] })
											}
										>
											{FIELD_TYPES.map((t) => (
												<option key={t} value={t}>
													{TYPE_LABELS[t]}
												</option>
											))}
										</select>
									</td>
									<td>
										<select
											className="nselect"
											value={compToToken(row.comparison)}
											onChange={(e) =>
												updateRow(row.key, { comparison: tokenToComp(e.target.value as CompToken, row.comparison?.type === "circular" ? row.comparison.period : DEFAULT_PERIOD) ?? null })
											}
										>
											{COMP_OPTIONS.map((o) => (
												<option key={o.token} value={o.token}>
													{o.label}
												</option>
											))}
										</select>
										{row.comparison?.type === "circular" && (
											<input
												className="input manage-fields-table__period"
												type="number"
												min="0"
												step="any"
												value={row.comparison.period}
												title="Value at which the field wraps around (e.g. 360 for degrees, 24 for hours, 12 for months)"
												onChange={(e) => {
													const period = parseFloat(e.target.value);
													updateRow(row.key, {
														comparison: { type: "circular", period: Number.isFinite(period) ? period : DEFAULT_PERIOD },
													});
												}}
											/>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<div className="manage-fields-modal__actions">
					<button className="button button--primary" type="button" onClick={handleSave}>
						Save
					</button>
					<button className="button" type="button" onClick={onClose}>
						Cancel
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
