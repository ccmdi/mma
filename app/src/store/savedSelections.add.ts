import type { MapData } from "@/types";
import type { Selection, SelectionProps, PolygonGeometry, FilterOp } from "./selections";
import { buildSelection } from "./selections";
import { getSettings, setSetting } from "./settings.add";
import { addSelections } from "./useMapStore";

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

export type SavedSelectionProps =
	| { type: "Everything" }
	| { type: "Polygon"; polygon: PolygonGeometry; includeInformational: boolean }
	| { type: "TagName"; tagName: string }
	| { type: "Untagged" }
	| { type: "Unpanned" }
	| { type: "PanoIds" }
	| { type: "NotPanoIds" }
	| { type: "Duplicates"; distance: number }
	| { type: "Filter"; field: string; op: FilterOp; value: unknown; value2?: unknown }
	| { type: "Intersection"; selections: SavedSelectionProps[] }
	| { type: "Union"; selections: SavedSelectionProps[] }
	| { type: "Invert"; selections: SavedSelectionProps[] };

export function selectionToSaved(sel: Selection, map: MapData): SavedSelectionProps | null {
	return propsToSaved(sel.props, map);
}

function propsToSaved(props: SelectionProps, map: MapData): SavedSelectionProps | null {
	switch (props.type) {
		case "Locations":
		case "Manual":
		case "ValidationState":
			return null;

		case "Tag": {
			const tag = map.meta.tags[String(props.tagId)];
			if (!tag) return null;
			return { type: "TagName", tagName: tag.name };
		}

		case "Intersection":
		case "Union":
		case "Invert": {
			const children = props.selections
				.map((child) => propsToSaved(child.props, map))
				.filter((c): c is SavedSelectionProps => c !== null);
			if (children.length === 0) return null;
			return { type: props.type, selections: children };
		}

		default:
			return props as SavedSelectionProps;
	}
}

function resolveTagByName(map: MapData, tagName: string): number | null {
	const lower = tagName.toLowerCase();
	for (const tag of Object.values(map.meta.tags)) {
		if (tag.name.toLowerCase() === lower) return tag.id;
	}
	return null;
}

export function savedToSelectionProps(
	saved: SavedSelectionProps,
	map: MapData,
): SelectionProps | null {
	switch (saved.type) {
		case "TagName": {
			const tagId = resolveTagByName(map, saved.tagName);
			if (tagId === null) return null;
			return { type: "Tag", tagId };
		}

		case "Intersection":
		case "Union":
		case "Invert": {
			const children = saved.selections
				.map((child) => savedToSelectionProps(child, map))
				.filter((c): c is SelectionProps => c !== null);
			if (children.length === 0) return null;
			const builtChildren = children.map((p) => buildSelection(map, p));
			return { type: saved.type, selections: builtChildren };
		}

		default:
			return saved as SelectionProps;
	}
}

// Display

export function describeRule(props: SavedSelectionProps): string {
	switch (props.type) {
		case "Everything":
			return "All";
		case "Polygon":
			return props.polygon.properties?.name || "Polygon";
		case "TagName":
			return `Tag: ${props.tagName}`;
		case "Untagged":
			return "Untagged";
		case "Unpanned":
			return "Unpanned";
		case "PanoIds":
			return "Has Pano ID";
		case "NotPanoIds":
			return "No Pano ID";
		case "Duplicates":
			return `Dupes (${props.distance}m)`;
		case "Filter":
			return `${props.field} ${props.op} ${String(props.value)}`;
		case "Intersection":
			return props.selections.map(describeRule).join(" AND ");
		case "Union":
			return props.selections.map(describeRule).join(" OR ");
		case "Invert":
			return `NOT (${props.selections.map(describeRule).join(", ")})`;
	}
}

/**
 * Rewrite Filter `field` references in persisted saved selections: `from` → `to`, or
 * drop the Filter (and any selection/composite that empties) when `to` is null.
 */
export function rewriteSavedSelectionFields(
	saved: SavedSelection[],
	from: string,
	to: string | null,
): SavedSelection[] {
	const rewriteProps = (p: SavedSelectionProps): SavedSelectionProps | null => {
		if (p.type === "Filter") {
			if (p.field !== from) return p;
			return to === null ? null : { ...p, field: to };
		}
		if (p.type === "Intersection" || p.type === "Union" || p.type === "Invert") {
			const children = p.selections
				.map(rewriteProps)
				.filter((c): c is SavedSelectionProps => c !== null);
			if (children.length === 0) return null;
			if (children.length === 1 && p.type !== "Invert") return children[0];
			return { ...p, selections: children };
		}
		return p;
	};
	return saved
		.map((s) => ({
			...s,
			items: s.items
				.map((it) => {
					const props = rewriteProps(it.props);
					return props ? { ...it, props } : null;
				})
				.filter((it): it is SavedSelectionItem => it !== null),
		}))
		.filter((s) => s.items.length > 0);
}

// CRUD

export function getSavedSelections(): SavedSelection[] {
	return getSettings().savedSelections;
}

export function saveCurrentSelections(
	name: string,
	selections: Selection[],
	map: MapData,
): boolean {
	const items: SavedSelectionItem[] = [];
	for (const sel of selections) {
		const props = selectionToSaved(sel, map);
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

export function applySavedSelection(saved: SavedSelection, map: MapData): number {
	const batch: SelectionProps[] = [];
	for (const item of saved.items) {
		const props = savedToSelectionProps(item.props, map);
		if (props) batch.push(props);
	}
	if (batch.length > 0) addSelections(batch);
	return batch.length;
}
