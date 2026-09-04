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
	mdiLayersOutline,
	mdiLayersTripleOutline,
	mdiCompassOffOutline,
	mdiImageOutline,
	mdiImageOffOutline,
	mdiContentSaveAlertOutline,
	mdiEyeCheckOutline,
	mdiBookOpenOutline,
	mdiDownloadBoxOutline,
	mdiFileDocumentOutline,
} from "@mdi/js";
import { registerCommand, type CommandDef } from "./commands";
import { intersectSelections, invertSelections, unionSelections } from "./selections";
import {
	undo,
	redo,
	addSelections,
	applySelectionUpdate,
	resetSelections,
	getMapState,
	deleteTags,
	getActiveSelections,
	removeLocations,
	toggleGhostAllSelections,
} from "./useMapStore";
import { hasCommitDiff } from "./commitDiff";
import { MAP_EMBED_PREFS, MAP_TYPES } from "./mapEmbedPrefs";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { isReservedMap } from "./mapList";
import { loadGeoJSON } from "@/lib/util/loadGeoJSON";
import { downloadBlob } from "@/lib/util/util";
import { toggleSeenOverlay } from "@/lib/seen/seenOverlay";
import { selectReviewedHistory } from "@/lib/review/review";
import { openDialog } from "./dialogBus";
import { msg } from "@/lib/i18n";

const requiresMap = () => getMapState().map !== null;
const requiresVersioning = () => requiresMap() && !isReservedMap(getMapState().mapId);
const hasActiveLocation = () => getMapState().activeLocation != null;
const hasSelection = () => getMapState().selectedLocationIds.size > 0;
const hasAnySelections = () => getMapState().selections.length > 0;
const openBulkOp = (op: string) => () => openDialog("bulk-op", op);
const openInlinePanel = (id: string) => () => openDialog("inline-panel", id);

/** Step `n` places through the basemap order, wrapping at both ends. */
const stepBasemap = (n: number) => () => {
	const prefs = getLocal(MAP_EMBED_PREFS);
	const i = MAP_TYPES.indexOf(prefs.mapType);
	const len = MAP_TYPES.length;
	setLocal(MAP_EMBED_PREFS, { ...prefs, mapType: MAP_TYPES[(i + n + len) % len] });
};

/** Every editor command (palette entries; all are hotkey-bindable in Settings). */
const COMMANDS = {
	save: {
		label: msg("Commit map"),
		icon: mdiContentSave,
		group: msg("Map"),
		defaultBinding: "Mod+s",
		aliases: ["save", "snapshot"],
		execute: () => openDialog("commit"),
		enabled: () => requiresVersioning() && hasCommitDiff(),
	},
	basemapPrev: {
		label: msg("Previous basemap"),
		icon: mdiLayersTripleOutline,
		group: msg("Map"),
		defaultBinding: "j",
		execute: stepBasemap(-1),
		enabled: requiresMap,
	},
	basemapNext: {
		label: msg("Next basemap"),
		icon: mdiLayersOutline,
		group: msg("Map"),
		defaultBinding: "k",
		execute: stepBasemap(1),
		enabled: requiresMap,
	},
	import: {
		label: msg("Import file"),
		icon: mdiFileImportOutline,
		group: msg("Map"),
		execute: () => openDialog("import"),
		enabled: requiresMap,
	},
	copyToMap: {
		label: msg("Copy location to map via hotkeys..."),
		icon: mdiMapPlus,
		group: msg("Map"),
		execute: () => openDialog("copy-to-map"),
		enabled: requiresMap,
	},
	quickCopyToMap: {
		label: msg("Copy location to map..."),
		icon: mdiMapMarkerPlus,
		group: msg("Map"),
		execute: () => {
			const id = getMapState().activeLocation?.id;
			if (id != null) openDialog("quick-copy-to-map", id);
		},
		enabled: hasActiveLocation,
	},
	undo: {
		label: msg("Undo"),
		icon: mdiUndo,
		group: msg("Map"),
		defaultBinding: "Mod+z",
		execute: undo,
		enabled: () => getMapState().canUndo,
	},
	redo: {
		label: msg("Redo"),
		icon: mdiRedo,
		group: msg("Map"),
		defaultBinding: "Mod+y, Mod+Shift+z",
		execute: redo,
		enabled: () => getMapState().canRedo,
	},
	export: {
		label: msg("Export"),
		icon: mdiFileExportOutline,
		group: msg("Map"),
		execute: () => openDialog("export"),
		enabled: requiresMap,
	},
	"open-history": {
		label: msg("Open version history"),
		icon: mdiHistory,
		group: msg("Map"),
		execute: () => openDialog("history"),
		enabled: requiresVersioning,
	},
	"open-seen": {
		label: msg("Open seen locations"),
		icon: mdiEye,
		group: msg("Map"),
		execute: () => openDialog("seen"),
		enabled: requiresMap,
	},
	"toggle-seen-overlay": {
		label: msg("Toggle seen locations overlay"),
		icon: mdiEyeOutline,
		group: msg("Map"),
		execute: () => toggleSeenOverlay(),
		enabled: requiresMap,
	},
	selectAll: {
		label: msg("Select everything"),
		icon: mdiSelectAll,
		group: msg("Selections"),
		defaultBinding: "Mod+a",
		execute: () => addSelections([{ type: "Everything" }]),
	},
	"select-untagged": {
		label: msg("Select untagged locations"),
		icon: mdiTagOffOutline,
		group: msg("Selections"),
		aliases: ["find untagged", "missing tags"],
		execute: () => addSelections([{ type: "Untagged" }]),
	},
	"select-unpanned": {
		label: msg("Select unpanned locations"),
		icon: mdiCompassOffOutline,
		group: msg("Selections"),
		execute: () => addSelections([{ type: "Unpanned" }]),
	},
	"select-panoid": {
		label: msg("Select Pano ID locations"),
		icon: mdiImageOutline,
		group: msg("Selections"),
		execute: () => addSelections([{ type: "PanoIds" }]),
	},
	"select-no-panoid": {
		label: msg("Select non-Pano ID locations"),
		icon: mdiImageOffOutline,
		group: msg("Selections"),
		execute: () => addSelections([{ type: "NotPanoIds" }]),
	},
	"select-uncommitted": {
		label: msg("Select uncommitted locations"),
		icon: mdiContentSaveAlertOutline,
		group: msg("Selections"),
		execute: () => addSelections([{ type: "Uncommitted" }]),
	},
	"select-reviewed": {
		label: msg("Select reviewed locations"),
		icon: mdiEyeCheckOutline,
		group: msg("Selections"),
		execute: () => selectReviewedHistory(),
		enabled: requiresMap,
	},
	"invert-selection": {
		label: msg("Invert selection"),
		icon: mdiSelectInverse,
		group: msg("Selections"),
		execute: () => applySelectionUpdate(invertSelections),
	},
	"intersect-selections": {
		label: msg("Intersect (AND) selections"),
		icon: mdiSetCenter,
		group: msg("Selections"),
		execute: () => applySelectionUpdate(intersectSelections),
	},
	"union-selections": {
		label: msg("Union (OR) selections"),
		icon: mdiSetAll,
		group: msg("Selections"),
		execute: () => applySelectionUpdate(unionSelections),
	},
	"load-geojson": {
		label: msg("Load shapes from GeoJSON as selection"),
		icon: mdiCodeJson,
		group: msg("Selections"),
		aliases: ["import polygon", "load polygon"],
		execute: loadGeoJSON,
	},
	"download-polygon-geojson": {
		label: msg("Download polygon selections as GeoJSON"),
		icon: mdiVectorPolygon,
		group: msg("Selections"),
		enabled: () => getActiveSelections().some((s) => s.selector.type === "Polygon"),
		execute: () => {
			const features: unknown[] = [];
			for (const sel of getActiveSelections()) {
				if (sel.selector.type !== "Polygon") continue;
				features.push({
					type: "Feature",
					properties: sel.selector.polygon.properties ?? {},
					geometry: { type: "Polygon", coordinates: sel.selector.polygon.coordinates },
				});
			}
			const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })], {
				type: "application/geo+json",
			});
			downloadBlob(blob, "selections.geojson");
		},
	},
	deselectAll: {
		label: msg("Deselect everything"),
		icon: mdiSelectRemove,
		group: msg("Selections"),
		defaultBinding: "Mod+d",
		execute: resetSelections,
		enabled: hasAnySelections,
	},
	"find-duplicates": {
		label: msg("Find duplicates..."),
		icon: mdiMapSearchOutline,
		group: msg("Selections"),
		aliases: ["dedupe", "duplicate check"],
		execute: openInlinePanel("find-duplicates"),
	},
	"merge-duplicates": {
		label: msg("Merge duplicates..."),
		icon: mdiCallMerge,
		group: msg("Selections"),
		aliases: ["dedupe", "combine duplicates"],
		execute: () => openDialog("merge-duplicates"),
	},
	"filter-by-metadata": {
		label: msg("Filter by metadata..."),
		icon: mdiFilterOutline,
		group: msg("Selections"),
		aliases: ["search by field", "field filter"],
		execute: openInlinePanel("filter-by-metadata"),
	},
	"top-k": {
		label: msg("Select top/bottom K..."),
		icon: mdiPodium,
		group: msg("Selections"),
		execute: openInlinePanel("top-k"),
	},
	"review-selected": {
		label: msg("Review selected locations"),
		icon: mdiPlayOutline,
		group: msg("Selections"),
		enabled: hasSelection,
		execute: () => openDialog("review-selected"),
	},
	"review-sessions": {
		label: msg("Review sessions"),
		icon: mdiBookOpenOutline,
		group: msg("Selections"),
		execute: () => openDialog("review-sessions"),
	},
	"select-random": {
		label: msg("Pick random locations from selection"),
		icon: mdiDiceMultiple,
		group: msg("Selections"),
		aliases: ["sample", "random sample"],
		execute: openInlinePanel("select-random"),
		enabled: hasSelection,
	},
	"select-spaced": {
		label: msg("Thin selection by minimum distance"),
		icon: mdiDotsGrid,
		group: msg("Selections"),
		aliases: ["spaced", "thin", "reduce density", "distribute", "evenly spaced"],
		execute: openInlinePanel("select-spaced"),
		enabled: hasSelection,
	},
	"ghost-selections": {
		label: msg("Ghost selections"),
		icon: mdiGhostOutline,
		group: msg("Selections"),
		aliases: ["hide selections", "dim selections"],
		execute: () => toggleGhostAllSelections(),
		enabled: hasAnySelections,
	},
	"save-selections": {
		label: msg("Save current selections..."),
		icon: mdiBookmarkOutline,
		group: msg("Selections"),
		execute: () => openDialog("save-selections"),
		enabled: hasAnySelections,
	},
	"apply-saved-selection": {
		label: msg("Apply saved selection..."),
		icon: mdiBookmarkCheckOutline,
		group: msg("Selections"),
		execute: () => openDialog("apply-saved-selection"),
	},
	"selection-delete-locations": {
		label: msg("Delete selected locations"),
		icon: mdiTrashCanOutline,
		group: msg("Selections"),
		enabled: hasSelection,
		execute: async () => {
			const ids = getMapState().selectedLocationIds;
			if (ids.size > 0) await removeLocations(ids);
		},
	},
	"bulk-validate": {
		label: msg("Validate locations"),
		icon: mdiCheckDecagram,
		group: msg("Bulk Operations"),
		aliases: ["check locations", "verify"],
		execute: openBulkOp("validate"),
	},
	"bulk-enrich": {
		label: msg("Enrich metadata fields"),
		icon: mdiDatabaseArrowUp,
		group: msg("Bulk Operations"),
		aliases: ["autotag", "fetch metadata", "auto-enrich"],
		execute: openBulkOp("enrich"),
	},
	"bulk-set-field": {
		label: msg("Set metadata field value"),
		icon: mdiDatabaseEditOutline,
		group: msg("Bulk Operations"),
		aliases: ["edit field", "assign field"],
		execute: openBulkOp("setField"),
	},
	"bulk-clear-fields": {
		label: msg("Clear metadata fields"),
		icon: mdiDatabaseRemoveOutline,
		group: msg("Bulk Operations"),
		aliases: ["remove fields", "strip metadata"],
		execute: openBulkOp("clearFields"),
	},
	"bulk-pin-pano": {
		label: msg("Pin locations to pano ID"),
		icon: mdiMapMarkerCheck,
		group: msg("Bulk Operations"),
		aliases: ["snap to pano", "lock pano"],
		execute: openBulkOp("pinPano"),
	},
	"bulk-heading-road": {
		label: msg("Pan headings along road"),
		icon: mdiCompassOutline,
		group: msg("Bulk Operations"),
		aliases: ["align headings", "road direction"],
		execute: openBulkOp("headingRoad"),
	},
	"bulk-download-panoramas": {
		label: msg("Download panoramas"),
		icon: mdiDownloadBoxOutline,
		group: msg("Bulk Operations"),
		aliases: ["bulk download", "export panoramas", "download street view"],
		execute: openBulkOp("downloadPanoramas"),
	},
	"delete-selected-tags": {
		label: msg("Delete selected tags"),
		icon: mdiTagRemove,
		group: msg("Tags"),
		execute: async () => {
			await deleteTags(
				getActiveSelections()
					.filter((s) => s.selector.type === "Tag")
					.map((s) => (s.selector as { type: "Tag"; tagId: number }).tagId),
			);
		},
		enabled: () => getActiveSelections().some((s) => s.selector.type === "Tag"),
	},
	"tag-download-csv": {
		label: msg("Download tag counts as CSV"),
		icon: mdiFileDelimitedOutline,
		group: msg("Tags"),
		execute: () => {
			const map = getMapState().map;
			if (!map) return;
			const counts = getMapState().tagCounts;
			const rows = Object.entries(counts)
				.map(([id, count]) => ({ name: getMapState().tags[Number(id)]?.name ?? id, count }))
				.sort((a, b) => b.count - a.count);
			const csv =
				"name,count\n" + rows.map((r) => `"${r.name.replace(/"/g, '""')}",${r.count}`).join("\n");
			downloadBlob(new Blob([csv], { type: "text/csv" }), `${map.name} tags.csv`);
		},
	},
	"tag-find-replace": {
		label: msg("Find and replace in tag names"),
		icon: mdiFindReplace,
		group: msg("Tags"),
		aliases: ["rename tags", "bulk rename"],
		execute: () => openDialog("tag-find-replace"),
		enabled: requiresMap,
	},
	"apply-field-as-tags": {
		label: msg("Apply metadata as tags"),
		icon: mdiTagMultipleOutline,
		group: msg("Tags"),
		aliases: ["group by field", "metadata to tags"],
		execute: () => openDialog("apply-field-as-tags"),
		enabled: requiresMap,
	},
	"assign-doclinks": {
		label: msg("Assign document links..."),
		icon: mdiFileDocumentOutline,
		group: msg("Tags"),
		aliases: ["doclinks", "link document"],
		execute: () => openDialog("doclink-assign"),
		enabled: requiresMap,
	},
} satisfies Record<string, CommandDef>;

export type CommandId = keyof typeof COMMANDS;
export type PinnedEntry = CommandId | "---" | (string & {});

for (const [id, def] of Object.entries(COMMANDS)) {
	registerCommand({ id, ...def });
}
