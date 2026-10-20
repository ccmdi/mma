import { Store } from "@/store/store";
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
	ValueNames,
} from "@/bindings.gen";
import type { Selector } from "@/types";
import { cmd } from "@/lib/commands";
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

/** @api @unstable */
export const UNARY_TYPES = unionTuple<UnaryType>()(["Invert"]);

export type FilterOpKind = FilterOp["op"];

/** Whether a predicate reads the location's clock in its own timezone. Only a range can. @api @unstable */
export const filterIsLocalTime = (test: FilterOp): boolean =>
	"tzLocal" in test && test.tzLocal === true;

/** Display symbol/word for each filter operator. Symbols are language-neutral; only the worded
 *  operators are marked for translation. @api @unstable */
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
 *  else, so there is no tag selector to build. @api @unstable */
export const tagSelector = (tagId: number): Selector => ({
	type: "Filter",
	field: "tags",
	test: { op: "contains", value: tagId },
});

/** Locations with no tags: `tags` resolves to nothing on an untagged location. @api @unstable */
export const untaggedSelector = (): Selector => ({
	type: "Filter",
	field: "tags",
	test: { op: "nothas" },
});

/** Locations whose heading was never set. @api @unstable */
export const unpannedSelector = (): Selector => ({
	type: "Filter",
	field: "heading",
	test: { op: "eq", value: 0 },
});

/** Locations pinned to one exact pano (the flag plus a pano id), or the locations not
 *  pinned. @api @unstable */
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

/** Locations holding a value for `field`. @api @unstable */
export const has = (field: string): Selector => ({ type: "Filter", field, test: { op: "has" } });

/** Locations holding no value for `field`. @api @unstable */
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

/** Locations matching every one of `selectors`; with none, every location. @api @unstable */
export const all = (...selectors: Selector[]): Selector => compose("Intersection", selectors);

/** Locations matching any of `selectors`; with none, no location. @api @unstable */
export const any = (...selectors: Selector[]): Selector => compose("Union", selectors);

const inverted = (s: SelectionInput): SelectionInput =>
	s.selector.type === "Invert"
		? s.selector.selections[0]
		: selection({ type: "Invert", selections: [s] });

/** Locations not matching `selector`. @api @unstable */
export const not = (selector: Selector): Selector => inverted(selection(selector)).selector;

/** The interned value a selector tests membership of, or null when it tests something else.
 *  The single place that recognises value membership, so nothing else has to know its shape. @api @unstable */
export function memberOf(selector: Selector): { field: string; id: number } | null {
	return selector.type === "Filter" &&
		selector.test.op === "contains" &&
		typeof selector.test.value === "number" &&
		getFieldDef(selector.field)?.interned
		? { field: selector.field, id: selector.test.value }
		: null;
}

/** The tag a selector names, or null when it names something else. @api @unstable */
export function tagIdOf(selector: Selector): number | null {
	const member = memberOf(selector);
	return member?.field === "tags" ? member.id : null;
}

/** A selector with its parts' keys and colors dropped and its fields in a fixed order, so two
 *  selectors that select the same way compare equal. */
function selectorShape(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(selectorShape);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([k]) => k !== "key" && k !== "color")
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([k, v]) => [k, selectorShape(v)]),
	);
}

const PRESETS: [Selector, () => string][] = [
	[untaggedSelector(), () => t("Untagged")],
	[unpannedSelector(), () => t("Unpanned")],
	[panoIdSelector(true), () => t("Pano ID locations")],
	[panoIdSelector(false), () => t("Coordinate locations")],
];

function namedLabel(selector: Selector): string | undefined {
	const shape = JSON.stringify(selectorShape(selector));
	return PRESETS.find(([preset]) => JSON.stringify(selectorShape(preset)) === shape)?.[1]();
}

/** What one selection type answers about itself; optional answers default at the lookup. */
interface SelectionDescriptor<K extends Selector["type"]> {
	label(selector: Variant<Selector, K>, valueNames?: ValueNames): string;
}

/** The display label of each selector variant. @api @unstable */
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
		label: (s, valueNames) =>
			t("Invert: {selection}", { selection: selectionDisplayName(s.selections[0], valueNames) }),
	},
	Filter: {
		label: (p, valueNames) => {
			const fieldDef = getFieldDef(p.field);
			const fieldLabel = fieldDef?.label ? t(fieldDef.label) : p.field;
			const test = p.test;
			const member = memberOf(p);
			if (member) {
				const name = valueDisplayName(member, valueNames);
				return member.field === "tags"
					? t("Tag: {name}", { name })
					: t("{field}: {name}", { field: fieldLabel, name });
			}
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
	return { label: (valueNames?: ValueNames) => d.label(selector, valueNames) };
}

/** Every child selection a selector wraps, whatever shape it wraps them in. @api @unstable */
export function childSelections<S>(selector: SelectorTree<S>): S[] {
	if ("selections" in selector) return selector.selections;
	if ("selection" in selector) return selector.selection ? [selector.selection] : [];
	return [];
}

/** `selector` with its children replaced, keeping the shape it wraps them in. @api @unstable */
export function withChildren<S>(selector: SelectorTree<S>, children: S[]): SelectorTree<S> {
	if ("selections" in selector) return { ...selector, selections: children };
	if ("selection" in selector) return { ...selector, selection: children[0] ?? null };
	return selector;
}

/** An unaddressed selection input; the store supplies its key and default color. @api @unstable */
export function selection(selector: Selector, color?: RGB): SelectionInput {
	if (color === undefined && selector.type === "Polygon") {
		const settings = getSettings();
		if (settings.polygonColorMode === "fixed") color = settings.polygonColor;
	}
	return { selector, ...(color ? { color } : {}) };
}

/** @api @unstable */
export async function buildSelection(selector: Selector): Promise<Selection> {
	return (await cmd.selectionBuild([selection(selector)]))[0];
}

export type SelectionPath = number[];
/** @api @unstable */
export function selectionAt(rows: ListedSelection[], path: SelectionPath): Selection | undefined {
	let node: Selection | undefined = rows[path[0]]?.selection;
	for (const i of path.slice(1)) node = node && childSelections(node.selector)[i];
	return node;
}

/** @api @unstable */
export const addSelection = (...selectors: Selector[]): SelectionOp => ({
	kind: "add",
	selections: selectors.map((s) => selection(s)),
});
/** @api @unstable */
export const toggleSelection = (...selectors: Selector[]): SelectionOp => ({
	kind: "toggle",
	selections: selectors.map((s) => selection(s)),
});
/** @api @unstable */
export const replaceSelection = (path: SelectionPath, selector: Selector): SelectionOp => ({
	kind: "replace",
	path,
	selection: selection(selector),
});

/** Human-readable label for a selection. Pass `valueNames` to resolve interned values by
 *  saved name rather than the open map's records. @api @unstable */
export function selectionDisplayName(sel: SelectionInput, valueNames?: ValueNames): string {
	return namedLabel(sel.selector) ?? descriptorFor(sel.selector).label(valueNames);
}

function valueDisplayName(
	{ field, id }: { field: string; id: number },
	valueNames?: ValueNames,
): string {
	const name = Store.get().fieldValues[field]?.[id]?.record?.name;
	if (typeof name === "string") return field === "tags" ? displayTagName(name) : name;
	// Not a value on this map: a saved rule still knows what it was called where it was saved.
	return valueNames?.[field]?.[id] ?? String(id);
}
