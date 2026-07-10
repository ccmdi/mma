/**
 * Unified field-definition registry.
 *
 * Field **existence** (which keys have data) is tracked separately by
 * `knownFieldKeys` in `useMapStore`. This module handles field **metadata**
 * (type, label, enum values) from two sources, in priority order:
 *
 *   1. **User overrides** — persisted in `MapMeta.extra.fields`, editable via
 *      ManageFields. Loaded on map open, updated on save. Curated defs for
 *      well-known SV keys are written here by Rust (`known_field_def`) when the
 *      key first appears in location data, so they show up the same way.
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

import { useSyncExternalStore } from "react";
import type { ExtraFieldDef } from "@/bindings.gen";

interface BuiltinFieldDef extends ExtraFieldDef {
	writable?: boolean;
}

const BUILTIN_FIELDS: Record<string, BuiltinFieldDef> = {
	lat: { type: "number", label: "Latitude" },
	lng: { type: "number", label: "Longitude" },
	heading: {
		type: "number",
		label: "Heading",
		comparison: { type: "circular", period: 360 },
		writable: true,
	},
	pitch: { type: "number", label: "Pitch", writable: true },
	zoom: { type: "number", label: "Zoom", writable: true },
	createdAt: { type: "date", label: "Created" },
	modifiedAt: { type: "date", label: "Modified" },
};

const VIRTUAL_FIELDS: Record<string, ExtraFieldDef> = {
	tagCount: { type: "number", label: "Tag count" },
};

/** True when `key` is a built-in Location field (not nested under `extra`). */
export function isBuiltinField(key: string): boolean {
	return key in BUILTIN_FIELDS;
}

/** True when `key` is a writable built-in field (heading, pitch, zoom). */
export function isWritableBuiltinField(key: string): boolean {
	return BUILTIN_FIELDS[key]?.writable === true;
}

/** All writable built-in field keys. */
export function getWritableBuiltinKeys(): string[] {
	return Object.keys(BUILTIN_FIELDS).filter((k) => BUILTIN_FIELDS[k].writable);
}

/** All built-in field keys (writable + read-only, excluding virtual). */
export function getBuiltinKeys(): string[] {
	return Object.keys(BUILTIN_FIELDS);
}

let pluginDefs: Record<string, ExtraFieldDef> = {};
let userDefs: Record<string, ExtraFieldDef> = {};

// --- Reactivity: a version that bumps whenever any layer changes. Consumers that
//     read defs (labels, comparison) inside a memo can't key on the field-key set
//     alone -- a label rename changes a def without changing which keys exist. They
//     subscribe to this so a def-only edit invalidates their memo. ---
let version = 0;
const listeners = new Set<() => void>();
function bump() {
	version++;
	listeners.forEach((l) => l());
}
function subscribe(l: () => void): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}
/** Snapshot of the def-change version (bumps on every layer mutation). */
export function getFieldDefsVersion(): number {
	return version;
}
/** Reactive hook: re-renders when any field def changes (label, type, comparison, ...). */
export function useFieldDefsVersion(): number {
	return useSyncExternalStore(subscribe, getFieldDefsVersion);
}

/** Register field definitions from an enrichment provider (called at activation). */
export function registerPluginFieldDefs(defs: Record<string, ExtraFieldDef>) {
	pluginDefs = { ...pluginDefs, ...defs };
	bump();
}

/** Remove plugin field definitions by key (called when a plugin is deactivated). */
export function unregisterPluginFieldDefs(keys: string[]) {
	if (keys.length === 0) return;
	const next = { ...pluginDefs };
	for (const k of keys) delete next[k];
	pluginDefs = next;
	bump();
}

/** Load user-customized field definitions from `MapMeta.extra.fields` (called on map open). */
export function setUserFieldDefs(defs: Record<string, ExtraFieldDef>) {
	userDefs = defs;
	bump();
}

/** Merge auto-registered/inferred defs into the user layer (e.g. after a mutation
 *  discovers new extra keys). Existing entries win, so user edits and previously-loaded
 *  defs are never clobbered. Keeps the registry the live source of truth without a reload. */
export function mergeUserFieldDefs(defs: Record<string, ExtraFieldDef>) {
	userDefs = { ...defs, ...userDefs };
	bump();
}

/** Clear per-map state on map close. Plugin defs persist across maps. */
export function resetForMapChange() {
	userDefs = {};
	bump();
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
	return mergeDef(
		mergeDef(userDefs[key], pluginDefs[key]),
		BUILTIN_FIELDS[key] ?? VIRTUAL_FIELDS[key],
	);
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

/** Merged view of all field definitions across all layers. */
export function getAllFieldDefs(): Record<string, ExtraFieldDef> {
	const out: Record<string, ExtraFieldDef> = {};
	const allKeys = new Set([
		...Object.keys(BUILTIN_FIELDS),
		...Object.keys(VIRTUAL_FIELDS),
		...Object.keys(pluginDefs),
		...Object.keys(userDefs),
	]);
	for (const key of allKeys) {
		const merged = getFieldDef(key);
		if (merged) out[key] = merged;
	}
	return out;
}
