/** Pure selection transforms. These only manipulate the JS selection tree; Rust resolves the actual bitmasks. */

import type { MapData } from "@/types";
import { hslToRgb } from "@/lib/util/color";

export type { Selection, SelectionProps, PolygonGeometry } from "@/bindings.gen";
import type { Selection, SelectionProps } from "@/bindings.gen";

export enum ValidationState {
	Ok = 0,
	UpdateAvailable = 1,
	UpdateApplied = 2,
	NotFound = 3,
	PanoIdBroke = 4,
	Unofficial = 5,
	GoodcamAvailable = 6,
}

export type SelectionType = SelectionProps["type"];

export type FilterOp =
	| "eq"
	| "neq"
	| "gt"
	| "lt"
	| "gte"
	| "lte"
	| "between"
	| "between_anyyear"
	| "has"
	| "nothas";

export function colorForKey(key: string): [number, number, number] {
	let t = 0;
	for (let i = 0; i < key.length; i += 1) t = ((key.charCodeAt(i) + (t << 5)) | 0) + t;
	t = (((t * 214013) | 0) + 2531011) | 0;
	return hslToRgb(Math.abs(t) % 360, 0.5, 0.5);
}

function locationsKey(ids: number[]): string {
	return ids.join(",");
}

export function resolveLocations(_map: MapData, props: SelectionProps): number[] {
	switch (props.type) {
		case "Locations":
		case "Manual":
			return [...props.locations];
		case "ValidationState":
			return [...props.locations];
		case "Intersection":
		case "Union":
		case "Invert":
			return [];
		default:
			return [];
	}
}

function keyForProps(_map: MapData, props: SelectionProps, locations: number[]): string {
	switch (props.type) {
		case "Locations":
			return locationsKey(locations);
		case "Everything":
			return "everything";
		case "Polygon":
			// polygon keys are unique per draw; use a generated id stored on first init
			return `polygon:${crypto.randomUUID()}`;
		case "Tag":
			return `tag:${props.tagId}`;
		case "Untagged":
			return "untagged";
		case "Unpanned":
			return "unpanned";
		case "PanoIds":
			return "panoids";
		case "NotPanoIds":
			return "notpanoids";
		case "Duplicates":
			return `duplicates:${props.distance}`;
		case "Manual":
			return "manual";
		case "ValidationState":
			return `validation:${props.state}`;
		case "Intersection":
			return props.selections.map((s) => `(${s.key})`).join("^");
		case "Union":
			return props.selections.map((s) => `(${s.key})`).join("|");
		case "Invert":
			return `!${props.selections[0].key}`;
		case "Filter":
			return `filter:${props.field}:${props.op}:${String(props.value)}${props.value2 != null ? `:${String(props.value2)}` : ""}`;
	}
}

/** Create a Selection with a deterministic key and hashed color from its props. */
export function buildSelection(map: MapData, props: SelectionProps): Selection {
	const locations = resolveLocations(map, props);
	const key = keyForProps(map, props, locations);
	return { key, color: colorForKey(key), props, count: 0 };
}

// dedupe by key, preserving order of last occurrence
function dedupe(selections: Selection[]): Selection[] {
	const map = new Map<string, Selection>();
	for (const s of selections) map.set(s.key, s);
	return map.size === selections.length ? selections : Array.from(map.values());
}

export function addSelection(
	map: MapData,
	current: Selection[],
	props: SelectionProps,
): Selection[] {
	return dedupe([...current, buildSelection(map, props)]);
}

/** Remove a selection by key. Composites (Intersection/Union/Invert) unwrap their children back into the list. */
export function removeSelection(current: Selection[], key: string): Selection[] {
	return current.flatMap((s) => {
		if (s.key !== key) return [s];
		if (s.props.type === "Invert" || s.props.type === "Intersection" || s.props.type === "Union")
			return s.props.selections;
		return [];
	});
}

/** Merge targeted selections into a single composite, flattening nested groups of the same type. */
function composeSelectionGroup(
	map: MapData,
	current: Selection[],
	keys: string[] | null,
	type: "Intersection" | "Union",
): Selection[] {
	if (current.length < 2) return current;
	const targetKeys = keys ?? current.map((s) => s.key);
	const targets: Selection[] = [];
	const others: Selection[] = [];
	for (const s of current) (targetKeys.includes(s.key) ? targets : others).push(s);
	const flat = targets.flatMap((s) => (s.props.type === type ? s.props.selections : [s]));
	return [...others, buildSelection(map, { type, selections: dedupe(flat) })];
}

export const intersectSelections = (map: MapData, current: Selection[], keys: string[] | null) => composeSelectionGroup(map, current, keys, "Intersection");

export const unionSelections = (map: MapData, current: Selection[], keys: string[] | null) => composeSelectionGroup(map, current, keys, "Union");

/** Invert targeted selections. Single target toggles in-place; multiple are wrapped in Union then Invert. */
export function invertSelections(
	map: MapData,
	current: Selection[],
	keys: string[] | null,
): Selection[] {
	if (current.length === 0) return current;
	const targetKeys = keys ?? current.map((s) => s.key);
	// single-target invert toggles in-place
	if (targetKeys.length === 1) {
		return current.map((s) => {
			if (s.key !== targetKeys[0]) return s;
			if (s.props.type === "Invert") return s.props.selections[0];
			return buildSelection(map, { type: "Invert", selections: [s] });
		});
	}
	const targets: Selection[] = [];
	const others: Selection[] = [];
	for (const s of current) (targetKeys.includes(s.key) ? targets : others).push(s);
	const flat = targets.flatMap((s) => (s.props.type === "Union" ? s.props.selections : [s]));
	const inner =
		flat.length === 1 ? flat[0] : buildSelection(map, { type: "Union", selections: flat });
	return [...others, buildSelection(map, { type: "Invert", selections: [inner] })];
}

export function toggleManualSelection(
	map: MapData,
	current: Selection[],
	locationId: number,
): Selection[] {
	const idx = current.findIndex((s) => s.key === "manual");
	if (idx === -1)
		return [...current, buildSelection(map, { type: "Manual", locations: [locationId] })];
	const sel = current[idx];
	const ids = (sel.props as Extract<SelectionProps, { type: "Manual" }>).locations.slice();
	const at = ids.indexOf(locationId);
	if (at === -1) ids.push(locationId);
	else ids.splice(at, 1);
	if (ids.length === 0) return current.toSpliced(idx, 1);
	const next = buildSelection(map, { type: "Manual", locations: ids });
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
	map: MapData,
	current: Selection[],
	dragKey: string,
	dropKey: string,
	mode: "intersection" | "union",
): Selection[] {
	const dragIdx = current.findIndex((s) => s.key === dragKey);
	const dropIdx = current.findIndex((s) => s.key === dropKey);
	if (dragIdx === -1 || dropIdx === -1 || dragIdx === dropIdx) return current;
	const drag = current[dragIdx];
	const drop = current[dropIdx];

	const matchType = mode === "intersection" ? "Intersection" : "Union";
	let children: Selection[];
	if (drop.props.type === matchType) {
		children = [...(drop.props as { selections: Selection[] }).selections, drag];
	} else {
		children = [drop, drag];
	}
	const composite = buildSelection(map, { type: matchType, selections: dedupe(children) });

	return current.filter((_, i) => i !== dragIdx).map((s) => (s.key === dropKey ? composite : s));
}

function removeChildFromComposite(
	map: MapData,
	sel: Selection,
	parentKey: string,
	childKey: string,
): { updated: Selection; removed: Selection } | null {
	const compositeProps = sel.props.type === "Invert" ? sel.props.selections[0].props : sel.props;
	if (compositeProps.type !== "Intersection" && compositeProps.type !== "Union") return null;
	const children = (compositeProps as { selections: Selection[] }).selections;

	if (sel.key === parentKey) {
		const childIdx = children.findIndex((s) => s.key === childKey);
		if (childIdx === -1) return null;
		const child = children[childIdx];
		const unwrapped =
			child.props.type === "Intersection" || child.props.type === "Union"
				? (child.props as { selections: Selection[] }).selections
				: [];
		const remaining = [
			...children.slice(0, childIdx),
			...unwrapped,
			...children.slice(childIdx + 1),
		];
		if (remaining.length <= 1) {
			return { updated: remaining[0] ?? child, removed: child };
		}
		return {
			updated: buildSelection(map, { type: compositeProps.type, selections: remaining }),
			removed: child,
		};
	}

	for (let i = 0; i < children.length; i++) {
		const result = removeChildFromComposite(map, children[i], parentKey, childKey);
		if (result) {
			const newChildren = children.with(i, result.updated);
			return {
				updated: buildSelection(map, { type: compositeProps.type, selections: newChildren }),
				removed: result.removed,
			};
		}
	}
	return null;
}

/** Pull a child out of a composite back into the top-level list. Parent collapses if only one child remains. */
export function decomposeChild(
	map: MapData,
	current: Selection[],
	parentKey: string,
	childKey: string,
): Selection[] {
	for (let i = 0; i < current.length; i++) {
		if (current[i].key === parentKey) {
			const result = removeChildFromComposite(map, current[i], parentKey, childKey);
			if (!result) return current;
			const out = [...current];
			out[i] = result.updated;
			out.splice(i + 1, 0, result.removed);
			return out;
		}
		const nested = removeChildFromComposite(map, current[i], parentKey, childKey);
		if (nested) {
			const out = [...current];
			out[i] = nested.updated;
			out.splice(i + 1, 0, nested.removed);
			return out;
		}
	}
	return current;
}

export function removeFromComposite(
	map: MapData,
	current: Selection[],
	parentKey: string,
	childKey: string,
): Selection[] {
	for (let i = 0; i < current.length; i++) {
		const result = removeChildFromComposite(map, current[i], parentKey, childKey);
		if (result) {
			const out = [...current];
			out[i] = result.updated;
			return out;
		}
	}
	return current;
}

export function composeSiblings(
	map: MapData,
	current: Selection[],
	parentKey: string,
	dragKey: string,
	dropKey: string,
	mode: "intersection" | "union",
): Selection[] {
	const parentIdx = current.findIndex((s) => s.key === parentKey);
	if (parentIdx === -1) return current;
	const parent = current[parentIdx];
	const compositeProps =
		parent.props.type === "Invert" ? parent.props.selections[0].props : parent.props;
	if (compositeProps.type !== "Intersection" && compositeProps.type !== "Union") return current;

	const children = (compositeProps as { selections: Selection[] }).selections;
	const dragChild = children.find((s) => s.key === dragKey);
	const dropChild = children.find((s) => s.key === dropKey);
	if (!dragChild || !dropChild) return current;

	const matchType = mode === "intersection" ? "Intersection" : "Union";
	const nested = buildSelection(map, { type: matchType, selections: [dropChild, dragChild] });
	const newChildren = children
		.filter((s) => s.key !== dragKey)
		.map((s) => (s.key === dropKey ? nested : s));
	const newParent = buildSelection(map, { type: compositeProps.type, selections: newChildren });
	return current.with(parentIdx, newParent);
}

export function composeWithChild(
	map: MapData,
	current: Selection[],
	dragKey: string,
	parentKey: string,
	childKey: string,
	mode: "intersection" | "union",
): Selection[] {
	const parentIdx = current.findIndex((s) => s.key === parentKey);
	const dragIdx = current.findIndex((s) => s.key === dragKey);
	if (parentIdx === -1 || dragIdx === -1) return current;
	const parent = current[parentIdx];
	const drag = current[dragIdx];
	const compositeProps =
		parent.props.type === "Invert" ? parent.props.selections[0].props : parent.props;
	if (compositeProps.type !== "Intersection" && compositeProps.type !== "Union") return current;

	const children = (compositeProps as { selections: Selection[] }).selections;
	const childIdx = children.findIndex((s) => s.key === childKey);
	if (childIdx === -1) return current;
	const child = children[childIdx];

	const matchType = mode === "intersection" ? "Intersection" : "Union";
	const nested = buildSelection(map, { type: matchType, selections: [child, drag] });
	const newChildren = children.with(childIdx, nested);
	const newParent = buildSelection(map, { type: compositeProps.type, selections: newChildren });

	return current.filter((_, i) => i !== dragIdx).map((s) => (s.key === parentKey ? newParent : s));
}

/** Human-readable label for a selection, resolving tag names and filter ops. */
export function selectionDisplayName(map: MapData, sel: Selection): string {
	const p = sel.props;
	switch (p.type) {
		case "Locations":
			return p.name ?? "Selection";
		case "Everything":
			return "Everything";
		case "Polygon":
			return p.polygon.properties?.name ? `Polygon: ${p.polygon.properties.name}` : "Polygon";
		case "Tag":
			return `Tag: ${tagDisplayName(map, p.tagId)}`;
		case "Untagged":
			return "Untagged";
		case "Unpanned":
			return "Unpanned";
		case "PanoIds":
			return "Pano ID locations";
		case "NotPanoIds":
			return "Coordinate locations";
		case "Duplicates":
			return `Duplicates (${p.distance}m)`;
		case "Manual":
			return "Manual selection";
		case "ValidationState":
			return validationStateLabel(p.state);
		case "Intersection":
			return "Intersection";
		case "Union":
			return "Union";
		case "Invert":
			return `Invert: ${selectionDisplayName(map, p.selections[0])}`;
		case "Filter": {
			const OP_LABELS: Record<FilterOp, string> = {
				eq: "=",
				neq: "!=",
				gt: ">",
				lt: "<",
				gte: ">=",
				lte: "<=",
				between: "between",
				between_anyyear: "between (any year)",
				has: "has",
				nothas: "does not have",
			};
			const fieldDef = map.meta.extra?.fields?.[p.field];
			const fieldLabel = fieldDef?.label ?? p.field;
			if (p.op === "has") return `has ${fieldLabel}`;
			if (p.op === "nothas") return `missing ${fieldLabel}`;
			const fmtMD = (v: unknown) => {
				const s = String(v);
				const m = /^(\d{2})-(\d{2})$/.exec(s);
				if (m) {
					const dt = new Date(2000, Number(m[1]) - 1, Number(m[2]));
					return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
				}
				return s;
			};
			const fmtVal = (v: unknown) => {
				const s = String(v);
				if (fieldDef?.type === "enum" && fieldDef.labels?.[s]) return fieldDef.labels[s];
				if (fieldDef?.type === "date") {
					const n = Number(v);
					if (!isNaN(n)) return new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ");
				}
				return s;
			};
			if (p.op === "between_anyyear")
				return `${fieldLabel} ${OP_LABELS[p.op]} ${fmtMD(p.value)}..${fmtMD(p.value2)}`;
			if (p.op === "between")
				return `${fieldLabel} ${OP_LABELS[p.op as FilterOp]} ${fmtVal(p.value)}..${fmtVal(p.value2)}`;
			return `${fieldLabel} ${OP_LABELS[p.op as FilterOp]} ${fmtVal(p.value)}`;
		}
	}
}

function tagDisplayName(map: MapData, tagId: number): string {
	return map.meta.tags[tagId]?.name ?? String(tagId);
}

function validationStateLabel(state: ValidationState): string {
	switch (state) {
		case ValidationState.Ok:
			return "Valid location";
		case ValidationState.UpdateAvailable:
			return "Newer coverage available";
		case ValidationState.UpdateApplied:
			return "Coverage updated since last view";
		case ValidationState.NotFound:
			return "Not found";
		case ValidationState.PanoIdBroke:
			return "Pano ID broke";
		case ValidationState.Unofficial:
			return "Unofficial";
		case ValidationState.GoodcamAvailable:
			return "Badcam, but good coverage available";
	}
}

export function setSelectionColor(
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
		if (s.key !== key || s.props.type !== "Polygon") return s;
		const props: SelectionProps = {
			...s.props,
			polygon: { ...s.props.polygon, properties: { ...s.props.polygon.properties, name } },
		};
		return { ...s, props };
	});
}
