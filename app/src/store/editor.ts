import { type OpenOrigin, Store } from "./store";
import { Query } from "./query";
import type { Location, Target } from "@/bindings.gen";
import type { MaybeLocation, WorkArea } from "@/types";
import { locId } from "@/types";
import { cmd } from "@/lib/commands";
import { emit as emitEvent } from "@/lib/events";
import { trace } from "@/lib/util/debug";
import { Import } from "./import";

let lastSession = 0;

/** Open a copy of `loc` in its session's layer, unless a later opening or closing overtook it. */
async function openPreview(loc: Location, origin: OpenOrigin) {
	const session = ++lastSession;
	const layer = Editor.layer(session);
	const r = await cmd.storeEdit(layer, [{ set: { ...loc, id: 0 } }], null);
	const [id] = r.mutation.keys;
	if (id == null) return;
	const [location = null] = await Query.read(
		{ type: "Locations", locations: [id], name: null },
		{ kind: "locations" },
		layer,
	);
	if (session !== lastSession) {
		await cmd.storeDrop(layer.name);
		return;
	}
	Store.patch({ open: { id, origin, session, location }, workArea: "location" });
	emitEvent("open:change", null);
}

/** Drop the open location, keeping `open:change` in step. */
function dropOpen(): void {
	const state = Store.get();
	if (state.open == null) return;
	Store.patch({ open: null });
	emitEvent("open:change", null);
}

export const Editor = {
	/** The pending layer holding the open location's draft edits for editor session `session`. */
	layer: (session: number): Extract<Target, { kind: "pending" }> => ({
		kind: "pending",
		name: `viewer:${session}`,
	}),
	/** Set the open location if `session` is still current. */
	setLocation: (location: Location | null, session: number) => {
		const state = Store.get();
		if (state.open?.session !== session) return;
		Store.patch({ open: { ...state.open, location } });
	},
	/** Preview a copy of a staged-import location. The import row stays staged until Confirm. @unstable */
	openImport: async (index: number) => {
		const first = Import.staging()?.preview.firstId;
		if (first == null) return;
		const loc =
			(
				await Query.read(
					{ type: "Locations", locations: [first + index], name: null },
					{ kind: "locations" },
					Import.target(),
				)
			)[0] ?? null;
		if (!loc) return;
		await openPreview(loc, "import");
		emitEvent("import-markers:changed");
	},
	/** Open an arbitrary location read-only as a seen-preview: loads its pano without
	 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. @unstable */
	preview: (loc: Location) => {
		void openPreview(loc, "seen");
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
		const state = Store.get();
		const t = trace("open");
		const id = locId(target);
		const activation = ++lastSession;
		if (state.open && state.open.origin !== "map") emitEvent("import-markers:changed");
		const loc = await Editor.resolve(target);
		t.step("ipc");
		if (activation !== lastSession) return t.end({ superseded: true });
		if (checkDuplicates && loc) {
			const nearby = await Query.read(
				{ type: "Nearby", selection: null, lat: loc.lat, lng: loc.lng, radiusM: 2.0 },
				{ kind: "locations" },
			);
			if (activation !== lastSession) return t.end({ superseded: true });
			if (nearby.length >= 2) {
				Store.patch({ duplicateLocations: nearby, workArea: "duplicates" });
				dropOpen();
				t.end({ duplicates: nearby.length });
				return;
			}
		}
		Store.patch({
			open: { id, origin: "map", session: activation, location: loc },
			workArea: "location",
		});
		emitEvent("open:change", id);
		t.end();
	},
	/** Close the open location and return to the pane it was opened from. */
	close: () => {
		const state = Store.get();
		++lastSession;
		const preview = state.open && state.open.origin !== "map" ? state.open.origin : null;
		if (preview) emitEvent("import-markers:changed");
		dropOpen();
		const fallback = Store.get().activePluginId ? "plugin" : "overview";
		Store.patch(
			preview
				? { workArea: preview === "import" ? "import" : fallback }
				: { duplicateLocations: [], workArea: fallback },
		);
	},
	/** Open one location from the duplicate-resolution panel in the editor. @unstable */
	openDuplicate: (loc: Location) => {
		Store.patch({
			open: { id: loc.id, origin: "map", session: ++lastSession, location: loc },
			workArea: "location",
		});
	},
	/** Drop a location from the duplicate-resolution panel (does not delete it). @unstable */
	removeDuplicate: (id: number) => {
		const state = Store.get();
		Store.patch({ duplicateLocations: state.duplicateLocations.filter((l) => l.id !== id) });
	},
	/** Close the duplicate-resolution panel and return to the overview. @unstable */
	closeDuplicates: () => {
		Store.patch({ duplicateLocations: [] });
		Editor.setArea("overview");
	},
	/** Transition the editor pane, enforcing state invariants:
	 *  leaving "location" closes the open location, leaving "plugin" clears the plugin id. @unstable */
	setArea: (area: WorkArea) => {
		Store.patch({ workArea: area });
		if (area !== "location") dropOpen();
		if (area !== "plugin") Store.patch({ activePluginId: null });
	},
	/** Open a plugin's sidebar (switches the editor pane to "plugin"). */
	openPlugin: (pluginId: string) => {
		Store.patch({ activePluginId: pluginId });
		Editor.setArea("plugin");
	},
	/** Close the plugin sidebar and return to the overview. */
	closePlugin: () => {
		Editor.setArea("overview");
	},
};
