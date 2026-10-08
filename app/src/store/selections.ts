/** Pure selection transforms: build, compose, invert, rewrite, and remove selections. */

import type {
	FilterOp,
	ListedSelection,
	PolygonGeometry,
	Selection,
	Selector,
} from "@/bindings.gen";
import type { Tag } from "@/types";
import { getVisibleTags, getTag } from "@/store/useMapStore";
import { hexToRgb, hslToRgb, type RGB } from "@/lib/util/color";
import { getFieldDef, fieldValueLabel } from "@/lib/data/fieldDefRegistry";
import { formatDistance, localDateTime, utcDateTime } from "@/lib/util/format";
import { isVariant, toggle, unionTuple, type Variant } from "@/types/util";
import { validationCategory } from "@/lib/sv/validationCategories";
import { getSettings } from "@/store/settings";
import { dayMonthFmt } from "@/lib/util/format";
import { t, msg } from "@/lib/i18n";
import { shortestUniqueSuffixes } from "@/lib/data/tagPaths";

/** Selector variants that wrap child selections (Intersection, Union, Invert). */
export type CompositeType = Extract<Selector, { selections: Selection[] }>["type"];
/** Composite variants that wrap exactly one child (e.g. Invert). */
export type UnaryType = "Invert";
/** Composite variants that are flat n-ary groups. */
export type GroupType = Exclude<CompositeType, UnaryType>;

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

/** Locations carrying `tagId`. A tag is membership in the `tags` list field and nothing
 *  else, so there is no tag selector to build. */
export const tagSelector = (tagId: number): Selector => ({
	type: "Filter",
	field: "tags",
	test: { op: "contains", value: tagId },
});

/** Locations with no tags: `tags` resolves to nothing on an untagged row. */
export const untaggedSelector = (): Selector => ({
	type: "Filter",
	field: "tags",
	test: { op: "nothas" },
});

/** Locations whose heading was never set. */
export const unpannedSelector = (): Selector => ({
	type: "Filter",
	field: "heading",
	test: { op: "eq", value: 0 },
});

/** Locations pinned to one exact pano (the flag plus a pano id, mirroring Rust's
 *  `Selector::pano_ids`), or the locations not pinned. */
export function panoIdSelector(on: boolean): Selector {
	const pinned: Selector = {
		type: "Intersection",
		selections: [
			buildSelection({ type: "Filter", field: "loadAsPanoId", test: { op: "eq", value: true } }),
			buildSelection({ type: "Filter", field: "panoId", test: { op: "has" } }),
		],
	};
	return on ? pinned : { type: "Invert", selections: [buildSelection(pinned)] };
}

/** Locations holding a value for `field`. */
export const has = (field: string): Selector => ({ type: "Filter", field, test: { op: "has" } });

/** Locations holding no value for `field`. */
export const lacks = (field: string): Selector => ({
	type: "Filter",
	field,
	test: { op: "nothas" },
});

function compose(type: GroupType, selectors: Selector[]): Selector {
	const parts = selectors.flatMap((s): Selection[] => {
		if (s.type === type) return s.selections;
		if (type === "Intersection" && s.type === "Everything") return [];
		return [buildSelection(s)];
	});
	if (parts.length === 1) return parts[0].selector;
	if (parts.length === 0 && type === "Intersection") return { type: "Everything" };
	return { type, selections: dedupe(parts) };
}

/** Locations matching every one of `selectors`; with none, every location. */
export const all = (...selectors: Selector[]): Selector => compose("Intersection", selectors);

/** Locations matching any of `selectors`; with none, no location. */
export const any = (...selectors: Selector[]): Selector => compose("Union", selectors);

const inverted = (s: Selection): Selection =>
	s.selector.type === "Invert"
		? s.selector.selections[0]
		: buildSelection({ type: "Invert", selections: [s] });

/** Locations not matching `selector`. */
export const not = (selector: Selector): Selector => inverted(buildSelection(selector)).selector;

/** The tag a selector names, or null when it names something else. The single place that
 *  recognises tag membership, so nothing else has to know its shape. */
export function tagIdOf(selector: Selector): number | null {
	return selector.type === "Filter" &&
		selector.field === "tags" &&
		selector.test.op === "contains" &&
		typeof selector.test.value === "number"
		? selector.test.value
		: null;
}

/** The color a selection displays as. */
export function displayColor(s: Selection): RGB {
	const inner = s.selector.type === "Invert" ? s.selector.selections[0] : s;
	const tagId = tagIdOf(inner.selector);
	const tag = tagId == null ? undefined : getTag(tagId);
	return tag ? hexToRgb(tag.color) : s.color;
}

/** The name a selection carries of its own, when it is one the builders name. */
function namedLabel(selector: Selector): string | undefined {
	const { labels, types } = named();
	if (!types.has(selector.type)) return undefined;
	return labels.get(buildSelection(selector).key)?.();
}

let registry: {
	labels: Map<string, () => string>;
	types: Set<Selector["type"]>;
} | null = null;

/** The selections that carry a name of their own, recognised by the key their builder
 *  derives: recognition is the builder inverted, so the shape is described once. Labels
 *  stay thunks because the locale resolves at render. */
function named() {
	if (!registry) {
		const entry = (selector: Selector, label: () => string) => ({
			key: buildSelection(selector).key,
			type: selector.type,
			label,
		});
		const panoOn = entry(panoIdSelector(true), () => t("Pano ID locations"));
		const panoOff = entry(panoIdSelector(false), () => t("Coordinate locations"));
		const all = [
			entry(untaggedSelector(), () => t("Untagged")),
			entry(unpannedSelector(), () => t("Unpanned")),
			panoOn,
			panoOff,
		];
		registry = {
			labels: new Map(all.map((n) => [n.key, n.label])),
			types: new Set(all.map((n) => n.type)),
		};
	}
	return registry;
}

/** Deterministic color derived from a selection key string. */
export function colorForKey(key: string): RGB {
	let t = 0;
	for (let i = 0; i < key.length; i += 1) t = ((key.charCodeAt(i) + (t << 5)) | 0) + t;
	t = (((t * 214013) | 0) + 2531011) | 0;
	return hslToRgb(Math.abs(t) % 360, 0.5, 0.5);
}

/** Key an id list by hashing it: the same ids in the same order give the same key.
 *  Order-sensitive, like the list it identifies. Key length is constant. */
export function locationsKey(ids: number[]): string {
	let h1 = 0xdeadbeef | 0;
	let h2 = 0x41c6ce57 | 0;
	for (const id of ids) {
		h1 = Math.imul(h1 ^ id, 2654435761);
		h2 = Math.imul(h2 ^ id, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return `locations:${ids.length}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
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
	Selected: {
		key: () => "selected",
		label: () => t("Selected"),
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
	Validation: {
		key: (s) => `validation:${s.category}`,
		label: (s) => {
			const category = validationCategory(s.category);
			return category ? t(category.label) : s.category;
		},
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
		label: (p, tagNames) => {
			const fieldDef = getFieldDef(p.field);
			const fieldLabel = fieldDef?.label ? t(fieldDef.label) : p.field;
			const test = p.test;
			const tagId = tagIdOf(p);
			if (tagId != null) return t("Tag: {name}", { name: tagDisplayName(tagId, tagNames) });
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

// Replace the targeted selections (all of them, when `keys` is null) with the one `merge` makes
// of them, where the first target stood.
const mergeTargets =
	(merge: (...selectors: Selector[]) => Selector) =>
	(keys: string[] | null = null) =>
	(current: Selection[]): Selection[] => {
		const targets = keys ? current.filter((s) => keys.includes(s.key)) : current;
		if (targets.length === 0) return current;
		const merged = buildSelection(merge(...targets.map((s) => s.selector)));
		if (targets.length === 1 && merged.key === targets[0].key) return current;
		const at = current.indexOf(targets[0]);
		return dedupe(current.filter((s) => !targets.includes(s)).toSpliced(at, 0, merged));
	};

/** Merge the targeted selections (or all, when `keys` is null) into a single Intersection. */
export const intersectSelections = mergeTargets(all);

/** Merge the targeted selections (or all, when `keys` is null) into a single Union. */
export const unionSelections = mergeTargets(any);

/** Invert the targeted selections (or all, when `keys` is null). One is inverted, or restored when
 *  already inverted; several are inverted as their union. */
export const invertSelections = mergeTargets((...selectors) => not(any(...selectors)));

/** Run `op` on the active selections only. Ghosted rows keep their places and the result fills
 *  the others in order; a selection already listed as a ghosted row updates that row and stays
 *  ghosted. */
export const onActive =
	(op: (active: Selection[]) => Selection[]) =>
	(rows: ListedSelection[]): ListedSelection[] => {
		const active = rows.filter((r) => !r.ghosted).map((r) => r.selection);
		const next = op(active);
		if (next.length === active.length && next.every((s, i) => s === active[i])) return rows;
		const ghostedAt = new Map<string, number>();
		rows.forEach((r, i) => r.ghosted && ghostedAt.set(r.selection.key, i));
		const landed = new Map<number, Selection>();
		const fresh: Selection[] = [];
		for (const s of next) {
			const i = ghostedAt.get(s.key);
			if (i === undefined) fresh.push(s);
			else landed.set(i, s);
		}
		const queue = fresh.values();
		const out: ListedSelection[] = [];
		rows.forEach((r, i) => {
			if (r.ghosted) {
				const selection = landed.get(i);
				out.push(selection ? { selection, ghosted: true } : r);
				return;
			}
			const n = queue.next();
			if (!n.done) out.push({ selection: n.value, ghosted: false });
		});
		for (const selection of queue) out.push({ selection, ghosted: false });
		return out;
	};

/** List the selections built from `selectors`. One already listed is updated in place, ghost and all. */
export const addSelection =
	(...selectors: Selector[]) =>
	(rows: ListedSelection[]): ListedSelection[] =>
		selectors.reduce((acc, selector) => {
			const selection = buildSelection(selector);
			const i = acc.findIndex((r) => r.selection.key === selection.key);
			return i === -1
				? [...acc, { selection, ghosted: false }]
				: acc.with(i, { ...acc[i], selection });
		}, rows);

/** Remove the listed selections whose keys are `keys`. A removed group leaves its children behind in its place. */
export const removeSelection =
	(...keys: string[]) =>
	(rows: ListedSelection[]): ListedSelection[] =>
		keys.reduce((acc, key) => {
			const i = acc.findIndex((r) => r.selection.key === key);
			return i === -1 ? acc : removeSelectionAt([i])(acc);
		}, rows);

/** List each selection built from `selectors`, or remove it when it is already listed. */
export const toggleSelection =
	(...selectors: Selector[]) =>
	(rows: ListedSelection[]): ListedSelection[] =>
		selectors.reduce((acc, selector) => {
			const { key } = buildSelection(selector);
			return toggle(
				(r: ListedSelection[]) => r.some((row) => row.selection.key === key),
				addSelection(selector),
				removeSelection(key),
			)(acc);
		}, rows);

/** Add or remove a location from the Manual selection, creating it if needed. */
export const toggleManualSelection =
	(locationId: number) =>
	(rows: ListedSelection[]): ListedSelection[] => {
		const manual = rows.find((r) => r.selection.key === "manual")?.selection.selector;
		const ids = toggle(
			(ids: number[]) => ids.includes(locationId),
			(ids) => [...ids, locationId],
			(ids) => ids.filter((id) => id !== locationId),
		)(manual?.type === "Manual" ? manual.locations : []);
		return ids.length > 0
			? addSelection({ type: "Manual", locations: ids })(rows)
			: removeSelection("manual")(rows);
	};

// The one writer of the ghost flag.
const ghostWhere =
	(ghosted: (row: ListedSelection, index: number) => boolean) =>
	(rows: ListedSelection[]): ListedSelection[] => {
		const next = rows.map((r, i) =>
			r.ghosted === ghosted(r, i) ? r : { ...r, ghosted: !r.ghosted },
		);
		return next.every((r, i) => r === rows[i]) ? rows : next;
	};

/** Ghost the listed selection at `index`, or un-ghost it. */
export const toggleGhost = (index: number) => ghostWhere((r, i) => r.ghosted !== (i === index));

// Ghost the rows `ghosted` picks, or un-ghost them all when they already stand that way.
const ghostOrClear = (ghosted: (index: number) => boolean) =>
	toggle(
		(rows: ListedSelection[]) => rows.every((r, i) => r.ghosted === ghosted(i)),
		ghostWhere((_, i) => ghosted(i)),
		ghostWhere(() => false),
	);

/** Ghost every listed selection but the one at `index`, or un-ghost them all when it already
 *  is the only one left. */
export const isolateGhost = (index: number) => ghostOrClear((i) => i !== index);

/** Ghost every listed selection, or un-ghost them all when every one already is. */
export const toggleGhostAll = ghostOrClear(() => true);

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
	(rows: ListedSelection[]): ListedSelection[] =>
		rows.flatMap((r) => {
			const selection = rewriteSelection(r.selection, from, to);
			return selection ? [{ ...r, selection }] : [];
		});

/** Where a selection sits: its index in the list, then its index among the children of each
 *  selection it is nested in. */
export type SelectionPath = readonly number[];

/** The selection at `path`, or undefined when nothing sits there. */
export function selectionAt(rows: ListedSelection[], path: SelectionPath): Selection | undefined {
	let node: Selection | undefined = rows[path[0]]?.selection;
	for (const i of path.slice(1)) node = node && childSelections(node.selector)[i];
	return node;
}

const isWithin = (inner: SelectionPath, outer: SelectionPath) =>
	outer.length <= inner.length && outer.every((i, depth) => inner[depth] === i);

interface PathEdit {
	path: SelectionPath;
	edit: (node: Selection) => Selection[];
}

// How one level of the tree holds its selections: listed rows at the top, bare selections below.
interface Level<T> {
	selectionOf(item: T): Selection;
	hold(selection: Selection, replaced: T): T;
}

const nested: Level<Selection> = { selectionOf: (s) => s, hold: (s) => s };

// A row keeps its ghost while its selection survives the edit; a new selection takes the ghost
// of the row it replaced.
function listLevel(rows: ListedSelection[]): Level<ListedSelection> {
	const ghostOf = new Map(rows.map((r) => [r.selection.key, r.ghosted]));
	return {
		selectionOf: (r) => r.selection,
		hold: (selection, replaced) => ({
			selection,
			ghosted: ghostOf.get(selection.key) ?? replaced.ghosted,
		}),
	};
}

const spliceRows = (rows: ListedSelection[], edits: PathEdit[]) =>
	spliceAt(rows, edits, listLevel(rows));

// Swap each edited node for what its edit returns, rebuilding the ancestors around it: a group
// left with one member collapses to it, an emptied composite disappears, and a node that now
// duplicates a sibling merges into that sibling, the existing one winning. Nodes a pending edit
// is about to change don't count as existing. Edits must not nest inside one another.
function spliceAt<T>(list: T[], edits: PathEdit[], level: Level<T>): T[] {
	const byIndex = [...Map.groupBy(edits, (e) => e.path[0])].sort(([a], [b]) => b - a);
	let out = list;
	byIndex.forEach(([i, here], n) => {
		const item = list[i];
		if (item === undefined) return;
		const node = level.selectionOf(item);
		const leaf = here.find((e) => e.path.length === 1);
		const replacement = leaf ? leaf.edit(node) : rebuildAround(node, here);
		if (replacement.length === 1 && replacement[0] === node) return;
		const pending = new Set(byIndex.slice(n + 1).map(([j]) => j));
		const kept = new Set(
			out.filter((_, j) => j !== i && !pending.has(j)).map((x) => level.selectionOf(x).key),
		);
		const placed = dedupe(replacement.filter((s) => !kept.has(s.key)));
		out = out.toSpliced(i, 1, ...placed.map((s) => level.hold(s, item)));
	});
	return out;
}

function rebuildAround(node: Selection, edits: PathEdit[]): Selection[] {
	const children = childSelections(node.selector);
	const next = spliceAt(
		children,
		edits.map((e) => ({ ...e, path: e.path.slice(1) })),
		nested,
	);
	if (next === children) return [node];
	if (isVariant(node.selector, GROUP_TYPES) && next.length <= 1) return next;
	if (isVariant(node.selector, UNARY_TYPES) && next.length === 0) return [];
	const rebuilt = buildSelection(withChildren(node.selector, next));
	return [rebuilt.key === node.key ? { ...rebuilt, color: node.color } : rebuilt];
}

/** Invert the selection at `path` in place, or restore it when it is already inverted. */
export const toggleInvert =
	(path: SelectionPath) =>
	(rows: ListedSelection[]): ListedSelection[] =>
		spliceRows(rows, [{ path, edit: (node) => [inverted(node)] }]);

/** Merge the selection at `drag` into the one at `drop` as a `mode` composite, absorbing it into
 *  `drop` when that already is one. Nothing happens when either contains the other. */
export const composeSelections =
	(drag: SelectionPath, drop: SelectionPath, mode: GroupType) =>
	(rows: ListedSelection[]): ListedSelection[] => {
		const dragged = selectionAt(rows, drag);
		if (!dragged || !selectionAt(rows, drop)) return rows;
		if (isWithin(drag, drop) || isWithin(drop, drag)) return rows;
		const merge = (target: Selection): Selection[] => [
			buildSelection({
				type: mode,
				selections: dedupe(
					isVariant(target.selector, mode)
						? [...target.selector.selections, dragged]
						: [target, dragged],
				),
			}),
		];
		return spliceRows(rows, [
			{ path: drag, edit: () => [] },
			{ path: drop, edit: merge },
		]);
	};

/** Move the selection at `from` to just before or after the one at `to`, which must sit in the
 *  list or directly in a group. Nothing happens when `to` is inside the moved selection. */
export const moveSelection =
	(from: SelectionPath, to: SelectionPath, position: "before" | "after") =>
	(rows: ListedSelection[]): ListedSelection[] => {
		const moved = selectionAt(rows, from);
		if (!moved || !selectionAt(rows, to) || isWithin(to, from)) return rows;
		const parent = to.length > 1 ? selectionAt(rows, to.slice(0, -1)) : undefined;
		if (parent && !isVariant(parent.selector, GROUP_TYPES)) return rows;
		const place = (rest: Selection[]) =>
			position === "before" ? [moved, ...rest] : [...rest, moved];
		if (isWithin(from, to)) {
			const within = [0, ...from.slice(to.length)];
			const lift = (target: Selection) =>
				place(spliceAt([target], [{ path: within, edit: () => [] }], nested));
			return spliceRows(rows, [{ path: to, edit: lift }]);
		}
		return spliceRows(rows, [
			{ path: from, edit: () => [] },
			{ path: to, edit: (target) => place([target]) },
		]);
	};

/** Remove the selection at `path`. A removed group, inverted or not, leaves its children
 *  behind in its place. */
export const removeSelectionAt =
	(path: SelectionPath) =>
	(rows: ListedSelection[]): ListedSelection[] =>
		spliceRows(rows, [
			{
				path,
				edit: (node) => {
					const inner = isVariant(node.selector, UNARY_TYPES) ? node.selector.selections[0] : node;
					return isVariant(inner.selector, GROUP_TYPES) ? inner.selector.selections : [];
				},
			},
		]);

/** Replace the selection at `path` with one built from `selector`. If that duplicates a sibling,
 *  the existing sibling wins and the replacement is dropped. */
export const replaceSelection =
	(path: SelectionPath, selector: Selector) =>
	(rows: ListedSelection[]): ListedSelection[] =>
		spliceRows(rows, [{ path, edit: () => [buildSelection(selector)] }]);

/** Recolor the selection at `path`. */
export const setSelectionColor =
	(path: SelectionPath, color: RGB) =>
	(rows: ListedSelection[]): ListedSelection[] =>
		spliceRows(rows, [{ path, edit: (s) => [{ ...s, color }] }]);

/** Rename a Polygon selection's display name. */
export const setPolygonName =
	(path: SelectionPath, name: string) =>
	(rows: ListedSelection[]): ListedSelection[] =>
		spliceRows(rows, [
			{
				path,
				edit: (s) => {
					if (s.selector.type !== "Polygon") return [s];
					const polygon = {
						...s.selector.polygon,
						properties: { ...s.selector.polygon.properties, name },
					};
					return [{ ...s, selector: { ...s.selector, polygon } }];
				},
			},
		]);

/** Human-readable label for a selection. Pass `tagNames` to resolve tags by saved name
 *  rather than the open map's tags. */
export function selectionDisplayName(sel: Selection, tagNames?: Record<number, string>): string {
	return namedLabel(sel.selector) ?? descriptorFor(sel.selector).label(tagNames);
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
