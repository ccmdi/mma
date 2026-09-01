import { useState, useEffect, useMemo } from "react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/primitives/Dialog";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Icon } from "@/components/primitives/Icon";
import { Switch } from "@/components/primitives/Switch";
import { SwitchRow } from "@/components/primitives/SwitchRow";
import { SegmentedControl } from "@/components/primitives/Sidebar";
import { Radio } from "@/components/primitives/Radio";
import { NSelect } from "@/components/primitives/NSelect";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { openManual } from "@/store/router";
import { getEnrichFieldOptions, getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { getFieldDef, fieldLabel, getKnownFieldKeys } from "@/lib/data/fieldDefRegistry";
import {
	deleteField,
	coverage as readCoverage,
	fieldValues,
	getMapState,
	renameField,
	setMapExtraFields,
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
	label: string;
	type: ExtraFieldDef["type"];
	comparison: ExtraFieldDef["comparison"];
	values: string[] | null;
	labels: Record<string, string> | null;
}

/** Fields that exist on this map: the only ones with a schema to edit. */
function buildRows(): FieldRow[] {
	return [...getKnownFieldKeys()].sort().map((key) => {
		const def = getFieldDef(key);
		return {
			key,
			label: fieldLabel(key),
			type: def?.type ?? "string",
			comparison: def?.comparison ?? null,
			values: def?.values ?? null,
			labels: def?.labels ?? null,
		};
	});
}

/** Share of the map's locations carrying each field. Refetched when `epoch` bumps. */
function useCoverage(epoch: number): Map<string, number> {
	const [coverage, setCoverage] = useState<Map<string, number>>(new Map());
	useEffect(() => {
		const total = getMapState().locationCount;
		if (total === 0) return;
		void readCoverage({ type: "Everything" }).then((counts) => {
			setCoverage(new Map(counts.map(([key, n]) => [key, n / total])));
		});
	}, [epoch]);
	return coverage;
}

function CoverageBar({ ratio }: { ratio: number }) {
	const pct = Math.round(ratio * 100);
	return (
		<span className="coverage-bar" title={t("{pct}% of locations", { pct })}>
			<span className="coverage-bar__track">
				<span className="coverage-bar__fill" style={{ width: `${pct}%` }} />
			</span>
			<span className="coverage-bar__pct mono">{pct}%</span>
		</span>
	);
}

interface RenamePrompt {
	key: string;
	target: string;
	winner: MergeWinner;
	affected: number;
	merge: boolean;
}

type Tab = "enrich" | "fields";

const TABS = [
	{ value: "enrich" as const, label: msg("Enrich") },
	{ value: "fields" as const, label: msg("Fields") },
];

/** Header-level home for enrichment and metadata fields. Two jobs, two tabs: which
 *  fields to enrich (the everyday one), and how each field on the map is defined. */
export function EnrichmentButton() {
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<Tab>("enrich");
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
				<SegmentedControl
					className="segmented--fill enrichment-modal__tabs"
					options={TABS.map((o) => ({ value: o.value, label: t(o.label) }))}
					value={tab}
					onChange={setTab}
				/>
				{open && tab === "enrich" && (
					<EnrichTab
						enrichMetadata={enrichMetadata}
						setEnrichMetadata={setEnrichMetadata}
						enrichFields={enrichFields}
						setEnrichFields={setEnrichFields}
						onOpenManual={() => {
							setOpen(false);
							openManual("enrichment");
						}}
					/>
				)}
				{open && tab === "fields" && <FieldsTab />}
			</DialogContent>
		</Dialog>
	);
}

/** The everyday view: one switch per enrichable field, and nothing about schema. */
export function EnrichTab({
	enrichMetadata,
	setEnrichMetadata,
	enrichFields,
	setEnrichFields,
	onOpenManual,
}: {
	enrichMetadata: boolean;
	setEnrichMetadata: (v: boolean) => void;
	enrichFields: string[] | null;
	setEnrichFields: (v: string[] | null) => void;
	onOpenManual: () => void;
}) {
	const coverage = useCoverage(0);
	// Declaration order, not alphabetical: it already groups the default set first.
	const options = getEnrichFieldOptions();

	const isOn = (key: string) =>
		enrichFields ? enrichFields.includes(key) : !options.find((f) => f.key === key)?.defaultOff;

	const toggle = (key: string, on: boolean) => {
		const defaults = getDefaultEnrichKeys();
		const current = enrichFields ?? [...defaults];
		const next = on ? [...current, key] : current.filter((k) => k !== key);
		const isDefault = next.length === defaults.length && next.every((k) => defaults.includes(k));
		setEnrichFields(isDefault ? null : next);
	};

	const row = (key: string, label: string) => (
		<SwitchRow
			key={key}
			className="enrich-field"
			checked={isOn(key)}
			disabled={!enrichMetadata}
			onChange={(v) => toggle(key, v)}
			label={label}
		>
			<span className="enrich-field__name">{label}</span>
			{SLOW_FIELDS.has(key) && (
				<span className="enrich-field__tag" title={t("Costs extra requests per location")}>
					{t("slow")}
				</span>
			)}
			<CoverageBar ratio={coverage.get(key) ?? 0} />
		</SwitchRow>
	);

	return (
		<>
			<div className="enrichment-modal__master">
				<Switch
					checked={enrichMetadata}
					onChange={setEnrichMetadata}
					label={t("Enrich locations")}
				/>
				<span className="enrichment-modal__master-text">
					<strong>{t("Enrich locations")}</strong>
					<span>{t("Automatically save metadata to locations")}</span>
				</span>
				<button
					className="icon-button icon-button--inline"
					type="button"
					title={t("Open manual chapter")}
					onClick={onOpenManual}
				>
					<Icon path={mdiInformationOutline} size={18} />
				</button>
			</div>

			<div className="enrich-fields" aria-disabled={!enrichMetadata || undefined}>
				{options.map((f) => row(f.key, f.label))}
			</div>
		</>
	);
}

/** Fields whose enrichment issues extra requests per location. */
const SLOW_FIELDS = new Set(["datetime"]);

/** The management view: every field on the map, with its schema in a detail pane so
 *  nothing has to escalate to a nested dialog just to fit. */
function FieldsTab() {
	const [rows, setRows] = useState(buildRows);
	const [selected, setSelected] = useState<string | null>(() => buildRows()[0]?.key ?? null);
	const [filter, setFilter] = useState("");
	const [renamePrompt, setRenamePrompt] = useState<RenamePrompt | null>(null);
	const [deleteKey, setDeleteKey] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [coverageEpoch, setCoverageEpoch] = useState(0);
	const coverage = useCoverage(coverageEpoch);

	const shown = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((r) => r.key.toLowerCase().includes(q) || r.label.toLowerCase().includes(q));
	}, [rows, filter]);

	const row = rows.find((r) => r.key === selected) ?? null;

	const refresh = () => {
		const next = buildRows();
		setRows(next);
		setSelected((cur) => (next.some((r) => r.key === cur) ? cur : (next[0]?.key ?? null)));
		setCoverageEpoch((n) => n + 1);
	};

	// Live commit: field defs apply on every edit (blur for text, change for selects).
	const commitDefs = async (next: FieldRow[]) => {
		const fields: Record<string, ExtraFieldDef> = {};
		for (const r of next) {
			const entry: ExtraFieldDef = { type: r.type, label: r.label };
			if (r.values) entry.values = r.values;
			if (r.labels) entry.labels = r.labels;
			if (r.comparison) entry.comparison = r.comparison;
			fields[r.key] = entry;
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

	const proposeRename = async (target: string) => {
		if (!row || !target || target === row.key) return;
		const counts = await readCoverage({ type: "Everything" });
		const affected = counts.find(([key]) => key === row.key)?.[1] ?? 0;
		setRenamePrompt({
			key: row.key,
			target,
			winner: "from",
			affected,
			merge: rows.some((r) => r.key === target),
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
		setSelected(renamePrompt.target);
		setRenamePrompt(null);
		refresh();
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

	if (rows.length === 0) {
		return (
			<p className="fields-pane__empty">
				{t("No fields on this map yet. Enrich or import locations to create some.")}
			</p>
		);
	}

	return (
		<>
			<div className="fields-pane">
				<div className="fields-pane__list">
					<TextInput
						type="search"
						className="fields-pane__filter"
						placeholder={t("Filter fields...")}
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
					<div className="fields-pane__scroll">
						{shown.map((r) => (
							<button
								key={r.key}
								type="button"
								className={`fields-pane__item${r.key === selected ? " is-active" : ""}`}
								onClick={() => setSelected(r.key)}
							>
								<span className="fields-pane__item-key mono">{r.key}</span>
								<CoverageBar ratio={coverage.get(r.key) ?? 0} />
							</button>
						))}
						{shown.length === 0 && <p className="fields-pane__empty">{t("No fields match.")}</p>}
					</div>
				</div>

				{row && (
					<div className="fields-pane__detail" key={row.key}>
						<h3 className="fields-pane__title mono">{row.key}</h3>

						<label className="fields-pane__field">
							<span>{t("Label")}</span>
							<TextInput
								value={row.label}
								onChange={(e) => updateRow(row.key, { label: e.target.value })}
								onBlur={() => void commitDefs(rows)}
							/>
						</label>

						<label className="fields-pane__field">
							<span>{t("Type")}</span>
							<NSelect
								value={row.type}
								onChange={(e) =>
									updateRow(row.key, { type: e.target.value as ExtraFieldDef["type"] }, true)
								}
							>
								{FIELD_TYPES.map((ft) => (
									<option key={ft} value={ft}>
										{t(TYPE_LABELS[ft])}
									</option>
								))}
							</NSelect>
						</label>

						<label className="fields-pane__field">
							<span>{t("Compare as")}</span>
							<NSelect
								value={compToToken(row.comparison)}
								onChange={(e) =>
									updateRow(
										row.key,
										{
											comparison: tokenToComp(e.target.value as CompToken, DEFAULT_PERIOD) ?? null,
										},
										true,
									)
								}
							>
								{COMP_OPTIONS.map((o) => (
									<option key={o.token} value={o.token}>
										{t(o.label)}
									</option>
								))}
							</NSelect>
						</label>

						{row.comparison?.type === "circular" && (
							<label className="fields-pane__field">
								<span>{t("Wraps at")}</span>
								<PeriodInput
									value={row.comparison.period}
									onCommit={(period) =>
										updateRow(row.key, { comparison: { type: "circular", period } }, true)
									}
								/>
							</label>
						)}

						{row.type === "enum" && (
							<EnumValues
								row={row}
								onCommit={(values, labels) => updateRow(row.key, { values, labels }, true)}
							/>
						)}

						<div className="fields-pane__actions">
							<RenameField
								fieldKey={row.key}
								taken={new Set(rows.map((r) => r.key))}
								busy={busy}
								onRename={(target) => void proposeRename(target)}
							/>
							<Button variant="destructive" disabled={busy} onClick={() => setDeleteKey(row.key)}>
								{t("Delete field")}
							</Button>
						</div>
					</div>
				)}
			</div>

			<Dialog open={renamePrompt !== null} onOpenChange={(open) => !open && setRenamePrompt(null)}>
				<DialogContent
					title={renamePrompt?.merge ? t("Merge field") : t("Rename field")}
					className="period-prompt"
				>
					{renamePrompt && (
						<>
							<p className="period-prompt__help">
								{renamePrompt.merge ? (
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
								) : (
									<Trans
										msg={{
											one: "Rename {from} to {to} across {n} location. This cannot be undone.",
											other: "Rename {from} to {to} across {n} locations. This cannot be undone.",
										}}
										from={<code>{renamePrompt.key}</code>}
										to={<code>{renamePrompt.target}</code>}
										n={renamePrompt.affected}
									/>
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
										<Trans msg={"{field}’s values"} field={<code>{renamePrompt.key}</code>} />
									</label>
									<label>
										<Radio
											checked={renamePrompt.winner === "to"}
											onChange={() => setRenamePrompt({ ...renamePrompt, winner: "to" })}
										/>{" "}
										<Trans msg={"{field}’s values"} field={<code>{renamePrompt.target}</code>} />
									</label>
								</fieldset>
							)}
							<div className="period-prompt__actions">
								<Button variant="primary" disabled={busy} onClick={() => void confirmRename()}>
									{renamePrompt.merge ? t("Merge") : t("Rename")}
								</Button>
								<Button disabled={busy} onClick={() => setRenamePrompt(null)}>
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
		</>
	);
}

/** Owns its draft so switching fields remounts it with the new key already in place.
 *  Syncing through an effect instead left the button live for a frame. */
function RenameField({
	fieldKey,
	taken,
	busy,
	onRename,
}: {
	fieldKey: string;
	taken: ReadonlySet<string>;
	busy: boolean;
	onRename: (target: string) => void;
}) {
	const [draft, setDraft] = useState(fieldKey);
	const target = draft.trim();
	const changed = target !== "" && target !== fieldKey;
	return (
		<span className="fields-pane__rename">
			<TextInput
				className="mono"
				value={draft}
				disabled={busy}
				spellCheck={false}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						onRename(target);
					}
				}}
			/>
			<Button disabled={busy || !changed} onClick={() => onRename(target)}>
				{changed && taken.has(target) ? t("Merge") : t("Rename")}
			</Button>
		</span>
	);
}

/** Draft-then-commit so a half-typed period never reaches the store. */
function PeriodInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	const commit = () => {
		const n = parseFloat(draft);
		onCommit(Number.isFinite(n) && n > 0 ? n : DEFAULT_PERIOD);
	};
	return (
		<TextInput
			type="number"
			min="0"
			step="any"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
			}}
		/>
	);
}

/** Allowed values for an enum field, inline. Was a nested dialog purely because a
 *  table cell had nowhere to put it. */
function EnumValues({
	row,
	onCommit,
}: {
	row: FieldRow;
	onCommit: (values: string[] | null, labels: Record<string, string> | null) => void;
}) {
	const [draft, setDraft] = useState(() =>
		(row.values ?? []).map((v) => ({ value: v, label: row.labels?.[v] ?? "" })),
	);
	const [candidates, setCandidates] = useState<string[]>([]);

	useEffect(() => {
		let live = true;
		const have = new Set(row.values ?? []);
		void fieldValues({ type: "Everything" }, row.key).then((values) => {
			if (live) setCandidates(values.filter((v) => !have.has(v)));
		});
		return () => {
			live = false;
		};
	}, [row.key, row.values]);

	const commit = (next: { value: string; label: string }[]) => {
		const values: string[] = [];
		const labels: Record<string, string> = {};
		for (const r of next) {
			const v = r.value.trim();
			if (!v || values.includes(v)) continue;
			values.push(v);
			const l = r.label.trim();
			if (l) labels[v] = l;
		}
		onCommit(values.length > 0 ? values : null, Object.keys(labels).length > 0 ? labels : null);
	};

	const setAt = (i: number, patch: Partial<{ value: string; label: string }>) =>
		setDraft((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

	return (
		<div className="enum-values">
			<span className="enum-values__legend">{t("Allowed values")}</span>
			{draft.map((r, i) => (
				<div className="enum-values__row" key={i}>
					<TextInput
						value={r.value}
						placeholder={t("value")}
						onChange={(e) => setAt(i, { value: e.target.value })}
						onBlur={() => commit(draft)}
					/>
					<TextInput
						value={r.label}
						placeholder={t("label")}
						onChange={(e) => setAt(i, { label: e.target.value })}
						onBlur={() => commit(draft)}
					/>
					<button
						className="enum-values__remove"
						type="button"
						title={t("Remove value")}
						onClick={() => {
							const next = draft.filter((_, j) => j !== i);
							setDraft(next);
							commit(next);
						}}
					>
						<Icon path={mdiClose} size={18} />
					</button>
				</div>
			))}
			<div className="enum-values__add">
				<Button onClick={() => setDraft([...draft, { value: "", label: "" }])}>
					{t("Add value")}
				</Button>
				{candidates.length > 0 && (
					<Button
						onClick={() => {
							const present = new Set(draft.map((r) => r.value.trim()));
							const kept = draft.filter((r) => r.value.trim() !== "" || r.label.trim() !== "");
							const next = [
								...kept,
								...candidates.filter((v) => !present.has(v)).map((v) => ({ value: v, label: "" })),
							];
							setDraft(next);
							commit(next);
						}}
					>
						{t("Add {n} found in data", { n: candidates.length })}
					</Button>
				)}
			</div>
		</div>
	);
}
