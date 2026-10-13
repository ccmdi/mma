import { Store } from "./store";
import { Query } from "./query";
import type { Location } from "@/bindings.gen";
import type { MaybeLocation, WorkArea, Patch } from "@/types";
import { locId } from "@/types";
import { Layer } from "./layer";
import { log } from "@/lib/util/log";
import { subscribe, emit as emitEvent, useEventValue } from "@/lib/events";
import { trace } from "@/lib/util/debug";
import { Import } from "./import";
import { latest } from "@/lib/util/latest";
import { enrich } from "@/lib/sv/enrich";

/** Where an open location came from: the map, the seen history, or a pending import. */
export type OpeningOrigin = "map" | "seen" | "import";

/** A location open in the editor. A preview's id is its viewer-layer id. */
export interface Opening {
	id: number;
	origin: OpeningOrigin;
	/** The pending layer holding this opening's draft. */
	layer: Layer;
	/** The draft as last read from its layer. */
	location: Location;
}

/** What the editor shows: the open location, the pane, and the panels that lead to them. */
export interface EditorState {
	/** The location open in the editor, or null. */
	open: Opening | null;
	/** @unstable */
	duplicateLocations: Location[];
	/** @unstable */
	workArea: WorkArea;
	/** @unstable */
	activePluginId: string | null;
}

let state: EditorState = {
	open: null,
	duplicateLocations: [],
	workArea: "overview",
	activePluginId: null,
};

function update(next: Partial<EditorState>): void {
	state = { ...state, ...next };
	emitEvent("editor:changed");
}

const refreshes = latest<{ open: Opening; location: Location | null }>({
	owner: () => state.open?.layer,
	publish: ({ open, location }) => {
		if (!location) return Editor.close();
		const next = { ...open, location };
		update({ open: next });
		if (location.panoId !== open.location.panoId) enrichDraft(next);
	},
	failed: (error) => log.error("[editor] draft read failed:", error),
});
const enrichments = new WeakMap<Layer, ReturnType<typeof latest>>();
type Opened = { kind: "opening"; opening: Opening } | { kind: "duplicates"; locations: Location[] };

const openings = latest<Opened | null>({
	publish: (result) => {
		if (result?.kind === "duplicates") {
			update({ duplicateLocations: result.locations, workArea: "duplicates" });
			setOpen(null);
		} else if (result) setOpen(result.opening, "location");
	},
	discard: (result) =>
		result?.kind === "opening"
			? result.opening.layer
					.close()
					.catch((error) => log.error("[editor] layer close failed:", error))
			: undefined,
});

type DraftPatch = Omit<Patch<Location>, "id">;

/** Edits and saves bound to one opening. Once another opening or none is current, they do
 *  nothing and resolve null. A failed edit or save is logged and resolves null. */
export interface Draft {
	/** Patch the draft, or derive the patch from the draft as it stands. */
	edit: (patch: DraftPatch | ((location: Location) => DraftPatch)) => Promise<void | null>;
	/** Land the draft with `patch` applied, resolving its id. */
	save: (patch: DraftPatch) => Promise<number | null>;
}

const lifetime = latest({ owner: () => state.open?.layer });
const drafts = new WeakMap<Layer, Draft>();
const inert: Draft = { edit: async () => null, save: async () => null };

function draftOf({ id, layer }: Opening): Draft {
	const edit = async (patch: DraftPatch | ((location: Location) => DraftPatch)) => {
		await layer.edit(async (read) => {
			const [location] = await read(
				{ type: "Locations", locations: [id], name: null },
				{ kind: "locations" },
			);
			if (!location) return [];
			return [{ put: { ...(typeof patch === "function" ? patch(location) : patch), id } }];
		});
	};
	const save = async (patch: DraftPatch) => {
		await layer.land([{ put: { ...patch, id } }]);
		return id;
	};
	const bound = <A extends unknown[], R>(name: string, run: (...args: A) => Promise<R>) =>
		lifetime.bind(
			(...args: A): Promise<R | null> =>
				run(...args).catch((error) => {
					log.error(`[editor] ${name} failed:`, error);
					return null;
				}),
			async () => null,
		);
	return { edit: bound("edit", edit), save: bound("save", save) };
}

/** Publish an opening and close the previous opening's layer. */
function setOpen(open: Opening | null, workArea?: WorkArea): void {
	const previous = state.open;
	if (!open && !previous) return;
	update({ open, ...(workArea && { workArea }) });
	if (open) enrichDraft(open);
	if (previous)
		void previous.layer.close().catch((error) => log.error("[editor] layer close failed:", error));
	emitEvent("open:change", open?.origin === "map" ? open.id : null);
}

function enrichDraft(open: Opening): void {
	if (!Store.get().map?.settings.enrichMetadata) {
		enrichments.get(open.layer)?.cancel();
		return;
	}
	let runs = enrichments.get(open.layer);
	if (!runs) {
		runs = latest({ failed: (error) => log.error("[editor] enrichment failed:", error) });
		enrichments.set(open.layer, runs);
	}
	void runs.replace((signal) =>
		enrich(
			{ type: "Locations", locations: [open.id], name: null },
			{ on: open.layer.target, resolve: false, signal },
		),
	);
}

async function opening(
	id: number,
	location: Location,
	origin: OpeningOrigin,
	layer?: Layer,
): Promise<Opened> {
	return {
		kind: "opening",
		opening: { id, location, origin, layer: layer ?? (await Layer.open()) },
	};
}

/** Prepare a copy while keeping the import or seen record unchanged. */
async function openPreview(loc: Location, origin: OpeningOrigin): Promise<Opened | null> {
	const layer = await Layer.open();
	try {
		const result = await layer.edit([{ set: { ...loc, id: 0 } }]);
		const [id] = result.mutation.keys;
		const [location] =
			id == null
				? []
				: await layer.read(
						{ type: "Locations", locations: [id], name: null },
						{ kind: "locations" },
					);
		if (id == null || !location) {
			await layer.close();
			return null;
		}
		return await opening(id, location, origin, layer);
	} catch (error) {
		await layer.close();
		throw error;
	}
}

export const Editor = {
	/** Imperative snapshot of the editor state. */
	get: (): Readonly<EditorState> => state,
	/** Reactive slice of the editor state. Select fields or memoized values, as with `Store.use`. */
	use: <T>(selector: (s: EditorState) => T): T =>
		useEventValue("editor:changed", () => selector(state)),
	/** Reread the current draft. Superseded reads and errors cannot update the next opening. @unstable */
	refresh: (): Promise<void> => {
		const open = state.open;
		if (!open) return Promise.resolve();
		return refreshes.replace(async () => {
			const [location = null] = await open.layer.read(
				{ type: "Locations", locations: [open.id], name: null },
				{ kind: "locations" },
			);
			return { open, location };
		});
	},
	/** The open draft's edit and save, the same pair for as long as this opening lasts. @unstable */
	draft: (): Draft => {
		const open = state.open;
		if (!open) return inert;
		let draft = drafts.get(open.layer);
		if (!draft) drafts.set(open.layer, (draft = draftOf(open)));
		return draft;
	},
	/** Whether procedure work is still writing to the open draft. @unstable */
	useWriting: (): boolean => {
		const name = Editor.use((s) => s.open?.layer.target.name);
		return Store.use((s) => name != null && s.writingLayers.includes(name));
	},
	/** Preview a copy of a staged-import location. The import row stays staged until Confirm. @unstable */
	openImport: (index: number): Promise<void> => {
		const first = Import.staging()?.preview.firstId;
		if (first == null) return Promise.resolve();
		return openings.replace(async () => {
			const [loc] = await Query.read(
				{ type: "Locations", locations: [first + index], name: null },
				{ kind: "locations" },
				Import.target(),
			);
			return loc ? openPreview(loc, "import") : null;
		});
	},
	/** Open an arbitrary location read-only as a seen-preview: loads its pano without
	 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. @unstable */
	preview: (loc: Location) => {
		void openings
			.replace(() => openPreview(loc, "seen"))
			.catch((error) => log.error("[editor] preview failed:", error));
	},
	/** Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found. */
	resolve: async (m: MaybeLocation): Promise<Location | null> => {
		return typeof m === "number"
			? ((
					await Query.read({ type: "Locations", locations: [m], name: null }, { kind: "locations" })
				)[0] ?? null)
			: m;
	},
	/** Open a location in the editor. With `checkDuplicates`, opening a spot with 2+ locations
	 *  within 2m opens the duplicate-resolution panel instead. A later opening or closing
	 *  supersedes one still loading. */
	open: async (target: MaybeLocation, checkDuplicates = true) => {
		const t = trace("open");
		await openings.replace(async () => {
			const loc = await Editor.resolve(target);
			t.step("ipc");
			if (!loc) return null;
			if (checkDuplicates) {
				const nearby = await Query.read(
					{ type: "Nearby", selection: null, lat: loc.lat, lng: loc.lng, radiusM: 2.0 },
					{ kind: "locations" },
				);
				if (nearby.length >= 2) return { kind: "duplicates", locations: nearby };
			}
			return opening(locId(target), loc, "map");
		});
		t.end();
	},
	/** Close the open location and return to the pane it was opened from. */
	close: () => {
		openings.cancel();
		const preview = state.open && state.open.origin !== "map" ? state.open.origin : null;
		setOpen(null);
		const fallback = state.activePluginId ? "plugin" : "overview";
		update(
			preview
				? { workArea: preview === "import" ? "import" : fallback }
				: { duplicateLocations: [], workArea: fallback },
		);
	},
	/** Open one location from the duplicate-resolution panel in the editor. @unstable */
	openDuplicate: (loc: Location) => openings.replace(() => opening(loc.id, loc, "map")),
	/** Drop a location from the duplicate-resolution panel (does not delete it). @unstable */
	removeDuplicate: (id: number) => {
		update({ duplicateLocations: state.duplicateLocations.filter((l) => l.id !== id) });
	},
	/** Close the duplicate-resolution panel and return to the overview. @unstable */
	closeDuplicates: () => {
		update({ duplicateLocations: [] });
		Editor.setArea("overview");
	},
	/** Transition the editor pane, enforcing state invariants:
	 *  leaving "location" closes the open location, leaving "plugin" clears the plugin id. @unstable */
	setArea: (area: WorkArea) => {
		if (area !== "location") openings.cancel();
		update({ workArea: area });
		if (area !== "location") setOpen(null);
		if (area !== "plugin") update({ activePluginId: null });
	},
	/** Open a plugin's sidebar (switches the editor pane to "plugin"). */
	openPlugin: (pluginId: string) => {
		update({ activePluginId: pluginId });
		Editor.setArea("plugin");
	},
	/** Close the plugin sidebar and return to the overview. */
	closePlugin: () => {
		Editor.setArea("overview");
	},
};

subscribe("store:change", ({ removed }) => {
	const open = state.open;
	if (open?.origin === "map" && removed.includes(open.id)) Editor.close();
	else void Editor.refresh();
});
