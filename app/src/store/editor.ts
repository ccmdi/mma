import { type Open, type OpenOrigin, Store } from "./store";
import { Query } from "./query";
import type { Location } from "@/bindings.gen";
import type { MaybeLocation, WorkArea } from "@/types";
import { locId } from "@/types";
import { cmd } from "@/lib/commands";
import { emit as emitEvent } from "@/lib/events";
import { trace } from "@/lib/util/debug";
import { getImportStaging, importTarget } from "./importStaging";

const VIEWER = { kind: "pending", name: "viewer" } as const;
let lastSession = 0;
const opening = (id: number, origin: OpenOrigin, location: Location | null = null): Open => ({
	id,
	origin,
	session: ++lastSession,
	location,
});

/** Set the open location if `session` is still current. */
function setLocation(location: Location | null, session: number) {
	const state = Store.get();
	if (state.open?.session !== session) return;
	Store.patch({ open: { ...state.open, location } });
}

/** Open a copy of `loc` in the viewer's layer. Closing discards draft edits. */
async function openPreview(loc: Location, origin: OpenOrigin) {
	await cmd.storeDrop(VIEWER.name);
	const r = await cmd.storeEdit(VIEWER, [{ set: { ...loc, id: 0 } }], null);
	const [added] = r.mutation.keys;
	if (added == null) return;
	const row =
		(
			await Query.read(
				{ type: "Locations", locations: [added], name: null },
				{ kind: "locations" },
				VIEWER,
			)
		)[0] ?? null;
	Store.patch({ open: opening(added, origin, row), workArea: "location" });
	emitEvent("open:change", null);
}

/** Preview a copy of a staged-import location. The import row stays staged until Confirm. @unstable */
async function openImport(index: number) {
	const first = getImportStaging()?.preview.firstId;
	if (first == null) return;
	const loc =
		(
			await Query.read(
				{ type: "Locations", locations: [first + index], name: null },
				{ kind: "locations" },
				importTarget(),
			)
		)[0] ?? null;
	if (!loc) return;
	await openPreview(loc, "import");
	emitEvent("import-markers:changed");
}

/** Open an arbitrary location read-only as a seen-preview: loads its pano without
 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. @unstable */
function preview(loc: Location) {
	void openPreview(loc, "seen");
}

/** Drop the open location, keeping `open:change` in step. */
function dropOpen(): void {
	const state = Store.get();
	if (state.open == null) return;
	Store.patch({ open: null });
	emitEvent("open:change", null);
}

/** Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found. */
async function resolve(m: MaybeLocation): Promise<Location | null> {
	return typeof m === "number"
		? ((
				await Query.read({ type: "Locations", locations: [m], name: null }, { kind: "locations" })
			)[0] ?? null)
		: m;
}

/** Open a location in the editor. With `checkDuplicates`, opening a spot with 2+ locations
 *  within 2m opens the duplicate-resolution panel instead. A later opening or closing
 *  supersedes one still loading. */
async function open(target: MaybeLocation, checkDuplicates = true) {
	const state = Store.get();
	const t = trace("open");
	const id = locId(target);
	const activation = ++lastSession;
	if (state.open && state.open.origin !== "map") emitEvent("import-markers:changed");
	const loc = await resolve(target);
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
	Store.patch({ open: opening(id, "map", loc), workArea: "location" });
	emitEvent("open:change", id);
	t.end();
}

/** Close the open location and return to the pane it was opened from. */
function close() {
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
}

/** Open one location from the duplicate-resolution panel in the editor. @unstable */
function openDuplicate(loc: Location) {
	Store.patch({ open: opening(loc.id, "map", loc), workArea: "location" });
}

/** Drop a location from the duplicate-resolution panel (does not delete it). @unstable */
function removeDuplicate(id: number) {
	const state = Store.get();
	Store.patch({ duplicateLocations: state.duplicateLocations.filter((l) => l.id !== id) });
}

/** Close the duplicate-resolution panel and return to the overview. @unstable */
function closeDuplicates() {
	Store.patch({ duplicateLocations: [] });
	setArea("overview");
}

/** Transition the editor pane, enforcing state invariants:
 *  leaving "location" closes the open location, leaving "plugin" clears the plugin id. @unstable */
function setArea(area: WorkArea) {
	Store.patch({ workArea: area });
	if (area !== "location") dropOpen();
	if (area !== "plugin") Store.patch({ activePluginId: null });
}

// --- Plugin mode ---

/** Open a plugin's sidebar (switches the editor pane to "plugin"). */
function openPlugin(pluginId: string) {
	Store.patch({ activePluginId: pluginId });
	setArea("plugin");
}

/** Close the plugin sidebar and return to the overview. */
function closePlugin() {
	setArea("overview");
}

export const Editor = {
	VIEWER,
	setLocation,
	openImport,
	preview,
	resolve,
	open,
	close,
	openDuplicate,
	removeDuplicate,
	closeDuplicates,
	setArea,
	openPlugin,
	closePlugin,
};
