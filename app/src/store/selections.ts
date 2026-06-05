/** Pure selection transforms. These only manipulate the JS selection tree; Rust resolves the actual bitmasks. */

import { match, P } from "ts-pattern";
import type { MapData } from "@/types";
import { hslToRgb } from "@/lib/util/color";
import { getFieldDef } from "@/lib/data/fieldDefRegistry";
import { isVariant, unionTuple, type Variant } from "@/lib/util/union";

export type { Selection, SelectionProps, PolygonGeometry } from "@/bindings.gen";
import type { Selection, SelectionProps } from "@/bindings.gen";

/** Variants that wrap children — derived as exactly those carrying a `selections` array. */
export type CompositeType = Extract<SelectionProps, { selections: Selection[] }>["type"];
/** Composite variants that are flat groups (no negation). */
export type GroupType = Exclude<CompositeType, "Invert">;

const COMPOSITE_TYPES = unionTuple<CompositeType>()(["Intersection", "Union", "Invert"]);
const GROUP_TYPES = unionTuple<GroupType>()(["Intersection", "Union"]);

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
	| "between_anytime"
	| "has"
	| "nothas";

/** Display symbol/word for each filter operator. */
export const OP_LABELS: Record<FilterOp, string> = {
	eq: "=",
	neq: "!=",
	gt: ">",
	lt: "<",
	gte: ">=",
	lte: "<=",
	between: "between",
	between_anyyear: "between (any year)",
	between_anytime: "between (any date)",
	has: "has",
	nothas: "does not have",
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

/** Pick `n` distinct ids uniformly at random from `ids` using `Math.random`.
 *  `n` is floored and clamped to `[0, ids.length]` (so over-large counts return all ids).
 *  Uses a partial Fisher–Yates shuffle, so the result contains no duplicates and `ids` is not mutated. */
export function sampleIds(ids: number[], n: number): number[] {
	const k = Math.max(0, Math.min(Math.floor(n), ids.length));
	const pool = ids.slice();
	for (let i = 0; i < k; i += 1) {
		const j = i + Math.floor(Math.random() * (pool.length - i));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, k);
}

export function resolveLocations(props: SelectionProps): number[] {
	return match(props)
		.with({ type: P.union("Locations", "Manual", "ValidationState", "Reviewed") }, (p) => [
			...p.locations,
		])
		.otherwise(() => []);
}

function keyForProps(props: SelectionProps, locations: number[]): string {
	return match(props)
		.with({ type: "Locations" }, () => locationsKey(locations))
		.with({ type: "Everything" }, () => "everything")
		// polygon keys are unique per draw; use a generated id stored on first init
		.with({ type: "Polygon" }, () => `polygon:${crypto.randomUUID()}`)
		.with({ type: "Tag" }, (p) => `tag:${p.tagId}`)
		.with({ type: "Untagged" }, () => "untagged")
		.with({ type: "Unpanned" }, () => "unpanned")
		.with({ type: "PanoIds" }, () => "panoids")
		.with({ type: "NotPanoIds" }, () => "notpanoids")
		.with({ type: "Duplicates" }, (p) => `duplicates:${p.distance}`)
		.with({ type: "Manual" }, () => "manual")
		.with({ type: "ValidationState" }, (p) => `validation:${p.state}`)
		.with({ type: "Reviewed" }, (p) => `review:${p.sessionId}:${p.mode}`)
		.with({ type: "Intersection" }, (p) => p.selections.map((s) => `(${s.key})`).join("^"))
		.with({ type: "Union" }, (p) => p.selections.map((s) => `(${s.key})`).join("|"))
		.with({ type: "Invert" }, (p) => `!${p.selections[0].key}`)
		.with(
			{ type: "Filter" },
			(p) =>
				`filter:${p.field}:${p.op}:${String(p.value)}${p.value2 != null ? `:${String(p.value2)}` : ""}`,
		)
		.exhaustive();
}

/** Overlay color for a selection. Reviewed/unreviewed get fixed complementary colors —
 *  hues 145 and 325 are exact opposites (180° apart) — everything else is hashed from its key. */
function selectionColor(props: SelectionProps, key: string): [number, number, number] {
	if (props.type !== "Reviewed") return colorForKey(key);
	return props.mode === "unreviewed" ? hslToRgb(325, 0.6, 0.5) : hslToRgb(145, 0.6, 0.5);
}

/** Create a Selection with a deterministic key and overlay color from its props. */
export function buildSelection(props: SelectionProps): Selection {
	const locations = resolveLocations(props);
	const key = keyForProps(props, locations);
	return { key, color: selectionColor(props, key), props, count: 0 };
}

// dedupe by key, preserving order of last occurrence
function dedupe(selections: Selection[]): Selection[] {
	const map = new Map<string, Selection>();
	for (const s of selections) map.set(s.key, s);
	return map.size === selections.length ? selections : Array.from(map.values());
}

export function addSelection(
	current: Selection[],
	props: SelectionProps,
): Selection[] {
	return dedupe([...current, buildSelection(props)]);
}

/** Remove a selection by key. Composites (Intersection/Union/Invert) unwrap their children back into the list. */
export function removeSelection(current: Selection[], key: string): Selection[] {
	return current.flatMap((s) => {
		if (s.key !== key) return [s];
		if (isVariant(s.props, COMPOSITE_TYPES)) return s.props.selections;
		return [];
	});
}

/** Merge targeted selections into a single composite, flattening nested groups of the same type. */
function composeSelectionGroup(
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
	return [...others, buildSelection({ type, selections: dedupe(flat) })];
}

export const intersectSelections = (current: Selection[], keys: string[] | null) =>
	composeSelectionGroup(current, keys, "Intersection");

export const unionSelections = (current: Selection[], keys: string[] | null) =>
	composeSelectionGroup(current, keys, "Union");

/** Invert targeted selections. Single target toggles in-place; multiple are wrapped in Union then Invert. */
export function invertSelections(
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
			return buildSelection({ type: "Invert", selections: [s] });
		});
	}
	const targets: Selection[] = [];
	const others: Selection[] = [];
	for (const s of current) (targetKeys.includes(s.key) ? targets : others).push(s);
	const flat = targets.flatMap((s) => (s.props.type === "Union" ? s.props.selections : [s]));
	const inner =
		flat.length === 1 ? flat[0] : buildSelection({ type: "Union", selections: flat });
	return [...others, buildSelection({ type: "Invert", selections: [inner] })];
}

export function toggleManualSelection(
	current: Selection[],
	locationId: number,
): Selection[] {
	const idx = current.findIndex((s) => s.key === "manual");
	if (idx === -1)
		return [...current, buildSelection({ type: "Manual", locations: [locationId] })];
	const sel = current[idx];
	const ids = (sel.props as Variant<SelectionProps, "Manual">).locations.slice();
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
	if (isVariant(drop.props, mode)) {
		children = [...drop.props.selections, drag];
	} else {
		children = [drop, drag];
	}
	const composite = buildSelection({ type: mode, selections: dedupe(children) });

	return current.filter((_, i) => i !== dragIdx).map((s) => (s.key === dropKey ? composite : s));
}

function removeChildFromComposite(
	sel: Selection,
	parentKey: string,
	childKey: string,
): { updated: Selection; removed: Selection } | null {
	const compositeProps = isVariant(sel.props, "Invert") ? sel.props.selections[0].props : sel.props;
	if (!isVariant(compositeProps, GROUP_TYPES)) return null;
	const children = compositeProps.selections;

	if (sel.key === parentKey) {
		const childIdx = children.findIndex((s) => s.key === childKey);
		if (childIdx === -1) return null;
		const child = children[childIdx];
		const unwrapped = isVariant(child.props, GROUP_TYPES) ? child.props.selections : [];
		const remaining = [
			...children.slice(0, childIdx),
			...unwrapped,
			...children.slice(childIdx + 1),
		];
		if (remaining.length <= 1) {
			return { updated: remaining[0] ?? child, removed: child };
		}
		return {
			updated: buildSelection({ type: compositeProps.type, selections: remaining }),
			removed: child,
		};
	}

	for (let i = 0; i < children.length; i++) {
		const result = removeChildFromComposite(children[i], parentKey, childKey);
		if (result) {
			const newChildren = children.with(i, result.updated);
			return {
				updated: buildSelection({ type: compositeProps.type, selections: newChildren }),
				removed: result.removed,
			};
		}
	}
	return null;
}

/** Pull a child out of a composite back into the top-level list. Parent collapses if only one child remains. */
export function decomposeChild(
	current: Selection[],
	parentKey: string,
	childKey: string,
): Selection[] {
	for (let i = 0; i < current.length; i++) {
		if (current[i].key === parentKey) {
			const result = removeChildFromComposite(current[i], parentKey, childKey);
			if (!result) return current;
			const out = [...current];
			out[i] = result.updated;
			out.splice(i + 1, 0, result.removed);
			return out;
		}
		const nested = removeChildFromComposite(current[i], parentKey, childKey);
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
	current: Selection[],
	parentKey: string,
	childKey: string,
): Selection[] {
	for (let i = 0; i < current.length; i++) {
		const result = removeChildFromComposite(current[i], parentKey, childKey);
		if (result) {
			const out = [...current];
			out[i] = result.updated;
			return out;
		}
	}
	return current;
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
	const parent = current[parentIdx];
	const compositeProps = isVariant(parent.props, "Invert")
		? parent.props.selections[0].props
		: parent.props;
	if (!isVariant(compositeProps, GROUP_TYPES)) return current;

	const children = compositeProps.selections;
	const dragChild = children.find((s) => s.key === dragKey);
	const dropChild = children.find((s) => s.key === dropKey);
	if (!dragChild || !dropChild) return current;

	const nested = buildSelection({ type: mode, selections: [dropChild, dragChild] });
	const newChildren = children
		.filter((s) => s.key !== dragKey)
		.map((s) => (s.key === dropKey ? nested : s));
	const newParent = buildSelection({ type: compositeProps.type, selections: newChildren });
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
	const parent = current[parentIdx];
	const drag = current[dragIdx];
	const compositeProps = isVariant(parent.props, "Invert")
		? parent.props.selections[0].props
		: parent.props;
	if (!isVariant(compositeProps, GROUP_TYPES)) return current;

	const children = compositeProps.selections;
	const childIdx = children.findIndex((s) => s.key === childKey);
	if (childIdx === -1) return current;
	const child = children[childIdx];

	const nested = buildSelection({ type: mode, selections: [child, drag] });
	const newChildren = children.with(childIdx, nested);
	const newParent = buildSelection({ type: compositeProps.type, selections: newChildren });

	return current.filter((_, i) => i !== dragIdx).map((s) => (s.key === parentKey ? newParent : s));
}

function replaceInTree(
	sel: Selection,
	oldKey: string,
	props: SelectionProps,
): Selection | null {
	if (sel.key === oldKey) return buildSelection(props);
	if (!isVariant(sel.props, COMPOSITE_TYPES)) return null;
	const children = sel.props.selections;
	for (let i = 0; i < children.length; i++) {
		const replaced = replaceInTree(children[i], oldKey, props);
		if (replaced) {
			const newChildren = children.with(i, replaced);
			return buildSelection({ type: sel.props.type, selections: newChildren });
		}
	}
	return null;
}

/** Replace the selection identified by `oldKey` (at any depth) with one built from
 *  `props`, rebuilding the keys of every composite on the path so identity stays
 *  consistent. Used to edit a filter in place without dropping it from its AND/OR group. */
export function replaceSelection(
	current: Selection[],
	oldKey: string,
	props: SelectionProps,
): Selection[] {
	for (let i = 0; i < current.length; i++) {
		const replaced = replaceInTree(current[i], oldKey, props);
		if (replaced) return current.with(i, replaced);
	}
	return current;
}

/** Human-readable label for a selection, resolving tag names and filter ops. */
export function selectionDisplayName(map: MapData, sel: Selection): string {
	return match(sel.props)
		.with({ type: "Locations" }, (p) => p.name ?? "Selection")
		.with({ type: "Everything" }, () => "Everything")
		.with({ type: "Polygon" }, (p) =>
			p.polygon.properties?.name ? `Polygon: ${p.polygon.properties.name}` : "Polygon",
		)
		.with({ type: "Tag" }, (p) => `Tag: ${tagDisplayName(map, p.tagId)}`)
		.with({ type: "Untagged" }, () => "Untagged")
		.with({ type: "Unpanned" }, () => "Unpanned")
		.with({ type: "PanoIds" }, () => "Pano ID locations")
		.with({ type: "NotPanoIds" }, () => "Coordinate locations")
		.with({ type: "Duplicates" }, (p) => `Duplicates (${p.distance}m)`)
		.with({ type: "Manual" }, () => "Manual selection")
		.with({ type: "ValidationState" }, (p) => validationStateLabel(p.state))
		.with({ type: "Reviewed" }, (p) => (p.mode === "unreviewed" ? "Unreviewed" : "Reviewed"))
		.with({ type: "Intersection" }, () => "Intersection")
		.with({ type: "Union" }, () => "Union")
		.with({ type: "Invert" }, (p) => `Invert: ${selectionDisplayName(map, p.selections[0])}`)
		.with({ type: "Filter" }, (p) => {
			const fieldDef = getFieldDef(p.field);
			const fieldLabel = fieldDef?.label ?? p.field;
			if (p.op === "has") return `has ${fieldLabel}`;
			if (p.op === "nothas") return `missing ${fieldLabel}`;
			const fmtMD = (v: unknown) => {
				const s = String(v);
				const m = /^(\d{2})-(\d{2})$/.exec(s);
				if (m) {
					const dt = new Date(2000, Number(m[1]) - 1, Number(m[2]));
					return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
			if (p.op === "between_anytime")
				return `${fieldLabel} ${OP_LABELS[p.op]} ${p.value}..${p.value2}`;
			if (p.op === "between")
				return `${fieldLabel} ${OP_LABELS[p.op as FilterOp]} ${fmtVal(p.value)}..${fmtVal(p.value2)}`;
			return `${fieldLabel} ${OP_LABELS[p.op as FilterOp]} ${fmtVal(p.value)}`;
		})
		.exhaustive();
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
		if (s.key !== key || s.props.type !== "Polygon") return s;
		const props: SelectionProps = {
			...s.props,
			polygon: { ...s.props.polygon, properties: { ...s.props.polygon.properties, name } },
		};
		return { ...s, props };
	});
}
