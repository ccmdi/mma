/** Saved selection rules: global, name-based, stored in SQLite.
 *
 *  A rule is one `Selector` tree plus the names its `Tag` leaves carried at save time.
 *  Tag ids are map-local, so the names are what makes a rule portable -- the tree itself
 *  is stored verbatim and re-resolved against whatever map is open. */

import type { SavedSelection, SavedSelectionInfo, Selection, Selector } from "@/bindings.gen";
import { buildSelection, selectionDisplayName } from "./selections";
import { cmd } from "@/lib/commands";
import { importLegacySavedSelections } from "./migrations";
import { bridgeAcrossWindows, emit, useEventValue } from "@/lib/events";
import { log } from "@/lib/util/log";
import { addSelections, getTag, getVisibleTags } from "./useMapStore";

/** Selection types bound to the open map (raw location ids, review sessions): a rule
 *  built from them would be a frozen snapshot, so they are never saved. */
export const MAP_LOCAL_TYPES = ["Locations", "Manual", "ValidationState", "Reviewed"] as const;

const MAP_LOCAL_SET: ReadonlySet<string> = new Set(MAP_LOCAL_TYPES);

/** A selector that matches nothing -- what a `Tag` leaf becomes when its saved name
 *  doesn't exist on this map. The rule stays intact; the dead leaf just contributes
 *  nothing to it. */
const NOTHING: Selector = { type: "Locations", locations: [], name: null };

/** Saveable only if the whole tree is portable: one map-local leaf anywhere would freeze
 *  the rule to the map it was built on. */
export function isSaveable(selector: Selector): boolean {
	if (MAP_LOCAL_SET.has(selector.type)) return false;
	return "selections" in selector ? selector.selections.every((c) => isSaveable(c.selector)) : true;
}

/** The name of every `Tag` leaf in the tree, keyed by id. */
function captureTagNames(selector: Selector, out: Record<number, string> = {}) {
	if (selector.type === "Tag") {
		const tag = getTag(selector.tagId);
		if (tag) out[selector.tagId] = tag.name;
	} else if ("selections" in selector) {
		for (const child of selector.selections) captureTagNames(child.selector, out);
	}
	return out;
}

/** Visible tags only -- a saved selection must not resurrect a soft-deleted ghost. */
function resolveTagByName(tagName: string): number | null {
	const lower = tagName.toLowerCase();
	for (const tag of getVisibleTags()) {
		if (tag.name.toLowerCase() === lower) return tag.id;
	}
	return null;
}

/** The saved tree against the open map: each `Tag` leaf re-resolves by the name it was
 *  saved under, and one whose name is gone here selects nothing. Composites are rebuilt
 *  so their keys follow the remapped ids; per-child colors survive. */
function remap(selector: Selector, tagNames: Record<number, string>): Selector {
	if (selector.type === "Tag") {
		const name = tagNames[selector.tagId];
		const id =
			name != null ? resolveTagByName(name) : getTag(selector.tagId) ? selector.tagId : null;
		return id === null ? NOTHING : { type: "Tag", tagId: id };
	}
	if ("selections" in selector) {
		return {
			type: selector.type,
			selections: selector.selections.map((child) => ({
				...buildSelection(remap(child.selector, tagNames)),
				color: child.color,
			})),
		};
	}
	return selector;
}

/** One part of a saved rule: what its chip reads as, and what it resolves to here. The
 *  label comes from the tree as saved, so a tag this map doesn't have still reads by the
 *  name it was saved under. */
export interface SavedPart {
	label: string;
	color: [number, number, number];
	selector: Selector;
}

/** A rule's parts: its top-level `Union` is the list it was saved from, anything else is
 *  a single part. */
export function savedParts(saved: SavedSelection): SavedPart[] {
	const { selector, tagNames } = saved;
	const parts: Selection[] =
		selector.type === "Union"
			? selector.selections
			: [{ ...buildSelection(selector), color: saved.color }];
	return parts.map((part) => ({
		label: selectionDisplayName(part, tagNames),
		color: part.color,
		selector: remap(part.selector, tagNames),
	}));
}

// A rule body can be ~1.7MB of JSON (a `Polygon` leaf inlines every coordinate), so JS
// holds the index and fetches bodies on demand.

/** The rule index, or null before it has been read. */
let index: SavedSelectionInfo[] | null = null;
/** Stable stand-in while the index is unread: a fresh literal would break the snapshot identity
 *  `useSyncExternalStore` relies on. */
const NO_RULES: SavedSelectionInfo[] = [];
/** Bodies that have been fetched. `null` records a rule that isn't there, so a miss is
 *  never re-requested on every render. */
const bodies = new Map<string, SavedSelection | null>();
let indexLoad: Promise<void> | null = null;

/** The rules that exist, as identity only. Empty until the index arrives -- the first
 *  call starts the read and `saved-selections:changed` announces it. */
export function getSavedSelectionIndex(): SavedSelectionInfo[] {
	if (index === null) void loadIndex();
	return index ?? NO_RULES;
}

export function useSavedSelectionIndex(): SavedSelectionInfo[] {
	return useEventValue("saved-selections:changed", getSavedSelectionIndex);
}

/** Bodies for `ids`, fetching only the ones not already held. */
export async function loadSavedSelections(ids: string[]): Promise<SavedSelection[]> {
	const missing = ids.filter((id) => !bodies.has(id));
	if (missing.length > 0) {
		const rows = await cmd.storeGetSavedSelections(missing);
		for (const id of missing) bodies.set(id, null);
		for (const row of rows) bodies.set(row.id, row);
	}
	return ids.map((id) => bodies.get(id)).filter((r): r is SavedSelection => r != null);
}

/** Every rule with its body. */
export async function loadAllSavedSelections(): Promise<SavedSelection[]> {
	await loadIndex();
	return loadSavedSelections((index ?? []).map((r) => r.id));
}

/** A saved rule as a single `Selector`, resolved against the open map. Matches nothing
 *  until the body arrives; fetching it emits `saved-selections:changed`, so a caller that
 *  re-reads on that event gets the real tree. */
export function savedSelector(id: string): Selector {
	const saved = bodies.get(id);
	if (saved) return remap(saved.selector, saved.tagNames);
	if (!bodies.has(id)) {
		void loadSavedSelections([id]).then((rows) => {
			if (rows.length > 0) emit("saved-selections:changed");
		});
	}
	return NOTHING;
}

/** A rule is only ever inserted or deleted, never edited, so id and name identify the
 *  whole list. */
const fingerprint = (rows: SavedSelectionInfo[]) => rows.map((r) => `${r.id}:${r.name}`).join("|");

/** Reread the index. Emits only on a real change, so the cross-window bridge settles
 *  after one round instead of echoing. Bodies of rules that are gone are dropped. */
async function reloadIndex(): Promise<void> {
	const next = await cmd.storeListSavedSelections();
	const changed = index === null || fingerprint(next) !== fingerprint(index);
	index = next;
	const live = new Set(next.map((r) => r.id));
	for (const id of bodies.keys()) if (!live.has(id)) bodies.delete(id);
	if (changed) emit("saved-selections:changed");
}

function loadIndex(): Promise<void> {
	// Never rejects: the index is read lazily from render paths, so a failure logs and
	// leaves the list empty rather than surfacing as an unhandled rejection.
	indexLoad ??= (async () => {
		await importLegacySavedSelections();
		await reloadIndex();
	})()
		.catch((e) => log.error("[saved-selections] index read failed:", e))
		.finally(() => {
			indexLoad = null;
		});
	return indexLoad;
}

bridgeAcrossWindows("saved-selections:changed", () => void reloadIndex());

/** Persists the saveable selections as one rule. False when none of them are saveable. */
export async function saveCurrentSelections(
	name: string,
	selections: Selection[],
): Promise<boolean> {
	const saveable = selections.filter((s) => isSaveable(s.selector));
	if (saveable.length === 0) return false;
	const selector: Selector =
		saveable.length === 1 ? saveable[0].selector : { type: "Union", selections: saveable };
	const saved = await cmd.storeSaveSelection(
		name,
		selector,
		captureTagNames(selector),
		saveable[0].color,
	);
	bodies.set(saved.id, saved);
	await reloadIndex();
	return true;
}

export async function deleteSavedSelection(id: string): Promise<void> {
	await cmd.storeDeleteSavedSelection(id);
	await reloadIndex();
}

/** Adds the rule's parts to the sidebar, resolved against the open map. Returns how many
 *  were added. */
export function applySavedSelection(saved: SavedSelection): number {
	const parts = savedParts(saved);
	if (parts.length > 0) void addSelections(parts.map((p) => p.selector));
	return parts.length;
}
