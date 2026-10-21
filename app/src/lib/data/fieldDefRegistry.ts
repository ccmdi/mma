// Unified field-definition registry.
//
// Layers, in priority order:
//   1. User overrides (per-map, persisted in MapMeta)
//   2. Plugin defs (declared by Provider.fieldDefs, live while the plugin is active)
//   3. Built-in fields
//
// `getFieldDef` composes per-attribute (not whole-object): a null attribute in a
// higher layer falls through to the next.
import { Store } from "@/store/store";
import { emit } from "@/lib/events";
import { memoOnRefs } from "@/lib/util/memoOnRefs";
import { BUILTIN_FIELDS, PROJECTIONS, type FieldType } from "@/bindings.consts";
import type { FieldDef } from "@/bindings.gen";
import { msg, t } from "@/lib/i18n";
import { log } from "@/lib/util/log";

// Field kind: identity (position), virtual (derived), term (expression-only),
// writable (bulk-editable), or undefined (read-only, listable).
type FieldKind = NonNullable<(typeof BUILTIN_FIELDS)[keyof typeof BUILTIN_FIELDS]["kind"]>;

interface RegistryFieldDef extends FieldDef {
	kind?: FieldKind;
	clearable?: boolean;
}

// Built-in field definitions, the shared BUILTIN_FIELDS table as field definitions.
const FIELDS: Record<string, RegistryFieldDef> = Object.fromEntries(
	Object.entries(BUILTIN_FIELDS).map(([key, f]) => [key, { ...f, kind: f.kind ?? undefined }]),
);

/** True when `key` is a built-in Location field (stored top-level, not under `extra`). @api */
export function isBuiltinField(key: string): boolean {
	return key in FIELDS && !isDerived(FIELDS[key].kind);
}

/** Derived from the location rather than stored on it, so never a column to assign. */
function isDerived(kind: FieldKind | undefined): boolean {
	return kind === "virtual";
}

/** True when the field can be bulk-edited. @api @unstable */
export function isWritableField(key: string): boolean {
	return key in FIELDS ? FIELDS[key].kind === "writable" : true;
}

/** True when the field can be bulk-cleared. @api @unstable */
export function isClearableField(key: string): boolean {
	return key in FIELDS ? FIELDS[key].clearable === true : true;
}

/** True when the field should appear in field pickers. @api @unstable */
export function isListableField(key: string): boolean {
	return key in FIELDS ? FIELDS[key].kind !== "identity" : true;
}

/** All built-in field keys (excluding virtual). @api @unstable */
export function getBuiltinKeys(): string[] {
	return Object.keys(FIELDS).filter(isBuiltinField);
}

let pluginDefs: Record<string, FieldDef> = {};
/** Register field definitions from an enrichment provider (called at activation). @api */
export function registerPluginFieldDefs(defs: Record<string, FieldDef>) {
	pluginDefs = { ...pluginDefs, ...defs };
	emit("fields:changed");
}

/** Remove plugin field definitions by key (called when a plugin is deactivated). @api */
export function unregisterPluginFieldDefs(keys: string[]) {
	if (keys.length === 0) return;
	const next = { ...pluginDefs };
	for (const k of keys) delete next[k];
	pluginDefs = next;
	emit("fields:changed");
}

/** Every listable built-in, and every field this map defines. @api @unstable */
export function getFieldKeys(): string[] {
	return [...new Set([...Object.keys(FIELDS), ...getKnownFieldKeys()])].filter(isListableField);
}

/** Keys this map defines a field for. Same reference until the user layer moves. @api */
export const getKnownFieldKeys: () => ReadonlySet<string> = memoOnRefs(
	() => [Store.get().fieldDefs] as const,
	(defs) => new Set(Object.keys(defs)),
);

// Compose two layers per-attribute: the higher layer wins when non-null.
function mergeDef(user: FieldDef | undefined, plugin: FieldDef | undefined): FieldDef | undefined {
	if (!user) return plugin;
	if (!plugin) return user;
	return {
		type: user.type,
		label: user.label ?? plugin.label,
		values: user.values ?? plugin.values,
		comparison: user.comparison ?? plugin.comparison,
		interned: user.interned ?? plugin.interned,
	};
}

/** Look up metadata for a field key. Returns `undefined` if no layer declares it. @api */
export function getFieldDef(key: string): FieldDef | undefined {
	return mergeDef(mergeDef(Store.get().fieldDefs[key], pluginDefs[key]), FIELDS[key]);
}

/** Translated display label for a field key, falling back to a sentence-cased version of the key. @api */
export function fieldLabel(key: string): string {
	const label = getFieldDef(key)?.label;
	return label
		? t(label)
		: key
				.replace(/([a-z])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`)
				.replace(/_/g, " ")
				.replace(/^./, (c) => c.toUpperCase());
}

/** Display label for a field value. Enum values use their translated display name. @api */
export function fieldValueLabel(def: FieldDef | undefined, value: unknown): string {
	const raw = String(value);
	const label = def?.values?.find((v) => v.value === raw)?.label;
	return label ? t(label) : raw;
}

/** The value space a field declares, as bare strings. Distinct from the store's
 *  `fieldValues`, which reports the values actually present in the data. @api */
export function declaredValues(def: FieldDef | undefined): string[] | null {
	return def?.values?.map((v) => v.value) ?? null;
}

/** Merged view of all field definitions across all layers. @api */
export function getAllFieldDefs(): Record<string, FieldDef> {
	const out: Record<string, FieldDef> = {};
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

/** Projections valid for a field type, in display order (first = dialog default). @api @unstable */
export function projectionsForType(type: FieldType): FieldProjection[] {
	return PROJECTIONS.filter((p) => (p.appliesTo as readonly FieldType[]).includes(type)).map(
		(p) => ({
			id: p.id,
			label: projectionLabel(p.id),
			needsTz: p.needsTz,
		}),
	);
}

// Render sites translate the returned label, so the raw id is a visible fallback, not a crash.
function projectionLabel(id: string): string {
	const label = PROJECTION_LABELS[id];
	if (!label && import.meta.env.DEV) log.warn(`[fields] projection "${id}" has no label`);
	return label ?? id;
}

/** The "Range" partition option (numeric binning). @api @unstable */
export const RANGE_ID = "range";

/** Partition-key dropdown options for a field type. @api @unstable */
export function partitionKeyOptions(
	type: FieldType,
	rangeForDates: boolean,
): { id: string; label: string }[] {
	const projs = projectionsForType(type).map((p) => ({ id: p.id, label: p.label }));
	const hasRange = type === "number" || (rangeForDates && type === "date");
	return hasRange ? [{ id: RANGE_ID, label: msg("Range") }, ...projs] : projs;
}
