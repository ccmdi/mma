/** Pure selection transforms. These only manipulate the JS selection tree; Rust resolves the actual bitmasks. */

import type { FilterOp, PolygonGeometry, Tag } from "@/bindings.gen";
import { getVisibleTags, getTag } from "@/store/useMapStore";
import { hslToRgb } from "@/lib/util/color";
import { getFieldDef, fieldValueLabel } from "@/lib/data/fieldDefRegistry";
import { formatDistance, localDateTime, utcDateTime } from "@/lib/util/format";
import { clamp, isVariant, unionTuple, type Variant } from "@/types/util";
import { ValidationState } from "@/bindings.consts";
import { pointInPolygon } from "@/lib/geo/geo";
import { getSettings } from "@/store/settings";
import { dayMonthFmt } from "@/lib/util/format";
import { t, msg } from "@/lib/i18n";
import { shortestUniqueSuffixes } from "@/components/editor/tags/tagTreeRange";

import type { Selection, Selector } from "@/bindings.gen";

/** Variants that wrap children — derived as exactly those carrying a `selections` array. */
export type CompositeType = Extract<Selector, { selections: Selection[] }>["type"];
/** Composite variants that wrap exactly one child (operators, not bags). They never collapse — a
 *  one-child group is degenerate, but one child is a unary node's only valid arity. */
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

export function colorForKey(key: string): [number, number, number] {
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
	color?(selector: Variant<Selector, K>): [number, number, number] | null;
	locations?(selector: Variant<Selector, K>): number[];
}

const ownLocations = (s: { locations: number[] }) => [...s.locations];

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
	TopK: {
		key: (s) => `topk:${s.field}:${s.k}:${s.ascending}`,
		label: (s) => {
			const fieldDef = getFieldDef(s.field);
			const label = fieldDef?.label ? t(fieldDef.label) : s.field;
			return s.ascending
				? t("Bottom {k} by {field}", { k: s.k, field: label })
				: t("Top {k} by {field}", { k: s.k, field: label });
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

/** Key a polygon by hashing its raw coordinates: identical geometry = identical key,
 *  so any path that rebuilds the Selection (composites, tree transforms) keeps the
 *  leaf's identity instead of minting a fresh one and breaking key-is-identity. */
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

/** Create a Selection with a deterministic key and overlay color from its selector. */
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

export function addSelection(current: Selection[], selector: Selector): Selection[] {
	return dedupe([...current, buildSelection(selector)]);
}

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

/** Remove a selection by key. Composites (Intersection/Union/Invert) unwrap their children back into the list. */
export function removeSelection(current: Selection[], key: string): Selection[] {
	return current.flatMap((s) => {
		if (s.key !== key) return [s];
		if (isVariant(s.selector, COMPOSITE_TYPES)) return s.selector.selections;
		return [];
	});
}

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

export const intersectSelections = (current: Selection[], keys: string[] | null) =>
	composeSelectionGroup(current, keys, "Intersection");

export const unionSelections = (current: Selection[], keys: string[] | null) =>
	composeSelectionGroup(current, keys, "Union");

/** Invert targeted selections. Single target toggles in-place at any depth; multiple are wrapped in Union then Invert. */
export function invertSelections(current: Selection[], keys: string[] | null): Selection[] {
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
	const flat = targets.flatMap((s) => (s.selector.type === "Union" ? s.selector.selections : [s]));
	const inner = flat.length === 1 ? flat[0] : buildSelection({ type: "Union", selections: flat });
	return [...others, buildSelection({ type: "Invert", selections: [inner] })];
}

export function toggleManualSelection(current: Selection[], locationId: number): Selection[] {
	const idx = current.findIndex((s) => s.key === "manual");
	if (idx === -1) return [...current, buildSelection({ type: "Manual", locations: [locationId] })];
	const sel = current[idx];
	const ids = (sel.selector as Variant<Selector, "Manual">).locations.slice();
	const at = ids.indexOf(locationId);
	if (at === -1) ids.push(locationId);
	else ids.splice(at, 1);
	if (ids.length === 0) return current.toSpliced(idx, 1);
	const next = buildSelection({ type: "Manual", locations: ids });
	return current.with(idx, next);
}

export function reorderSelections(
	current: Selection[],
	fromKey: string,
	toKey: string,
	position: "before" | "after",
): Selection[] {
	const fromIdx = current.findIndex((s) => s.key === fromKey);
	if (fromIdx === -1) return current;
	const item = current[fromIdx];
	const without = current.toSpliced(fromIdx, 1);
	let toIdx = without.findIndex((s) => s.key === toKey);
	if (toIdx === -1) return current;
	if (position === "after") toIdx++;
	return without.toSpliced(toIdx, 0, item);
}

/** Drag-drop composition: merge drag into drop as a new composite, absorbing existing children of the same type. */
export function composeSelections(
	current: Selection[],
	dragKey: string,
	dropKey: string,
	mode: GroupType,
): Selection[] {
	const dragIdx = current.findIndex((s) => s.key === dragKey);
	const dropIdx = current.findIndex((s) => s.key === dropKey);
	if (dragIdx === -1 || dropIdx === -1 || dragIdx === dropIdx) return current;
	const drag = current[dragIdx];
	const drop = current[dropIdx];

	let children: Selection[];
	if (isVariant(drop.selector, mode)) {
		children = [...drop.selector.selections, drag];
	} else {
		children = [drop, drag];
	}
	const composite = buildSelection({ type: mode, selections: dedupe(children) });

	return current.filter((_, i) => i !== dragIdx).map((s) => (s.key === dropKey ? composite : s));
}

/** Unwrap a unary operator (e.g. Invert) to the n-ary group it wraps, returning that group's selector
 *  plus a `rewrap` that restores the operator; a plain group returns itself with an identity rewrap.
 *  Null when there's no group to operate on. Single source for "a unary node keeps its wrapper" —
 *  every site that rebuilds a composite's children routes through it. */
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

/** Rebuild a composite around `next`: a group that drops to one child collapses to it, an empty
 *  one is gone (null). `rewrap` keeps a unary wrapper (Invert) around whatever survives. */
function rebuildComposite(
	type: GroupType,
	rewrap: (inner: Selection) => Selection,
	next: Selection[],
): Selection | null {
	if (next.length === 0) return null;
	return rewrap(next.length === 1 ? next[0] : buildSelection({ type, selections: next }));
}

/** `updated: null` means the composite is empty now and the caller must drop it. `dissolve` hoists a
 *  removed group's children into the parent instead of taking them with it — a delete ungroups,
 *  an extract must not (the child keeps its own children when it leaves). */
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

/** `extract` puts the child back at the top level; `delete` drops it, ungrouping a nested group's
 *  children into the parent. */
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
export function decomposeChild(
	current: Selection[],
	parentKey: string,
	childKey: string,
): Selection[] {
	return detachChild(current, parentKey, childKey, "extract");
}

export function removeFromComposite(
	current: Selection[],
	parentKey: string,
	childKey: string,
): Selection[] {
	return detachChild(current, parentKey, childKey, "delete");
}

export function composeSiblings(
	current: Selection[],
	parentKey: string,
	dragKey: string,
	dropKey: string,
	mode: GroupType,
): Selection[] {
	const parentIdx = current.findIndex((s) => s.key === parentKey);
	if (parentIdx === -1) return current;
	const grp = unwrapUnary(current[parentIdx]);
	if (!grp) return current;
	const { selector: composite, rewrap } = grp;

	const children = composite.selections;
	const dragChild = children.find((s) => s.key === dragKey);
	const dropChild = children.find((s) => s.key === dropKey);
	if (!dragChild || !dropChild) return current;

	const nested = buildSelection({ type: mode, selections: [dropChild, dragChild] });
	const newChildren = children
		.filter((s) => s.key !== dragKey)
		.map((s) => (s.key === dropKey ? nested : s));
	const newParent = rewrap(buildSelection({ type: composite.type, selections: newChildren }));
	return current.with(parentIdx, newParent);
}

export function composeWithChild(
	current: Selection[],
	dragKey: string,
	parentKey: string,
	childKey: string,
	mode: GroupType,
): Selection[] {
	const parentIdx = current.findIndex((s) => s.key === parentKey);
	const dragIdx = current.findIndex((s) => s.key === dragKey);
	if (parentIdx === -1 || dragIdx === -1) return current;
	const drag = current[dragIdx];
	const grp = unwrapUnary(current[parentIdx]);
	if (!grp) return current;
	const { selector: composite, rewrap } = grp;

	const children = composite.selections;
	const childIdx = children.findIndex((s) => s.key === childKey);
	if (childIdx === -1) return current;
	const child = children[childIdx];

	const nested = buildSelection({ type: mode, selections: [child, drag] });
	const newChildren = children.with(childIdx, nested);
	const newParent = rewrap(buildSelection({ type: composite.type, selections: newChildren }));

	return current.filter((_, i) => i !== dragIdx).map((s) => (s.key === parentKey ? newParent : s));
}

/** Put `replaced` at `index` in `list`, enforcing unique keys at this level: if it collides
 *  with another entry, drop the spliced (edited) one and keep the pre-existing. Index-based so
 *  it's correct at every level — a re-key can collide with a sibling not just where the edit
 *  happened but at any composite up the path (e.g. editing one group's child to match another
 *  group makes the two groups identical). */
function spliceMerging(list: Selection[], index: number, replaced: Selection): Selection[] {
	if (list.some((s, j) => j !== index && s.key === replaced.key)) {
		return list.filter((_, j) => j !== index);
	}
	return list.with(index, replaced);
}

/** Find the node identified by `key` at any depth and replace it with `fn(matched)`, rebuilding the
 *  keys of every composite on the path so identity stays consistent. Enforces the unique-key
 *  invariant via {@link spliceMerging}. A group that merges down to one child collapses to that
 *  child; Invert is unary, so it always keeps its wrapper around the rebuilt child. */
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

/** Replace the selection identified by `oldKey` (at any depth) with one built from `selector`,
 *  rebuilding the keys of every composite on the path so identity stays consistent. Used to
 *  edit a filter in place without dropping it from its AND/OR group. Enforces the unique-key
 *  invariant recursively (via {@link spliceMerging}): if a re-key collides with an existing
 *  selection at any level, merge into it — drop this edit, keep the existing one. A selection's
 *  key is its identity, so a duplicate key would break every key-addressed op (recolor,
 *  reorder, drag-highlight, remove). */
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

/** Human-readable label for a selection, resolving tag names and filter ops. Each branch is one
 *  whole message with named params -- never assembled from translated fragments, so a language
 *  can reorder it. `tagNames` is a saved rule's tag-name side table: it names `Tag` leaves whose
 *  id belongs to the map the rule was saved on rather than the one that is open. */
export function selectionDisplayName(sel: Selection, tagNames?: Record<number, string>): string {
	return descriptorFor(sel.selector).label(tagNames);
}

let suffixCache: { tags: Tag[]; suffixes: Map<string, string> } | null = null;

/** Display label for a tag NAME. In tree view with `truncateTagPaths` on, collapses the
 *  `/`-path to its shortest unique suffix; otherwise returns the name verbatim. Uniqueness
 *  is computed over visible tags only — soft-deleted ghosts must not widen suffixes.
 *  Memoized on the visible-tags array (stable identity between tag mutations) so list
 *  rendering stays O(n). */
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

export function setSelectionColors(
	current: Selection[],
	key: string,
	color: [number, number, number],
): Selection[] {
	const idx = current.findIndex((s) => s.key === key);
	if (idx === -1) return current;
	return current.with(idx, { ...current[idx], color });
}

export function setPolygonName(current: Selection[], key: string, name: string): Selection[] {
	return current.map((s) => {
		if (s.key !== key || s.selector.type !== "Polygon") return s;
		const selector: Selector = {
			...s.selector,
			polygon: { ...s.selector.polygon, properties: { ...s.selector.polygon.properties, name } },
		};
		return { ...s, selector };
	});
}

/**
 * Rewrite Filter `field` references in a selection tree: `from` -> `to`, or drop the
 * Filter when `to` is null (field deleted). Composites collapse if emptied, or unwrap
 * to their sole survivor (matching the rest of the selection engine's semantics).
 */
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

export function rewriteSelectionFields(
	selections: Selection[],
	from: string,
	to: string | null,
): Selection[] {
	return selections
		.map((s) => rewriteSelection(s, from, to))
		.filter((s): s is Selection => s !== null);
}
