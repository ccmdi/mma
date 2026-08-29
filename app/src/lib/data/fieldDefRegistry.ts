/*
 * Unified field-definition registry.
 *
 * Field **metadata** (type, label, enum values) from two sources, in priority order:
 *
 *   1. **User overrides** — persisted in `MapMeta.extra.fields`, editable via
 *      ManageFields. Loaded on map open, replaced whole whenever a mutation result
 *      carries `fieldDefs`. Curated defs for well-known SV keys are written here by
 *      Rust (`known_field_def`) when the key first appears in location data, so they
 *      show up the same way. This layer is also field **existence**: a key is in it
 *      exactly when some location carries it (`getKnownFieldKeys`).
 *   2. **Plugin defs** — declared by `EnrichmentProvider.fieldDefs` at
 *      registration time. Available as long as the plugin is active.
 *
 * `getFieldDef(key)` composes the layers **per-attribute**, not whole-object: the
 * user layer wins for any attribute it actually has an opinion on, falling through
 * to the plugin layer for null/absent ones. This matters because Rust auto-registers
 * a label-less placeholder (`{ type, label: null, comparison: null, ... }`) into the
 * user layer the first time a plugin-owned key appears in data — Rust can't see the
 * plugin layer, so it must infer *something*. Whole-object precedence would let that
 * placeholder shadow the plugin's real label and comparison; per-attribute fallthrough
 * treats a null attribute as "no opinion, ask the next layer." Returns `undefined` if
 * no layer declares the key (the UI falls back to the raw key name).
 */

import { emit } from "@/lib/events";
import { BUILTIN_FIELDS, PROJECTIONS } from "@/bindings.gen";
import type { ExtraFieldDef, ExtraFieldType } from "@/bindings.gen";
import { msg, t } from "@/lib/i18n";

/**
 * What a registry field *is*, which determines how it may be accessed:
 * - "identity": composes the location itself (position). Never writable through the
 *   field system, never offered in pickers; resolvable by exact key only.
 * - "virtual": derived, not stored on the location. Never writable.
 * - "term": only a term in a field expression. Never writable, never offered in pickers:
 *   a selection type already answers it, and better.
 * - "writable": explicitly bulk-editable top-level field.
 * - undefined: on the location, listable and filterable, but read-only.
 * Extra (user/plugin) fields live outside this map and are always writable and listable.
 */
type FieldKind = NonNullable<(typeof BUILTIN_FIELDS)[number]["kind"]>;

interface RegistryFieldDef extends ExtraFieldDef {
	kind?: FieldKind;
}

/** Derived from the Rust `BUILTIN_FIELDS` table, which the filter resolvers share. */
const FIELDS: Record<string, RegistryFieldDef> = Object.fromEntries(
	BUILTIN_FIELDS.map((f) => [
		f.key,
		{
			type: f.type,
			label: f.label,
			comparison: f.comparison,
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

/** False for identity fields (lat/lng) and expression terms, which pickers must not offer. */
export function isListableField(key: string): boolean {
	return key in FIELDS ? !["identity", "term"].includes(FIELDS[key].kind ?? "") : true;
}

/** All built-in field keys (excluding virtual). */
export function getBuiltinKeys(): string[] {
	return Object.keys(FIELDS).filter(isBuiltinField);
}

let pluginDefs: Record<string, ExtraFieldDef> = {};
let userDefs: Record<string, ExtraFieldDef> = {};
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

let knownKeys: ReadonlySet<string> = new Set();

/** Replace the user layer: on map open from `MapMeta.extra.fields`, and from every
 *  mutation result that carries `fieldDefs`. Rust owns this map; JS never merges into it. */
export function setUserFieldDefs(defs: Record<string, ExtraFieldDef>) {
	userDefs = defs;
	knownKeys = new Set(Object.keys(defs));
	emit("fields:changed");
}

/** Keys some location on this map carries. Same reference until `fields:changed`. */
export function getKnownFieldKeys(): ReadonlySet<string> {
	return knownKeys;
}

/** Compose two layers per-attribute: the user value wins when present, falling
 *  through to the plugin value for null/absent attributes (a label-less inferred
 *  placeholder must not shadow the plugin's real label/comparison). */
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

/** Look up metadata for a single field key. Returns `undefined` if no metadata exists. */
export function getFieldDef(key: string): ExtraFieldDef | undefined {
	return mergeDef(mergeDef(userDefs[key], pluginDefs[key]), FIELDS[key]);
}

/** Display label for a field key: registered label if known, otherwise sentence-cased from camelCase/snake_case. */
export function fieldLabel(key: string): string {
	return (
		getFieldDef(key)?.label ??
		key
			.replace(/([a-z])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`)
			.replace(/_/g, " ")
			.replace(/^./, (c) => c.toUpperCase())
	);
}

/** Display text for one *value* of a field, the counterpart to [`fieldLabel`] naming the
 *  field itself. Enum values carry translated display names; everything else is its own
 *  string. */
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
		...Object.keys(userDefs),
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
	/** Date projections read in the location's own timezone when set -- surfaces a toggle. */
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

/** The synthetic "Range" option: numeric binning, which isn't a stateless projection. */
export const RANGE_ID = "range";

/** Dropdown options for a partition: the projection catalog plus "Range" for numbers (and
 *  dates too when `rangeForDates`). */
export function partitionKeyOptions(
	type: ExtraFieldType,
	rangeForDates: boolean,
): { id: string; label: string }[] {
	const projs = projectionsForType(type).map((p) => ({ id: p.id, label: p.label }));
	const hasRange = type === "number" || (rangeForDates && type === "date");
	return hasRange ? [{ id: RANGE_ID, label: msg("Range") }, ...projs] : projs;
}
