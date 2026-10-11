import { displayTagName } from "@/lib/data/tags";
/** Pure selection transforms: build, compose, invert, rewrite, and remove selections. */

import type {
	FilterOp,
	ListedSelection,
	RGB,
	Selection,
	SelectionInput,
	SelectionOp,
	Selector as SelectorTree,
} from "@/bindings.gen";
import type { Selector } from "@/types";
import { cmd } from "@/lib/commands";
import { getTag } from "@/store/useMapStore";

import { getFieldDef, fieldValueLabel } from "@/lib/data/fieldDefRegistry";
import { formatDistance, localDateTime, utcDateTime } from "@/lib/util/format";
import { unionTuple, type Variant } from "@/types/util";
import { validationCategory } from "@/lib/sv/validationCategories";
import { getSettings } from "@/store/settings";
import { dayMonthFmt } from "@/lib/util/format";
import { t, msg } from "@/lib/i18n";

/** Selector variants with child selections. */
export type CompositeType = Extract<Selector, { selections: SelectionInput[] }>["type"];
/** Composite variants that wrap exactly one child (e.g. Invert). */
export type UnaryType = "Invert";
/** Composite variants that are flat n-ary groups. */
export type GroupType = Exclude<CompositeType, UnaryType>;

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

/** Locations with no tags: `tags` resolves to nothing on an untagged location. */
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
			selection({ type: "Filter", field: "loadAsPanoId", test: { op: "eq", value: true } }),
			selection({ type: "Filter", field: "panoId", test: { op: "has" } }),
		],
	};
	return on ? pinned : { type: "Invert", selections: [selection(pinned)] };
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
	const parts = selectors.flatMap((s): SelectionInput[] => {
		if (s.type === type) return s.selections;
		if (type === "Intersection" && s.type === "Everything") return [];
		return [selection(s)];
	});
	if (parts.length === 1) return parts[0].selector;
	if (parts.length === 0 && type === "Intersection") return { type: "Everything" };
	return { type, selections: parts };
}

/** Locations matching every one of `selectors`; with none, every location. */
export const all = (...selectors: Selector[]): Selector => compose("Intersection", selectors);

/** Locations matching any of `selectors`; with none, no location. */
export const any = (...selectors: Selector[]): Selector => compose("Union", selectors);

const inverted = (s: SelectionInput): SelectionInput =>
	s.selector.type === "Invert"
		? s.selector.selections[0]
		: selection({ type: "Invert", selections: [s] });

/** Locations not matching `selector`. */
export const not = (selector: Selector): Selector => inverted(selection(selector)).selector;

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

function namedLabel(selector: Selector): string | undefined {
	if (selector.type === "Filter") {
		if (selector.field === "tags" && selector.test.op === "nothas") return t("Untagged");
		if (selector.field === "heading" && selector.test.op === "eq" && selector.test.value === 0)
			return t("Unpanned");
	}
	const inner = selector.type === "Invert" ? selector.selections[0]?.selector : selector;
	if (inner?.type !== "Intersection" || inner.selections.length !== 2) return undefined;
	const [flag, pano] = inner.selections.map((s) => s.selector);
	if (
		flag.type === "Filter" &&
		flag.field === "loadAsPanoId" &&
		flag.test.op === "eq" &&
		flag.test.value === true &&
		pano.type === "Filter" &&
		pano.field === "panoId" &&
		pano.test.op === "has"
	) {
		return selector.type === "Invert" ? t("Coordinate locations") : t("Pano ID locations");
	}
	return undefined;
}

/** What one selection type answers about itself; optional answers default at the lookup. */
interface SelectionDescriptor<K extends Selector["type"]> {
	label(selector: Variant<Selector, K>, tagNames?: Record<number, string>): string;
}

/** Per-type descriptor for each selector variant: key derivation, display label, and optional color/location overrides. */
export const SELECTIONS: { [K in Selector["type"]]: SelectionDescriptor<K> } = {
	Locations: {
		label: (s) => s.name ?? t("Selection"),
	},
	Everything: {
		label: () => t("Everything"),
	},
	Selected: {
		label: () => t("Selected"),
	},
	Polygon: {
		label: (s) =>
			s.polygon.properties?.name
				? t("Polygon: {name}", { name: String(s.polygon.properties.name) })
				: t("Polygon"),
	},
	Uncommitted: {
		label: () => t("Uncommitted"),
	},
	Duplicates: {
		label: (s) => t("Duplicates ({distance})", { distance: formatDistance(s.distance) }),
	},
	Manual: {
		label: () => t("Manual selection"),
	},
	Validation: {
		label: (s) => {
			const category = validationCategory(s.category);
			return category ? t(category.label) : s.category;
		},
	},
	Reviewed: {
		label: (s) => (s.mode === "unreviewed" ? t("Unreviewed") : t("Reviewed")),
	},
	Intersection: {
		label: () => t("Intersection"),
	},
	Union: {
		label: () => t("Union"),
	},
	Invert: {
		label: (s, tagNames) =>
			t("Invert: {selection}", { selection: selectionDisplayName(s.selections[0], tagNames) }),
	},
	Filter: {
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
		label: (s) => {
			const fieldDef = getFieldDef(s.expr);
			const by = fieldDef?.label ? t(fieldDef.label) : s.expr;
			if (s.k == null) return t("Ranked by {field}", { field: by });
			return s.ascending
				? t("Bottom {k} by {field}", { k: s.k, field: by })
				: t("Top {k} by {field}", { k: s.k, field: by });
		},
	},
	Sample: {
		label: (s) => t("Random {n}", { n: s.n }),
	},
	Spaced: {
		label: () => t("Spaced"),
	},
	EvenlySpaced: {
		label: () => t("Evenly spaced"),
	},
	Nearby: {
		label: (s) => t("Within {distance}", { distance: formatDistance(s.radiusM) }),
	},
	Nearest: {
		label: () => t("Nearest location"),
	},
};

function descriptorFor(selector: Selector) {
	const d = SELECTIONS[selector.type] as SelectionDescriptor<Selector["type"]>;
	return { label: (tagNames?: Record<number, string>) => d.label(selector, tagNames) };
}

/** Every child selection a selector wraps, whatever shape it wraps them in. */
export function childSelections<S>(selector: SelectorTree<S>): S[] {
	if ("selections" in selector) return selector.selections;
	if ("selection" in selector) return selector.selection ? [selector.selection] : [];
	return [];
}

/** `selector` with its children replaced, keeping the shape it wraps them in. */
export function withChildren<S>(selector: SelectorTree<S>, children: S[]): SelectorTree<S> {
	if ("selections" in selector) return { ...selector, selections: children };
	if ("selection" in selector) return { ...selector, selection: children[0] ?? null };
	return selector;
}

/** An unaddressed selection input; Rust supplies its key and default color. */
export function selection(selector: Selector, color?: RGB): SelectionInput {
	if (color === undefined && selector.type === "Polygon") {
		const settings = getSettings();
		if (settings.polygonColorMode === "fixed") color = settings.polygonColor;
	}
	return { selector, ...(color ? { color } : {}) };
}

export async function buildSelection(selector: Selector): Promise<Selection> {
	return (await cmd.selectionBuild([selection(selector)]))[0];
}

export type SelectionPath = readonly number[];
export function selectionAt(rows: ListedSelection[], path: SelectionPath): Selection | undefined {
	let node: Selection | undefined = rows[path[0]]?.selection;
	for (const i of path.slice(1)) node = node && childSelections(node.selector)[i];
	return node;
}

export const addSelection = (...selectors: Selector[]): SelectionOp => ({
	kind: "add",
	selections: selectors.map((s) => selection(s)),
});
export const setSelections = (selections: SelectionInput[]): SelectionOp => ({
	kind: "set",
	selections,
});
export const removeSelection = (...keys: string[]): SelectionOp => ({ kind: "remove", keys });
export const toggleSelection = (...selectors: Selector[]): SelectionOp => ({
	kind: "toggle",
	selections: selectors.map((s) => selection(s)),
});
export const toggleManualSelection = (id: number): SelectionOp => ({ kind: "manual", id });
export const onActive = (op: SelectionOp): SelectionOp => ({ kind: "active", op });
export const intersectSelections = (keys: string[] | null = null): SelectionOp => ({
	kind: "combine",
	mode: "intersection",
	keys,
});
export const unionSelections = (keys: string[] | null = null): SelectionOp => ({
	kind: "combine",
	mode: "union",
	keys,
});
export const invertSelections = (keys: string[] | null = null): SelectionOp => ({
	kind: "combine",
	mode: "invert",
	keys,
});
export const toggleGhost = (index: number): SelectionOp => ({ kind: "ghost", index });
export const isolateGhost = (index: number): SelectionOp => ({ kind: "isolate", index });
export const toggleGhostAll: SelectionOp = { kind: "ghostAll" };
export const toggleInvert = (path: SelectionPath): SelectionOp => ({
	kind: "invert",
	path: [...path],
});
export const composeSelections = (
	drag: SelectionPath,
	drop: SelectionPath,
	mode: GroupType,
): SelectionOp => ({
	kind: "compose",
	drag: [...drag],
	drop: [...drop],
	mode: mode === "Union" ? "union" : "intersection",
});
export const moveSelection = (
	from: SelectionPath,
	to: SelectionPath,
	position: "before" | "after",
): SelectionOp => ({ kind: "move", from: [...from], to: [...to], after: position === "after" });
export const removeSelectionAt = (path: SelectionPath): SelectionOp => ({
	kind: "removeAt",
	path: [...path],
});
export const replaceSelection = (path: SelectionPath, selector: Selector): SelectionOp => ({
	kind: "replace",
	path: [...path],
	selection: selection(selector),
});
export const setSelectionColor = (path: SelectionPath, color: RGB): SelectionOp => ({
	kind: "color",
	path: [...path],
	color,
});
export const setPolygonName = (path: SelectionPath, name: string): SelectionOp => ({
	kind: "polygonName",
	path: [...path],
	name,
});

/** Human-readable label for a selection. Pass `tagNames` to resolve tags by saved name
 *  rather than the open map's tags. */
export function selectionDisplayName(
	sel: SelectionInput,
	tagNames?: Record<number, string>,
): string {
	return namedLabel(sel.selector) ?? descriptorFor(sel.selector).label(tagNames);
}

function tagDisplayName(tagId: number, tagNames?: Record<number, string>): string {
	const name = getTag(tagId)?.name;
	if (name != null) return displayTagName(name);
	// Not a tag on this map: a saved rule still knows what it was called where it was saved.
	return tagNames?.[tagId] ?? String(tagId);
}
