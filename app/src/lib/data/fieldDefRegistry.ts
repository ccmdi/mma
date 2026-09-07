// Unified field-definition registry.
//
// Layers, in priority order:
//   1. User overrides (per-map, persisted in MapMeta)
//   2. Plugin defs (declared by Provider.fieldDefs, live while the plugin is active)
//   3. Built-in fields
//
// `getFieldDef` composes per-attribute (not whole-object): a null attribute in a
// higher layer falls through to the next.

import { emit } from "@/lib/events";
import { getMapState } from "@/store/useMapStore";
import { memoOnRefs } from "@/lib/util/memoOnRefs";
import { createFieldDef } from "@/types";
import { BUILTIN_FIELDS, CLEARABLE_BUILTINS, PROJECTIONS } from "@/bindings.consts";
import type { ExtraFieldDef, ExtraFieldType } from "@/bindings.gen";
import { msg, t } from "@/lib/i18n";

// Field kind: identity (position), virtual (derived), term (expression-only),
// writable (bulk-editable), or undefined (read-only, listable).
type FieldKind = NonNullable<(typeof BUILTIN_FIELDS)[number]["kind"]>;

interface RegistryFieldDef extends ExtraFieldDef {
	kind?: FieldKind;
}

// Built-in field definitions, derived from the shared BUILTIN_FIELDS table.
const FIELDS: Record<string, RegistryFieldDef> = Object.fromEntries(
	BUILTIN_FIELDS.map((f) => [
		f.key,
		{
			...createFieldDef(f.type, { label: f.label, comparison: f.comparison }),
			kind: f.kind ?? undefined,
		},
	]),
);

/** True when `key` is a built-in Location field (stored top-level, not under `extra`). */
export function isBuiltinField(key: string): boolean {
	return key in FIELDS && !isDerived(FIELDS[key].kind);
}

/** Derived from the location rather than stored on it, so never a column to assign. */
function isDerived(kind: FieldKind | undefined): boolean {
	return kind === "virtual" || kind === "term";
}

export function isWritableField(key: string): boolean {
	return key in FIELDS ? FIELDS[key].kind === "writable" : true;
}

/** True when the field can be bulk-cleared. */
export function isClearableField(key: string): boolean {
	return key in FIELDS ? (CLEARABLE_BUILTINS as readonly string[]).includes(key) : true;
}

/** True when the field should appear in field pickers. */
export function isListableField(key: string): boolean {
	return key in FIELDS ? !["identity", "term"].includes(FIELDS[key].kind ?? "") : true;
}

/** All built-in field keys (excluding virtual). */
export function getBuiltinKeys(): string[] {
	return Object.keys(FIELDS).filter(isBuiltinField);
}

let pluginDefs: Record<string, ExtraFieldDef> = {};
/** Register field definitions from an enrichment provider (called at activation). */
export function registerPluginFieldDefs(defs: Record<string, ExtraFieldDef>) {
	pluginDefs = { ...pluginDefs, ...defs };
	emit("fields:changed");
}

/** Remove plugin field definitions by key (called when a plugin is deactivated). */
export function unregisterPluginFieldDefs(keys: string[]) {
	if (keys.length === 0) return;
	const next = { ...pluginDefs };
	for (const k of keys) delete next[k];
	pluginDefs = next;
	emit("fields:changed");
}

/** Keys some location on this map carries. Same reference until the user layer moves. */
export const getKnownFieldKeys: () => ReadonlySet<string> = memoOnRefs(
	() => [getMapState().fieldDefs] as const,
	(defs) => new Set(Object.keys(defs)),
);

// Compose two layers per-attribute: the higher layer wins when non-null.
function mergeDef(
	user: ExtraFieldDef | undefined,
	plugin: ExtraFieldDef | undefined,
): ExtraFieldDef | undefined {
	if (!user) return plugin;
	if (!plugin) return user;
	return {
		type: user.type,
		label: user.label ?? plugin.label,
		values: user.values ?? plugin.values,
		labels: user.labels ?? plugin.labels,
		comparison: user.comparison ?? plugin.comparison,
	};
}

/** Look up metadata for a field key. Returns `undefined` if no layer declares it. */
export function getFieldDef(key: string): ExtraFieldDef | undefined {
	return mergeDef(mergeDef(getMapState().fieldDefs[key], pluginDefs[key]), FIELDS[key]);
}

/** Display label for a field key, falling back to a sentence-cased version of the key. */
export function fieldLabel(key: string): string {
	return (
		getFieldDef(key)?.label ??
		key
			.replace(/([a-z])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`)
			.replace(/_/g, " ")
			.replace(/^./, (c) => c.toUpperCase())
	);
}

/** Display label for a field value. Enum values use their translated display name. */
export function fieldValueLabel(def: ExtraFieldDef | undefined, value: unknown): string {
	const raw = String(value);
	const label = def?.type === "enum" ? def.labels?.[raw] : undefined;
	return label ? t(label) : raw;
}

/** Merged view of all field definitions across all layers. */
export function getAllFieldDefs(): Record<string, ExtraFieldDef> {
	const out: Record<string, ExtraFieldDef> = {};
	const allKeys = new Set([
		...Object.keys(FIELDS),
		...Object.keys(pluginDefs),
		...getKnownFieldKeys(),
	]);
	for (const key of allKeys) {
		const merged = getFieldDef(key);
		if (merged) out[key] = merged;
	}
	return out;
}

// --- Tag projections: the grouping keys a field may be partitioned by --------------
// The catalog (ids, applicability, timezone need) is the Rust `PROJECTIONS` constant;
// key derivation runs in Rust too (`KeySpec`). Only the labels live here.

const PROJECTION_LABELS: Record<string, string> = {
	value: msg("Value"),
	year: msg("Year"),
	yearMonth: msg("Year-month"),
	day: msg("Exact day"),
	monthOfYear: msg("Month of year"),
	hourOfDay: msg("Hour of day"),
};

export interface FieldProjection {
	id: string;
	label: string;
	/** True when this projection uses the location's timezone. */
	needsTz: boolean;
}

/** Projections valid for a field type, in display order (first = dialog default). */
export function projectionsForType(type: ExtraFieldType): FieldProjection[] {
	return PROJECTIONS.filter((p) => (p.appliesTo as readonly ExtraFieldType[]).includes(type)).map(
		(p) => ({
			id: p.id,
			label: PROJECTION_LABELS[p.id] ?? p.id,
			needsTz: p.needsTz,
		}),
	);
}

/** The "Range" partition option (numeric binning). */
export const RANGE_ID = "range";

/** Partition-key dropdown options for a field type. */
export function partitionKeyOptions(
	type: ExtraFieldType,
	rangeForDates: boolean,
): { id: string; label: string }[] {
	const projs = projectionsForType(type).map((p) => ({ id: p.id, label: p.label }));
	const hasRange = type === "number" || (rangeForDates && type === "date");
	return hasRange ? [{ id: RANGE_ID, label: msg("Range") }, ...projs] : projs;
}
