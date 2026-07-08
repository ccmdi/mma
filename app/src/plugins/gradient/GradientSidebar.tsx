import { useState, useMemo, useCallback } from "react";
import { Sidebar, Field, EmptyState, SegmentedControl } from "@/components/primitives/Sidebar";
import { NSelect } from "@/components/primitives/NSelect";
import { ScopeSelector } from "@/components/primitives/ScopeSelector";
import type { ExtraFieldDef, ExtraFieldType, KeySpec, DatePart } from "@/bindings.gen";
import { getFieldDef, fieldLabel } from "@/lib/data/fieldDefRegistry";
import { partitionKeyOptions, RANGE_ID } from "@/lib/data/fieldOps";
import { isNumericField, colorPartition } from "./gradientMath";
import { partition, useScope } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import "./gradient.css";

interface GradientPreset {
	name: string;
	stops: [number, number, number][];
}

const PRESETS: GradientPreset[] = [
	{
		name: "Blue-Red",
		stops: [
			[66, 133, 244],
			[234, 67, 53],
		],
	},
	{
		name: "Green-Yellow-Red",
		stops: [
			[52, 168, 83],
			[251, 188, 4],
			[234, 67, 53],
		],
	},
	{
		name: "Purple-Orange",
		stops: [
			[136, 84, 208],
			[255, 152, 0],
		],
	},
	{
		name: "Cool-Warm",
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

interface FieldOption {
	key: string;
	label: string;
	def: ExtraFieldDef | undefined;
	numeric: boolean;
}

// Gradient offers Range for numbers and dates (count bins); numeric defaults to Range.
const gradientOptions = (type: ExtraFieldType) => partitionKeyOptions(type, true);
function defaultProjection(type: ExtraFieldType): string {
	return type === "number" || type === "date"
		? RANGE_ID
		: (gradientOptions(type)[0]?.id ?? "value");
}

function buildGradientFields(knownKeys: ReadonlySet<string>): FieldOption[] {
	const result: FieldOption[] = [];
	for (const key of knownKeys) {
		const def = getFieldDef(key);
		const numeric = isNumericField(def);
		if (!def || numeric || def.type === "enum" || def.type === "string" || def.type === "month") {
			result.push({ key, label: fieldLabel(key), def, numeric });
		}
	}
	return result;
}

function defaultGradientField(fields: FieldOption[]): string {
	return (fields.find((f) => f.key === "altitude") ?? fields[0])?.key ?? "";
}

export function GradientSidebar({ onClose }: { onClose: () => void }) {
	const [fieldKey, setFieldKey] = useState(() =>
		defaultGradientField(buildGradientFields(MMA.getKnownFieldKeys())),
	);
	const [projectionId, setProjectionId] = useState(RANGE_ID);
	const [presetIdx, setPresetIdx] = useState(0);
	const [bucketCount, setBucketCount] = useState(10);
	const [applying, setApplying] = useState(false);
	const scopeCtl = useScope();
	const dateTimezone = useSetting("dateTimezone");

	const map = MMA.getCurrentMap();

	const knownKeys = MMA.getKnownFieldKeys();
	const fields = useMemo(() => buildGradientFields(knownKeys), [knownKeys]);

	const preset = PRESETS[presetIdx];
	const fieldOpt = fields.find((f) => f.key === fieldKey);
	const fieldType = (fieldOpt?.def?.type ?? "string") as ExtraFieldType;
	const projOptions = useMemo(() => gradientOptions(fieldType), [fieldType]);

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

			const groups = await partition(fieldKey, key, scopeCtl.scope);
			if (groups.length === 0) return;

			const sels = colorPartition(groups, {
				fieldKey: fieldKey,
				fieldType,
				stops: preset.stops,
				scoped: scopeCtl.scope.kind === "selected",
				ordinal: projectionId === RANGE_ID,
				eqFilter: projectionId === "value",
			});
			if (sels.length === 0) return;

			await MMA.resetSelections();
			await MMA.addSelections(sels.map((s) => s.props));
			MMA.setSelectionColors(sels.map((s) => ({ key: s.key, color: s.color })));
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
		preset,
		scopeCtl.scope,
		dateTimezone,
	]);

	return (
		<Sidebar title="Gradient" onBack={onClose} className="gradient-sidebar">
			{fields.length === 0 ? (
				<EmptyState>No extra fields on this map. Enrich locations first.</EmptyState>
			) : (
				<>
					<Field label="Apply to">
						<ScopeSelector ctl={scopeCtl} />
					</Field>
					<Field label="Field">
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
									{f.label}
								</option>
							))}
						</NSelect>
					</Field>

					{projOptions.length > 1 && (
						<Field label="Group by">
							<NSelect
								value={projectionId}
								onChange={(e) => {
									setProjectionId(e.target.value);
								}}
							>
								{projOptions.map((p) => (
									<option key={p.id} value={p.id}>
										{p.label}
									</option>
								))}
							</NSelect>
						</Field>
					)}

					<Field label="Gradient">
						<div className="gradient-sidebar__presets">
							{PRESETS.map((p, i) => (
								<button
									key={p.name}
									className={`gradient-sidebar__preset ${i === presetIdx ? "gradient-sidebar__preset--active" : ""}`}
									onClick={() => {
										setPresetIdx(i);
									}}
									title={p.name}
								>
									<div
										className="gradient-sidebar__preset-bar"
										style={{
											background: `linear-gradient(to right, ${p.stops
												.map(
													(s, si) =>
														`rgb(${s[0]},${s[1]},${s[2]}) ${(si / (p.stops.length - 1)) * 100}%`,
												)
												.join(", ")})`,
										}}
									/>
								</button>
							))}
						</div>
					</Field>

					{projectionId === RANGE_ID && (
						<Field label="Buckets">
							<SegmentedControl
								value={bucketCount}
								onChange={setBucketCount}
								options={BUCKET_COUNTS.map((n) => ({ value: n, label: String(n) }))}
							/>
						</Field>
					)}

					<div className="gradient-sidebar__preview">
						<span className="gradient-sidebar__control-label">Preview</span>
						<div
							className="gradient-sidebar__preview-bar"
							style={{
								background: `linear-gradient(to right, ${preset.stops
									.map(
										(s, i) =>
											`rgb(${s[0]},${s[1]},${s[2]}) ${(i / (preset.stops.length - 1)) * 100}%`,
									)
									.join(", ")})`,
							}}
						/>
						<div className="gradient-sidebar__preview-labels">
							<span>Low</span>
							<span>High</span>
						</div>
					</div>

					<button
						className="button button--primary gradient-sidebar__apply"
						onClick={applyGradient}
						disabled={applying || !fieldKey}
					>
						Apply
					</button>
				</>
			)}
		</Sidebar>
	);
}
