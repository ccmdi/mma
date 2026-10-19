/** Saved selection rules shared across maps. Tag membership is stored by name
 * so rules can be applied on maps with different tag ids. */
import type * as bindings from "@/bindings.gen";
import { Mutation } from "@/store/mutation";
import type { Selector } from "@/types";
import type { RGB, SavedSelectionInfo, Selection, SelectionInput } from "@/bindings.gen";
import { selection, childSelections, selectionDisplayName } from "./selections";
import { cmd } from "@/lib/commands";
import { importLegacySavedSelections } from "./migrations";
import { bridgeAcrossWindows, emit } from "@/lib/events";
import { log } from "@/lib/util/log";

export type SavedSelection = bindings.SavedSelection;

const MAP_LOCAL_TYPES = ["Locations", "Manual", "Validation", "Reviewed", "Selected"] as const;
const MAP_LOCAL_SET: ReadonlySet<string> = new Set(MAP_LOCAL_TYPES);

/** One part of a saved rule: what its chip reads as, and what it resolves to here. The
 *  label comes from the tree as saved, so a tag this map doesn't have still reads by the
 *  name it was saved under. */
export interface SavedPart {
	label: string;
	color: RGB;
	selector: Selector;
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

export const SavedSelection = {
	/** Selection types that cannot be saved as rules because they are bound to the open map. */
	MAP_LOCAL_TYPES,
	/** Whether the selector tree contains only portable types (no map-local leaves). */
	isSaveable: (selector: Selector): boolean => {
		if (MAP_LOCAL_SET.has(selector.type)) return false;
		return childSelections(selector).every((c) => SavedSelection.isSaveable(c.selector));
	},
	/** A rule's parts: its top-level `Union` is the list it was saved from, anything else is
	 *  a single part. */
	parts: (saved: SavedSelection): SavedPart[] => {
		const { selector } = saved;
		const parts: SelectionInput[] =
			selector.type === "Union"
				? selector.selections.map((s) => ({ ...selection(s.selector), color: s.color }))
				: [{ ...selection(selector), color: saved.color }];
		return parts.map((part) => ({
			label: selectionDisplayName(part, saved.valueNames),
			color: part.color!,
			selector: part.selector,
		}));
	},
	/** The rules that exist, as identity only. Empty until the index loads: the first
	 *  call starts the read and `saved-selections:changed` announces it. */
	index: (): SavedSelectionInfo[] => {
		if (index === null) void loadIndex();
		return index ?? NO_RULES;
	},
	/** Load the full rule bodies for the given `ids`. */
	load: async (ids: string[]): Promise<SavedSelection[]> => {
		const missing = ids.filter((id) => !bodies.has(id));
		if (missing.length > 0) {
			const rows = await cmd.storeGetSavedSelections(missing);
			for (const id of missing) bodies.set(id, null);
			for (const row of rows) bodies.set(row.id, row);
		}
		return ids.map((id) => bodies.get(id)).filter((r): r is SavedSelection => r != null);
	},
	/** Every rule with its body. */
	loadAll: async (): Promise<SavedSelection[]> => {
		await loadIndex();
		return SavedSelection.load((index ?? []).map((r) => r.id));
	},
	/** Persists the saveable selections as one rule. False when none of them are saveable. */
	save: async (name: string, selections: Selection[]): Promise<boolean> => {
		const saveable = selections.filter((s) => SavedSelection.isSaveable(s.selector));
		if (saveable.length === 0) return false;
		const selector: Selector =
			saveable.length === 1 ? saveable[0].selector : { type: "Union", selections: saveable };
		const saved = await cmd.storeSaveSelection(name, selector, saveable[0].color);
		bodies.set(saved.id, saved);
		await reloadIndex();
		return true;
	},
	/** Permanently delete a saved selection rule. */
	remove: async (id: string): Promise<void> => {
		await cmd.storeDeleteSavedSelection(id);
		await reloadIndex();
	},
	/** Adds the rule's parts to the sidebar, resolved against the open map. Returns how many
	 *  were added. */
	apply: (saved: SavedSelection): number => {
		const count = saved.selector.type === "Union" ? saved.selector.selections.length : 1;
		void Mutation.run(() => cmd.storeEditSelections({ kind: "addSaved", id: saved.id }));
		return count;
	},
};
