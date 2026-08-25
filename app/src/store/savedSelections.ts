import type { Selection, SelectionProps } from "@/bindings.gen";
import { buildSelection } from "./selections";
import { getSettings, setSetting } from "./settings";
import { addSelections, getTag, getVisibleTags, scopeIds } from "./useMapStore";
import { t } from "@/lib/i18n";

export interface SavedSelectionItem {
	props: SavedSelectionProps;
	color: [number, number, number];
}

export interface SavedSelection {
	id: string;
	name: string;
	items: SavedSelectionItem[];
	createdAt: number;
}

/** Selection types bound to the open map (raw location ids, review sessions): a rule
 *  built from them would be a frozen snapshot, so they are never saved. Everything else
 *  is saveable as-is. */
export const MAP_LOCAL_TYPES = ["Locations", "Manual", "ValidationState", "Reviewed"] as const;
export type MapLocalType = (typeof MAP_LOCAL_TYPES)[number];

type MapLocalProps = Extract<SelectionProps, { type: MapLocalType }>;
type PortableProps = Exclude<SelectionProps, MapLocalProps>;

export type SavedSelectionProps =
	| Exclude<PortableProps, { type: "Tag" | "Intersection" | "Union" | "Invert" }>
	| { type: "TagName"; tagName: string }
	| { type: "Intersection"; selections: SavedSelectionProps[] }
	| { type: "Union"; selections: SavedSelectionProps[] }
	| { type: "Invert"; selections: SavedSelectionProps[] };

const MAP_LOCAL_SET: ReadonlySet<string> = new Set(MAP_LOCAL_TYPES);

function isMapLocal(props: SelectionProps): props is MapLocalProps {
	return MAP_LOCAL_SET.has(props.type);
}

export function selectionToSaved(sel: Selection): SavedSelectionProps | null {
	return propsToSaved(sel.props);
}

function propsToSaved(props: SelectionProps): SavedSelectionProps | null {
	if (isMapLocal(props)) return null;

	switch (props.type) {
		case "Tag": {
			const tag = getTag(props.tagId);
			if (!tag) return null;
			return { type: "TagName", tagName: tag.name };
		}

		case "Intersection":
		case "Union":
		case "Invert": {
			const children = props.selections
				.map((child) => propsToSaved(child.props))
				.filter((c): c is SavedSelectionProps => c !== null);
			if (children.length === 0) return null;
			return { type: props.type, selections: children };
		}

		default:
			return props;
	}
}

/** Visible tags only — a saved selection must not resurrect a soft-deleted ghost. */
function resolveTagByName(tagName: string): number | null {
	const lower = tagName.toLowerCase();
	for (const tag of getVisibleTags()) {
		if (tag.name.toLowerCase() === lower) return tag.id;
	}
	return null;
}

/** Resolve a saved rule against the open map, or null when it no longer applies
 *  (e.g. the tag name doesn't exist here). */
export function savedToSelectionProps(saved: SavedSelectionProps): SelectionProps | null {
	switch (saved.type) {
		case "TagName": {
			const tagId = resolveTagByName(saved.tagName);
			if (tagId === null) return null;
			return { type: "Tag", tagId };
		}

		case "Intersection":
		case "Union":
		case "Invert": {
			const children = saved.selections
				.map((child) => savedToSelectionProps(child))
				.filter((c): c is SelectionProps => c !== null);
			if (children.length === 0) return null;
			const builtChildren = children.map((p) => buildSelection(p));
			return { type: saved.type, selections: builtChildren };
		}

		default:
			return saved;
	}
}

// Resolution

/** Resolve a saved selection to the union of its items' matching location ids. */
export async function resolveSavedSelectionIds(id: string): Promise<Set<number>> {
	const ids = new Set<number>();
	const saved = getSavedSelections().find((s) => s.id === id);
	if (saved) {
		const propsList = saved.items
			.map((item) => savedToSelectionProps(item.props))
			.filter((p): p is SelectionProps => p !== null);
		const resolved = await Promise.all(propsList.map((p) => scopeIds({ kind: "props", props: p })));
		for (const arr of resolved) for (const locId of arr) ids.add(locId);
	}
	return ids;
}

// Display

/** Short human-readable description of a saved-selection rule. */
export function describeRule(props: SavedSelectionProps): string {
	switch (props.type) {
		case "Everything":
			return t("All");
		case "Polygon":
			return props.polygon.properties?.name || t("Polygon");
		case "TagName":
			return t("Tag: {name}", { name: props.tagName });
		case "Untagged":
			return t("Untagged");
		case "Unpanned":
			return t("Unpanned");
		case "PanoIds":
			return t("Has Pano ID");
		case "NotPanoIds":
			return t("No Pano ID");
		case "Uncommitted":
			return t("Uncommitted");
		case "Duplicates":
			return t("Dupes ({distance}m)", { distance: props.distance });
		case "Filter":
			return t("{field} {op} {value}", {
				field: props.field,
				op: props.op,
				value: String(props.value),
			});
		case "TopK":
			return props.ascending
				? t("Bottom {k} by {field}", { k: props.k, field: props.field })
				: t("Top {k} by {field}", { k: props.k, field: props.field });
		// Boolean composites read as a formal expression, so only the operator tokens translate.
		case "Intersection":
			return props.selections.map(describeRule).join(` ${t("AND")} `);
		case "Union":
			return props.selections.map(describeRule).join(` ${t("OR")} `);
		case "Invert":
			return t("NOT ({selections})", {
				selections: props.selections.map(describeRule).join(", "),
			});
	}
	const unhandled: never = props;
	return unhandled;
}

// CRUD

/** All saved selection rules (global, name-based; shared across maps). */
export function getSavedSelections(): SavedSelection[] {
	return getSettings().savedSelections;
}

export function saveCurrentSelections(name: string, selections: Selection[]): boolean {
	const items: SavedSelectionItem[] = [];
	for (const sel of selections) {
		const props = selectionToSaved(sel);
		if (props) items.push({ props, color: sel.color });
	}
	if (items.length === 0) return false;

	const entry: SavedSelection = {
		id: crypto.randomUUID(),
		name,
		items,
		createdAt: Date.now(),
	};
	setSetting("savedSelections", [...getSavedSelections(), entry]);
	return true;
}

export function deleteSavedSelection(id: string): void {
	setSetting(
		"savedSelections",
		getSavedSelections().filter((s) => s.id !== id),
	);
}

export function applySavedSelection(saved: SavedSelection): number {
	const batch: SelectionProps[] = [];
	for (const item of saved.items) {
		const props = savedToSelectionProps(item.props);
		if (props) batch.push(props);
	}
	if (batch.length > 0) void addSelections(batch);
	return batch.length;
}
