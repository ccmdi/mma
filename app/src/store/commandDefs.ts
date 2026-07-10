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
	mdiEyeOutline,
	mdiTagRemove,
	mdiTagMultipleOutline,
	mdiTrashCanOutline,
	mdiDatabaseRemoveOutline,
	mdiDatabaseEditOutline,
	mdiFindReplace,
	mdiGhostOutline,
	mdiCompassOutline,
	mdiDiceMultiple,
	mdiDotsGrid,
	mdiMapPlus,
	mdiMapMarkerPlus,
	mdiVectorPolygon,
	mdiMapSearchOutline,
	mdiFilterOutline,
	mdiPodium,
	mdiCallMerge,
	mdiPlayOutline,
	mdiBookmarkOutline,
	mdiBookmarkCheckOutline,
	mdiSelectAll,
	mdiTagOffOutline,
	mdiCompassOffOutline,
	mdiImageOutline,
	mdiImageOffOutline,
	mdiContentSaveAlertOutline,
	mdiEyeCheckOutline,
	mdiBookOpenOutline,
	mdiDownloadBoxOutline,
} from "@mdi/js";
import { registerCommand, type CommandDef } from "./commands";
import {
	undo,
	redo,
	selectEverything,
	selectUntagged,
	selectUnpanned,
	selectPanoIds,
	selectNotPanoIds,
	selectUncommitted,
	selectInverse,
	selectIntersection,
	selectUnion,
	resetSelections,
	commitMap,
	getCurrentMap,
	getUndoRedoState,
	deleteTags,
	getSelections,
	getAllSelections,
	getSelectedLocationIds,
	removeLocations,
	getTagCounts,
	hasCommitDiff,
	toggleGhostAllSelections,
} from "./useMapStore";
import { loadGeoJSON } from "@/lib/util/loadGeoJSON";
import { toggleSeenOverlay } from "@/lib/seen/seenOverlay";
import { selectReviewedHistory } from "@/lib/review/review";

const COMMANDS = {
	save: {
		label: "Commit map",
		icon: mdiContentSave,
		group: "Map",
		defaultBinding: "Mod+s",
		aliases: ["save", "snapshot"],
		execute: () => commitMap(),
		enabled: () => getCurrentMap() !== null && hasCommitDiff(),
	},
	import: {
		label: "Import file",
		icon: mdiFileImportOutline,
		group: "Map",
		execute: () => document.dispatchEvent(new CustomEvent("open-import")),
		enabled: () => getCurrentMap() !== null,
	},
	copyToMap: {
		label: "Copy location to map via hotkeys...",
		icon: mdiMapPlus,
		group: "Map",
		execute: () => document.dispatchEvent(new CustomEvent("open-copy-to-map")),
		enabled: () => getCurrentMap() !== null,
	},
	quickCopyToMap: {
		label: "Copy location to map...",
		icon: mdiMapMarkerPlus,
		group: "Map",
		execute: () => document.dispatchEvent(new CustomEvent("open-quick-copy-to-map")),
		enabled: () => getCurrentMap() !== null,
	},
	undo: {
		label: "Undo",
		icon: mdiUndo,
		group: "Map",
		defaultBinding: "Mod+z",
		execute: undo,
		enabled: () => getUndoRedoState().canUndo,
	},
	redo: {
		label: "Redo",
		icon: mdiRedo,
		group: "Map",
		defaultBinding: "Mod+y, Mod+Shift+z",
		execute: redo,
		enabled: () => getUndoRedoState().canRedo,
	},
	export: {
		label: "Export",
		icon: mdiFileExportOutline,
		group: "Map",
		execute: () => document.dispatchEvent(new CustomEvent("open-export")),
		enabled: () => getCurrentMap() !== null,
	},
	"open-history": {
		label: "Open version history",
		icon: mdiHistory,
		group: "Map",
		execute: () => document.dispatchEvent(new CustomEvent("open-history")),
		enabled: () => getCurrentMap() !== null,
	},
	"open-seen": {
		label: "Open seen locations",
		icon: mdiEye,
		group: "Map",
		execute: () => document.dispatchEvent(new CustomEvent("open-seen")),
		enabled: () => getCurrentMap() !== null,
	},
	"toggle-seen-overlay": {
		label: "Toggle seen locations overlay",
		icon: mdiEyeOutline,
		group: "Map",
		execute: () => toggleSeenOverlay(),
		enabled: () => getCurrentMap() !== null,
	},
	selectAll: {
		label: "Select everything",
		icon: mdiSelectAll,
		group: "Selections",
		defaultBinding: "Mod+a",
		execute: selectEverything,
	},
	"select-untagged": {
		label: "Select untagged locations",
		icon: mdiTagOffOutline,
		group: "Selections",
		aliases: ["find untagged", "missing tags"],
		execute: selectUntagged,
	},
	"select-unpanned": {
		label: "Select unpanned locations",
		icon: mdiCompassOffOutline,
		group: "Selections",
		execute: selectUnpanned,
	},
	"select-panoid": {
		label: "Select Pano ID locations",
		icon: mdiImageOutline,
		group: "Selections",
		execute: selectPanoIds,
	},
	"select-no-panoid": {
		label: "Select non-Pano ID locations",
		icon: mdiImageOffOutline,
		group: "Selections",
		execute: selectNotPanoIds,
	},
	"select-uncommitted": {
		label: "Select uncommitted locations",
		icon: mdiContentSaveAlertOutline,
		group: "Selections",
		execute: selectUncommitted,
	},
	"select-reviewed": {
		label: "Select reviewed locations",
		icon: mdiEyeCheckOutline,
		group: "Selections",
		execute: () => selectReviewedHistory(),
		enabled: () => getCurrentMap() !== null,
	},
	"invert-selection": {
		label: "Invert selection",
		icon: mdiSelectInverse,
		group: "Selections",
		execute: () => selectInverse(),
	},
	"intersect-selections": {
		label: "Intersect (AND) selections",
		icon: mdiSetCenter,
		group: "Selections",
		execute: () => selectIntersection(),
	},
	"union-selections": {
		label: "Union (OR) selections",
		icon: mdiSetAll,
		group: "Selections",
		execute: () => selectUnion(),
	},
	"load-geojson": {
		label: "Load shapes from GeoJSON as selection",
		icon: mdiCodeJson,
		group: "Selections",
		aliases: ["import polygon", "load polygon"],
		execute: loadGeoJSON,
	},
	"download-polygon-geojson": {
		label: "Download polygon selections as GeoJSON",
		icon: mdiVectorPolygon,
		group: "Selections",
		enabled: () => getSelections().some((s) => s.props.type === "Polygon"),
		execute: () => {
			const features: unknown[] = [];
			for (const sel of getSelections()) {
				if (sel.props.type !== "Polygon") continue;
				features.push({
					type: "Feature",
					properties: sel.props.polygon.properties ?? {},
					geometry: { type: "Polygon", coordinates: sel.props.polygon.coordinates },
				});
			}
			const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })], {
				type: "application/geo+json",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = "selections.geojson";
			a.click();
			URL.revokeObjectURL(url);
		},
	},
	deselectAll: {
		label: "Deselect everything",
		icon: mdiSelectRemove,
		group: "Selections",
		defaultBinding: "Mod+d",
		execute: resetSelections,
		enabled: () => getAllSelections().length > 0,
	},
	"find-duplicates": {
		label: "Find duplicates...",
		icon: mdiMapSearchOutline,
		group: "Selections",
		aliases: ["dedupe", "duplicate check"],
		execute: () =>
			document.dispatchEvent(new CustomEvent("open-inline-panel", { detail: "find-duplicates" })),
	},
	"merge-duplicates": {
		label: "Merge duplicates...",
		icon: mdiCallMerge,
		group: "Selections",
		aliases: ["dedupe", "combine duplicates"],
		execute: () => document.dispatchEvent(new CustomEvent("open-merge-duplicates")),
	},
	"filter-by-metadata": {
		label: "Filter by metadata...",
		icon: mdiFilterOutline,
		group: "Selections",
		aliases: ["search by field", "field filter"],
		execute: () =>
			document.dispatchEvent(
				new CustomEvent("open-inline-panel", { detail: "filter-by-metadata" }),
			),
	},
	"top-k": {
		label: "Select top/bottom K...",
		icon: mdiPodium,
		group: "Selections",
		execute: () =>
			document.dispatchEvent(new CustomEvent("open-inline-panel", { detail: "top-k" })),
	},
	"review-selected": {
		label: "Review selected locations",
		icon: mdiPlayOutline,
		group: "Selections",
		enabled: () => getSelectedLocationIds().size > 0,
		execute: () => document.dispatchEvent(new CustomEvent("open-review-selected")),
	},
	"review-sessions": {
		label: "Review sessions",
		icon: mdiBookOpenOutline,
		group: "Selections",
		execute: () => document.dispatchEvent(new CustomEvent("open-review-sessions")),
	},
	"select-random": {
		label: "Pick random locations from selection",
		icon: mdiDiceMultiple,
		group: "Selections",
		aliases: ["sample", "random sample"],
		execute: () =>
			document.dispatchEvent(new CustomEvent("open-inline-panel", { detail: "select-random" })),
		enabled: () => getSelectedLocationIds().size > 0,
	},
	"select-spaced": {
		label: "Pick evenly spaced locations from selection",
		icon: mdiDotsGrid,
		group: "Selections",
		aliases: ["spaced", "thin", "reduce density", "distribute"],
		execute: () =>
			document.dispatchEvent(new CustomEvent("open-inline-panel", { detail: "select-spaced" })),
		enabled: () => getSelectedLocationIds().size > 0,
	},
	"ghost-selections": {
		label: "Ghost selections",
		icon: mdiGhostOutline,
		group: "Selections",
		aliases: ["hide selections", "dim selections"],
		execute: () => toggleGhostAllSelections(),
		enabled: () => getAllSelections().length > 0,
	},
	"save-selections": {
		label: "Save current selections...",
		icon: mdiBookmarkOutline,
		group: "Selections",
		execute: () => document.dispatchEvent(new CustomEvent("open-save-selections")),
		enabled: () => getAllSelections().length > 0,
	},
	"apply-saved-selection": {
		label: "Apply saved selection...",
		icon: mdiBookmarkCheckOutline,
		group: "Selections",
		execute: () => document.dispatchEvent(new CustomEvent("open-apply-saved-selection")),
	},
	"selection-delete-locations": {
		label: "Delete selected locations",
		icon: mdiTrashCanOutline,
		group: "Selections",
		enabled: () => getSelectedLocationIds().size > 0,
		execute: () => {
			const ids = getSelectedLocationIds();
			if (ids.size > 0) removeLocations(ids);
		},
	},
	"bulk-validate": {
		label: "Validate locations",
		icon: mdiCheckDecagram,
		group: "Bulk Operations",
		aliases: ["check locations", "verify"],
		execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "validate" })),
	},
	"bulk-enrich": {
		label: "Enrich metadata fields",
		icon: mdiDatabaseArrowUp,
		group: "Bulk Operations",
		aliases: ["autotag", "fetch metadata", "auto-enrich"],
		execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "enrich" })),
	},
	"bulk-set-field": {
		label: "Set metadata field value",
		icon: mdiDatabaseEditOutline,
		group: "Bulk Operations",
		aliases: ["edit field", "assign field"],
		execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "setField" })),
	},
	"bulk-clear-fields": {
		label: "Clear metadata fields",
		icon: mdiDatabaseRemoveOutline,
		group: "Bulk Operations",
		aliases: ["remove fields", "strip metadata"],
		execute: () =>
			document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "clearFields" })),
	},
	"bulk-pin-pano": {
		label: "Pin locations to pano ID",
		icon: mdiMapMarkerCheck,
		group: "Bulk Operations",
		aliases: ["snap to pano", "lock pano"],
		execute: () => document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "pinPano" })),
	},
	"bulk-heading-road": {
		label: "Pan headings along road",
		icon: mdiCompassOutline,
		group: "Bulk Operations",
		aliases: ["align headings", "road direction"],
		execute: () =>
			document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "headingRoad" })),
	},
	"bulk-download-panoramas": {
		label: "Download panoramas",
		icon: mdiDownloadBoxOutline,
		group: "Bulk Operations",
		aliases: ["bulk download", "export panoramas", "download street view"],
		execute: () =>
			document.dispatchEvent(new CustomEvent("open-bulk-op", { detail: "downloadPanoramas" })),
	},
	"delete-selected-tags": {
		label: "Delete selected tags",
		icon: mdiTagRemove,
		group: "Tags",
		execute: async () => {
			await deleteTags(
				getSelections()
					.filter((s) => s.props.type === "Tag")
					.map((s) => (s.props as { type: "Tag"; tagId: number }).tagId),
			);
		},
		enabled: () => getSelections().some((s) => s.props.type === "Tag"),
	},
	"tag-download-csv": {
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
			const csv =
				"name,count\n" + rows.map((r) => `"${r.name.replace(/"/g, '""')}",${r.count}`).join("\n");
			const blob = new Blob([csv], { type: "text/csv" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${map.meta.name} tags.csv`;
			a.click();
			URL.revokeObjectURL(url);
		},
	},
	"tag-find-replace": {
		label: "Find and replace in tag names",
		icon: mdiFindReplace,
		group: "Tags",
		aliases: ["rename tags", "bulk rename"],
		execute: () => document.dispatchEvent(new CustomEvent("open-tag-find-replace")),
		enabled: () => getCurrentMap() !== null,
	},
	"apply-field-as-tags": {
		label: "Apply metadata as tags",
		icon: mdiTagMultipleOutline,
		group: "Tags",
		aliases: ["group by field", "metadata to tags"],
		execute: () => document.dispatchEvent(new CustomEvent("open-apply-field-as-tags")),
		enabled: () => getCurrentMap() !== null,
	},
} satisfies Record<string, CommandDef>;

export type CommandId = keyof typeof COMMANDS;
export type PinnedEntry = CommandId | "---" | (string & {});

for (const [id, def] of Object.entries(COMMANDS)) {
	registerCommand({ id, ...def });
}
