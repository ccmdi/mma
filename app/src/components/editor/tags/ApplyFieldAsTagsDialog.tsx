import { useState, useEffect, useMemo, type ReactNode } from "react";
import clsx from "clsx";
import { NSelect } from "@/components/primitives/NSelect";
import type { KeySpec } from "@/bindings.gen";
import type { DatePart } from "@/bindings.consts";
import { resolveFieldLabels } from "@/lib/data/procedures";
import { projectionsForType, partitionKeyOptions, RANGE_ID } from "@/lib/data/fieldProjections";
import { useExtraFieldKeys } from "@/components/editor/map/FilterBuilder";
import { countBy, countIn, coverage, createTags, partition } from "@/store/useMapStore";
import { all, not } from "@/store/selections";
import { useSelectorPick } from "@/store/selectorPick";
import { SelectorPicker } from "@/components/primitives/SelectorPicker";
import { useSetting } from "@/store/settings";
import {
	Dialog,
	DialogActions,
	DialogContent,
	DialogForm,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { Hint } from "@/components/primitives/Hint";
import { TextInput } from "@/components/primitives/TextInput";
import { Checkbox } from "@/components/primitives/Checkbox";
import { CoverageBar } from "@/components/primitives/CoverageBar";
import { t } from "@/lib/i18n";
import { fillTemplate } from "@/lib/util/format";
import { countMissingTimezone, missingTimezoneMessage } from "@/lib/util/timezone";
import { applyCounts, type Preview } from "./applyCounts";

/** `{value}` alone keeps today's names; a prefix such as `Camera/{value}` files them in a folder. */
const DEFAULT_TEMPLATE = "{value}";
const MANY_TAGS = 100;

export function ApplyFieldAsTagsDialog({ open, onOpenChange }: DialogProps) {
	const tzDefault = useSetting("dateTimezone") === "location";
	const [field, setField] = useState("");
	const [projectionId, setProjectionId] = useState("");
	const [width, setWidth] = useState("");
	const [tzLocal, setTzLocal] = useState(tzDefault);
	const [tagMissing, setTagMissing] = useState(false);
	const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
	const picker = useSelectorPick();
	const fields = useExtraFieldKeys();

	const fieldType = fields.find((f) => f.key === field)?.def.type ?? "string";
	const projOptions = partitionKeyOptions(fieldType, false);
	const isRange = projectionId === RANGE_ID;
	const selectedProj = projectionsForType(fieldType).find((p) => p.id === projectionId);
	const hasTzData = fields.some((f) => f.key === "timezone");
	const showTz = !isRange && selectedProj?.needsTz === true && fieldType === "date";
	const useRowTz = showTz && tzLocal && hasTzData;
	const [tzGap, setTzGap] = useState(0);

	useEffect(() => {
		let live = true;
		void countMissingTimezone(picker.selector, field, fieldType, useRowTz).then((n) => {
			if (live) setTzGap(n);
		});
		return () => {
			live = false;
		};
	}, [picker.selector, field, fieldType, useRowTz]);
	const showWidth = isRange;
	const widthValid = !showWidth || Number(width) > 0;

	const key = useMemo((): KeySpec | null => {
		if (!field || !widthValid) return null;
		if (isRange) return { kind: "numericBin", binning: { by: "width", w: Number(width) } };
		if (projectionId === "value") return { kind: "value" };
		return { kind: "datePart", part: projectionId as DatePart, tzLocal: tzLocal && hasTzData };
	}, [field, widthValid, isRange, width, projectionId, tzLocal, hasTzData]);

	const [loaded, setLoaded] = useState<{
		field: string;
		key: KeySpec | null;
		preview: Preview;
	} | null>(null);
	useEffect(() => {
		if (!field) return;
		let live = true;
		const selector = picker.selector;
		void Promise.all([
			countIn(selector),
			coverage(selector),
			key ? countBy(selector, field, key) : Promise.resolve([]),
		]).then(([total, counts, groups]) => {
			if (!live) return;
			setLoaded({
				field,
				key,
				preview: {
					total,
					have: counts.find(([k]) => k === field)?.[1] ?? 0,
					groupSizes: groups.map(([, n]) => n),
				},
			});
		});
		return () => {
			live = false;
		};
	}, [picker.selector, field, key]);

	const preview = field ? (loaded?.preview ?? null) : null;
	const pending = !!field && (loaded?.field !== field || loaded.key !== key);
	const counts = preview ? applyCounts(preview, tagMissing) : null;

	const handleFieldChange = (next: string) => {
		setField(next);
		const type = fields.find((f) => f.key === next)?.def.type ?? "string";
		setProjectionId(projectionsForType(type)[0]?.id ?? "");
		setWidth("");
		setTzLocal(tzDefault);
	};

	const fieldLabel = fields.find((f) => f.key === field)?.label ?? field;
	const missingName = t("No {field} data", { field: fieldLabel });
	const tagName = (value: string) => fillTemplate(template, { value, field: fieldLabel });

	const handleApply = async () => {
		if (!field || !key) return;

		const groups = await partition(field, key, picker.selector);

		// Rust drops rows whose key does not resolve, so whatever the groups miss is exactly
		// the set with no value for this field.
		const missing = tagMissing
			? all(
					picker.selector,
					not({ type: "Locations", locations: groups.flatMap((g) => g.ids), name: null }),
				)
			: null;
		const missingCount = missing ? await countIn(missing) : 0;
		if (groups.length === 0 && missingCount === 0) return;

		const labels = await resolveFieldLabels(
			field,
			groups.map((g) => g.key),
			key,
		);
		// Groups sharing a label land on one tag: createTags reuses an existing name.
		for (const [i, g] of groups.entries())
			await createTags([tagName(labels[i])], {
				type: "Locations",
				locations: g.ids,
				name: null,
			});
		if (missing && missingCount > 0) await createTags([tagName(missingName)], missing);
		onOpenChange(false);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				onOpenChange(v);
				if (!v) {
					setField("");
					setProjectionId("");
					setWidth("");
					setTzLocal(tzDefault);
					setTagMissing(false);
					setTemplate(DEFAULT_TEMPLATE);
				}
			}}
		>
			<DialogContent title={t("Apply metadata as tags")}>
				<DialogForm onSubmit={() => void handleApply()}>
					<SelectorPicker ctl={picker} />
					<div style={{ display: "flex", gap: "0.5rem" }}>
						<NSelect
							compact
							value={field}
							onChange={(e) => handleFieldChange(e.target.value)}
							style={{ flex: 1 }}
							autoFocus
						>
							<option value="">{t("Select a field...")}</option>
							{fields.map((f) => (
								<option key={f.key} value={f.key}>
									{f.label}
								</option>
							))}
						</NSelect>
						{field && projOptions.length > 1 && (
							<NSelect
								compact
								value={projectionId}
								onChange={(e) => setProjectionId(e.target.value)}
							>
								{projOptions.map((p) => (
									<option key={p.id} value={p.id}>
										{t(p.label)}
									</option>
								))}
							</NSelect>
						)}
					</div>
					{showWidth && (
						<TextInput
							type="number"
							min="0"
							value={width}
							onChange={(e) => setWidth(e.target.value)}
							placeholder={t("Bucket width...")}
						/>
					)}
					{showTz && (
						<Checkbox
							checked={tzLocal && hasTzData}
							disabled={!hasTzData}
							onChange={(e) => setTzLocal(e.target.checked)}
							title={hasTzData ? undefined : t("No locations have timezone data")}
						>
							{t("Location timezone")}
						</Checkbox>
					)}
					{tzGap > 0 && <Hint>{missingTimezoneMessage(tzGap)}</Hint>}
					{field && (
						<div className={clsx("apply-tags__coverage", pending && "is-pending")}>
							<span className="apply-tags__coverage-label">
								{t("Locations with {field}", { field: fieldLabel })}
							</span>
							<CoverageBar
								ratio={preview && preview.total > 0 ? preview.have / preview.total : 0}
								status
								className="coverage-bar--wide"
							/>
						</div>
					)}
					{field && (
						<label className="bulk-operation__option">
							{t("Tag name")}
							<TextInput
								value={template}
								onChange={(e) => setTemplate(e.target.value)}
								placeholder={DEFAULT_TEMPLATE}
								title={t(
									"{value} is the projected value, {field} the field label. A / makes a folder.",
								)}
							/>
						</label>
					)}
					{field && (
						<Checkbox checked={tagMissing} onChange={(e) => setTagMissing(e.target.checked)}>
							{t("Tag locations with no value as “{name}”", { name: missingName })}
						</Checkbox>
					)}
					<DialogActions
						start={
							<ApplySummary
								preview={preview}
								pending={pending}
								needsWidth={!!field && !key}
								tags={counts?.tags ?? 0}
								locations={counts?.locations ?? 0}
								fieldLabel={fieldLabel}
								suggestRange={fieldType === "number" && !isRange}
							/>
						}
						cancel
						primary={{ label: t("Apply"), disabled: !key || !counts?.tags }}
					/>
				</DialogForm>
			</DialogContent>
		</Dialog>
	);
}

function ApplySummary({
	preview,
	pending,
	needsWidth,
	tags,
	locations,
	fieldLabel,
	suggestRange,
}: {
	preview: Preview | null;
	pending: boolean;
	needsWidth: boolean;
	tags: number;
	locations: number;
	fieldLabel: string;
	suggestRange: boolean;
}) {
	let state: "blank" | "empty" | "warning" | "ready" = "ready";
	let head: ReactNode = null;
	let note: ReactNode = null;
	if (needsWidth) {
		state = "empty";
		head = t("Enter a bucket width");
	} else if (!preview) {
		state = "blank";
	} else if (tags === 0) {
		state = "empty";
		head = t("No tags to create");
		note =
			preview.total === 0
				? t("No locations to tag")
				: preview.have === 0
					? t(
							{
								one: "The {n} location has no {field}",
								other: "None of the {n} locations have {field}",
							},
							{ n: preview.total, field: fieldLabel },
						)
					: t("No values could be grouped");
	} else {
		head = (
			<>
				{t({ one: "{n} tag", other: "{n} tags" }, { n: tags })}
				<span className="apply-tags__summary-sep" aria-hidden>
					·
				</span>
				{t({ one: "{n} location", other: "{n} locations" }, { n: locations })}
			</>
		);
		if (tags > MANY_TAGS) {
			state = "warning";
			note = suggestRange
				? t("That's a lot of tags. Range groups numbers into buckets.")
				: t("That's a lot of tags. Try a coarser grouping.");
		}
	}
	// Both lines always render so the footer keeps one height through every state.
	return (
		<div
			className={clsx("apply-tags__summary", `is-${state}`, pending && "is-pending")}
			aria-live="polite"
		>
			<span className="apply-tags__summary-head truncate">{head ?? "\u00a0"}</span>
			<span className="apply-tags__summary-note truncate">{note ?? "\u00a0"}</span>
		</div>
	);
}
