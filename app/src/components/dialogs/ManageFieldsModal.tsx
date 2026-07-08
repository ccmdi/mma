import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { NSelect } from "@/components/primitives/NSelect";
import { mdiClose } from "@mdi/js";
import {
	setMapExtraFields,
	getKnownFieldKeys,
	getCurrentMap,
	renameField,
	deleteField,
	fetchAllLocations,
} from "@/store/useMapStore";
import type { ExtraFieldDef } from "@/bindings.gen";
import type { MergeWinner } from "@/lib/data/fieldOps";
import { getFieldDef, fieldLabel } from "@/lib/data/fieldDefRegistry";

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
}

function CoverageIcon({ ratio }: { ratio: number }) {
	const pct = Math.round(ratio * 100);
	return (
		<svg className="manage-fields-table__coverage" width="14" height="14" viewBox="0 0 14 14">
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

function buildRows(): FieldRow[] {
	return [...getKnownFieldKeys()].sort().map((key) => {
		const def = getFieldDef(key);
		return {
			key,
			draftKey: key,
			label: fieldLabel(key),
			type: def?.type ?? "string",
			comparison: def?.comparison ?? null,
		};
	});
}

export function ManageFieldsModal({ onClose }: { onClose: () => void }) {
	const [rows, setRows] = useState(buildRows);
	const [renamePrompt, setRenamePrompt] = useState<RenamePrompt | null>(null);
	const [deleteKey, setDeleteKey] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [periodPrompt, setPeriodPrompt] = useState<{ key: string; value: string } | null>(null);
	const [coverage, setCoverage] = useState<Map<string, number>>(new Map());
	const [editingKey, setEditingKey] = useState<string | null>(null);
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
	}, []);

	const existingKeys = new Set(rows.map((r) => r.key));

	const updateRow = (key: string, patch: Partial<FieldRow>) => {
		setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
	};

	const confirmPeriod = () => {
		if (!periodPrompt) return;
		const period = parseFloat(periodPrompt.value);
		updateRow(periodPrompt.key, {
			comparison: {
				type: "circular",
				period: Number.isFinite(period) && period > 0 ? period : DEFAULT_PERIOD,
			},
		});
		setPeriodPrompt(null);
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
		setRows(buildRows());
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
		setRows(buildRows());
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
								<th />
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
												onClick={() => setEditingKey(row.key)}
											>
												{row.key}
											</span>
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
										<NSelect
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
										</NSelect>
									</td>
									<td>
										<NSelect
											value={compToToken(row.comparison)}
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
													updateRow(row.key, {
														comparison: tokenToComp(token, DEFAULT_PERIOD) ?? null,
													});
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
											title="Delete field"
											disabled={busy}
											onClick={() => setDeleteKey(row.key)}
										>
											<Icon path={mdiClose} size={18} />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}

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
							Delete <code>{deleteKey}</code> and clear its values from every location? This cannot
							be undone.
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

				<div className="manage-fields-modal__actions">
					<button
						className="button button--primary"
						type="button"
						disabled={busy}
						onClick={handleSave}
					>
						Save
					</button>
					<button className="button" type="button" disabled={busy} onClick={onClose}>
						Cancel
					</button>
				</div>

				<Dialog
					open={periodPrompt !== null}
					onOpenChange={(open) => !open && setPeriodPrompt(null)}
				>
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
			</DialogContent>
		</Dialog>
	);
}
