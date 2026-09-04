import { useState, useMemo, useCallback, useEffect } from "react";
import { Sidebar, Field, EmptyState, SegmentedControl } from "@/components/primitives/Sidebar";
import { NSelect } from "@/components/primitives/NSelect";
import { Checkbox } from "@/components/primitives/Checkbox";
import { SelectorPicker } from "@/components/primitives/SelectorPicker";
import type { ExtraFieldType, KeySpec, DatePart } from "@/bindings.gen";
import { getFieldDef, getKnownFieldKeys } from "@/lib/data/fieldDefRegistry";
import { useExtraFieldKeys, type FieldEntry } from "@/components/editor/map/FilterBuilder";
import { partition } from "@/store/useMapStore";
import { partitionKeyOptions, RANGE_ID } from "@/lib/data/fieldDefRegistry";
import { isNumericField, colorPartition } from "./gradientMath";
import { useSelectorPick } from "@/store/selectorPick";
import { countMissingTimezone, missingTimezoneMessage } from "@/lib/util/timezone";
import { usePluginState } from "@/plugins/registry";
import { useSetting } from "@/store/settings";
import "./gradient.css";
import { t, msg } from "@/lib/i18n";
import { Button } from "@/components/primitives/Button";

interface GradientPreset {
	name: string;
	stops: [number, number, number][];
}

const PRESETS: GradientPreset[] = [
	{
		name: msg("Blue-Red"),
		stops: [
			[66, 133, 244],
			[234, 67, 53],
		],
	},
	{
		name: msg("Green-Yellow-Red"),
		stops: [
			[52, 168, 83],
			[251, 188, 4],
			[234, 67, 53],
		],
	},
	{
		name: msg("Purple-Orange"),
		stops: [
			[136, 84, 208],
			[255, 152, 0],
		],
	},
	{
		name: msg("Cool-Warm"),
		stops: [
			[33, 150, 243],
			[200, 200, 200],
			[244, 67, 54],
		],
	},
	{
		name: "Viridis",
		stops: [
			[68, 1, 84],
			[59, 82, 139],
			[33, 145, 140],
			[94, 201, 98],
			[253, 231, 37],
		],
	},
];

const BUCKET_COUNTS = [5, 10, 15, 20];

// Refuse to color a partition into more groups than a human can distinguish.
const MAX_GROUPS = 100;

const gradientCss = (stops: [number, number, number][]) =>
	`linear-gradient(to right, ${stops
		.map((s, i) => `rgb(${s[0]},${s[1]},${s[2]}) ${(i / (stops.length - 1)) * 100}%`)
		.join(", ")})`;

// Gradient offers Range for numbers and dates (count bins); numeric defaults to Range.
const gradientOptions = (type: ExtraFieldType) => partitionKeyOptions(type, true);
function defaultProjection(type: ExtraFieldType): string {
	return type === "number" || type === "date"
		? RANGE_ID
		: (gradientOptions(type)[0]?.id ?? "value");
}

// Fields the map actually carries that a gradient can project.
function gradientFields(all: FieldEntry[], knownKeys: ReadonlySet<string>): FieldEntry[] {
	return all.filter((f) => {
		if (!knownKeys.has(f.key)) return false;
		const def = getFieldDef(f.key);
		return (
			!!def &&
			(isNumericField(def) || def.type === "enum" || def.type === "string" || def.type === "month")
		);
	});
}

function defaultGradientField(fields: FieldEntry[]): string {
	return (fields.find((f) => f.key === "altitude") ?? fields[0])?.key ?? "";
}

export function GradientSidebar({ onClose }: { onClose: () => void }) {
	// Empty resolves to nothing, so the effective field falls back to the default below.
	const [fieldKeyRaw, setFieldKey] = usePluginState<string>("gradient", "fieldKey", "");
	const [projectionIdRaw, setProjectionId] = usePluginState("gradient", "projectionId", RANGE_ID);
	const [presetIdxRaw, setPresetIdx] = usePluginState("gradient", "presetIdx", 0);
	const [bucketCount, setBucketCount] = usePluginState("gradient", "bucketCount", 10);
	const [reversed, setReversed] = usePluginState("gradient", "reversed", false);
	const [applying, setApplying] = useState(false);
	const [lastResult, setLastResult] = useState<{
		groups: number;
		applied: boolean;
		skipped: number;
	} | null>(null);
	const picker = useSelectorPick();
	const dateTimezone = useSetting("dateTimezone");

	const map = MMA.getMapState().map;

	const allFields = useExtraFieldKeys();
	const knownKeys = getKnownFieldKeys();
	const fields = useMemo(() => gradientFields(allFields, knownKeys), [allFields, knownKeys]);

	// Persisted values are global; fall back when they don't resolve on this map.
	const fieldKey = fields.some((f) => f.key === fieldKeyRaw)
		? fieldKeyRaw
		: defaultGradientField(fields);
	const presetIdx = presetIdxRaw < PRESETS.length ? presetIdxRaw : 0;
	const preset = PRESETS[presetIdx];
	const stops = reversed ? [...preset.stops].reverse() : preset.stops;
	const fieldOpt = fields.find((f) => f.key === fieldKey);
	const fieldType = (fieldOpt?.def?.type ?? "string") as ExtraFieldType;
	const projOptions = useMemo(() => gradientOptions(fieldType), [fieldType]);
	const projectionId = projOptions.some((p) => p.id === projectionIdRaw)
		? projectionIdRaw
		: defaultProjection(fieldType);

	const applyGradient = useCallback(async () => {
		if (!fieldOpt || !map) return;
		setApplying(true);
		try {
			const key: KeySpec =
				projectionId === RANGE_ID
					? { kind: "numericBin", binning: { by: "count", n: bucketCount } }
					: projectionId === "value"
						? { kind: "value" }
						: {
								kind: "datePart",
								part: projectionId as DatePart,
								tzLocal: dateTimezone === "location",
							};

			const groups = await partition(fieldKey, key, picker.selector);
			const skipped = await countMissingTimezone(
				picker.selector,
				fieldKey,
				fieldType,
				key.kind === "datePart" && key.tzLocal,
			);
			if (groups.length > MAX_GROUPS) {
				setLastResult({ groups: groups.length, applied: false, skipped });
				return;
			}
			setLastResult({ groups: groups.length, applied: true, skipped });
			if (groups.length === 0) return;

			const sels = colorPartition(groups, {
				fieldKey: fieldKey,
				fieldType,
				stops,
				narrowed: picker.choice.pick === "selection",
				ordinal: projectionId === RANGE_ID,
				eqFilter: projectionId === "value",
			});
			if (sels.length === 0) return;

			await MMA.resetSelections();
			await MMA.addSelections(sels.map((s) => s.selector));
			await MMA.applySelectionUpdate(
				MMA.setSelectionColors(sels.map((s) => ({ key: s.key, color: s.color }))),
			);
		} finally {
			setApplying(false);
		}
	}, [
		fieldKey,
		fieldOpt,
		fieldType,
		projectionId,
		map,
		bucketCount,
		stops,
		picker.selector,
		picker.choice.pick,
		dateTimezone,
	]);

	// The result line describes the last apply; stale once any input changes.
	useEffect(() => {
		setLastResult(null);
	}, [fieldKey, projectionId, presetIdx, bucketCount, reversed, picker.selector]);

	return (
		<Sidebar title={t("Gradient")} onBack={onClose} className="gradient-sidebar">
			{fields.length === 0 ? (
				<EmptyState>{t("No extra fields on this map. Enrich locations first.")}</EmptyState>
			) : (
				<>
					<Field label={t("Apply to")}>
						<SelectorPicker ctl={picker} />
					</Field>
					<div className="gradient-sidebar__row">
						<Field label={t("Field")}>
							<NSelect
								value={fieldKey}
								onChange={(e) => {
									const key = e.target.value;
									setFieldKey(key);
									const ft = (fields.find((f) => f.key === key)?.def?.type ??
										"string") as ExtraFieldType;
									const opts = gradientOptions(ft);
									if (!opts.some((p) => p.id === projectionId))
										setProjectionId(defaultProjection(ft));
								}}
							>
								{fields.map((f) => (
									<option key={f.key} value={f.key}>
										{t(f.label)}
									</option>
								))}
							</NSelect>
						</Field>
						<Field label={t("Group by")}>
							<NSelect
								value={projectionId}
								disabled={projOptions.length <= 1}
								onChange={(e) => {
									setProjectionId(e.target.value);
								}}
							>
								{projOptions.map((p) => (
									<option key={p.id} value={p.id}>
										{t(p.label)}
									</option>
								))}
							</NSelect>
						</Field>
					</div>

					<Field label={t("Buckets")}>
						<SegmentedControl
							value={bucketCount}
							onChange={setBucketCount}
							options={BUCKET_COUNTS.map((n) => ({
								value: n,
								label: String(n),
								disabled: projectionId !== RANGE_ID,
								title: projectionId !== RANGE_ID ? t("Only applies to Range grouping") : undefined,
							}))}
						/>
					</Field>

					<Field label={t("Gradient")}>
						<div className="gradient-sidebar__presets">
							{PRESETS.map((p, i) => (
								<button
									key={p.name}
									className={`gradient-sidebar__preset ${i === presetIdx ? "gradient-sidebar__preset--active" : ""}`}
									onClick={() => {
										setPresetIdx(i);
									}}
									title={t(p.name)}
								>
									<div
										className="gradient-sidebar__preset-bar"
										style={{
											background: gradientCss(reversed ? [...p.stops].reverse() : p.stops),
										}}
									/>
								</button>
							))}
						</div>
						<div className="gradient-sidebar__preview-labels">
							<span>{t("Low")}</span>
							<span>{t("High")}</span>
						</div>
						<label className="gradient-sidebar__check">
							<Checkbox checked={reversed} onChange={(e) => setReversed(e.target.checked)} />

							{t("Reverse")}
						</label>
					</Field>

					<div className="gradient-sidebar__apply-row">
						<Button
							variant="primary"
							onClick={() => void applyGradient()}
							disabled={applying || !fieldKey}
						>
							{t("Apply")}
						</Button>
						{lastResult != null && (
							<span className="gradient-sidebar__result">
								{!lastResult.applied
									? t("{n} groups. Too many to color (max {max}).", {
											n: lastResult.groups,
											max: MAX_GROUPS,
										})
									: lastResult.groups === 0
										? t("No groups found")
										: t(
												{ one: "{n} group applied", other: "{n} groups applied" },
												{ n: lastResult.groups },
											)}
							</span>
						)}
					</div>
					{lastResult != null && lastResult.skipped > 0 && (
						<div className="gradient-sidebar__skipped">
							{missingTimezoneMessage(lastResult.skipped)}
						</div>
					)}
				</>
			)}
		</Sidebar>
	);
}
