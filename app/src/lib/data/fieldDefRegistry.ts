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
import { BUILTIN_FIELDS, CLEARABLE_BUILTINS } from "@/bindings.consts";
import type { FieldDef } from "@/bindings.gen";
import { t } from "@/lib/i18n";

// Field kind: identity (position), virtual (derived), term (expression-only),
// writable (bulk-editable), or undefined (read-only, listable).
type FieldKind = NonNullable<(typeof BUILTIN_FIELDS)[number]["kind"]>;

interface RegistryFieldDef extends FieldDef {
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
	return kind === "virtual";
}

/** True when the field can be bulk-edited. @unstable */
export function isWritableField(key: string): boolean {
	return key in FIELDS ? FIELDS[key].kind === "writable" : true;
}

/** True when the field can be bulk-cleared. @unstable */
export function isClearableField(key: string): boolean {
	return key in FIELDS ? (CLEARABLE_BUILTINS as readonly string[]).includes(key) : true;
}

/** True when the field should appear in field pickers. @unstable */
export function isListableField(key: string): boolean {
	return key in FIELDS ? FIELDS[key].kind !== "identity" : true;
}

/** All built-in field keys (excluding virtual). @unstable */
export function getBuiltinKeys(): string[] {
	return Object.keys(FIELDS).filter(isBuiltinField);
}

let pluginDefs: Record<string, FieldDef> = {};
/** Register field definitions from an enrichment provider (called at activation). */
export function registerPluginFieldDefs(defs: Record<string, FieldDef>) {
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

/** Keys a field picker offers: every listable built-in, and every key this map's locations carry. @unstable */
export function getPickableFieldKeys(): string[] {
	return [...new Set([...Object.keys(FIELDS), ...getKnownFieldKeys()])].filter(isListableField);
}

/** Keys some location on this map carries. Same reference until the user layer moves. */
export const getKnownFieldKeys: () => ReadonlySet<string> = memoOnRefs(
	() => [getMapState().fieldDefs] as const,
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
	};
}

/** Look up metadata for a field key. Returns `undefined` if no layer declares it. */
export function getFieldDef(key: string): FieldDef | undefined {
	return mergeDef(mergeDef(getMapState().fieldDefs[key], pluginDefs[key]), FIELDS[key]);
}

/** Translated display label for a field key, falling back to a sentence-cased version of the key. */
export function fieldLabel(key: string): string {
	const label = getFieldDef(key)?.label;
	return label
		? t(label)
		: key
				.replace(/([a-z])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`)
				.replace(/_/g, " ")
				.replace(/^./, (c) => c.toUpperCase());
}

/** Display label for a field value. Enum values use their translated display name. */
export function fieldValueLabel(def: FieldDef | undefined, value: unknown): string {
	const raw = String(value);
	const label = def?.values?.find((v) => v.value === raw)?.label;
	return label ? t(label) : raw;
}

/** The value space a field declares, as bare strings. Distinct from the store's
 *  `fieldValues`, which reports the values actually present in the data. */
export function declaredValues(def: FieldDef | undefined): string[] | null {
	return def?.values?.map((v) => v.value) ?? null;
}

/** Merged view of all field definitions across all layers. */
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
