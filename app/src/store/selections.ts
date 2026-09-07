/** Pure selection transforms: build, compose, invert, rewrite, and remove selections. */

import type { FilterOp, PolygonGeometry, Tag } from "@/bindings.gen";
import { getVisibleTags, getTag } from "@/store/useMapStore";
import { hslToRgb, type RGB } from "@/lib/util/color";
import { getFieldDef, fieldValueLabel } from "@/lib/data/fieldDefRegistry";
import { formatDistance, localDateTime, utcDateTime } from "@/lib/util/format";
import { batch, clamp, isVariant, unionTuple, type Variant } from "@/types/util";
export { batch };
import { ValidationState } from "@/bindings.consts";
import { pointInPolygon } from "@/lib/geo/geo";
import { getSettings } from "@/store/settings";
import { dayMonthFmt } from "@/lib/util/format";
import { t, msg } from "@/lib/i18n";
import { shortestUniqueSuffixes } from "@/components/editor/tags/tagTreeRange";

import type { Selection, Selector } from "@/bindings.gen";

export interface SelectionState {
	selections: Selection[];
	ghosted: ReadonlySet<string>;
}

export type SelectionPatch = Partial<SelectionState>;

/** Selector variants that wrap child selections (Intersection, Union, Invert). */
export type CompositeType = Extract<Selector, { selections: Selection[] }>["type"];
/** Composite variants that wrap exactly one child (e.g. Invert). */
export type UnaryType = "Invert";
/** Composite variants that are flat n-ary groups. */
export type GroupType = Exclude<CompositeType, UnaryType>;

const COMPOSITE_TYPES = unionTuple<CompositeType>()(["Intersection", "Union", "Invert"]);
const GROUP_TYPES = unionTuple<GroupType>()(["Intersection", "Union"]);
export const UNARY_TYPES = unionTuple<UnaryType>()(["Invert"]);

export type FilterOpKind = FilterOp["op"];

/** Whether a predicate reads the location's clock in its own timezone. Only a range can. */
export const filterIsLocalTime = (test: FilterOp): boolean =>
	"tzLocal" in test && test.tzLocal === true;

/** Display symbol/word for each filter operator. Symbols are language-neutral; only the worded
 *  operators are marked for translation. */
export const OP_LABELS: Record<FilterOpKind, string> = {
	eq: "=",
	neq: "!=",
	gt: ">",
	lt: "<",
	gte: ">=",
	lte: "<=",
	between: msg("between"),
	between_anyyear: msg("between (any year)"),
	between_anytime: msg("between (any date)"),
	has: msg("has"),
	nothas: msg("does not have"),
	contains: msg("contains"),
	notcontains: msg("does not contain"),
};

/** Deterministic color derived from a selection key string. */
export function colorForKey(key: string): RGB {
	let t = 0;
	for (let i = 0; i < key.length; i += 1) t = ((key.charCodeAt(i) + (t << 5)) | 0) + t;
	t = (((t * 214013) | 0) + 2531011) | 0;
	return hslToRgb(Math.abs(t) % 360, 0.5, 0.5);
}

function locationsKey(ids: number[]): string {
	return ids.join(",");
}

/** Ghost keys that "solo" `key`: everything except it. Returns an empty set when `key`
 *  is already the sole visible selection, so a repeat call un-isolates (clears all ghosts). */
export function isolateGhostKeys(
	keys: string[],
	ghosted: ReadonlySet<string>,
	key: string,
): Set<string> {
	const alreadyIsolated = !ghosted.has(key) && keys.every((k) => k === key || ghosted.has(k));
	return alreadyIsolated ? new Set() : new Set(keys.filter((k) => k !== key));
}

/** Toggle one selection's ghosted (dimmed) state. */
export const toggleGhost =
	(key: string) =>
	(_sels: Selection[], ghosted: ReadonlySet<string>): SelectionPatch => ({
		ghosted: ghosted.symmetricDifference(new Set([key])),
	});

/** Solo one selection by ghosting all others. Repeat to clear all ghosts. */
export const isolateGhost =
	(key: string) =>
	(sels: Selection[], ghosted: ReadonlySet<string>): SelectionPatch => ({
		ghosted: isolateGhostKeys(
			sels.map((s) => s.key),
			ghosted,
			key,
		),
	});

/** Ghost all selections, or clear all ghosts if every selection is already ghosted. */
export const toggleGhostAll =
	() =>
	(sels: Selection[], ghosted: ReadonlySet<string>): SelectionPatch => {
		const keys = new Set(sels.map((s) => s.key));
		const allGhosted = keys.size > 0 && keys.isSubsetOf(ghosted);
		return { ghosted: allGhosted ? new Set() : ghosted.union(keys) };
	};

/** Pick `n` distinct ids uniformly at random from `ids` using `Math.random`.
 *  `n` is floored and clamped to `[0, ids.length]` (so over-large counts return all ids).
 *  Uses a partial Fisher–Yates shuffle, so the result contains no duplicates and `ids` is not mutated. */
export function sampleIds(ids: number[], n: number): number[] {
	const k = clamp(Math.floor(n), 0, ids.length);
	const pool = ids.slice();
	for (let i = 0; i < k; i += 1) {
		const j = i + Math.floor(Math.random() * (pool.length - i));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, k);
}

/** What one selection type answers about itself; optional answers default at the lookup. */
interface SelectionDescriptor<K extends Selector["type"]> {
	key(selector: Variant<Selector, K>, locations: number[]): string;
	label(selector: Variant<Selector, K>, tagNames?: Record<number, string>): string;
	/** Null falls through to the key hash. */
	color?(selector: Variant<Selector, K>): RGB | null;
	locations?(selector: Variant<Selector, K>): number[];
}

const ownLocations = (s: { locations: number[] }) => [...s.locations];

/** Per-type descriptor for each selector variant: key derivation, display label, and optional color/location overrides. */
export const SELECTIONS: { [K in Selector["type"]]: SelectionDescriptor<K> } = {
	Locations: {
		key: (_s, locations) => locationsKey(locations),
		label: (s) => s.name ?? t("Selection"),
		locations: ownLocations,
	},
	Everything: {
		key: () => "everything",
		label: () => t("Everything"),
	},
	Polygon: {
		key: (s) => polygonKey(s.polygon),
		label: (s) =>
			s.polygon.properties?.name
				? t("Polygon: {name}", { name: String(s.polygon.properties.name) })
				: t("Polygon"),
		color: () => {
			const { polygonColorMode, polygonColor } = getSettings();
			return polygonColorMode === "fixed" ? polygonColor : null;
		},
	},
	Tag: {
		key: (s) => `tag:${s.tagId}`,
		label: (s, tagNames) => t("Tag: {name}", { name: tagDisplayName(s.tagId, tagNames) }),
	},
	Untagged: {
		key: () => "untagged",
		label: () => t("Untagged"),
	},
	Unpanned: {
		key: () => "unpanned",
		label: () => t("Unpanned"),
	},
	PanoIds: {
		key: () => "panoids",
		label: () => t("Pano ID locations"),
	},
	NotPanoIds: {
		key: () => "notpanoids",
		label: () => t("Coordinate locations"),
	},
	Uncommitted: {
		key: () => "uncommitted",
		label: () => t("Uncommitted"),
	},
	Duplicates: {
		key: (s) => `duplicates:${s.distance}`,
		label: (s) => t("Duplicates ({distance})", { distance: formatDistance(s.distance) }),
	},
	Manual: {
		key: () => "manual",
		label: () => t("Manual selection"),
		locations: ownLocations,
	},
	ValidationState: {
		key: (s) => `validation:${s.state}`,
		label: (s) => t(validationStateLabel(s.state as ValidationState)),
		locations: ownLocations,
	},
	Reviewed: {
		key: (s) => `review:${s.sessionId}:${s.mode}`,
		label: (s) => (s.mode === "unreviewed" ? t("Unreviewed") : t("Reviewed")),
		// Green reviewed, violet unreviewed: both stay clear of the red active marker.
		color: (s) => (s.mode === "unreviewed" ? hslToRgb(280, 0.6, 0.5) : hslToRgb(145, 0.6, 0.5)),
		locations: ownLocations,
	},
	Intersection: {
		key: (s) => s.selections.map((c) => `(${c.key})`).join("^"),
		label: () => t("Intersection"),
	},
	Union: {
		key: (s) => s.selections.map((c) => `(${c.key})`).join("|"),
		label: () => t("Union"),
	},
	Invert: {
		key: (s) => `!${s.selections[0].key}`,
		label: (s, tagNames) =>
			t("Invert: {selection}", { selection: selectionDisplayName(s.selections[0], tagNames) }),
	},
	Filter: {
		key: (s) => {
			const t = s.test;
			const operands = "lo" in t ? [t.lo, t.hi] : "value" in t ? [t.value] : [null];
			const frame = filterIsLocalTime(t) ? ":local" : "";
			return `filter:${s.field}:${t.op}:${operands.map(String).join(":")}${frame}`;
		},
		label: (p) => {
			const fieldDef = getFieldDef(p.field);
			const fieldLabel = fieldDef?.label ? t(fieldDef.label) : p.field;
			const test = p.test;
			if (test.op === "has") return t("has {field}", { field: fieldLabel });
			if (test.op === "nothas") return t("missing {field}", { field: fieldLabel });
			const fmtMD = (v: unknown) => {
				const s = String(v);
				const m = /^(\d{2})-(\d{2})$/.exec(s);
				if (m) {
					const dt = new Date(2000, Number(m[1]) - 1, Number(m[2]));
					return dayMonthFmt.format(dt);
				}
				return s;
			};
			// Local-time values are wall-clock instants encoded as UTC epochs: render via UTC getters.
			const local = filterIsLocalTime(test);
			const fmtVal = (v: unknown) => {
				if (fieldDef?.type === "date") {
					const n = Number(v);
					if (!isNaN(n)) return local ? utcDateTime(n) : localDateTime(n);
				}
				return fieldValueLabel(fieldDef, v);
			};
			const tzSuffix = local ? " " + t("(location time)") : "";
			const clause = (value: string) =>
				t("{field} {op} {value}", { field: fieldLabel, op: t(OP_LABELS[test.op]), value }) +
				tzSuffix;
			if (test.op === "between_anyyear") return clause(`${fmtMD(test.lo)}..${fmtMD(test.hi)}`);
			if (test.op === "between_anytime") return clause(`${test.lo}..${test.hi}`);
			if (test.op === "between") return clause(`${fmtVal(test.lo)}..${fmtVal(test.hi)}`);
			return clause(fmtVal(test.value));
		},
	},
	Ranked: {
		key: (s) => `ranked:${s.expr}:${s.k}:${s.ascending}:${s.selection?.key ?? ""}`,
		label: (s) => {
			const fieldDef = getFieldDef(s.expr);
			const by = fieldDef?.label ? t(fieldDef.label) : s.expr;
			if (s.k == null) return t("Ranked by {field}", { field: by });
			return s.ascending
				? t("Bottom {k} by {field}", { k: s.k, field: by })
				: t("Top {k} by {field}", { k: s.k, field: by });
		},
	},
};

function descriptorFor(selector: Selector) {
	const d = SELECTIONS[selector.type] as SelectionDescriptor<Selector["type"]>;
	return {
		key: (locations: number[]) => d.key(selector, locations),
		label: (tagNames?: Record<number, string>) => d.label(selector, tagNames),
		color: () => d.color?.(selector) ?? null,
		locations: () => d.locations?.(selector) ?? [],
	};
}

// Key a polygon by hashing its raw coordinates: identical geometry = identical key.
function polygonKey(geom: PolygonGeometry): string {
	let h1 = 0xdeadbeef | 0;
	let h2 = 0x41c6ce57 | 0;
	const f64 = new Float64Array(2);
	const u32 = new Uint32Array(f64.buffer);
	const foldRing = (ring: [number, number][]) => {
		for (const [lng, lat] of ring) {
			f64[0] = lng;
			f64[1] = lat;
			h1 = Math.imul(h1 ^ u32[0], 2654435761) ^ u32[1];
			h2 = Math.imul(h2 ^ u32[2], 1597334677) ^ u32[3];
		}
	};
	for (const ring of geom.coordinates) foldRing(ring);
	for (const poly of geom.extraPolygons ?? []) for (const ring of poly) foldRing(ring);
	return `polygon:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** Every child selection a selector wraps, whatever shape it wraps them in. */
export function childSelections(selector: Selector): Selection[] {
	if ("selections" in selector) return selector.selections;
	if ("selection" in selector) return selector.selection ? [selector.selection] : [];
	return [];
}

/** `selector` with its children replaced, keeping the shape it wraps them in. */
export function withChildren(selector: Selector, children: Selection[]): Selector {
	if ("selections" in selector) return { ...selector, selections: children };
	if ("selection" in selector) return { ...selector, selection: children[0] ?? null };
	return selector;
}

/** Create a Selection with a deterministic key and color from its selector. */
export function buildSelection(selector: Selector): Selection {
	const d = descriptorFor(selector);
	const key = d.key(d.locations());
	return { key, color: d.color() ?? colorForKey(key), selector };
}

// dedupe by key, preserving order of last occurrence
function dedupe(selections: Selection[]): Selection[] {
	const map = new Map<string, Selection>();
	for (const s of selections) map.set(s.key, s);
	return map.size === selections.length ? selections : Array.from(map.values());
}

/** Append a new selection built from `selector`, deduplicating by key. */
export const addSelection =
	(selector: Selector) =>
	(current: Selection[]): Selection[] =>
		dedupe([...current, buildSelection(selector)]);

/** Keys of every Polygon selection whose geometry contains the point. */
export function polygonSelectionsContaining(
	selections: Selection[],
	lat: number,
	lng: number,
): string[] {
	const keys: string[] = [];
	for (const sel of selections) {
		if (sel.selector.type !== "Polygon") continue;
		const { coordinates, extraPolygons } = sel.selector.polygon;
		const polys = extraPolygons ? [coordinates, ...extraPolygons] : [coordinates];
		if (polys.some((rings) => pointInPolygon(lng, lat, rings))) keys.push(sel.key);
	}
	return keys;
}

/** Remove a selection by key. Composites unwrap their children back into the list. */
export const removeSelection =
	(key: string) =>
	(current: Selection[]): Selection[] => {
		const idx = current.findIndex((s) => s.key === key);
		if (idx === -1) return current;
		const s = current[idx];
		const children = isVariant(s.selector, COMPOSITE_TYPES) ? s.selector.selections : [];
		return [...current.slice(0, idx), ...children, ...current.slice(idx + 1)];
	};

/** Split selections into [matching the keys, everything else]. */
function partitionByKeys(current: Selection[], keys: string[]): [Selection[], Selection[]] {
	const targets: Selection[] = [];
	const others: Selection[] = [];
	for (const s of current) (keys.includes(s.key) ? targets : others).push(s);
	return [targets, others];
}

/** Merge targeted selections into a single composite, flattening nested groups of the same type. */
function composeSelectionGroup(
	current: Selection[],
	keys: string[] | null,
	type: "Intersection" | "Union",
): Selection[] {
	if (current.length < 2) return current;
	const [targets, others] = partitionByKeys(current, keys ?? current.map((s) => s.key));
	const flat = targets.flatMap((s) => (s.selector.type === type ? s.selector.selections : [s]));
	return [...others, buildSelection({ type, selections: dedupe(flat) })];
}

/** Merge the targeted selections (or all, when `keys` is null) into a single Intersection. */
export const intersectSelections =
	(keys: string[] | null = null) =>
	(current: Selection[]) =>
		composeSelectionGroup(current, keys, "Intersection");

/** Merge the targeted selections (or all, when `keys` is null) into a single Union. */
export const unionSelections =
	(keys: string[] | null = null) =>
	(current: Selection[]) =>
		composeSelectionGroup(current, keys, "Union");

/** Invert targeted selections. Single target toggles in-place at any depth; multiple are wrapped in Union then Invert. */
export const invertSelections =
	(keys: string[] | null = null) =>
	(current: Selection[]): Selection[] => {
		if (current.length === 0) return current;
		const targetKeys = keys ?? current.map((s) => s.key);
		// single-target invert toggles in-place, nested children included
		if (targetKeys.length === 1) {
			const toggle = (m: Selection): Selection =>
				m.selector.type === "Invert"
					? m.selector.selections[0]
					: buildSelection({ type: "Invert", selections: [m] });
			for (let i = 0; i < current.length; i++) {
				const inverted = transformInTree(current[i], targetKeys[0], toggle);
				if (inverted) return spliceMerging(current, i, inverted);
			}
			return current;
		}
		const [targets, others] = partitionByKeys(current, targetKeys);
		const flat = targets.flatMap((s) =>
			s.selector.type === "Union" ? s.selector.selections : [s],
		);
		const inner = flat.length === 1 ? flat[0] : buildSelection({ type: "Union", selections: flat });
		return [...others, buildSelection({ type: "Invert", selections: [inner] })];
	};

/** Add or remove a location from the Manual selection, creating it if needed. */
export const toggleManualSelection =
	(locationId: number) =>
	(current: Selection[]): Selection[] => {
		const idx = current.findIndex((s) => s.key === "manual");
		if (idx === -1)
			return [...current, buildSelection({ type: "Manual", locations: [locationId] })];
		const sel = current[idx];
		const ids = (sel.selector as Variant<Selector, "Manual">).locations.slice();
		const at = ids.indexOf(locationId);
		if (at === -1) ids.push(locationId);
		else ids.splice(at, 1);
		if (ids.length === 0) return current.toSpliced(idx, 1);
		const next = buildSelection({ type: "Manual", locations: ids });
		return current.with(idx, next);
	};

/** Move selection `fromKey` before or after `toKey` in the list. */
export const reorderSelections =
	(fromKey: string, toKey: string, position: "before" | "after") =>
	(current: Selection[]): Selection[] => {
		const fromIdx = current.findIndex((s) => s.key === fromKey);
		if (fromIdx === -1) return current;
		const item = current[fromIdx];
		const without = current.toSpliced(fromIdx, 1);
		let toIdx = without.findIndex((s) => s.key === toKey);
		if (toIdx === -1) return current;
		if (position === "after") toIdx++;
		return without.toSpliced(toIdx, 0, item);
	};

/** Merge the dragged selection into the drop target as a composite, absorbing existing
 *  children of the same type. Handles nested cases across parent groups. */
export const composeSelections =
	(
		dragKey: string,
		dropKey: string,
		mode: GroupType,
		dragParent: string | null = null,
		dropParent: string | null = null,
	) =>
	(current: Selection[]): Selection[] => {
		if (dragParent && dropParent && dragParent === dropParent) {
			return composeSiblings(current, dragParent, dragKey, dropKey, mode);
		}
		const sels = dragParent ? decomposeChild(dragParent, dragKey)(current) : current;
		if (dropParent) return composeWithChild(sels, dragKey, dropParent, dropKey, mode);
		const dragIdx = sels.findIndex((s) => s.key === dragKey);
		const dropIdx = sels.findIndex((s) => s.key === dropKey);
		if (dragIdx === -1 || dropIdx === -1 || dragIdx === dropIdx) return sels;
		const drag = sels[dragIdx];
		const drop = sels[dropIdx];

		let children: Selection[];
		if (isVariant(drop.selector, mode)) {
			children = [...drop.selector.selections, drag];
		} else {
			children = [drop, drag];
		}
		const composite = buildSelection({ type: mode, selections: dedupe(children) });

		return sels.filter((_, i) => i !== dragIdx).map((s) => (s.key === dropKey ? composite : s));
	};

// Unwrap a unary operator to the group it wraps, returning the group's selector plus a `rewrap`
// that restores the operator; a plain group returns itself with an identity rewrap. Null when
// there's no group to operate on.
function unwrapUnary(
	sel: Selection,
): { selector: Variant<Selector, GroupType>; rewrap: (inner: Selection) => Selection } | null {
	const unary = isVariant(sel.selector, UNARY_TYPES) ? sel.selector.type : null;
	const selector = isVariant(sel.selector, UNARY_TYPES)
		? sel.selector.selections[0].selector
		: sel.selector;
	if (!isVariant(selector, GROUP_TYPES)) return null;
	return {
		selector,
		rewrap: (inner) => (unary ? buildSelection({ type: unary, selections: [inner] }) : inner),
	};
}

// Rebuild a composite around `next`: a group that drops to one child collapses to it, an empty
// one is gone (null). `rewrap` keeps a unary wrapper (Invert) around whatever survives.
function rebuildComposite(
	type: GroupType,
	rewrap: (inner: Selection) => Selection,
	next: Selection[],
): Selection | null {
	if (next.length === 0) return null;
	return rewrap(next.length === 1 ? next[0] : buildSelection({ type, selections: next }));
}

// `updated: null` means the composite is empty now and the caller must drop it. `dissolve` hoists a
// removed group's children into the parent instead of taking them with it - a delete ungroups,
// an extract must not (the child keeps its own children when it leaves).
function removeChildFromComposite(
	sel: Selection,
	parentKey: string,
	childKey: string,
	dissolve: boolean,
): { updated: Selection | null; removed: Selection } | null {
	const grp = unwrapUnary(sel);
	if (!grp) return null;
	const { selector: composite, rewrap } = grp;
	const children = composite.selections;
	const rebuild = (next: Selection[]) => rebuildComposite(composite.type, rewrap, next);

	if (sel.key === parentKey) {
		const childIdx = children.findIndex((s) => s.key === childKey);
		if (childIdx === -1) return null;
		const child = children[childIdx];
		const inlined =
			dissolve && isVariant(child.selector, GROUP_TYPES) ? child.selector.selections : [];
		return { updated: rebuild(children.toSpliced(childIdx, 1, ...inlined)), removed: child };
	}

	for (let i = 0; i < children.length; i++) {
		const result = removeChildFromComposite(children[i], parentKey, childKey, dissolve);
		if (result) {
			const next = result.updated ? children.with(i, result.updated) : children.toSpliced(i, 1);
			return { updated: rebuild(next), removed: result.removed };
		}
	}
	return null;
}

// `extract` puts the child back at the top level; `delete` drops it, ungrouping a nested group's
// children into the parent.
function detachChild(
	current: Selection[],
	parentKey: string,
	childKey: string,
	mode: "extract" | "delete",
): Selection[] {
	for (let i = 0; i < current.length; i++) {
		const result = removeChildFromComposite(current[i], parentKey, childKey, mode === "delete");
		if (result) {
			const out = result.updated ? current.with(i, result.updated) : current.toSpliced(i, 1);
			if (mode === "extract") out.splice(result.updated ? i + 1 : i, 0, result.removed);
			return out;
		}
	}
	return current;
}

/** Pull a child out of a composite back into the top-level list, children and all. Parent collapses
 *  if only one child remains, and disappears if none do. */
export const decomposeChild =
	(parentKey: string, childKey: string) =>
	(current: Selection[]): Selection[] =>
		detachChild(current, parentKey, childKey, "extract");

/** Remove a child from a composite, ungrouping any nested group's children into the parent. */
export const removeFromComposite =
	(parentKey: string, childKey: string) =>
	(current: Selection[]): Selection[] =>
		detachChild(current, parentKey, childKey, "delete");

// Rewrite the children of the composite at `parentKey` in place. `edit` returning null leaves the
// list untouched.
function withComposite(
	current: Selection[],
	parentKey: string,
	edit: (children: Selection[]) => Selection[] | null,
): Selection[] {
	const parentIdx = current.findIndex((s) => s.key === parentKey);
	if (parentIdx === -1) return current;
	const grp = unwrapUnary(current[parentIdx]);
	if (!grp) return current;
	const { selector: composite, rewrap } = grp;
	const newChildren = edit(composite.selections);
	if (!newChildren) return current;
	return current.with(
		parentIdx,
		rewrap(buildSelection({ type: composite.type, selections: newChildren })),
	);
}

/** Compose two siblings inside the same parent group into a nested composite. */
export function composeSiblings(
	current: Selection[],
	parentKey: string,
	dragKey: string,
	dropKey: string,
	mode: GroupType,
): Selection[] {
	return withComposite(current, parentKey, (children) => {
		const dragChild = children.find((s) => s.key === dragKey);
		const dropChild = children.find((s) => s.key === dropKey);
		if (!dragChild || !dropChild) return null;
		const nested = buildSelection({ type: mode, selections: [dropChild, dragChild] });
		return children.filter((s) => s.key !== dragKey).map((s) => (s.key === dropKey ? nested : s));
	});
}

/** Compose a top-level selection with a child inside a parent group. */
export function composeWithChild(
	current: Selection[],
	dragKey: string,
	parentKey: string,
	childKey: string,
	mode: GroupType,
): Selection[] {
	const dragIdx = current.findIndex((s) => s.key === dragKey);
	if (dragIdx === -1) return current;
	const drag = current[dragIdx];

	const next = withComposite(current, parentKey, (children) => {
		const childIdx = children.findIndex((s) => s.key === childKey);
		if (childIdx === -1) return null;
		const nested = buildSelection({ type: mode, selections: [children[childIdx], drag] });
		return children.with(childIdx, nested);
	});
	return next === current ? current : next.filter((_, i) => i !== dragIdx);
}

// Put `replaced` at `index` in `list`, enforcing unique keys: if the replacement collides with
// another entry, drop it and keep the pre-existing one.
function spliceMerging(list: Selection[], index: number, replaced: Selection): Selection[] {
	if (list.some((s, j) => j !== index && s.key === replaced.key)) {
		return list.filter((_, j) => j !== index);
	}
	return list.with(index, replaced);
}

// Find the node identified by `key` at any depth and replace it with `fn(matched)`, rebuilding
// composite keys on the path. A group that drops to one child collapses to that child.
function transformInTree(
	sel: Selection,
	key: string,
	fn: (matched: Selection) => Selection,
): Selection | null {
	if (sel.key === key) return fn(sel);
	if (!isVariant(sel.selector, COMPOSITE_TYPES)) return null;
	const children = sel.selector.selections;
	for (let i = 0; i < children.length; i++) {
		const next = transformInTree(children[i], key, fn);
		if (next) {
			const newChildren = spliceMerging(children, i, next);
			if (newChildren.length === 1 && !isVariant(sel.selector, UNARY_TYPES)) return newChildren[0];
			return buildSelection({ type: sel.selector.type, selections: newChildren });
		}
	}
	return null;
}

/** Replace the selection at `oldKey` (at any depth) with one built from `selector`. If the new
 *  key collides with an existing selection, the existing one wins and the replacement is dropped. */
export function replaceSelection(
	current: Selection[],
	oldKey: string,
	selector: Selector,
): Selection[] {
	for (let i = 0; i < current.length; i++) {
		const replaced = transformInTree(current[i], oldKey, () => buildSelection(selector));
		if (replaced) return spliceMerging(current, i, replaced);
	}
	return current;
}

/** Human-readable label for a selection. Pass `tagNames` to resolve tags by saved name
 *  rather than the open map's tags (used by saved selection rules). */
export function selectionDisplayName(sel: Selection, tagNames?: Record<number, string>): string {
	return descriptorFor(sel.selector).label(tagNames);
}

let suffixCache: { tags: Tag[]; suffixes: Map<string, string> } | null = null;

/** Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
 *  the `/`-path to its shortest unique suffix; otherwise returns the name verbatim. */
export function displayTagName(name: string): string {
	const s = getSettings();
	if (s.tagViewMode !== "tree" || !s.truncateTagPaths) return name;
	const tags = getVisibleTags();
	if (!suffixCache || suffixCache.tags !== tags) {
		suffixCache = { tags, suffixes: shortestUniqueSuffixes(tags.map((t) => t.name)) };
	}
	return suffixCache.suffixes.get(name) ?? name;
}

function tagDisplayName(tagId: number, tagNames?: Record<number, string>): string {
	const name = getTag(tagId)?.name;
	if (name != null) return displayTagName(name);
	// Not a tag on this map: a saved rule still knows what it was called where it was saved.
	return tagNames?.[tagId] ?? String(tagId);
}

function validationStateLabel(state: ValidationState): string {
	switch (state) {
		case ValidationState.Ok:
			return msg("Valid location");
		case ValidationState.UpdateAvailable:
			return msg("Newer coverage available");
		case ValidationState.UpdateApplied:
			return msg("Coverage updated since last view");
		case ValidationState.NotFound:
			return msg("Not found");
		case ValidationState.PanoIdBroke:
			return msg("Pano ID broke");
		case ValidationState.Unofficial:
			return msg("Unofficial");
		case ValidationState.GoodcamAvailable:
			return msg("Badcam, but good coverage available");
	}
}

/** Update the colors of selections by matching keys from `entries`. */
export const setSelectionColors =
	(entries: Selection[]) =>
	(current: Selection[]): Selection[] =>
		entries.reduce((sels, entry) => {
			const idx = sels.findIndex((s) => s.key === entry.key);
			return idx === -1 ? sels : sels.with(idx, entry);
		}, current);

/** Rename a Polygon selection's display name. */
export const setPolygonName =
	(key: string, name: string) =>
	(current: Selection[]): Selection[] => {
		return current.map((s) => {
			if (s.key !== key || s.selector.type !== "Polygon") return s;
			const selector: Selector = {
				...s.selector,
				polygon: { ...s.selector.polygon, properties: { ...s.selector.polygon.properties, name } },
			};
			return { ...s, selector };
		});
	};

// Rewrite Filter `field` references in a selection tree: `from` -> `to`, or drop the
// Filter when `to` is null. Composites collapse if emptied or unwrap to their sole survivor.
function rewriteSelection(sel: Selection, from: string, to: string | null): Selection | null {
	const p = sel.selector;
	if (p.type === "Filter") {
		if (p.field !== from) return sel;
		return to === null ? null : buildSelection({ ...p, field: to });
	}
	if ("selections" in p) {
		const children = p.selections
			.map((c) => rewriteSelection(c, from, to))
			.filter((c): c is Selection => c !== null);
		if (children.length === 0) return null;
		if (children.length === 1 && p.type !== "Invert") return children[0];
		return buildSelection({ ...p, selections: children } as Selector);
	}
	return sel;
}

/** Rename or remove a field across all Filter selections. When `to` is null, filters on that field are dropped. */
export const rewriteSelectionFields =
	(from: string, to: string | null) =>
	(selections: Selection[]): Selection[] =>
		selections.map((s) => rewriteSelection(s, from, to)).filter((s): s is Selection => s !== null);
