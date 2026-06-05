import {
	mdiUndo,
	mdiRedo,
	mdiFileImportOutline,
	mdiFileExportOutline,
	mdiContentSave,
	mdiSelectRemove,
	mdiSetCenter,
	mdiSetAll,
	mdiSelectInverse,
	mdiCodeJson,
	mdiFileDelimitedOutline,
	mdiCheckDecagram,
	mdiDatabaseArrowUp,
	mdiMapMarkerCheck,
	mdiHistory,
	mdiEye,
	mdiTagRemove,
	mdiTagMultipleOutline,
	mdiTrashCanOutline,
	mdiDatabaseRemoveOutline,
	mdiDatabaseEditOutline,
	mdiFindReplace,
	mdiGhostOutline,
	mdiCompassOutline,
	mdiDiceMultiple,
} from "@mdi/js";
import { registerCommand } from "./commands.add";
import {
	undo,
	redo,
	selectEverything,
	selectUntagged,
	selectUnpanned,
	selectPanoIds,
	selectNotPanoIds,
	selectInverse,
	selectIntersection,
	selectUnion,
	resetSelections,
	commitMap,
	getCurrentMap,
	getUndoRedoState,
	deleteTags,
	getSelections,
	getSelectedLocationIds,
	removeLocations,
	getTagCounts,
	hasCommitDiff,
	toggleGhostAllSelections,
} from "./useMapStore";
import { loadGeoJSON } from "@/lib/util/loadGeoJSON.add";

registerCommand({
	id: "save",
	label: "Commit map",
	icon: mdiContentSave,
	group: "Map",
	defaultBinding: "Mod+s",
	execute: () => commitMap(),
	enabled: () => getCurrentMap() !== null && hasCommitDiff(),
});

registerCommand({
	id: "import",
	label: "Import file",
	icon: mdiFileImportOutline,
	group: "Map",
	execute: () => document.dispatchEvent(new CustomEvent("open-import")),
	enabled: () => getCurrentMap() !== null,
});

registerCommand({
	id: "undo",
	label: "Undo",
	icon: mdiUndo,
	group: "Map",
	defaultBinding: "Mod+z",
	execute: undo,
	enabled: () => getUndoRedoState().canUndo,
});

registerCommand({
	id: "redo",
	label: "Redo",
	icon: mdiRedo,
	group: "Map",
	defaultBinding: "Mod+y, Mod+Shift+z",
	execute: redo,
	enabled: () => getUndoRedoState().canRedo,
});

registerCommand({
	id: "selectAll",
	label: "Select everything",
	group: "Selections",
	defaultBinding: "Mod+a",
	execute: selectEverything,
});

registerCommand({
	id: "select-untagged",
	label: "Select untagged locations",
	group: "Selections",
	execute: selectUntagged,
});

registerCommand({
	id: "select-unpanned",
	label: "Select unpanned locations",
	group: "Selections",
	execute: selectUnpanned,
});

registerCommand({
	id: "select-panoid",
	label: "Select Pano ID locations",
	group: "Selections",
	execute: selectPanoIds,
});

registerCommand({
	id: "select-no-panoid",
	label: "Select non-Pano ID locations",
	group: "Selections",
	execute: selectNotPanoIds,
});

registerCommand({
	id: "invert-selection",
	label: "Invert selection",
	icon: mdiSelectInverse,
	group: "Selections",
	execute: () => selectInverse(),
});

registerCommand({
	id: "intersect-selections",
	label: "Intersect (AND) selections",
	icon: mdiSetCenter,
	group: "Selections",
	execute: () => selectIntersection(),
});

registerCommand({
	id: "union-selections",
	label: "Union (OR) selections",
	icon: mdiSetAll,
	group: "Selections",
	execute: () => selectUnion(),
});

registerCommand({
	id: "load-geojson",
	label: "Load shapes from GeoJSON as selection",
	icon: mdiCodeJson,
	group: "Selections",
	execute: loadGeoJSON,
});

registerCommand({
	id: "deselectAll",
	label: "Deselect everything",
	icon: mdiSelectRemove,
	group: "Selections",
	defaultBinding: "Mod+d",
	execute: resetSelections,
});

registerCommand({
	id: "select-random",
	label: "Pick random locations from selection",
	icon: mdiDiceMultiple,
	group: "Selections",
	execute: () => document.dispatchEvent(new CustomEvent("open-random-pick")),
	enabled: () => getSelectedLocationIds().size > 0,
});

registerCommand({
	id: "ghost-selections",
	label: "Ghost selections",
	icon: mdiGhostOutline,
	group: "Selections",
	execute: () => toggleGhostAllSelections(),
	enabled: () => getSelections().length > 0,
});

registerCommand({
	id: "selection-delete-locations",
	label: "Delete selected locations",
	icon: mdiTrashCanOutline,
	group: "Selections",
	enabled: () => getSelectedLocationIds().size > 0,
	execute: () => {
		const ids = getSelectedLocationIds();
		if (ids.size > 0) removeLocations(ids);
	},
});

registerCommand({
	id: "bulk-validate",
	label: "Validate locations",
	icon: mdiCheckDecagram,
	group: "Bulk Operations",
	execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "validate" })),
});

registerCommand({
	id: "bulk-enrich",
	label: "Enrich metadata fields",
	icon: mdiDatabaseArrowUp,
	group: "Bulk Operations",
	execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "enrich" })),
});

registerCommand({
	id: "bulk-set-field",
	label: "Set metadata field value",
	icon: mdiDatabaseEditOutline,
	group: "Bulk Operations",
	execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "setField" })),
});

registerCommand({
	id: "bulk-clear-fields",
	label: "Clear metadata fields",
	icon: mdiDatabaseRemoveOutline,
	group: "Bulk Operations",
	execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "clearFields" })),
});

registerCommand({
	id: "bulk-pin-pano",
	label: "Pin locations to pano ID",
	icon: mdiMapMarkerCheck,
	group: "Bulk Operations",
	execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "pinPano" })),
});

registerCommand({
	id: "bulk-heading-road",
	label: "Pan headings along road",
	icon: mdiCompassOutline,
	group: "Bulk Operations",
	execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "headingRoad" })),
});

registerCommand({
	id: "delete-selected-tags",
	label: "Delete selected tags",
	icon: mdiTagRemove,
	group: "Tags",
	execute: async () => {
		await deleteTags(getSelections().filter((s) => s.props.type === "Tag").map((s) => (s.props as { type: "Tag"; tagId: number }).tagId));
	},
	enabled: () => getSelections().some((s) => s.props.type === "Tag"),
});

registerCommand({
	id: "tag-download-csv",
	label: "Download tag counts as CSV",
	icon: mdiFileDelimitedOutline,
	group: "Tags",
	execute: () => {
		const map = getCurrentMap();
		if (!map) return;
		const counts = getTagCounts();
		const rows = Object.entries(counts)
			.map(([id, count]) => ({ name: map.meta.tags[id]?.name ?? id, count }))
			.sort((a, b) => b.count - a.count);
		const csv = "name,count\n" + rows.map((r) => `"${r.name.replace(/"/g, '""')}",${r.count}`).join("\n");
		const blob = new Blob([csv], { type: "text/csv" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${map.meta.name} tags.csv`;
		a.click();
		URL.revokeObjectURL(url);
	},
});

registerCommand({
	id: "tag-find-replace",
	label: "Find and replace in tag names",
	icon: mdiFindReplace,
	group: "Tags",
	execute: () => document.dispatchEvent(new CustomEvent("open-tag-find-replace")),
	enabled: () => getCurrentMap() !== null,
});

registerCommand({
	id: "apply-field-as-tags",
	label: "Apply metadata as tags",
	icon: mdiTagMultipleOutline,
	group: "Tags",
	execute: () => document.dispatchEvent(new CustomEvent("open-apply-field-as-tags")),
	enabled: () => getCurrentMap() !== null,
});

registerCommand({
	id: "export",
	label: "Export",
	icon: mdiFileExportOutline,
	group: "Map",
	execute: () => document.dispatchEvent(new CustomEvent("open-export")),
	enabled: () => getCurrentMap() !== null,
});

registerCommand({
	id: "open-history",
	label: "Open version history",
	icon: mdiHistory,
	group: "Map",
	execute: () => document.dispatchEvent(new CustomEvent("open-history")),
	enabled: () => getCurrentMap() !== null,
});

registerCommand({
	id: "open-seen",
	label: "Open seen locations",
	icon: mdiEye,
	group: "Map",
	execute: () => document.dispatchEvent(new CustomEvent("open-seen")),
	enabled: () => getCurrentMap() !== null,
});
