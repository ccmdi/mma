/// <reference types="google.maps" />
/// <reference path="./google-maps.d.ts" />

import { ComponentType, SetStateAction, ReactNode } from 'react';
import * as react_jsx_runtime from 'react/jsx-runtime';
import { invoke } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Layer, PickingInfo } from '@deck.gl/core';
import maplibregl from 'maplibre-gl';

export interface PluginSettingDef {
    key: string;
    label: string;
    type: "boolean" | "string" | "number";
    default: unknown;
}
export interface Plugin {
    id: string;
    name: string;
    description?: string;
    icon: string;
    comingSoon?: boolean;
    core?: boolean;
    settings?: PluginSettingDef[];
    /** Keep the sidebar mounted (hidden) when the user leaves plugin mode.
     *  Only for plugins whose state can't be serialized (e.g. an iframe). */
    keepAlive?: boolean;
    activate(): void | (() => void);
    modal?: ComponentType<{
        onClose: () => void;
    }>;
    sidebar?: ComponentType<{
        onClose: () => void;
    }>;
    locationPanel?: ComponentType;
}
export type PluginBehavior = Partial<Plugin> & {
    activate(): void | (() => void);
};
/** Register a plugin. `activate` runs when a map opens; its returned cleanup runs on map close. */
declare function registerPlugin(plugin: Plugin | PluginBehavior): void;
export interface PluginStorage {
    get<T = unknown>(key: string, fallback?: T): T;
    set(key: string, value: unknown): void;
    remove(key: string): void;
    keys(): string[];
}
/** Persistent key-value storage namespaced to a plugin. Survives restarts. */
declare function createPluginStorage(id: string): PluginStorage;
/** useState persisted through the plugin's namespaced store. UI state saved this
 *  way survives sidebar unmount and app restart. Values are global, not per-map —
 *  callers must fall back gracefully when a stored value doesn't resolve against
 *  the current map (e.g. a field key or saved-selection id). */
declare function usePluginState<T>(pluginId: string, key: string, initial: T | (() => T)): readonly [T, (action: SetStateAction<T>) => void];

/** Commands */
declare const commands: {
    /**
     *  Write arbitrary text content to a named temp file (`mma_{name}`). Returns the path.
     *  Used by JS to pass large payloads via file instead of IPC serialization.
     */
    writeTempFile: (name: string, content: string) => Promise<string>;
    /**  Read a file from disk as UTF-8 text. Used by JS to read temp files and plugin sources. */
    readFile: (path: string) => Promise<string>;
    appReady: () => Promise<number>;
    /**  Return the platform-specific app data directory path (e.g., `%LOCALAPPDATA%/app.map-making.local`). */
    getAppDataDir: () => Promise<string>;
    /**  Report where map data is currently stored. */
    getDataLocation: () => Promise<DataLocation>;
    /**
     *  Set (`Some`) or clear (`None`) the data-folder override. Takes effect after relaunch.
     *  Does not move existing data -- the caller warns the user.
     */
    setDataLocation: (path: string | null) => Promise<null>;
    /**  Open the app data directory in the OS file explorer. */
    openDataFolder: () => Promise<null>;
    /**  Open the current log file in the OS default handler. */
    openLogFile: () => Promise<null>;
    /**  Scan the `plugins/` directory under app data and return manifests for all installed plugins. */
    listUserPlugins: () => Promise<PluginManifest[]>;
    /**
     *  Download a plugin from the GitHub plugin repository and install it to the local plugins directory.
     *  Fetches `manifest.json` and the main JS file specified in the manifest.
     */
    installPlugin: (id: string) => Promise<PluginManifest>;
    /**  Remove a plugin by deleting its directory from the local plugins folder. */
    uninstallPlugin: (id: string) => Promise<null>;
    /**
     *  Download a plugin's sidecar bundle from GitHub Releases and extract it under
     *  `{appData}/plugins/{plugin_id}/sidecar/`. Emits `sidecar-install-progress`.
     */
    sidecarInstall: (pluginId: string, name: string, version: string) => Promise<null>;
    /**  Installed sidecar version for a plugin (from `sidecar/version.txt`), or `None`. */
    sidecarInstalledVersion: (pluginId: string) => Promise<string | null>;
    /**
     *  Spawn a plugin's installed sidecar binary. Streams stdout/stderr lines as
     *  `sidecar-stdout` / `sidecar-stderr` events and the exit as `sidecar-exit`,
     *  keyed by the returned run id. Runs in the sidecar dir so co-located dlls resolve.
     */
    sidecarSpawn: (pluginId: string, name: string, args: string[]) => Promise<number>;
    /**  Kill a running sidecar process by run id (no-op if already exited). */
    sidecarKill: (runId: number) => Promise<null>;
    checkBorderFile: (level: string) => Promise<boolean>;
    downloadBorderFile: (level: string) => Promise<null>;
    borderLookup: (lat: number, lng: number, level: string) => Promise<PolygonGeometry | null>;
    /**
     *  Finds the nearest city/country for a coordinate. O(log n) k-d tree lookup.
     *  Always returns `Some` -- the GeoNames dataset covers every landmass.
     */
    reverseGeocode: (lat: number, lng: number) => Promise<GeoResult | null>;
    discordPresenceSet: (activity: PresenceActivity) => Promise<null>;
    discordPresenceClear: () => Promise<null>;
    /**
     *  Start (or re-key) the remote API server. Idempotent: a running server just
     *  picks up the new key. Returns the base URL.
     */
    remoteApiStart: (key: string) => Promise<string>;
    remoteApiStop: () => Promise<null>;
    /**
     *  Webview -> HTTP reply path: resolves the parked request for `id`.
     *  `payload` is JSON text, not a typed value -- specta cannot export the
     *  recursive `serde_json::Value` type (stack overflow at bindings export).
     */
    remoteApiRespond: (id: number, ok: boolean, payload: string) => Promise<void>;
    /**
     *  Load a map's Arrow data from disk, rebuild all indexes, and return initial state
     *  (tag counts, undo/redo availability). Must be called before any other store commands.
     */
    storeOpenMap: (mapId: string) => Promise<StoreStatus>;
    /**
     *  Close the current map: bake overlay, flush Arrow + tags + edit history to disk, then
     *  release all in-memory state (batch, mmap, indexes, selections, undo stacks).
     */
    storeCloseMap: () => Promise<null>;
    /**  Autosave uncommitted changes to the delta sidecar. No-op when nothing changed. */
    storeSaveDirty: () => Promise<SaveResult>;
    /**
     *  Copy locations into another map, skipping ones the target already has. Tags and extra
     *  fields carry over.
     */
    storeCopyLocationsToMap: (targetMapId: string, ids: number[]) => Promise<CopyToMapResult>;
    /**  Lightweight status query: location count, version, and dirty flag. */
    storeGetSummary: () => Promise<SummaryResult>;
    /**  Return metadata for every map in the database. */
    storeListMaps: () => Promise<MapMeta[]>;
    /**  Fetch a single map's metadata by ID. Returns `None` if not found. */
    storeGetMap: (id: string) => Promise<MapData | null>;
    /**
     *  Create a new empty map with default settings. Returns the full metadata
     *  (including the generated UUID) so the frontend can navigate to it immediately.
     */
    storeCreateMap: (name: string, folder: string | null) => Promise<MapData>;
    /**  Delete a map and all its data: database rows and files on disk. */
    storeDeleteMap: (id: string) => Promise<null>;
    /**  Apply a partial update to a map's metadata; `None` fields are left unchanged. */
    storeUpdateMapMeta: (id: string, patch: MapMetaPatch_Deserialize) => Promise<null>;
    /**
     *  Update `last_opened_at` to the current timestamp. Used to sort the map
     *  list by recency in the dashboard.
     */
    storeTouchMapOpened: (mapId: string) => Promise<null>;
    /**  Rename a folder across all maps that reference it. */
    storeRenameFolder: (from: string, to: string) => Promise<null>;
    /**  Delete a folder by setting all its maps' folder to `NULL` (moves them to root). */
    storeDeleteFolder: (name: string) => Promise<null>;
    /**  List all user-created tables with their row counts. Excludes SQLite internals. */
    storeDbTableInfo: () => Promise<DbTableInfo[]>;
    /**
     *  Add new locations. IDs are allocated server-side (monotonic). Records an undo entry
     *  and clears the redo stack.
     */
    storeAddLocations: (locations: Location[]) => Promise<MutationResult>;
    /**  Remove locations by ID. Snapshots the full location data for undo before deleting. */
    storeRemoveLocations: (ids: number[]) => Promise<MutationResult>;
    /**
     *  Apply partial patches to existing locations. `record_undo` defaults to true;
     *  set to false for ephemeral updates (e.g., plugin-driven batch modifications
     *  that manage their own undo).
     */
    storeUpdateLocations: (updates: Update<LocationPatch_Deserialize>[], recordUndo: boolean | null) => Promise<MutationResult>;
    /**
     *  Set (or clear) the active location. Fire-and-forget from JS; no re-render triggered.
     *  JS patches the cell buffer synchronously to hide/show the active marker.
     */
    storeSetActive: (id: number | null) => Promise<null>;
    /**
     *  Set the default marker color used by the render delta path. Fire-and-forget from JS;
     *  the JS side recolors its cell buffers in place (no full rebuild).
     */
    storeSetMarkerColor: (color: [number, number, number]) => Promise<null>;
    /**  Fetch a single location by ID. Returns `None` if the ID is dead or doesn't exist. */
    storeGetLocation: (id: number) => Promise<Location | null>;
    /**  Fetch multiple locations by ID. Silently skips IDs that don't exist. */
    storeGetLocationsByIds: (ids: number[]) => Promise<Location[]>;
    /**
     *  Dump every alive location to a temp JSON file. Returns the file path.
     *  Used by export and plugins that need the full dataset.
     */
    storeGetAllLocations: () => Promise<string>;
    /**
     *  Count locations by country (offline point-in-polygon). Returns unsorted (ISO-A2, count) pairs.
     *  `level` selects border precision, falling back to "light" if unavailable.
     */
    storeCountryDistribution: (level: string) => Promise<[string, number][]>;
    /**
     *  Compute the bounding box [west, south, east, north]. O(N).
     *  When `selected_only` is true, restricts to the current selection.
     */
    storeBounds: (selectedOnly: boolean) => Promise<[number, number, number, number] | null>;
    /**  Find all locations within `radius_m` metres of (`lat`, `lng`). */
    storeFindNearby: (lat: number, lng: number, radiusM: number) => Promise<Location[]>;
    /**
     *  For each input point, whether any existing location lies within `radius_m` metres.
     *  Bulk form so callers probing many coordinates (e.g. the map generator skipping
     *  already-covered spots) pay one IPC round-trip, not one per point.
     */
    storeNearAny: (lats: number[], lngs: number[], radiusM: number) => Promise<boolean[]>;
    /**
     *  Collect all distinct values for an `extra` field across all alive locations. O(N).
     *  Used by the filter UI to populate dropdown options.
     */
    storeExtraFieldValues: (field: string) => Promise<string[]>;
    /**
     *  Create tags by name. Deduplicates case-insensitively: if a tag with the same name
     *  already exists, it is made visible instead of creating a duplicate.
     */
    storeCreateTags: (names: string[]) => Promise<MutationResult>;
    /**
     *  Rename and/or recolor tags in one batch. Renaming onto an existing name (case-insensitive)
     *  merges the two tags.
     */
    storeUpdateTags: (updates: Update<TagPatch>[]) => Promise<MutationResult>;
    /**
     *  Strip tags from all locations. Tags stay in `store.tags` with count=0 /
     *  visible=false so undo can revive them. Returns MutationResult with `tags`.
     */
    storeDeleteTags: (tagIds: number[]) => Promise<MutationResult>;
    /**
     *  Persist tag ordering. `ordered_ids` specifies the desired order; each tag's
     *  `order` field is set to its index in the list.
     */
    storeReorderTags: (orderedIds: number[]) => Promise<MutationResult>;
    /**  Pop the undo stack and reverse the last edit. Pushes the entry onto the redo stack. */
    storeUndo: () => Promise<MutationResult>;
    /**  Pop the redo stack and replay the edit forward. Pushes the entry back onto undo. */
    storeRedo: () => Promise<MutationResult>;
    /**  Clear both undo and redo stacks. Called after a commit to start fresh. */
    storeResetUndo: () => Promise<null>;
    /**  The uncommitted changes since the last commit -- the same changeset `store_commit` will record. */
    storeCommitDiff: () => Promise<[number, number, number]>;
    /**
     *  Replace all selections, resolve bitmasks against current data, and write a binary
     *  patch file for JS to apply to the render overlay. Returns per-selection counts.
     */
    storeSyncSelections: (sels: SelectionInput[]) => Promise<SelectionSync>;
    /**  Return the union of all currently selected location IDs. */
    storeGetSelectedIdsList: () => Promise<number[]>;
    /**
     *  Pick an evenly spaced subset of the current selection. Exactly one of `target_count`
     *  (thin to N, maximizing spacing) or `min_distance_m` (keep as many as fit at that spacing)
     *  must be provided.
     */
    storePickSpaced: (targetCount: number | null, minDistanceM: number | null) => Promise<SpacedPickResult>;
    /**
     *  Resolve a single selection to its matching location IDs without persisting it.
     *  Used by plugins and one-off queries (e.g., tag merge, export filtered).
     */
    storeResolveSelection: (props: SelectionProps) => Promise<number[]>;
    /**
     *  Group locations by a derived key, returning `{ key, ids, bin }` per group.
     *  `scope` restricts to a selection; `None` partitions the whole map.
     */
    storePartition: (field: string, key: KeySpec, scope: Scope) => Promise<PartitionBucket[]>;
    /**
     *  Transitive spatial duplicate groups (connected components, size >= 2) within `distance`
     *  metres. Read-only; used to preview a merge. Returns groups of location IDs.
     */
    storeDuplicateGroups: (distance: number) => Promise<number[][]>;
    /**
     *  Merge each duplicate group within `distance` metres into one survivor location, unioning
     *  tags and extra fields. One undoable edit.
     */
    storeMergeDuplicates: (distance: number) => Promise<MutationResult>;
    /**
     *  Thin duplicates among `ids` within `distance` metres, keeping the best location per
     *  cluster. Informational locations are never pruned. One undoable edit.
     */
    storePruneDuplicates: (ids: number[], distance: number, keepTagIds: number[]) => Promise<MutationResult>;
    /**
     *  Full render rebuild: single-pass over all alive locations, writes binary to a temp file.
     *  Returns the file path for JS to fetch via `mma-buf://`. Only called on map open or full reset.
     */
    storeFillRenderFile: (req: RenderRequest) => Promise<string>;
    /**
     *  Resolve a deck.gl pick result (cell key + index within cell) to a location ID.
     *  Called on marker click to map the GPU pick back to a logical location.
     */
    storeResolvePick: (cell: string, cellIndex: number) => Promise<number | null>;
    /**
     *  Parse a file (JSON or ZIP of JSONs) and return previews without persisting.
     *  Results are cached in `CACHED_PARSE` so `bulk_import_confirm` can skip re-parsing.
     *  ZIP files have each `.json` entry parsed in parallel via rayon.
     */
    bulkImportPreview: (path: string) => Promise<ImportPreviewEntry[]>;
    /**  Import the selected maps from a previously previewed file. Emits `bulk-import-progress` per map. */
    bulkImportConfirm: (path: string, selectedIndices: number[]) => Promise<ImportedMapInfo[]>;
    /**
     *  Drop the cached parse from `bulk_import_preview` when the user dismisses the
     *  import dialog without confirming, instead of holding it until the next preview.
     */
    bulkImportCancel: () => Promise<null>;
    /**
     *  Parse a file and return field-level statistics + preview positions for the editor
     *  import sidebar. Caches the parse result for `store_import_file` to consume on commit.
     */
    storeImportPreview: (path: string) => Promise<EditorImportPreview>;
    /**
     *  Parse pasted text (JSON or CSV) and stage it for preview, exactly like
     *  `store_import_preview` does for a file. Caches the parse for `store_import_file`.
     */
    storeImportPastePreview: (text: string) => Promise<EditorImportPreview>;
    /**
     *  Fetch one staged (not yet imported) location by its preview index, for read-only
     *  preview in the editor. Indexes follow the preview positions order.
     */
    storeImportStagedLocation: (index: number) => Promise<Location>;
    /**
     *  Commit a previously previewed editor import, optionally dropping fields and/or
     *  applying a bulk tag to every imported location. Consumes the cached parse from
     *  `store_import_preview`/`store_import_paste_preview`. Fields in `dropped_fields`
     *  (e.g. `"heading"`, `"extra.countryCode"`) are zeroed/removed.
     */
    storeImportFile: (droppedFields: string[], tagName: string | null) => Promise<EditorImportResult>;
    /**  Export locations as a `{name, customCoordinates}` JSON file, including tags and field defs. */
    storeExportJson: (opts: ExportOpts) => Promise<string>;
    /**  Export locations as a minimal lat/lng CSV file. */
    storeExportCsv: (scope: number[] | null) => Promise<string>;
    /**
     *  Export locations as a GeoJSON FeatureCollection of Point features.
     *  Each feature carries its tag names in `properties.tags`.
     */
    storeExportGeojson: (scope: number[] | null, tagsJson: string) => Promise<string>;
    /**
     *  Copy a temp export file to the destination chosen via the native save dialog,
     *  then remove the temp source. `dest_path` comes from the frontend save dialog.
     */
    storeSaveExportFile: (srcPath: string, destPath: string) => Promise<null>;
    /**  Export every map in the database as a ZIP of JSON files. Duplicate map names get a numeric suffix. */
    storeExportBulkZip: () => Promise<string>;
    /**
     *  Create a temp session dir for binary uploads from the frontend. Files are
     *  written into it via `mma-buf://` POST, then packaged by [`store_upload_finish`].
     */
    storeUploadBegin: () => Promise<string>;
    /**
     *  Package an upload session and remove its dir: a single file is moved out
     *  as-is, multiple are packed into a Stored ZIP (entries like JPEG/PNG are
     *  already compressed). Returns a temp path for [`store_save_export_file`].
     */
    storeUploadFinish: (sessionDir: string) => Promise<string>;
    /**  Remove an abandoned upload session dir (e.g. cancelled operation). */
    storeUploadAbort: (sessionDir: string) => Promise<null>;
    /**
     *  Delete all rows from a table. Returns the number of deleted rows.
     *  Used in the debug panel for cache/history cleanup.
     */
    storeDbClearTable: (table: string) => Promise<number>;
    /**
     *  Compute aggregate database statistics (map/location/tag/commit counts,
     *  database file size, journal mode). Tag count is summed across all maps
     *  by parsing each map's tags JSON column.
     */
    storeDbStats: () => Promise<DbStats>;
    /**  Record a panorama visit. Oldest entries beyond `MAX_SEEN` are evicted. */
    storeSeenWrite: (entry: SeenWriteEntry) => Promise<null>;
    /**  Returns a page of seen entries, newest first, with optional filtering. */
    storeSeenList: (limit: number, offset: number, filter: SeenFilter | null, thumbnails: boolean) => Promise<SeenEntry[]>;
    /**  Returns the total number of seen entries matching the filter (for pagination). */
    storeSeenCount: (filter: SeenFilter | null) => Promise<number>;
    /**
     *  Returns all distinct country codes present in the seen table, sorted alphabetically.
     *  Used to populate the country filter dropdown.
     */
    storeSeenCountries: () => Promise<string[]>;
    /**
     *  Returns all distinct maps that have seen entries, with resolved display names.
     *  Returns maps that have seen entries. Only includes maps that still exist.
     */
    storeSeenMaps: () => Promise<SeenMapInfo[]>;
    /**  Deletes all seen history entries. */
    storeSeenClear: () => Promise<null>;
    storeReviewCreate: (session: ReviewCreate) => Promise<ReviewSession>;
    storeReviewGet: (mapId: string, sourceKey: string) => Promise<ReviewSession | null>;
    storeReviewList: (mapId: string, status: string | null) => Promise<ReviewSession[]>;
    storeReviewUpdate: (update: ReviewUpdate) => Promise<null>;
    storeReviewDelete: (id: string) => Promise<null>;
    remoteMappingGet: (provider: string, mapId: string) => Promise<RemoteMappingRow[]>;
    remoteMappingUpsert: (provider: string, mapId: string, rows: RemoteMappingRow[]) => Promise<null>;
    remoteMappingDelete: (provider: string, mapId: string, localIds: number[]) => Promise<null>;
    remoteMappingClear: (provider: string, mapId: string) => Promise<null>;
    /**
     *  Open the GeoGuessr sign-in window and wait for a `_ncfa` cookie to appear.
     *  Returns the signed-in nickname.
     */
    geoguessrLogin: () => Promise<string>;
    /**  The signed-in user, or `None` when there is no session (or it was rejected). */
    geoguessrMe: () => Promise<GgUser | null>;
    geoguessrLogout: () => Promise<null>;
    /**  Local-only check: is a token stored? Says nothing about its validity. */
    geoguessrHasSession: () => Promise<boolean>;
    /**
     *  Commit the map's uncommitted changes and return the new commit id.
     *  `message` None auto-generates a `+a -r ~m` summary.
     */
    storeCommit: (mapId: string, message: string | null) => Promise<string>;
    /**  List all commits for a map, newest first. */
    storeListCommits: (mapId: string) => Promise<CommitInfo[]>;
    /**
     *  Restore a map to the state captured by a previous commit. The caller must reopen
     *  the map afterwards (undo/redo is cleared).
     */
    storeCheckoutCommit: (mapId: string, commitId: string) => Promise<null>;
    /**  Read a single commit's delta (created/removed locations) for the diff viewer. */
    storeGetCommitDelta: (mapId: string, commitId: string) => Promise<CommitDelta>;
    /**
     *  Generate locations from a Vali map definition (JSON/JSONC text). Missing country
     *  data is auto-downloaded like the Vali CLI. Returns the generated locations.
     */
    valiGenerate: (definition: string) => Promise<ValiLocation[]>;
    /**  Download Vali coverage data. `country` = code/continent alias/None for all. */
    valiDownload: (country: string | null, full: boolean, updates: boolean) => Promise<null>;
    /**  Cancel an in-flight vali generate or download. */
    valiCancel: () => Promise<void>;
    /**  Subdivision weights for a country (JSON text, same shape as `vali subdivisions`). */
    valiSubdivisions: (country: string) => Promise<string>;
};
/**
 *  A swap-removal from a render cell. JS must move the last element into `cell_index`
 *  and pop the array to mirror the Rust-side swap-remove.
 */
type CellRemoval = {
    cell: string;
    cellIndex: number;
    id: number;
};
/**
 *  Override the RGBA color of a single marker within a cell (used when selection
 *  membership changes without a position change).
 */
type ColorPatchEntry = {
    cell: string;
    cellIndex: number;
    r: number;
    g: number;
    b: number;
    a: number;
};
/**
 *  A commit's delta, returned to the frontend for the per-commit diff viewer.
 *  An updated location appears in both `created` (new) and `removed` (old).
 */
type CommitDelta = {
    created: Location[];
    removed: Location[];
};
type CommitDiff = {
    added: number;
    removed: number;
    modified: number;
};
type CommitInfo = {
    id: string;
    mapId: string;
    parentId: string | null;
    message: string | null;
    treeHash: string | null;
    locationCount: number;
    createdAt: string;
} & CommitDiff;
/**
 *  How a field's values are compared when measuring how strongly it separates
 *  groups (selection disambiguation). The only un-inferrable property a field can
 *  declare is circularity (heading/azimuth=360, hour-of-day=24, month=12);
 *  everything else is inferred from `ExtraFieldType`.
 */
type ComparisonType = {
    type: "linear";
} | {
    type: "circular";
    period: number;
} | {
    type: "categorical";
};
/**  Result of a cross-map location copy. `target_name` feeds the toast. */
type CopyToMapResult = {
    copied: number;
    skipped: number;
    targetName: string;
};
/**  The active and default data-folder paths, plus whether a custom override is in effect. */
type DataLocation = {
    /**  Folder currently in use this session (default or override). */
    path: string;
    /**  OS default, ignoring any override -- used for the "reset" affordance. */
    default_path: string;
    /**  True when `path` differs from the OS default. */
    is_custom: boolean;
};
/**  A calendar component to group dates by. */
type DatePart = "year" | "yearMonth" | "day" | "monthOfYear" | "hourOfDay";
/**  Aggregate database statistics for the debug panel. */
type DbStats = {
    maps: number;
    locations: number;
    tags: number;
    commits: number;
    dbSizeBytes: number;
    journalMode: string;
    foreignKeys: boolean;
};
/**  Row count for a single SQLite table, used in the debug diagnostics panel. */
type DbTableInfo = {
    name: string;
    rows: number;
};
/**
 *  Preview data for importing a file into the currently open map.
 *  Unlike bulk import, this shows per-field counts so the user can
 *  selectively drop fields (heading, panoId, etc.) before importing.
 */
type EditorImportPreview = {
    locationCount: number;
    tags: Tag[];
    fields: FieldCount[];
    warnings: string[];
    /**  Temp-file path to preview positions: interleaved LE f32 `[lng, lat]` pairs. */
    previewPositionsPath: string;
    /**  `[west, south, east, north]` bounding box of the import, for map auto-focus. */
    bounds: [number, number, number, number] | null;
    /**
     *  True when this import exceeds `IMPORT_AUTOCOMMIT_THRESHOLD` and will be
     *  committed automatically (not undoable). Drives the import warning modal.
     */
    willAutoCommit: boolean;
};
/**
 *  Combined result of an editor import: the mutation delta (for render pipeline)
 *  plus import-specific metadata.
 */
type EditorImportResult = {
    importedCount: number;
    warnings: string[];
    /**  True when the import was large enough to autocommit; the caller commits it. */
    autoCommit: boolean;
    /**  Settings carried by the import (`extra.settings`) */
    settings: {
        [key in string]: any;
    };
} & MutationResult;
/**
 *  Configuration for JSON export. Controls which fields are included and
 *  whether the export covers all locations or a specific selection.
 */
type ExportOpts = {
    exportZoom: boolean;
    exportUnpanned: boolean;
    exportExtras: boolean;
    /**  When `Some`, restricts export to these location IDs (e.g. current selection). */
    scope: number[] | null;
    mapName: string;
    /**
     *  Serialized `{id: {name, color}}` tag definitions from the store, used to
     *  convert numeric tag IDs back to human-readable names in the output.
     */
    tagsJson: string;
    extraFieldsJson: string | null;
};
/**
 *  Schema definition for a single `Location.extra` field. Stored in the map's
 *  `extra.fields` JSON. For enum types, `values` lists valid options and `labels`
 *  provides display names.
 */
type ExtraFieldDef = {
    type: ExtraFieldType;
    label?: string | null;
    values?: string[] | null;
    labels?: {
        [key in string]: string;
    } | null;
    /**
     *  Optional override for how this field is compared during disambiguation.
     *  `None` => inferred from `field_type` on the analysis side.
     */
    comparison?: ComparisonType | null;
};
/**
 *  Type discriminant for `Location.extra` field definitions.
 *  Determines how the field is displayed and filtered in the UI.
 */
type ExtraFieldType = "string" | "number" | "date" | "month" | "enum" | "array";
/**
 *  Field presence count for the editor import preview dialog, letting
 *  the user see which optional fields exist and decide which to keep/drop.
 */
type FieldCount = {
    key: string;
    count: number;
};
/**
 *  Filter comparison operator. Single source of truth: specta renders the literal
 *  union, so the TS `FilterOp` type and `OP_LABELS` derive from this enum.
 */
type FilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "between" | "between_anyyear" | "between_anytime" | "has" | "nothas" | "contains" | "notcontains";
/**  Reverse geocode result: nearest populated place to a coordinate. */
type GeoResult = {
    city: string;
    /**  First-level administrative division (state, province, region). */
    admin: string;
    country: string;
    /**  ISO 3166-1 alpha-2 (e.g. "US", "FR"). */
    country_code: string;
};
/**  The signed-in GeoGuessr account. */
type GgUser = {
    id: string;
    nick: string;
};
/**
 *  Summary of a single map found during bulk import preview.
 *  Shown in the import dialog so the user can select which maps to import.
 */
type ImportPreviewEntry = {
    name: string;
    folder: string | null;
    locationCount: number;
    tagCount: number;
    warnings: string[];
};
/**  Result returned per map after a successful bulk import. */
type ImportedMapInfo = {
    id: string;
    name: string;
    locationCount: number;
    tagCount: number;
};
/**  How a field value becomes a group key. Wire-mirrors the JS `KeySpec`. */
type KeySpec = 
/**  String value of the field (enum/string/month "YYYY-MM"/number). */
{
    kind: "value";
} | 
/**  Equal-width numeric bins. */
{
    kind: "numericBin";
    binning: NumericBinning;
} | 
/**  Calendar component of a date (epoch seconds) or month ("YYYY-MM") field. */
{
    kind: "datePart";
    part: DatePart;
    tzLocal: boolean;
};
/**
 *  A single Street View location on a map.
 *
 *  This is the atomic unit of data in the system. Locations are stored columnar
 *  in Arrow IPC on disk and addressed by `id` everywhere. The `id` is unique
 *  within a map and assigned by the store's monotonic allocator.
 */
type Location = {
    /**
     *  Monotonically increasing within a map. Zero is a sentinel meaning
     *  "not yet assigned" (used during import before IDs are allocated).
     */
    id: number;
    lat: number;
    lng: number;
    heading: number;
    pitch: number;
    zoom: number;
    panoId: string | null;
    /**  See [`LocationFlags`]. */
    flags: number;
    /**  Tag IDs applied to this location. References `Tag.id`. */
    tags: number[];
    /**  Arbitrary key-value metadata */
    extra: any | null;
    /**  Unix timestamp (seconds) */
    createdAt: number;
    modifiedAt: number | null;
};
/**
 *  Partial location update from JS. `None` fields are unchanged; `Some(None)` on
 *  nullable fields (panoId, extra, modifiedAt) explicitly sets the field to null.
 *  `extra` is a JSON Merge Patch (RFC 7386): keys shallow-merge, null values delete.
 */
/**
 *  Partial location update from JS. `None` fields are unchanged; `Some(None)` on
 *  nullable fields (panoId, extra, modifiedAt) explicitly sets the field to null.
 *  `extra` is a JSON Merge Patch (RFC 7386): keys shallow-merge, null values delete.
 */
type LocationPatch_Deserialize = {
    lat?: number | null;
    lng?: number | null;
    heading?: number | null;
    pitch?: number | null;
    zoom?: number | null;
    panoId?: string | null;
    flags?: number | null;
    tags?: number[] | null;
    extra?: any | null;
    createdAt?: number | null;
    modifiedAt?: number | null;
};
/**
 *  Partial location update from JS. `None` fields are unchanged; `Some(None)` on
 *  nullable fields (panoId, extra, modifiedAt) explicitly sets the field to null.
 *  `extra` is a JSON Merge Patch (RFC 7386): keys shallow-merge, null values delete.
 */
type LocationPatch = {
    lat: number | null;
    lng: number | null;
    heading: number | null;
    pitch: number | null;
    zoom: number | null;
    panoId: string | null;
    flags: number | null;
    tags: number[] | null;
    extra: any | null;
    createdAt: number | null;
    modifiedAt: number | null;
};
type MapData = {
    meta: MapMeta;
};
/**
 *  Top-level `extra` JSON blob on a map row. Currently only holds field definitions,
 *  but structured as an object to allow future extensions.
 */
type MapExtra = {
    fields?: {
        [key in string]: ExtraFieldDef;
    } | null;
};
/**
 *  Action performed by a per-map key binding on the active location.
 *  New action kinds (e.g. copy-to-map) are added as variants here.
 */
type MapKeyAction = {
    type: "applyTag";
    tagId: number;
} | {
    type: "copyToMap";
    mapId: string;
};
/**
 *  One user-defined per-map key binding. `key` is a combo string in the same
 *  canonical format as global hotkey bindings (e.g. "m", "Mod+Shift+x").
 */
type MapKeyBinding = {
    key: string;
    action: MapKeyAction;
};
/**
 *  Full metadata for a map, deserialized from the SQLite `maps` row.
 *  JSON columns (settings, tags, extra, etc.) are parsed into typed structs.
 */
type MapMeta = {
    id: string;
    name: string;
    description: string;
    folder: string | null;
    settings: MapSettings;
    scoreBounds: ScoreBounds;
    extra: MapExtra;
    tags: {
        [key in string]: Tag;
    };
    labels: string[];
    locationCount: number;
    createdAt: string;
    updatedAt: string;
    lastOpenedAt: string | null;
};
/**
 *  Partial update for map metadata. Only non-`None` fields are written.
 *  `folder: Some(None)` explicitly unsets the folder (moves to root).
 */
/**
 *  Partial update for map metadata. Only non-`None` fields are written.
 *  `folder: Some(None)` explicitly unsets the folder (moves to root).
 */
type MapMetaPatch_Deserialize = {
    name?: string | null;
    description?: string | null;
    folder?: string | null;
    settings?: MapSettings | null;
    scoreBounds?: ScoreBounds | null;
    extra?: MapExtra | null;
    tags?: {
        [key in string]: Tag;
    } | null;
    labels?: string[] | null;
};
/**
 *  Partial update for map metadata. Only non-`None` fields are written.
 *  `folder: Some(None)` explicitly unsets the folder (moves to root).
 */
type MapMetaPatch = {
    name: string | null;
    description: string | null;
    folder: string | null;
    settings: MapSettings | null;
    scoreBounds: ScoreBounds | null;
    extra: MapExtra | null;
    tags: {
        [key in string]: Tag;
    } | null;
    labels: string[] | null;
};
/**
 *  Per-map editor preferences. Controls Street View lookup behavior (official vs
 *  unofficial, camera type filters), export defaults, and metadata enrichment.
 */
type MapSettings = {
    pointAlongRoad?: boolean;
    preferDirection?: string | null;
    preferOfficial?: boolean;
    preferHigherQuality?: boolean;
    onlyOfficial?: boolean;
    cameraTypes?: string[] | null;
    defaultPanoId?: boolean;
    exportZoom?: boolean;
    exportUnpanned?: boolean;
    exportExtras?: boolean;
    searchRadius?: number | null;
    enrichMetadata?: boolean;
    enrichFields?: string[] | null;
    keyBindings?: MapKeyBinding[];
    /**  Virtual tag-tree nodes keyed by full slash path. Tree-view only. */
    virtualTags?: {
        [key in string]: VirtualTag;
    };
    /**
     *  Tag aliases: a second tree location (full slash path) -> the real tag id shown
     *  there. Tree-view only; clicking the alias leaf toggles the real tag.
     */
    aliases?: {
        [key in string]: number;
    };
};
/**
 *  Unified response for every mutation IPC. Bundles the store status, render delta,
 *  optional selection sync, optional newly-discovered extra-field keys, and optional
 *  updated tags. JS applies all of these atomically to stay in sync with the Rust state.
 *  `new_field_defs` carries the inferred/known field definitions for extra-field keys
 *  discovered for the first time in this mutation. JS merges them straight into the
 *  field-def registry, so field metadata is live without a reload.
 */
type MutationResult = {
    delta: RenderDelta;
    selectionSync: SelectionSync | null;
    newFieldDefs: {
        [key in string]: ExtraFieldDef;
    } | null;
    tags: {
        [key in number]: Tag;
    } | null;
} & StoreStatus;
/**  Equal-width bin sizing. `count` derives the width from the data range; `width` fixes it. */
type NumericBinning = {
    by: "count";
    n: number;
} | {
    by: "width";
    w: number;
};
/**
 *  One partition group: a stable key, the ids it holds, and (numeric bins only) the
 *  `[lo, hi]` bounds so JS can rebuild a live Filter for whole-map gradients.
 */
type PartitionBucket = {
    key: string;
    ids: number[];
    bin: [number, number] | null;
};
/**  Metadata for a user-installed plugin, read from `plugins/{id}/manifest.json`. */
/**  Metadata for a user-installed plugin, read from `plugins/{id}/manifest.json`. */
type PluginManifest_Deserialize = {
    id: string;
    name: string;
    description: string;
    icon: string;
    main: string;
    version: string;
    sidecar: PluginSidecar_Deserialize | null;
};
/**  Metadata for a user-installed plugin, read from `plugins/{id}/manifest.json`. */
type PluginManifest = {
    id: string;
    name: string;
    description: string;
    icon: string;
    main: string;
    version: string;
    sidecar?: PluginSidecar | null;
};
/**  A plugin's declared sidecar binary (downloaded from GitHub Releases on install). */
/**  A plugin's declared sidecar binary (downloaded from GitHub Releases on install). */
type PluginSidecar_Deserialize = {
    name: string;
    version: string;
    /**  Expected SHA-256 hex digest of the platform-specific zip archive. */
    sha256: string | null;
};
/**  A plugin's declared sidecar binary (downloaded from GitHub Releases on install). */
type PluginSidecar = {
    name: string;
    version: string;
    /**  Expected SHA-256 hex digest of the platform-specific zip archive. */
    sha256?: string | null;
};
/**
 *  GeoJSON-like polygon geometry. `coordinates` is the primary polygon (outer ring +
 *  optional holes). `extra_polygons` allows multipolygon selections (e.g., from GeoJSON import).
 */
type PolygonGeometry = {
    coordinates: (([number, number])[])[];
    extraPolygons?: ((([number, number])[])[])[] | null;
    properties?: any | null;
};
type PresenceActivity = {
    details: string | null;
    state: string | null;
    largeImage: string | null;
    largeText: string | null;
    smallImage: string | null;
    smallText: string | null;
    /**  Unix seconds; Discord renders an "elapsed" timer counting up from here. */
    start: number | null;
};
/**  One mapping row. `hash` is the plugin's content fingerprint (opaque text to us). */
type RemoteMappingRow = {
    localId: number;
    /**  Remote ids can exceed u32 (observed ~1.2e10), so i64. */
    remoteId: number;
    hash: string;
};
/**
 *  Incremental render update sent to JS after a mutation. Contains adds, position/heading
 *  patches, swap-removals, and color patches (for selection overlay changes).
 *  `full_reset` signals JS to discard all cell data and re-fetch via `store_fill_render_file`.
 */
type RenderDelta = {
    added: RenderEntry[];
    updated: RenderPatchEntry[];
    removed: CellRemoval[];
    colorPatches: ColorPatchEntry[];
    fullReset: boolean;
};
/**  A newly-added marker to a render cell: position, heading, and base color. */
type RenderEntry = {
    cell: string;
    id: number;
    lng: number;
    lat: number;
    heading: number;
    r: number;
    g: number;
    b: number;
    a: number;
};
/**  Partial update to an existing marker within its cell (position and/or heading changed). */
type RenderPatchEntry = {
    cell: string;
    cellIndex: number;
    lng: number | null;
    lat: number | null;
    heading: number | null;
};
/**
 *  Parameters for a full render rebuild. `marker_style` ("arrow" or "pin") determines
 *  whether heading angles are written. The bounding box fields are currently unused
 *  (no viewport culling -- all locations are rendered).
 */
type RenderRequest = {
    west?: number;
    south?: number;
    east?: number;
    north?: number;
    selectedIds?: number[] | null;
    markerStyle?: string;
    markerColor?: [number, number, number] | null;
};
/**
 *  Inbound payload for creating a session. `order` is the frozen worklist (must be non-empty);
 *  the cursor starts at its first id and `reviewed` starts empty.
 */
type ReviewCreate = {
    mapId: string;
    name: string;
    sourceKey: string;
    sourceProps: any;
    order: number[];
};
/**
 *  A review session as returned to the frontend. `order`/`reviewed` are decoded from the
 *  JSON-text columns; `source_props` is the originating `SelectionProps` (opaque here).
 */
type ReviewSession = {
    id: string;
    mapId: string;
    name: string;
    sourceKey: string;
    sourceProps: any;
    order: number[];
    reviewed: number[];
    cursorId: number;
    status: string;
    createdAt: string;
    updatedAt: string;
};
/**
 *  Partial update. Any `Some` field is written; `None` leaves the column untouched.
 *  `ordering`/`reviewed` carry the full replacement arrays (used by reconciliation pruning).
 */
type ReviewUpdate = {
    id: string;
    name?: string | null;
    cursorId: number | null;
    reviewed: number[] | null;
    ordering: number[] | null;
    status: string | null;
};
/**  Result of `store_save_dirty`: bytes written to the delta sidecar (0 = skipped). */
type SaveResult = {
    savedBytes: number;
};
/**
 *  Which locations to operate on: the whole map or the current selection. Resolved in Rust
 *  against the maintained selection set.
 */
type Scope = {
    kind: "all";
} | {
    kind: "selected";
};
/**
 *  Score bounding box: either `"auto"` (computed from locations) or an
 *  explicit `[south, west, north, east]` rectangle.
 */
type ScoreBounds = string | [number, number, number, number];
/**  A panorama visit record as returned to the frontend. */
type SeenEntry = {
    id: number;
    panoId: string;
    lat: number;
    lng: number;
    heading: number;
    pitch: number;
    zoom: number;
    enteredAt: number;
    mapId: string | null;
    locationId: number | null;
    countryCode: string | null;
    address: string | null;
    thumbnail: string | null;
};
/**
 *  Optional filters for seen-history queries. All fields are AND-combined.
 *  `search` does a substring match on the `address` column.
 */
type SeenFilter = {
    country?: string | null;
    mapId?: string | null;
    search?: string | null;
};
/**
 *  Map id + display name pair for the "filter by map" dropdown.
 *  Name is resolved from the `maps` table when available, falling back to raw id.
 */
type SeenMapInfo = {
    id: string;
    name: string;
};
/**
 *  Inbound payload for recording a new panorama visit. Same shape as `SeenEntry`
 *  minus the auto-assigned `id`.
 */
type SeenWriteEntry = {
    panoId: string;
    lat: number;
    lng: number;
    heading: number;
    pitch: number;
    zoom: number;
    enteredAt: number;
    mapId: string | null;
    locationId: number | null;
    countryCode: string | null;
    address: string | null;
    thumbnail: string | null;
};
/**
 *  A named, colored selection. `key` is deterministic (e.g., `"tag:5"`, `"polygon:abc"`)
 *  so JS can diff selections across syncs. `color` is the RGB overlay color.
 */
type Selection = {
    key: string;
    color: [number, number, number];
    props: SelectionProps;
};
/**  Input for `store_sync_selections`: selection criteria + display color. */
type SelectionInput = {
    /**  Deterministic selection key (e.g. `"tag:5"`), used to return per-node counts back keyed. */
    key: string;
    props: SelectionProps;
    color: [number, number, number];
    /**  Counted, but kept out of the overlay and the selected set. */
    ghosted?: boolean;
};
/**
 *  Discriminated union of all selection types. Serialized with `{ "type": "..." }` tag
 *  for JS interop. Simple types (Tag, Untagged, PanoIds, etc.) resolve in O(N) with
 *   parallel batch scans. Composites (Intersection, Union, Invert) recursively resolve
 *  children. Duplicates uses a grid-accelerated spatial scan.
 */
type SelectionProps = {
    type: "Locations";
    locations: number[];
    name: string | null;
} | {
    type: "Everything";
} | {
    type: "Polygon";
    polygon: PolygonGeometry;
    includeInformational: boolean;
} | {
    type: "Tag";
    tagId: number;
} | {
    type: "Untagged";
} | {
    type: "Unpanned";
} | {
    type: "PanoIds";
} | {
    type: "NotPanoIds";
} | {
    type: "Uncommitted";
} | {
    type: "Manual";
    locations: number[];
} | {
    type: "Duplicates";
    distance: number;
} | {
    type: "ValidationState";
    locations: number[];
    state: number;
} | {
    type: "Reviewed";
    locations: number[];
    sessionId: string;
    mode: string;
} | {
    type: "Intersection";
    selections: Selection[];
} | {
    type: "Union";
    selections: Selection[];
} | {
    type: "Invert";
    selections: Selection[];
} | {
    type: "Filter";
    field: string;
    op: FilterOp;
    value: any;
    value2?: any | null;
    tzLocal?: boolean;
} | {
    type: "TopK";
    field: string;
    k: number;
    ascending: boolean;
};
/**
 *  Selection bitmask sync payload. `bitmask` carries the packed per-cell bitmask bytes
 *  inline in the IPC response (no shared temp file → no clobber race under concurrent
 *  mutations). `None` when nothing changed. `counts` gives per-selection match counts.
 */
type SelectionSync = {
    /**  Resolved count per selection node, keyed by `Selection.key` (top-level and nested). */
    counts: {
        [key in string]: number;
    };
    bitmask: number[] | null;
    selectedCount: number;
};
type SpacedPickResult = {
    ids: number[];
    distanceM: number;
};
/**
 *  Metadata snapshot returned to JS after every mutation. JS uses `version` to
 *  detect stale responses and `canUndo`/`canRedo` for toolbar button state.
 *  `known_field_keys` lists every extra-field key that exists in location data
 *  on this map. Add-only within a session; seeded from `MapMeta.extra.fields`
 *  on map open.
 */
type StoreStatus = {
    version: number;
    locationCount: number;
    canUndo: boolean;
    canRedo: boolean;
    /**
     *  `None` when the mutation did not change any tag count (`finish_mutation`
     *  strips it), so JS keeps its reference and consumers skip re-rendering.
     */
    tagCounts: {
        [key in number]: number;
    } | null;
    knownFieldKeys: string[];
};
/**  Lightweight status for polling: count, version, and whether unsaved changes exist. */
type SummaryResult = {
    locationCount: number;
    version: number;
    dirtyCount: number;
};
/**
 *  A user-defined label that can be applied to any number of locations.
 *
 *  Tags are stored in `MapMeta` and referenced by id in each `Location.tags`.
 *  The `count` field is maintained by callers during batch mutations, not by
 *  the overlay add/remove methods.
 */
type Tag = {
    id: number;
    name: string;
    /**
     *  Hex color string (e.g. "#3a7fc2"). Generated deterministically from
     *  the tag name via `util::color_for_name` when not explicitly set.
     */
    color: string;
    visible?: boolean;
    /**
     *  Display order in the sidebar tag list. `None` for legacy tags
     *  that predate ordered insertion.
     */
    order?: number | null;
    /**
     *  Number of locations currently carrying this tag. Denormalized for
     *  fast sidebar display -- kept in sync by callers after batch edits.
     */
    count?: number;
    /**
     *  Document links from the map JSON's `extra.tags[name].doclinks` --
     *  URLs into external docs (e.g. Google Docs heading links). Read-only
     *  in the app; round-trips through import/export.
     */
    doclinks?: string[];
};
/**  Patchable fields of a `Tag`. Subset by design: id/count/visible aren't editable here. */
type TagPatch = {
    name?: string | null;
    color?: string | null;
    /**  Full replacement for the tag's doclink URLs (empty vec clears). */
    doclinks?: string[] | null;
};
/**
 *  Generic `{id, patch}` update envelope, parameterized by the patch type. Specta
 *  has no `Partial<T>`, and a patch is a deliberate *subset* of patchable fields, so
 *  each entity names its own patch struct (e.g. `TagPatch`) rather than deriving one.
 */
type Update<P> = {
    id: number;
    patch: P;
};
type ValiLocation_Deserialize = {
    lat: number;
    lng: number;
    heading: number;
    zoom: number | null;
    pitch: number | null;
    panoId: string | null;
    tags: string[];
};
type ValiLocation = {
    lat: number;
    lng: number;
    heading: number;
    zoom?: number | null;
    pitch?: number | null;
    panoId?: string | null;
    tags: string[];
};
/**
 *  Per-map config for a virtual tag-tree node — a folder node with no underlying
 *  tag (e.g. "a" when only "a/b" and "a/c" exist). Keyed by the node's full slash
 *  path in `MapSettings::virtual_tags`. Tree-view only; never creates a real tag.
 */
type VirtualTag = {
    color?: string | null;
};

export type LatLng = google.maps.LatLngLiteral;
export type Bounds = google.maps.LatLngBoundsLiteral;
/** Panorama source type from Google's internal metadata. */
declare const enum PanoType {
    Official = 2,
    Unknown = 3,
    UserUploaded = 10
}
/** A location you already hold in full, or just its id to fetch on demand.
 *  Lets the pick -> activate path carry "materialized or not" as plain data;
 *  `resolveLocation` (in the store) fetches only the id case. */
export type MaybeLocation = Location | number;
/** Build a Location from lat/lng plus overrides. `id` stays 0 until `addLocations`
 *  writes the real id back into the object. */
declare function createLocation(partial: Partial<Location> & LatLng): Location;
export type TagSortMode = "default" | "name" | "amount";
export type WorkArea = "overview" | "location" | "duplicates" | "import" | "plugin" | "diff";
/** Hex like "#1098ad"; legacy stored prefs may hold an Open Props ramp name. */
export type SvColor = string;
export type MapTypeKey = "map" | "satellite" | "osm" | "vector";
export type SvCoverageType = "official" | "unofficial" | "default";
export type SvThickness = "default" | "high";
export type MarkerStyle = "pin" | "circle" | "arrow";

/**
 * Pure planning logic for bulk metadata-field operations (rename / merge / delete / set).
 * These compute `extra` merge patches (RFC 7386: null deletes a key) and selection-reference
 * rewrites; the store orchestrates IPC, definitions, and persistence. Side-effect-free.
 */

/** When a move target already holds a value, which field's value survives. */
export type MergeWinner = "from" | "to";

/** Per-cell, per-selection membership: a dense bitmask or a sparse selected-index list. */
export type SelEntry = {
    kind: "mask";
    mask: Uint8Array;
} | {
    kind: "idx";
    indices: Uint32Array;
};
export interface SelCellEntry {
    cellChar: string;
    locCount: number;
    sels: SelEntry[];
}
/** The read-only id-membership surface shared by `Set<number>` and `SelectedIds`, for code
 *  that only needs `size` / `has` / iteration over either. */
export interface ReadonlyIdSet extends Iterable<number> {
    readonly size: number;
    has(id: number): boolean;
}
/**
 * Membership set of selected location ids, backed by a bit array indexed by id rather than a
 * hash `Set`. Location ids are dense u32s, so a bitset makes the build ~10x cheaper than 1M
 * `Set.add`s (a typed-array OR vs hashing), with O(1) `has`/`size`. Iteration yields the
 * selected ids from the overlay's id array. Exposes the Set-like surface its consumers use.
 */
declare class SelectedIds {
    private readonly bits;
    /** Count of distinct selected ids (not overlay entries — an id selected by N
     *  overlapping selections still counts once). */
    readonly size: number;
    /** Shared empty selection (no map open / cleared). */
    static readonly EMPTY: SelectedIds;
    constructor(bits: Uint8Array, 
    /** Count of distinct selected ids (not overlay entries — an id selected by N
     *  overlapping selections still counts once). */
    size: number);
    has(id: number): boolean;
    /** Yields each selected id once, ascending. Scans the bit array, so it's O(maxId/8);
     *  used by deliberate bulk consumers (export, bulk-tag, delete), not the per-frame path. */
    [Symbol.iterator](): Iterator<number>;
}

/** Pure selection transforms. These only manipulate the JS selection tree; Rust resolves the actual bitmasks. */

/** Variants that wrap children — derived as exactly those carrying a `selections` array. */
export type CompositeType = Extract<SelectionProps, {
    selections: Selection[];
}>["type"];
/** Composite variants that wrap exactly one child (operators, not bags). They never collapse — a
 *  one-child group is degenerate, but one child is a unary node's only valid arity. */
export type UnaryType = "Invert";
/** Composite variants that are flat n-ary groups. */
export type GroupType = Exclude<CompositeType, UnaryType>;
declare enum ValidationState {
    Ok = 0,
    UpdateAvailable = 1,
    UpdateApplied = 2,
    NotFound = 3,
    PanoIdBroke = 4,
    Unofficial = 5,
    GoodcamAvailable = 6
}

/** Reactive per-tag location counts for the open map, keyed by tag id. */
declare const useTagCounts: () => Record<number, number>;
/** Per-tag location counts for the open map, keyed by tag id. */
declare function getTagCounts(): Record<number, number>;
/** Reactive open map (metadata + settings), or null when no map is open. */
declare const useCurrentMap: () => MapData | null;
/** Tags that exist from the user's point of view. Raw `meta.tags` also holds soft-deleted ghosts (count=0, visible=false, kept for undo revival) — almost nothing outside the undo/revival machinery should enumerate those. */
declare const getVisibleTags: () => Tag[];
declare const useVisibleTags: () => Tag[];
/** Raw by-id tag lookup — includes soft-deleted ghosts so stale references
 *  (e.g. a selection whose tag just died) still resolve to a name. */
declare function getTag(id: number): Tag | undefined;
/** Reactive set of all currently selected location ids. */
declare const useSelectedLocationIds: () => SelectedIds;
/** Reactive location currently open in the editor, or null. */
declare const useActiveLocation: () => Location | null;
/** Locations shown in the duplicate-resolution panel. */
declare function getDuplicateLocations(): Location[];
/** Reactive locations shown in the duplicate-resolution panel. */
declare const useDuplicateLocations: () => Location[];
/** Reactive editor pane: "overview" | "location" | "duplicates" | "import" | "plugin". */
declare const useWorkArea: () => WorkArea;
declare function hasCommitDiff(): boolean;
declare function useCommitDiff(): {
    added: number;
    removed: number;
    modified: number;
};
/** Number of uncommitted changes (the overlay size). */
declare function getDirtyCount(): Promise<number>;
/** Schedule an autosave shortly. Mutations call this automatically; debounced. */
declare function scheduleSave(): void;
declare function cancelAutosave(): void;
declare function waitForInflightPersist(): Promise<void> | null;
/** Background auto-commit after an import with autoCommit set. */
declare function scheduleAutoCommit(mapId: string, importedCount: number): void;
/** Save any unsaved changes now instead of waiting for the autosave timer. */
declare function flushSave(): Promise<void>;
/** One-time store startup. The app calls this; plugins never need to. */
declare function initStore(): Promise<void>;
/** Cross-module stopwatch for map-open latency. */
declare const mapOpen: {
    start: number;
    seen: Set<string>;
    begin(): void;
    mark(phase: string): void;
};
/** Open a map in this window, closing any currently open map first. */
declare function openMap(id: string): Promise<void>;
/** Close the open map, saving unsaved changes first. */
declare function closeMap(): Promise<void>;
/** Drop the open map without persisting anything */
declare function discardOpenMap(): void;
/** Id of the open map, or null. */
declare function getCurrentMapId(): string | null;
/** The open map (metadata + settings), or null. */
declare function getCurrentMap(): MapData | null;
/** Returns the set of extra-field keys known to exist on the current map. */
declare function getKnownFieldKeys(): ReadonlySet<string>;
/** Reactive hook for `knownFieldKeys`. Re-renders when keys are added. */
declare const useKnownFieldKeys: () => ReadonlySet<string>;
/** The location currently open in the editor, or null. */
declare function getActiveLocation(): Location | null;
/** Fetch every location in the map. */
declare function fetchAllLocations(): Promise<Location[]>;
/** Fetch one location by id, or null if it doesn't exist. */
declare function fetchLocation(id: number): Promise<Location | null>;
/** Fetch locations by id (missing ids are skipped). Prefer this over per-id fetches. */
declare function fetchLocationsByIds(ids: number[]): Promise<Location[]>;
/** All selections including ghosted. Only for rendering/UI that needs the full list. */
declare function getAllSelections(): Selection[];
/** Active (non-ghosted) selections, the default for any operational logic. */
declare const getSelections: () => Selection[];
/** The set of all currently selected location ids (the union of all selections). */
declare function getSelectedLocationIds(): SelectedIds;
/** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want -- prefer `addSelections`. */
declare function setSelectedLocationIds(ids: SelectedIds): void;
/** @internal Test-only. Forces a full selection re-resolve in Rust and returns
 *  the raw selected IDs. App code should use getSelectedLocationIds() instead —
 *  mutations already sync selections via MutationResult. */
declare function syncSelections(): Promise<{
    ids: number[];
}>;
declare function renameMap(id: string, name: string): Promise<void>;
declare function updateMapLabels(id: string, labels: string[]): Promise<void>;
declare function updateMapMeta(patch: MapMetaPatch_Deserialize): Promise<void> | undefined;
/** Replace the map's extra-field definitions (types/labels for `Location.extra` keys). */
declare function setMapExtraFields(fields: Record<string, ExtraFieldDef>): Promise<void>;
/** Decode the inline bitmask bytes from Rust and emit to the event bus. */
declare function emitBitmask(bytes: number[]): void;
/** Run a mutation IPC, emit its render delta, sync JS state, and schedule a save. */
declare function mutate(fn: () => Promise<MutationResult>): Promise<MutationResult>;
/** Add locations to the map. Rust assigns real ids and they are written back into
 *  the passed objects -- build with `createLocation` (id 0) and read `loc.id` after. Undoable. */
declare function addLocations(locs: Location[], opts?: {
    hideInDelta?: boolean;
}): Promise<void>;
/** Clone a location in place and return the new id, or null if it doesn't exist. Undoable. */
declare function duplicateLocation(id: number): Promise<number | null>;
/** Remove locations by id. Undoable. */
declare function removeLocations(ids: ReadonlyIdSet): Promise<void>;
/** Patch locations by id. Only include the fields you're changing; `extra` merges
 *  per-key (null deletes a key). Undoable by default. */
declare function updateLocations(updates: Update<LocationPatch_Deserialize>[], opts?: {
    undoable?: boolean;
}): Promise<void>;
/** Rename or merge extra-field `from` into `to` across all locations, then migrate
 *  its definition and every selection that references it. Merge ≡ rename; `winner`
 *  decides the survivor only where a location already holds `to`. */
declare function renameField(from: string, to: string, winner?: MergeWinner): Promise<void>;
/** Delete extra-field `key` from every location, its definition, and references. */
declare function deleteField(key: string): Promise<void>;
/** All selections including ghosted. Only for rendering/UI that needs the full list. */
declare const useAllSelections: () => Selection[];
/** Active (non-ghosted) selections — the default for any operational logic. */
declare const useSelections: () => Selection[];
/** Keyed per-node selection counts (by `Selection.key`). Look up a row's count by its key. */
declare const useSelectionCounts: () => Record<string, number>;
/** Per-selection location counts, keyed by `Selection.key`. */
declare function getSelectionCounts(): Record<string, number>;
/** Reactive set of ghosted (temporarily excluded) selection keys. */
declare const useGhostedSelections: () => ReadonlySet<string>;
/** The set of ghosted (temporarily excluded) selection keys. */
declare const getGhostedSelections: () => ReadonlySet<string>;
/** Toggle a selection's ghosted state and re-sync (excludes/includes it from the overlay). */
declare function toggleGhostSelection(key: string): Promise<void>;
/** "Solo" a selection: ghost every other top-level selection, keep this one visible.
 *  If it is already the only visible one, un-ghost everything (toggle back). */
declare function isolateSelection(key: string): Promise<void>;
/** Ghost every top-level selection; if all are already ghosted, un-ghost them all. */
declare function toggleGhostAllSelections(): Promise<void>;
/** Add selections to the sidebar and highlight their locations. Same-key selections replace. */
declare function addSelections(props: SelectionProps[]): Promise<void>;
/** No-op (no sync) when none of the keys are live selections. */
declare function removeSelections(keys: string[]): Promise<void> | undefined;
/** Clear all selections. */
declare function resetSelections(): Promise<void>;
/** Combine selections into an AND composite. `keys` null combines all top-level selections. */
declare function selectIntersection(keys?: string[] | null): Promise<void>;
/** Combine selections into an OR composite. `keys` null combines all top-level selections. */
declare function selectUnion(keys?: string[] | null): Promise<void>;
/** Wrap selections in an Invert composite (everything NOT in them). `keys` null inverts all. */
declare function selectInverse(keys?: string[] | null): Promise<void>;
/** Add or remove one location from the Manual selection (creating it if needed). */
declare function toggleManualSelection(locationId: number): Promise<void>;
/** Replace the current selection with a single Manual selection holding `count` ids picked
 *  at random from whatever is currently selected. `count` is clamped to the selection size.
 *  No-op when nothing is selected. Returns the number of ids actually picked. */
declare function selectRandomFromSelection(count: number): number;
/** Replace the current selection with a single Manual selection of ids picked from the
 *  current selection, spaced apart in Rust: either `count` ids maximizing spacing, or as
 *  many as fit at `minDistanceM`. No-op when the pick returns nothing. */
declare function selectSpacedFromSelection(opts: {
    count?: number;
    minDistanceM?: number;
}): Promise<{
    picked: number;
    distanceM: number;
}>;
/** Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres. */
declare function previewDuplicateGroups(distance: number): Promise<number[][]>;
/** Merge each transitive duplicate group into one survivor (tags unioned). One undoable edit. */
declare function mergeDuplicates(distance: number): Promise<void>;
/**
 * Prune duplicates within a resolved selection: keeps the most relevant location per
 * cluster (<= 25m) or thins to enforce spacing (> 25m). Locations tagged "keep pano"
 * get a +5 score bonus. Returns the number pruned.
 */
declare function pruneDuplicates(props: SelectionProps, distance: number): Promise<number>;
/** Edit an existing filter (or any selection) in place by key, preserving its
 *  position inside any AND/OR/Invert composite. Carries ghost state to the new key. */
declare function updateFilterSelection(oldKey: string, props: SelectionProps): Promise<void>;
/** Rename a polygon selection. */
declare function setPolygonName(key: string, name: string): Promise<void>;
/** Set the highlight color of selections, by key. */
declare function setSelectionColors(entries: {
    key: string;
    color: [number, number, number];
}[]): void;
/** Move a selection before/after another in the sidebar order. */
declare function reorderSelection(fromKey: string, toKey: string, position: "before" | "after"): void;
/** Nest existing selections under a new AND/OR/Invert composite. */
declare function composeSelections(dragKey: string, dropKey: string, mode: GroupType, dragParent: string | null, dropParent: string | null): void;
/** Pull a child out of a composite back to the top level. */
declare function decomposeChild(parentKey: string, childKey: string): void;
/** Delete a child from a composite (without re-adding it at the top level). */
declare function removeChildFromSelection(parentKey: string, childKey: string): void;
/** Toggle tag selections on/off for the given tags (used by tag-pill clicks). */
declare function toggleTagSelections(tagIds: number[]): void;
declare const useSelectedTagIds: () => ReadonlySet<number>;
/** Open a staged-import location read-only, "as if" it were active. The location becomes
 *  virtual (negative id; ImportPreview flag) so identity and mutate-guards derive from it. */
declare function openStagedLocation(index: number): Promise<void>;
/** Open an arbitrary location read-only as a virtual seen-preview: loads its pano without
 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. */
declare function previewVirtualLocation(loc: Location): void;
/** Materialize a `MaybeLocation`. */
declare function resolveLocation(m: MaybeLocation): Promise<Location | null>;
/** Open a location in the editor (null closes it). With `checkDuplicates`, opening a spot
 *  with 2+ locations within 2m opens the duplicate-resolution panel instead. */
declare function setActiveLocation(target: MaybeLocation | null, checkDuplicates?: boolean): Promise<void>;
/** Open one location from the duplicate-resolution panel in the editor. */
declare function openDuplicateLocation(loc: Location): void;
/** Drop a location from the duplicate-resolution panel (does not delete it). */
declare function removeDuplicate(id: number): void;
/** Close the duplicate-resolution panel and return to the overview. */
declare function closeDuplicates(): void;
/** Transition the editor pane, enforcing state invariants:
 *  leaving "location" clears the active location, leaving "plugin" clears the plugin id. */
declare function setWorkArea(area: WorkArea): void;
/** The id of the plugin whose sidebar is open, or null. */
declare function getActivePluginId(): string | null;
/** Reactive id of the plugin whose sidebar is open, or null. */
declare const useActivePluginId: () => string | null;
/** The current editor pane. */
declare function getWorkArea(): WorkArea;
/** Open a plugin's sidebar (switches the editor pane to "plugin"). */
declare function setPluginMode(pluginId: string): void;
/** Close the plugin sidebar and return to the overview. */
declare function exitPluginMode(): void;
/** Get-or-create tags by name. Returns the tag objects for use
 *  in subsequent location updates. Idempotent — existing tags are returned
 *  as-is, new names get auto-generated colors. */
declare function createTags(names: string[]): Promise<Tag[]>;
/** Rename or recolor tags. If a rename collides with an existing tag name
 *  (case-insensitive), the two tags are merged — all locations are remapped
 *  to the survivor. */
declare function updateTags(updates: Update<TagPatch>[]): Promise<void>;
/** Delete tags and strip them from all locations. Undoable (the location
 *  changes are in the undo stack; visibility auto-restores on undo). */
declare function deleteTags(tagIds: number[]): Promise<void>;
/** Persist a new tag display order. */
declare function reorderTags(orderedIds: number[]): Promise<void>;
/** Add a tag to locations (skips ones that already have it). Undoable. */
declare function addTagToLocations(tagId: number, locationIds: number[]): Promise<void>;
/** Remove a tag from the given locations. Undoable. */
declare function removeTagFromLocations(tagId: number, locationIds: number[]): Promise<void>;
/** Remove a tag from every location that has it. Undoable. */
declare function removeTagFromAllLocations(tagId: number): Promise<void>;
/** Undo the last edit. */
declare function undo(): Promise<void>;
/** Redo the last undone edit. */
declare function redo(): Promise<void>;
/** Whether undo/redo are currently available. */
declare function getUndoRedoState(): {
    canUndo: boolean;
    canRedo: boolean;
};
declare const useUndoRedo: () => {
    canUndo: boolean;
    canRedo: boolean;
};
/** Bake overlay, write the commit delta, create a VCS commit. Resets undo stack. */
declare function commitMap(message?: string): Promise<string>;
/** Restore the map to a previous commit's state and reopen it. Clears undo/redo. */
declare function checkoutCommit(commitId: string): Promise<void>;

declare const store_addLocations: typeof addLocations;
declare const store_addSelections: typeof addSelections;
declare const store_addTagToLocations: typeof addTagToLocations;
declare const store_cancelAutosave: typeof cancelAutosave;
declare const store_checkoutCommit: typeof checkoutCommit;
declare const store_closeDuplicates: typeof closeDuplicates;
declare const store_closeMap: typeof closeMap;
declare const store_commitMap: typeof commitMap;
declare const store_composeSelections: typeof composeSelections;
declare const store_createTags: typeof createTags;
declare const store_decomposeChild: typeof decomposeChild;
declare const store_deleteField: typeof deleteField;
declare const store_deleteTags: typeof deleteTags;
declare const store_discardOpenMap: typeof discardOpenMap;
declare const store_duplicateLocation: typeof duplicateLocation;
declare const store_emitBitmask: typeof emitBitmask;
declare const store_exitPluginMode: typeof exitPluginMode;
declare const store_fetchAllLocations: typeof fetchAllLocations;
declare const store_fetchLocation: typeof fetchLocation;
declare const store_fetchLocationsByIds: typeof fetchLocationsByIds;
declare const store_flushSave: typeof flushSave;
declare const store_getActiveLocation: typeof getActiveLocation;
declare const store_getActivePluginId: typeof getActivePluginId;
declare const store_getAllSelections: typeof getAllSelections;
declare const store_getCurrentMap: typeof getCurrentMap;
declare const store_getCurrentMapId: typeof getCurrentMapId;
declare const store_getDirtyCount: typeof getDirtyCount;
declare const store_getDuplicateLocations: typeof getDuplicateLocations;
declare const store_getGhostedSelections: typeof getGhostedSelections;
declare const store_getKnownFieldKeys: typeof getKnownFieldKeys;
declare const store_getSelectedLocationIds: typeof getSelectedLocationIds;
declare const store_getSelectionCounts: typeof getSelectionCounts;
declare const store_getSelections: typeof getSelections;
declare const store_getTag: typeof getTag;
declare const store_getTagCounts: typeof getTagCounts;
declare const store_getUndoRedoState: typeof getUndoRedoState;
declare const store_getVisibleTags: typeof getVisibleTags;
declare const store_getWorkArea: typeof getWorkArea;
declare const store_hasCommitDiff: typeof hasCommitDiff;
declare const store_initStore: typeof initStore;
declare const store_isolateSelection: typeof isolateSelection;
declare const store_mapOpen: typeof mapOpen;
declare const store_mergeDuplicates: typeof mergeDuplicates;
declare const store_mutate: typeof mutate;
declare const store_openDuplicateLocation: typeof openDuplicateLocation;
declare const store_openMap: typeof openMap;
declare const store_openStagedLocation: typeof openStagedLocation;
declare const store_previewDuplicateGroups: typeof previewDuplicateGroups;
declare const store_previewVirtualLocation: typeof previewVirtualLocation;
declare const store_pruneDuplicates: typeof pruneDuplicates;
declare const store_redo: typeof redo;
declare const store_removeChildFromSelection: typeof removeChildFromSelection;
declare const store_removeDuplicate: typeof removeDuplicate;
declare const store_removeLocations: typeof removeLocations;
declare const store_removeSelections: typeof removeSelections;
declare const store_removeTagFromAllLocations: typeof removeTagFromAllLocations;
declare const store_removeTagFromLocations: typeof removeTagFromLocations;
declare const store_renameField: typeof renameField;
declare const store_renameMap: typeof renameMap;
declare const store_reorderSelection: typeof reorderSelection;
declare const store_reorderTags: typeof reorderTags;
declare const store_resetSelections: typeof resetSelections;
declare const store_resolveLocation: typeof resolveLocation;
declare const store_scheduleAutoCommit: typeof scheduleAutoCommit;
declare const store_scheduleSave: typeof scheduleSave;
declare const store_selectIntersection: typeof selectIntersection;
declare const store_selectInverse: typeof selectInverse;
declare const store_selectRandomFromSelection: typeof selectRandomFromSelection;
declare const store_selectSpacedFromSelection: typeof selectSpacedFromSelection;
declare const store_selectUnion: typeof selectUnion;
declare const store_setActiveLocation: typeof setActiveLocation;
declare const store_setMapExtraFields: typeof setMapExtraFields;
declare const store_setPluginMode: typeof setPluginMode;
declare const store_setPolygonName: typeof setPolygonName;
declare const store_setSelectedLocationIds: typeof setSelectedLocationIds;
declare const store_setSelectionColors: typeof setSelectionColors;
declare const store_setWorkArea: typeof setWorkArea;
declare const store_syncSelections: typeof syncSelections;
declare const store_toggleGhostAllSelections: typeof toggleGhostAllSelections;
declare const store_toggleGhostSelection: typeof toggleGhostSelection;
declare const store_toggleManualSelection: typeof toggleManualSelection;
declare const store_toggleTagSelections: typeof toggleTagSelections;
declare const store_undo: typeof undo;
declare const store_updateFilterSelection: typeof updateFilterSelection;
declare const store_updateLocations: typeof updateLocations;
declare const store_updateMapLabels: typeof updateMapLabels;
declare const store_updateMapMeta: typeof updateMapMeta;
declare const store_updateTags: typeof updateTags;
declare const store_useActiveLocation: typeof useActiveLocation;
declare const store_useActivePluginId: typeof useActivePluginId;
declare const store_useAllSelections: typeof useAllSelections;
declare const store_useCommitDiff: typeof useCommitDiff;
declare const store_useCurrentMap: typeof useCurrentMap;
declare const store_useDuplicateLocations: typeof useDuplicateLocations;
declare const store_useGhostedSelections: typeof useGhostedSelections;
declare const store_useKnownFieldKeys: typeof useKnownFieldKeys;
declare const store_useSelectedLocationIds: typeof useSelectedLocationIds;
declare const store_useSelectedTagIds: typeof useSelectedTagIds;
declare const store_useSelectionCounts: typeof useSelectionCounts;
declare const store_useSelections: typeof useSelections;
declare const store_useTagCounts: typeof useTagCounts;
declare const store_useUndoRedo: typeof useUndoRedo;
declare const store_useVisibleTags: typeof useVisibleTags;
declare const store_useWorkArea: typeof useWorkArea;
declare const store_waitForInflightPersist: typeof waitForInflightPersist;
declare namespace store {
  export {
    store_addLocations as addLocations,
    store_addSelections as addSelections,
    store_addTagToLocations as addTagToLocations,
    store_cancelAutosave as cancelAutosave,
    store_checkoutCommit as checkoutCommit,
    store_closeDuplicates as closeDuplicates,
    store_closeMap as closeMap,
    store_commitMap as commitMap,
    store_composeSelections as composeSelections,
    store_createTags as createTags,
    store_decomposeChild as decomposeChild,
    store_deleteField as deleteField,
    store_deleteTags as deleteTags,
    store_discardOpenMap as discardOpenMap,
    store_duplicateLocation as duplicateLocation,
    store_emitBitmask as emitBitmask,
    store_exitPluginMode as exitPluginMode,
    store_fetchAllLocations as fetchAllLocations,
    store_fetchLocation as fetchLocation,
    store_fetchLocationsByIds as fetchLocationsByIds,
    store_flushSave as flushSave,
    store_getActiveLocation as getActiveLocation,
    store_getActivePluginId as getActivePluginId,
    store_getAllSelections as getAllSelections,
    store_getCurrentMap as getCurrentMap,
    store_getCurrentMapId as getCurrentMapId,
    store_getDirtyCount as getDirtyCount,
    store_getDuplicateLocations as getDuplicateLocations,
    store_getGhostedSelections as getGhostedSelections,
    store_getKnownFieldKeys as getKnownFieldKeys,
    store_getSelectedLocationIds as getSelectedLocationIds,
    store_getSelectionCounts as getSelectionCounts,
    store_getSelections as getSelections,
    store_getTag as getTag,
    store_getTagCounts as getTagCounts,
    store_getUndoRedoState as getUndoRedoState,
    store_getVisibleTags as getVisibleTags,
    store_getWorkArea as getWorkArea,
    store_hasCommitDiff as hasCommitDiff,
    store_initStore as initStore,
    store_isolateSelection as isolateSelection,
    store_mapOpen as mapOpen,
    store_mergeDuplicates as mergeDuplicates,
    store_mutate as mutate,
    store_openDuplicateLocation as openDuplicateLocation,
    store_openMap as openMap,
    store_openStagedLocation as openStagedLocation,
    store_previewDuplicateGroups as previewDuplicateGroups,
    store_previewVirtualLocation as previewVirtualLocation,
    store_pruneDuplicates as pruneDuplicates,
    store_redo as redo,
    store_removeChildFromSelection as removeChildFromSelection,
    store_removeDuplicate as removeDuplicate,
    store_removeLocations as removeLocations,
    store_removeSelections as removeSelections,
    store_removeTagFromAllLocations as removeTagFromAllLocations,
    store_removeTagFromLocations as removeTagFromLocations,
    store_renameField as renameField,
    store_renameMap as renameMap,
    store_reorderSelection as reorderSelection,
    store_reorderTags as reorderTags,
    store_resetSelections as resetSelections,
    store_resolveLocation as resolveLocation,
    store_scheduleAutoCommit as scheduleAutoCommit,
    store_scheduleSave as scheduleSave,
    store_selectIntersection as selectIntersection,
    store_selectInverse as selectInverse,
    store_selectRandomFromSelection as selectRandomFromSelection,
    store_selectSpacedFromSelection as selectSpacedFromSelection,
    store_selectUnion as selectUnion,
    store_setActiveLocation as setActiveLocation,
    store_setMapExtraFields as setMapExtraFields,
    store_setPluginMode as setPluginMode,
    store_setPolygonName as setPolygonName,
    store_setSelectedLocationIds as setSelectedLocationIds,
    store_setSelectionColors as setSelectionColors,
    store_setWorkArea as setWorkArea,
    store_syncSelections as syncSelections,
    store_toggleGhostAllSelections as toggleGhostAllSelections,
    store_toggleGhostSelection as toggleGhostSelection,
    store_toggleManualSelection as toggleManualSelection,
    store_toggleTagSelections as toggleTagSelections,
    store_undo as undo,
    store_updateFilterSelection as updateFilterSelection,
    store_updateLocations as updateLocations,
    store_updateMapLabels as updateMapLabels,
    store_updateMapMeta as updateMapMeta,
    store_updateTags as updateTags,
    store_useActiveLocation as useActiveLocation,
    store_useActivePluginId as useActivePluginId,
    store_useAllSelections as useAllSelections,
    store_useCommitDiff as useCommitDiff,
    store_useCurrentMap as useCurrentMap,
    store_useDuplicateLocations as useDuplicateLocations,
    store_useGhostedSelections as useGhostedSelections,
    store_useKnownFieldKeys as useKnownFieldKeys,
    store_useSelectedLocationIds as useSelectedLocationIds,
    store_useSelectedTagIds as useSelectedTagIds,
    store_useSelectionCounts as useSelectionCounts,
    store_useSelections as useSelections,
    store_useTagCounts as useTagCounts,
    store_useUndoRedo as useUndoRedo,
    store_useVisibleTags as useVisibleTags,
    store_useWorkArea as useWorkArea,
    store_waitForInflightPersist as waitForInflightPersist,
  };
}

/** Prompt for GeoJSON file(s) and add their polygons as selections. */
declare function loadGeoJSON(): Promise<void>;

declare const requiresMap: () => boolean;
declare const hasSelection: () => boolean;
declare const hasAnySelections: () => boolean;
/** Every editor command (palette entries; all are hotkey-bindable in Settings). */
declare const COMMANDS: {
    save: {
        label: string;
        icon: string;
        group: "Map";
        defaultBinding: string;
        aliases: string[];
        execute: () => Promise<string>;
        enabled: () => boolean;
    };
    import: {
        label: string;
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    copyToMap: {
        label: string;
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    quickCopyToMap: {
        label: string;
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    undo: {
        label: string;
        icon: string;
        group: "Map";
        defaultBinding: string;
        execute: typeof undo;
        enabled: () => boolean;
    };
    redo: {
        label: string;
        icon: string;
        group: "Map";
        defaultBinding: string;
        execute: typeof redo;
        enabled: () => boolean;
    };
    export: {
        label: string;
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "open-history": {
        label: string;
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "open-seen": {
        label: string;
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "toggle-seen-overlay": {
        label: string;
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    selectAll: {
        label: string;
        icon: string;
        group: "Selections";
        defaultBinding: string;
        execute: () => Promise<void>;
    };
    "select-untagged": {
        label: string;
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => Promise<void>;
    };
    "select-unpanned": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "select-panoid": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "select-no-panoid": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "select-uncommitted": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "select-reviewed": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
        enabled: typeof requiresMap;
    };
    "invert-selection": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "intersect-selections": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "union-selections": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "load-geojson": {
        label: string;
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: typeof loadGeoJSON;
    };
    "download-polygon-geojson": {
        label: string;
        icon: string;
        group: "Selections";
        enabled: () => boolean;
        execute: () => void;
    };
    deselectAll: {
        label: string;
        icon: string;
        group: "Selections";
        defaultBinding: string;
        execute: typeof resetSelections;
        enabled: typeof hasAnySelections;
    };
    "find-duplicates": {
        label: string;
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
    };
    "merge-duplicates": {
        label: string;
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
    };
    "filter-by-metadata": {
        label: string;
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
    };
    "top-k": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => void;
    };
    "review-selected": {
        label: string;
        icon: string;
        group: "Selections";
        enabled: typeof hasSelection;
        execute: () => void;
    };
    "review-sessions": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => void;
    };
    "select-random": {
        label: string;
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
        enabled: typeof hasSelection;
    };
    "select-spaced": {
        label: string;
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
        enabled: typeof hasSelection;
    };
    "ghost-selections": {
        label: string;
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => Promise<void>;
        enabled: typeof hasAnySelections;
    };
    "save-selections": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => void;
        enabled: typeof hasAnySelections;
    };
    "apply-saved-selection": {
        label: string;
        icon: string;
        group: "Selections";
        execute: () => void;
    };
    "selection-delete-locations": {
        label: string;
        icon: string;
        group: "Selections";
        enabled: typeof hasSelection;
        execute: () => void;
    };
    "bulk-validate": {
        label: string;
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-enrich": {
        label: string;
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-set-field": {
        label: string;
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-clear-fields": {
        label: string;
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-pin-pano": {
        label: string;
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-heading-road": {
        label: string;
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-download-panoramas": {
        label: string;
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "delete-selected-tags": {
        label: string;
        icon: string;
        group: "Tags";
        execute: () => Promise<void>;
        enabled: () => boolean;
    };
    "tag-download-csv": {
        label: string;
        icon: string;
        group: "Tags";
        execute: () => void;
    };
    "tag-find-replace": {
        label: string;
        icon: string;
        group: "Tags";
        aliases: string[];
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "apply-field-as-tags": {
        label: string;
        icon: string;
        group: "Tags";
        aliases: string[];
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "assign-doclinks": {
        label: string;
        icon: string;
        group: "Tags";
        aliases: string[];
        execute: () => void;
        enabled: typeof requiresMap;
    };
};
export type CommandId = keyof typeof COMMANDS;
export type PinnedEntry = CommandId | "---" | (string & {});

export interface SavedSelectionItem {
    props: SavedSelectionProps;
    color: [number, number, number];
}
export interface SavedSelection {
    id: string;
    name: string;
    items: SavedSelectionItem[];
    createdAt: number;
}
export type SavedSelectionProps = {
    type: "Everything";
} | {
    type: "Polygon";
    polygon: PolygonGeometry;
    includeInformational: boolean;
} | {
    type: "TagName";
    tagName: string;
} | {
    type: "Untagged";
} | {
    type: "Unpanned";
} | {
    type: "PanoIds";
} | {
    type: "NotPanoIds";
} | {
    type: "Uncommitted";
} | {
    type: "Duplicates";
    distance: number;
} | {
    type: "Filter";
    field: string;
    op: FilterOp;
    value: unknown;
    value2?: unknown;
} | {
    type: "TopK";
    field: string;
    k: number;
    ascending: boolean;
} | {
    type: "Intersection";
    selections: SavedSelectionProps[];
} | {
    type: "Union";
    selections: SavedSelectionProps[];
} | {
    type: "Invert";
    selections: SavedSelectionProps[];
};
/** Resolve a saved rule against the open map, or null when it no longer applies
 *  (e.g. the tag name doesn't exist here). */
declare function savedToSelectionProps(saved: SavedSelectionProps): SelectionProps | null;
/** Short human-readable description of a saved-selection rule. */
declare function describeRule(props: SavedSelectionProps): string;
/** All saved selection rules (global, name-based; shared across maps). */
declare function getSavedSelections(): SavedSelection[];

export type RGB = {
    r: number;
    g: number;
    b: number;
};

declare const MOVEMENT_MODES: {
    readonly moving: "Moving";
    readonly "no-move": "No Move";
    readonly nmpz: "NMPZ";
};
declare const SEEN_RESOLUTIONS: {
    readonly low: "Low (160x90)";
    readonly medium: "Medium (320x180)";
    readonly high: "High (640x360)";
};
declare const EXACT_DATE_FORMATS: {
    readonly date: "Date only";
    readonly datetime: "Date + time";
};
declare const DATE_TIMEZONES: {
    readonly location: "Location timezone";
    readonly utc: "UTC";
};
declare const MAP_LIST_FIELDS: {
    readonly locationCount: "Location count";
    readonly lastOpened: "Last opened";
    readonly created: "Date created";
};
declare const DISCORD_PRESENCE_MODES: {
    readonly off: "Off";
    readonly generic: "Generic (no map name)";
    readonly full: "Full (map name + count)";
};
declare const GEOCODE_PROVIDERS: {
    readonly local: "Local (offline)";
    readonly nominatim: "Nominatim";
    readonly google: "Google (from panorama)";
};
declare const TAG_VIEW_MODES: {
    readonly flat: "Flat";
    readonly tree: "Tree";
};
declare const TAG_FOLDER_COLOR_MODES: {
    readonly direct: "Fixed color";
    readonly firstChild: "Inherit first child";
};
declare const BORDER_DETAILS: {
    readonly light: "Standard (bundled)";
    readonly medium: "High (~10MB)";
    readonly heavy: "Ultra (~46MB)";
};
declare const SUBDIVISION_DETAILS: {
    readonly off: "Off";
    readonly adm1: "States / provinces";
};
declare const PREVIEW_ASPECT_RATIOS: {
    readonly "4 / 3": "4:3";
    readonly "16 / 10": "16:10";
    readonly "16 / 9": "16:9";
    readonly "21 / 9": "21:9";
    readonly "32 / 9": "32:9";
    readonly free: "Free";
};
export type MovementMode = keyof typeof MOVEMENT_MODES;
export type ExactDateFormat = keyof typeof EXACT_DATE_FORMATS;
export type DateTimezone = keyof typeof DATE_TIMEZONES;
export type SeenResolution = keyof typeof SEEN_RESOLUTIONS;
export type MapListField = keyof typeof MAP_LIST_FIELDS;
export type DiscordPresenceMode = keyof typeof DISCORD_PRESENCE_MODES;
export type GeocodeProvider = keyof typeof GEOCODE_PROVIDERS;
export type TagViewMode = keyof typeof TAG_VIEW_MODES;
export type TagFolderColorMode = keyof typeof TAG_FOLDER_COLOR_MODES;
export type BorderDetail = keyof typeof BORDER_DETAILS;
export type SubdivisionDetail = keyof typeof SUBDIVISION_DETAILS;
export type PreviewAspectRatio = keyof typeof PREVIEW_ASPECT_RATIOS;
declare const DEFAULTS: {
    showCameraBadges: boolean;
    showLinksControl: boolean;
    clickToGo: boolean;
    showRoadLabels: boolean;
    defaultMovementMode: MovementMode;
    showCar: boolean;
    showCrosshair: boolean;
    showCompass: boolean;
    showCompassTape: boolean;
    showZoom: boolean;
    showReturnToSpawn: boolean;
    showJumpButtons: boolean;
    showMapLinks: boolean;
    showCoordinateDisplay: boolean;
    showFullscreenButton: boolean;
    showPanoMetadata: boolean;
    exactDateFormat: ExactDateFormat;
    dateTimezone: DateTimezone;
    showNavArrow: boolean;
    showGroundArrow: boolean;
    hidePanoUI: boolean;
    fullscreenMap: boolean;
    showFullscreenMapMeta: boolean;
    showFullscreenMiniLocationPreview: boolean;
    fullscreenMiniLocationScale: number;
    showFullscreenMinimap: boolean;
    fullscreenMinimapScale: number;
    showFullscreenTagbar: boolean;
    showFullscreenDatePicker: boolean;
    customCss: string;
    enableSeen: boolean;
    enableSeenThumbnails: boolean;
    seenResolution: SeenResolution;
    mapPanSpeed: number;
    panoLookSpeed: number;
    slowModifier: number;
    showFps: boolean;
    mapListFields: MapListField[];
    /** Reopen the maps that were open when the session last ended (main window closed). */
    restoreSession: boolean;
    /** Discord Rich Presence: off, generic (no map name), or full (map name + count). */
    discordPresence: DiscordPresenceMode;
    /** Per-label color overrides (hex), keyed by lowercased label name. Shared across all maps. */
    labelColors: Record<string, string>;
    geocodeProvider: GeocodeProvider;
    nominatimApiKey: string;
    panToImported: boolean;
    /** Min half-extent (degrees) a single pasted/imported point is padded to before fitBounds */
    pastePadding: number;
    followActiveInReview: boolean;
    markerColor: RGB;
    activeLocationColor: RGB;
    importPreviewColor: RGB;
    panoDotColor: RGB;
    panoDotScaled: boolean;
    tagViewMode: TagViewMode;
    /** Tree view only: render each tag as the shortest path suffix that's still unique. */
    truncateTagPaths: boolean;
    /** Tree view: how a colorless folder row gets its color. `direct` uses tagFolderColor;
     *  `firstChild` inherits the first own-colored descendant in display order,
     *  with tagFolderColor as the fallback for colorless subtrees. */
    tagFolderColorMode: TagFolderColorMode;
    tagFolderColor: RGB;
    tagSortMode: TagSortMode;
    /** Gap between tag pills (px), shared by flat and tree views via `--tag-gap`. */
    tagGap: number;
    animateTagReorder: boolean;
    borderDetail: BorderDetail;
    subdivisionDetail: SubdivisionDetail;
    previewAspectRatio: PreviewAspectRatio;
    tagSuggestionLimit: number;
    savedSelections: SavedSelection[];
    /** Local REST transport for window.MMA (Settings > Advanced). */
    remoteApi: boolean;
    remoteApiKey: string;
    pinnedCommands: PinnedEntry[];
    hasSeenWelcome: boolean;
};
export type AppSettings = typeof DEFAULTS;
declare function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;

/** Parsed-but-not-committed import shown while `workArea === "import"`. */
export interface ImportStaging {
    preview: EditorImportPreview;
    source: "file" | "paste";
}
declare function getImportPreviewPositions(): Float32Array<ArrayBuffer>;
declare function getImportStaging(): ImportStaging | null;
/** Reset import state (called when map edit state is cleared). */
declare function resetImportState(): void;
/** Import from a known file path. Used by file picker and drag-and-drop. */
declare function beginImportFromPath(path: string): Promise<void>;
/** Stage pasted text for preview. Throws if no locations are found. */
declare function beginImportPaste(text: string): Promise<void>;
/** Commit the staged import, optionally dropping fields and applying a bulk tag. */
declare function confirmImport(droppedFields: string[], tagName?: string): Promise<EditorImportResult | null>;
/** Discard the staged import without committing. */
declare function cancelImport(): void;

export type importStaging_ImportStaging = ImportStaging;
declare const importStaging_beginImportFromPath: typeof beginImportFromPath;
declare const importStaging_beginImportPaste: typeof beginImportPaste;
declare const importStaging_cancelImport: typeof cancelImport;
declare const importStaging_confirmImport: typeof confirmImport;
declare const importStaging_getImportPreviewPositions: typeof getImportPreviewPositions;
declare const importStaging_getImportStaging: typeof getImportStaging;
declare const importStaging_resetImportState: typeof resetImportState;
declare namespace importStaging {
  export { importStaging_beginImportFromPath as beginImportFromPath, importStaging_beginImportPaste as beginImportPaste, importStaging_cancelImport as cancelImport, importStaging_confirmImport as confirmImport, importStaging_getImportPreviewPositions as getImportPreviewPositions, importStaging_getImportStaging as getImportStaging, importStaging_resetImportState as resetImportState };
  export type { importStaging_ImportStaging as ImportStaging };
}

/** Ephemeral commit-diff overlay shown while `workArea === "diff"`. Position arrays are
 *  interleaved `[lng, lat]` f32; `diff-markers:changed` fires to rebuild the layers. */
export interface CommitDiffPreview {
    commitId: string;
    hash: string;
    counts: CommitDiff;
    added: Float32Array;
    removed: Float32Array;
    modified: Float32Array;
}
declare function getCommitDiffPreview(): CommitDiffPreview | null;
/** Reset diff state (called when map edit state is cleared). */
declare function resetCommitDiffState(): void;
/** Interleave `[lng, lat]` pairs into an f32 buffer for deck.gl. */
declare function diffPositions(locs: LatLng[]): Float32Array;
/** Split a commit delta into added / removed / modified. An updated location appears in
 *  both `created` (new) and `removed` (old), keyed by id. */
declare function categorizeCommitDelta(delta: CommitDelta): {
    added: Location[];
    removed: Location[];
    modified: Location[];
};
/** Fetch a commit's delta and overlay its added/removed/modified locations on the map,
 *  temporarily replacing the regular markers. */
declare function beginCommitDiffPreview(commit: CommitInfo): Promise<void>;
/** Leave commit-diff preview and restore the regular markers. */
declare function endCommitDiffPreview(): void;

export type commitDiff_CommitDiffPreview = CommitDiffPreview;
declare const commitDiff_beginCommitDiffPreview: typeof beginCommitDiffPreview;
declare const commitDiff_categorizeCommitDelta: typeof categorizeCommitDelta;
declare const commitDiff_diffPositions: typeof diffPositions;
declare const commitDiff_endCommitDiffPreview: typeof endCommitDiffPreview;
declare const commitDiff_getCommitDiffPreview: typeof getCommitDiffPreview;
declare const commitDiff_resetCommitDiffState: typeof resetCommitDiffState;
declare namespace commitDiff {
  export { commitDiff_beginCommitDiffPreview as beginCommitDiffPreview, commitDiff_categorizeCommitDelta as categorizeCommitDelta, commitDiff_diffPositions as diffPositions, commitDiff_endCommitDiffPreview as endCommitDiffPreview, commitDiff_getCommitDiffPreview as getCommitDiffPreview, commitDiff_resetCommitDiffState as resetCommitDiffState };
  export type { commitDiff_CommitDiffPreview as CommitDiffPreview };
}

/** The user-facing "which locations" concept: Rust's mechanical Scope widened with
 *  saved selections, which resolve to ids in JS (Rust never sees saved definitions). */
export type SourceScope = Scope | {
    kind: "saved";
    id: string;
};
export interface ScopeController<S extends SourceScope = Scope> {
    scope: S;
    setScope(s: S): void;
    allCount: number;
    selectionCount: number;
    /** Opt-in: ScopeSelector offers saved selections. Only for consumers that
     *  narrow via resolveScopeIds rather than passing the scope to Rust. */
    saved?: boolean;
}
/** Narrow a materialized pool of id-bearing records to the scope's subset (JS-side). */
declare function applyScope(scope: Scope, pool: Location[]): Location[];
/** The id-set a scope narrows to, or null for "all". Saved scopes resolve in Rust. */
declare function resolveScopeIds(scope: SourceScope): Promise<{
    has(id: number): boolean;
    size: number;
} | null>;
/** Group the scoped location set by a derived key - entirely in Rust, no locations fetched.
 *  Numeric bins arrive in bound order; projection keys are sorted naturally for display. */
declare function partition(field: string, key: KeySpec, scope: Scope): Promise<PartitionBucket[]>;
/** Reactive scope state + live counts, owned by the calling React component. Defaults to
 *  the current selection when one exists at mount, else all locations. Use this for plugins
 *  whose scope lives entirely in a React sidebar; reach for `createScope` when an imperative
 *  renderer (e.g. a deck.gl overlay) outside React also needs to read the scope. */
declare function useScope(initial?: Scope): ScopeController;
/** A per-consumer scope store that lives outside React, so an imperative renderer can read it
 *  synchronously and subscribe to changes while a React sidebar drives it via `use()`. Mirrors
 *  the module-store + hook idiom (cf. settings). Isolated per call - one consumer's choice never
 *  leaks into another's. */
export interface ScopeHandle {
    get(): Scope;
    set(scope: Scope): void;
    subscribe(listener: () => void): () => void;
    /** React view of this handle: re-renders on change, with live counts. */
    use(): ScopeController;
}
/** A standalone "all locations vs current selection" switch, for features that operate on a subset. */
declare function createScope(initial?: Scope): ScopeHandle;

export type scope_ScopeController<S extends SourceScope = Scope> = ScopeController<S>;
export type scope_ScopeHandle = ScopeHandle;
export type scope_SourceScope = SourceScope;
declare const scope_applyScope: typeof applyScope;
declare const scope_createScope: typeof createScope;
declare const scope_partition: typeof partition;
declare const scope_resolveScopeIds: typeof resolveScopeIds;
declare const scope_useScope: typeof useScope;
declare namespace scope {
  export { scope_applyScope as applyScope, scope_createScope as createScope, scope_partition as partition, scope_resolveScopeIds as resolveScopeIds, scope_useScope as useScope };
  export type { scope_ScopeController as ScopeController, scope_ScopeHandle as ScopeHandle, scope_SourceScope as SourceScope };
}

/** Reactive list of all maps (metadata only). */
declare function useMapList(): MapMeta[];
/** The list of all maps (metadata only). */
declare function getMapList(): MapMeta[];
declare function reloadMapList(): Promise<void>;
/** Re-fetch the map list from the database. */
declare function invalidateMapList(): Promise<void>;
/** Set the cached map list directly (used by initStore). */
declare function setCachedMapList(list: MapMeta[]): void;
/** Create a new empty map and return its metadata. */
declare function createMap(name: string, folder?: string | null): Promise<MapMeta>;
/** Permanently delete a map and all its data. Not undoable. */
declare function deleteMap(id: string): Promise<void>;
declare function renameFolder(from: string, to: string): Promise<void>;
declare function moveMapToFolder(mapId: string, folder: string | null): Promise<void>;
declare function deleteFolder(name: string): Promise<void>;

declare const mapList_createMap: typeof createMap;
declare const mapList_deleteFolder: typeof deleteFolder;
declare const mapList_deleteMap: typeof deleteMap;
declare const mapList_getMapList: typeof getMapList;
declare const mapList_invalidateMapList: typeof invalidateMapList;
declare const mapList_moveMapToFolder: typeof moveMapToFolder;
declare const mapList_reloadMapList: typeof reloadMapList;
declare const mapList_renameFolder: typeof renameFolder;
declare const mapList_setCachedMapList: typeof setCachedMapList;
declare const mapList_useMapList: typeof useMapList;
declare namespace mapList {
  export {
    mapList_createMap as createMap,
    mapList_deleteFolder as deleteFolder,
    mapList_deleteMap as deleteMap,
    mapList_getMapList as getMapList,
    mapList_invalidateMapList as invalidateMapList,
    mapList_moveMapToFolder as moveMapToFolder,
    mapList_reloadMapList as reloadMapList,
    mapList_renameFolder as renameFolder,
    mapList_setCachedMapList as setCachedMapList,
    mapList_useMapList as useMapList,
  };
}

export interface PruneResult {
    session: ReviewSession | null;
    cursorMoved: boolean;
}
/** Remove `removed` ids from a session's worklist + reviewed set. The cursor only
 *  moves if the cursor id itself was removed (advancing to the next survivor by old
 *  position). Returns the same session reference untouched if nothing overlapped. */
declare function pruneSession(s: ReviewSession, removed: Set<number>): PruneResult;
/** Mark the current cursor reviewed and step forward. `done` when the cursor was the
 *  last item (status flips to "done"). */
declare function advance(s: ReviewSession): {
    session: ReviewSession;
    done: boolean;
};
/** Step backward without marking anything reviewed. Null when already at the start. */
declare function retreat(s: ReviewSession): ReviewSession | null;
/** Position of the session cursor within its review order. */
declare function reviewIndex(s: ReviewSession): number;
/** Union of reviewed ids across sessions, de-duplicated. Pure (unit-tested). */
declare function reviewedHistoryIds(sessions: ReviewSession[]): number[];
/** True when the cursor is on the session's first location. */
declare function isAtStart(s: ReviewSession): boolean;
/** Current cursor location is in the reviewed set. */
declare function isCurrentReviewed(s: ReviewSession): boolean;
/** Reactive active review session, or null. */
declare function useReviewSession(): ReviewSession | null;
/** The active review session, or null. */
declare function getReviewSession(): ReviewSession | null;
/** Start (or resume) a review over `ids`. When `source` is a real selection, the session
 *  is keyed by it so re-reviewing that selection resumes the in-progress session. */
declare function beginReview(ids: number[], source?: Selection): Promise<void>;
/** Resume a session picked from the resume modal. */
declare function resumeReview(s: ReviewSession): Promise<void>;
/** Mark the current location reviewed and step to the next one. */
declare function reviewNext(): Promise<void>;
/** Step back to the previous location in the session. */
declare function reviewPrev(): Promise<void>;
/** Delete the current location and advance FORWARD (like reviewNext) — to the item that
 *  followed it, or exit the pass if it was the last one. We navigate off the doomed location
 *  first so the shared `removeLocations` doesn't bounce us to the overview; its emitted
 *  `location:remove` is then a no-op for our reconcile listener (already pruned). */
declare function reviewDelete(): Promise<void>;
/** Exit the review UI but keep the session resumable (persisted as active). */
declare function cancelReview(): void;
/** Rename a session (custom label over the auto-derived selection name). Persists immediately;
 *  also patches the live session if it's the one being renamed. */
declare function renameReview(id: string, name: string): Promise<void>;
/** Delete a review session (its progress, not the locations). */
declare function deleteSession(id: string): Promise<void>;
/** Review sessions for the open map, optionally filtered by status. */
declare function listSessions(status?: "active" | "done"): Promise<ReviewSession[]>;
/** Select every location marked reviewed across all review sessions on this map (active + done).
 *  A snapshot; re-running refreshes it in place (deterministic key). */
declare function selectReviewedHistory(): Promise<void>;
/** Add a reviewed/unreviewed overlay selection for an arbitrary session (resume modal). Mirrors
 *  refreshProjection's props so the key and color match an in-progress projection. */
declare function selectReviewSet(s: ReviewSession, mode: "reviewed" | "unreviewed"): Promise<void>;

export type review_PruneResult = PruneResult;
declare const review_advance: typeof advance;
declare const review_beginReview: typeof beginReview;
declare const review_cancelReview: typeof cancelReview;
declare const review_deleteSession: typeof deleteSession;
declare const review_getReviewSession: typeof getReviewSession;
declare const review_isAtStart: typeof isAtStart;
declare const review_isCurrentReviewed: typeof isCurrentReviewed;
declare const review_listSessions: typeof listSessions;
declare const review_pruneSession: typeof pruneSession;
declare const review_renameReview: typeof renameReview;
declare const review_resumeReview: typeof resumeReview;
declare const review_retreat: typeof retreat;
declare const review_reviewDelete: typeof reviewDelete;
declare const review_reviewIndex: typeof reviewIndex;
declare const review_reviewNext: typeof reviewNext;
declare const review_reviewPrev: typeof reviewPrev;
declare const review_reviewedHistoryIds: typeof reviewedHistoryIds;
declare const review_selectReviewSet: typeof selectReviewSet;
declare const review_selectReviewedHistory: typeof selectReviewedHistory;
declare const review_useReviewSession: typeof useReviewSession;
declare namespace review {
  export { review_advance as advance, review_beginReview as beginReview, review_cancelReview as cancelReview, review_deleteSession as deleteSession, review_getReviewSession as getReviewSession, review_isAtStart as isAtStart, review_isCurrentReviewed as isCurrentReviewed, review_listSessions as listSessions, review_pruneSession as pruneSession, review_renameReview as renameReview, review_resumeReview as resumeReview, review_retreat as retreat, review_reviewDelete as reviewDelete, review_reviewIndex as reviewIndex, review_reviewNext as reviewNext, review_reviewPrev as reviewPrev, review_reviewedHistoryIds as reviewedHistoryIds, review_selectReviewSet as selectReviewSet, review_selectReviewedHistory as selectReviewedHistory, review_useReviewSession as useReviewSession };
  export type { review_PruneResult as PruneResult };
}

export type Cmd = typeof commands;

/** Standard right-hand sidebar chrome (title, back button, scrollable body). Use for plugin sidebars. */
declare function Sidebar({ title, onBack, actions, className, flush, children, }: {
    title: ReactNode;
    onBack?: () => void;
    actions?: ReactNode;
    className?: string;
    flush?: boolean;
    children: ReactNode;
}): react_jsx_runtime.JSX.Element;
/** Collapsible titled section inside a Sidebar. */
declare function Section({ title, defaultOpen, collapsible, addons, children, }: {
    title: ReactNode;
    defaultOpen?: boolean;
    collapsible?: boolean;
    addons?: ReactNode;
    children: ReactNode;
}): react_jsx_runtime.JSX.Element;
/** Labelled form row (label left, control right) for sidebar sections. */
declare function Field({ label, hint, row, children, }: {
    label: ReactNode;
    hint?: ReactNode;
    row?: boolean;
    children: ReactNode;
}): react_jsx_runtime.JSX.Element;
/** Centered icon + message for empty panels. */
declare function EmptyState({ icon, children }: {
    icon?: string;
    children: ReactNode;
}): react_jsx_runtime.JSX.Element;
export interface SegmentedOption<T extends string | number> {
    value: T;
    label: ReactNode;
    disabled?: boolean;
    title?: string;
}
/** Row of mutually exclusive option buttons (a compact radio group). */
declare function SegmentedControl<T extends string | number>({ options, value, onChange, className, }: {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    className?: string;
}): react_jsx_runtime.JSX.Element;

declare function ScopeSelector({ ctl, className, }: {
    ctl: ScopeController<SourceScope>;
    className?: string;
}): react_jsx_runtime.JSX.Element;

declare function toast(message: string, duration?: number, container?: HTMLElement): void;

/** Get a module the app bundles (e.g. "react", "@deck.gl/core") for use inside a plugin.
 *  Lazy modules must be loaded with `preloadModules` first. */
declare function mmaRequire(id: string): unknown;
/** Load lazy bundled modules so `mmaRequire` can return them synchronously. */
declare function preloadModules(ids: string[]): Promise<void>;
/** Names of every module available through `mmaRequire`. */
declare function getAvailableExternals(): string[];
declare global {
    var __mma_require: typeof mmaRequire;
}

export interface EnrichFieldOption {
    key: string;
    label: string;
    /** Excluded from the default field set (null enrichFields); user must opt in. */
    defaultOff?: boolean;
}
/** Offer extra fields in the enrichment UI. Unregistered when the plugin deactivates. */
declare function registerEnrichFields(fields: EnrichFieldOption[]): void;
/** Optional context passed by the bulk runner. Cheap providers can ignore it. */
export interface EnrichCtx {
    signal?: AbortSignal;
    force?: boolean;
    /** Advance the bulk progress bar by one unit. */
    onUnit?: () => void;
    /** Report a location that errored (surfaced as failed in the bulk summary). */
    onFail?: (id: number) => void;
}
export interface EnrichmentProvider {
    id: string;
    /** Bulk progress label for slow providers; omit for instant ones. */
    label?: string;
    enrich(locations: Location[], enrichFields: string[] | null, ctx?: EnrichCtx): Promise<Map<number, Record<string, unknown>>>;
    fieldDefs: Record<string, ExtraFieldDef>;
    /** Fields this provider reads: schedules it into a later dependency wave than any
     *  provider producing them (core-written fields like imageDate precede wave 1). */
    requires?: string[];
    /** Progress units this provider would contribute in bulk (absent = instant). */
    units?(locations: Location[], enrichFields: string[] | null, force?: boolean): number;
    /** Transform a raw partition value per-location. Return null to skip. */
    transform?(field: string, value: string, location: Location): string | null;
}
/** Register a provider that computes extra fields during enrichment (e.g. sun position).
 *  Unregistered when the plugin deactivates. */
declare function registerEnrichmentProvider(provider: EnrichmentProvider): void;

/** Look up metadata for a single field key. Returns `undefined` if no metadata exists. */
declare function getFieldDef(key: string): ExtraFieldDef | undefined;
/** Merged view of all field definitions across all layers. */
declare function getAllFieldDefs(): Record<string, ExtraFieldDef>;

export interface SelectionBitmaskPayload {
    selColors: [number, number, number][];
    cellEntries: SelCellEntry[];
    setIds: (ids: SelectedIds) => void;
}
declare const EVENT_DEFS: {
    "location:add": Location[];
    "location:remove": number[];
    "location:update": Update<LocationPatch_Deserialize>[];
    "tag:add": Tag[];
    "tag:remove": number[];
    "tag:update": Update<TagPatch>[];
    "selection:change": Selection[];
    "active:change": number | null;
    "map:open": MapData;
    "map:close": void;
    "store:changed": void;
    "render:delta": RenderDelta;
    "render:selection": SelectionBitmaskPayload;
    "settings:changed": void;
    "fullscreen:changed": void;
    "plugins:changed": void;
    "hotkeys:changed": void;
    "toasts:changed": void;
    "scene:changed": void;
    "measure:changed": void;
    "anchor:changed": void;
    "viewport-lock:changed": void;
    "trail:changed": void;
    "altitude:changed": void;
    "seen:changed": void;
    "update:changed": void;
    "review:changed": void;
    "fields:changed": void;
    "route:changed": void;
    "import-markers:changed": void;
    "diff-markers:changed": void;
};
export type EditorEventMap = typeof EVENT_DEFS;
export type EditorEvent = keyof EditorEventMap;
export type EventHandler<E extends EditorEvent> = (payload: EditorEventMap[E]) => void;

/** Fetch a page of the seen (visited-panorama) history. */
declare function getSeenEntries(limit?: number, offset?: number, filter?: SeenFilter, thumbnails?: boolean): Promise<SeenEntry[]>;
/** Number of seen entries matching the filter (all when omitted). */
declare function getSeenCount(filter?: SeenFilter): Promise<number>;
/** Delete the entire seen history. Not undoable. */
declare function clearSeen(): Promise<void>;

/** Open a seen entry's panorama in the Street View viewer. */
declare function loadSeenPano(entry: SeenEntry): Promise<void>;

/** True when the location is missing any of the given enrich fields (default: the enabled set). */
declare function needsEnrichment(loc: Location, enrichFields?: string[]): boolean;
/** One summary row per pass that did work: the core metadata pass, then every
 *  provider that updated or failed at least one location. */
export interface EnrichOutcome {
    id: string;
    label: string;
    success: number[];
    failed: number[];
}
export type EnrichResult = EnrichOutcome[];
/** Bulk enrich: selector over the resolver engine. Runs `enrichMeta`, then the
 *  enrichment providers (exact date among them) in dependency waves. */
declare function enrichAll(locations: Location[], opts?: {
    signal?: AbortSignal;
    force?: boolean;
    onProgress?: (done: number, total: number, label?: string) => void;
}): Promise<EnrichResult>;

/** Pin each location to a resolved panorama (sets `panoId`), so it always loads the same pano. */
declare function bulkPinToPano(locations: Location[], opts?: {
    signal?: AbortSignal;
    force?: boolean;
    useLatest?: boolean;
    onProgress?: (done: number, total: number) => void;
}): Promise<number>;

export interface ValidationProgress {
    progress: number;
    results: Map<ValidationState, Location[]>;
}
/** Check that each location's Street View coverage still exists; returns locations grouped
 *  by validation state. */
declare function validateLocations(locations: Location[], opts?: {
    signal?: AbortSignal;
    onProgress?: (p: ValidationProgress) => void;
}): Promise<Map<ValidationState, Location[]>>;

/** Fetch full pano metadata directly from Google's internal RPC (bypasses StreetViewService). */
declare function fetchSvMetadata(panoIds: string[]): Promise<(google.maps.StreetViewResolvedPanoramaData | null)[]>;

/** URL that serves a local file over the `mma-buf://` protocol (binary Rust-to-JS transfers). */
declare function mmaBufUrl(path: string): string;

export interface MapEmbedPrefs {
    svOpacity: number;
    svColor: SvColor;
    showLabels: boolean;
    showTerrain: boolean;
    svPanoramas: boolean;
    svCoverageType: SvCoverageType;
    svThickness: SvThickness;
    svBlobby: boolean;
    boldCountryBorders: boolean;
    boldSubdivisionBorders: boolean;
    hideRoadLabels: boolean;
    hidePoi: boolean;
    hideTransit: boolean;
    hideHighways: boolean;
    mapStyleName: string;
    vectorStyleName: string;
    mapType: MapTypeKey;
    markerStyle: MarkerStyle;
    markerOpacity: number;
    markerSize: number;
    showPerfectScoreCircle: boolean;
    showSearchRadiusCursor: boolean;
    showPreviews: boolean;
    selectOnly: boolean;
}

export interface MapStyle {
    featureType?: string;
    elementType?: string;
    stylers: Record<string, any>[];
}

export interface CustomStyle {
    name: string;
    style: MapStyle[];
}

export interface HostInstances {
    google: google.maps.Map;
    maplibre: maplibregl.Map;
}
export type MapHostKind = keyof HostInstances;
export interface DeckOverlayProps {
    layers: Layer[];
    onClick?: (info: PickingInfo, domEvent?: Event) => void;
    onHover?: (info: PickingInfo, domEvent?: Event) => void;
    onError?: (e: unknown) => void;
}
export interface DeckOverlayHandle {
    setProps(props: Partial<DeckOverlayProps>): void;
    finalize(): void;
}
export interface MapHostEvents {
    mousemove: LatLng;
    mousedown: LatLng;
    mouseup: LatLng;
    mouseout: void;
    zoom: void;
    camera: void;
    tilesloaded: void;
}
export interface BasemapOpts {
    useBlobby: boolean;
    customStyles: CustomStyle[];
}
export interface MapHostContract<K extends MapHostKind = MapHostKind> {
    readonly kind: K;
    readonly container: HTMLElement;
    getHostInstance(): HostInstances[K];
    getZoom(): number;
    setZoom(zoom: number): void;
    getCenter(): LatLng | null;
    getBounds(): Bounds | null;
    panTo(p: LatLng): void;
    moveCamera(opts: {
        center?: LatLng;
        zoom?: number;
    }): void;
    fitBounds(bounds: Bounds, padding?: number, opts?: {
        snap?: boolean;
    }): void;
    on<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void;
    once<K extends keyof MapHostEvents>(event: K, fn: (arg: MapHostEvents[K]) => void): () => void;
    containerPxToLatLng(x: number, y: number): LatLng | null;
    setDraggable(v: boolean): void;
    setDoubleClickZoom(v: boolean): void;
    createDeckOverlay(): DeckOverlayHandle;
    triggerClickAt(latLng: LatLng): void;
    applyPrefs(prefs: MapEmbedPrefs, opts: BasemapOpts): void;
    setSvOpacity(v: number): void;
    resize(): void;
    destroy(): void;
}
export type MapHost = {
    [K in MapHostKind]: MapHostContract<K>;
}[MapHostKind];

/**
 * This refers to the main editor map only.
 */
declare function getMapHost(): MapHost | null;
/**
 * Wait for the main editor map to be ready.
 */
declare function waitForMapHost(): Promise<MapHost>;

declare function getGoogleMap(): google.maps.Map | null;
declare function waitForGoogleMap(): Promise<google.maps.Map | null>;

declare const legacy_getGoogleMap: typeof getGoogleMap;
declare const legacy_waitForGoogleMap: typeof waitForGoogleMap;
declare namespace legacy {
  export {
    legacy_getGoogleMap as getGoogleMap,
    legacy_waitForGoogleMap as waitForGoogleMap,
  };
}

export interface LocationStore {
    locations: Map<number, Location>;
    /** The materialized locations narrowed to a scope (defaults to all). */
    get(scope?: Scope): Location[];
    onChange(cb: () => void): () => void;
    destroy(): void;
}
/** A live id-to-Location map of the whole map, kept in sync via store events.
 *  Call `destroy()` when done. */
declare function createLocationStore(): Promise<LocationStore>;
/** A running sidecar process. Callbacks fire per line; listeners self-remove on exit. */
export interface SidecarRun {
    runId: number;
    onLine(cb: (line: string) => void): void;
    onStderr(cb: (line: string) => void): void;
    onExit(cb: (code: number | null) => void): void;
    kill(): void;
}
/** Run an installed plugin's sidecar binary. Register onLine/onExit right after this
 *  resolves -- listeners attach before the process starts, so no output is missed. */
declare function spawnSidecar(pluginId: string, name: string, args: string[]): Promise<SidecarRun>;
/** Explicitly exposed functions not in other APIs. */
declare const surface: {
    ready: boolean;
    cmd: Cmd;
    invoke: typeof invoke;
    shell: {
        Command: typeof Command;
    };
    dialog: {
        open: typeof open;
        save: typeof save;
    };
    sidecar: {
        installedVersion: (pluginId: string) => Promise<string | null>;
        spawn: typeof spawnSidecar;
    };
    registerPlugin: typeof registerPlugin;
    registerEnrichFields: typeof registerEnrichFields;
    registerEnrichmentProvider: typeof registerEnrichmentProvider;
    preloadModules: typeof preloadModules;
    getAvailableExternals: typeof getAvailableExternals;
    createLocationStore: typeof createLocationStore;
    ui: {
        Sidebar: typeof Sidebar;
        Section: typeof Section;
        Field: typeof Field;
        EmptyState: typeof EmptyState;
        SegmentedControl: typeof SegmentedControl;
        ScopeSelector: typeof ScopeSelector;
    };
    toast: typeof toast;
    storage: typeof createPluginStorage;
    usePluginState: typeof usePluginState;
    getFieldDef: typeof getFieldDef;
    getAllFieldDefs: typeof getAllFieldDefs;
    createLocation: typeof createLocation;
    getMapHost: typeof getMapHost;
    waitForMapHost: typeof waitForMapHost;
    setSetting: typeof setSetting;
    getSettings: () => {
        showCameraBadges: boolean;
        showLinksControl: boolean;
        clickToGo: boolean;
        showRoadLabels: boolean;
        defaultMovementMode: MovementMode;
        showCar: boolean;
        showCrosshair: boolean;
        showCompass: boolean;
        showCompassTape: boolean;
        showZoom: boolean;
        showReturnToSpawn: boolean;
        showJumpButtons: boolean;
        showMapLinks: boolean;
        showCoordinateDisplay: boolean;
        showFullscreenButton: boolean;
        showPanoMetadata: boolean;
        exactDateFormat: ExactDateFormat;
        dateTimezone: DateTimezone;
        showNavArrow: boolean;
        showGroundArrow: boolean;
        hidePanoUI: boolean;
        fullscreenMap: boolean;
        showFullscreenMapMeta: boolean;
        showFullscreenMiniLocationPreview: boolean;
        fullscreenMiniLocationScale: number;
        showFullscreenMinimap: boolean;
        fullscreenMinimapScale: number;
        showFullscreenTagbar: boolean;
        showFullscreenDatePicker: boolean;
        customCss: string;
        enableSeen: boolean;
        enableSeenThumbnails: boolean;
        seenResolution: SeenResolution;
        mapPanSpeed: number;
        panoLookSpeed: number;
        slowModifier: number;
        showFps: boolean;
        mapListFields: MapListField[];
        restoreSession: boolean;
        discordPresence: DiscordPresenceMode;
        labelColors: Record<string, string>;
        geocodeProvider: GeocodeProvider;
        nominatimApiKey: string;
        panToImported: boolean;
        pastePadding: number;
        followActiveInReview: boolean;
        markerColor: RGB;
        activeLocationColor: RGB;
        importPreviewColor: RGB;
        panoDotColor: RGB;
        panoDotScaled: boolean;
        tagViewMode: TagViewMode;
        truncateTagPaths: boolean;
        tagFolderColorMode: TagFolderColorMode;
        tagFolderColor: RGB;
        tagSortMode: TagSortMode;
        tagGap: number;
        animateTagReorder: boolean;
        borderDetail: BorderDetail;
        subdivisionDetail: SubdivisionDetail;
        previewAspectRatio: PreviewAspectRatio;
        tagSuggestionLimit: number;
        savedSelections: SavedSelection[];
        remoteApi: boolean;
        remoteApiKey: string;
        pinnedCommands: PinnedEntry[];
        hasSeenWelcome: boolean;
    };
    getSavedSelections: typeof getSavedSelections;
    savedToSelectionProps: typeof savedToSelectionProps;
    describeRule: typeof describeRule;
    on<E extends EditorEvent>(event: E, handler: EventHandler<E>): () => void;
    getSeenEntries: typeof getSeenEntries;
    getSeenCount: typeof getSeenCount;
    clearSeen: typeof clearSeen;
    loadSeenPano: typeof loadSeenPano;
    enrichAll: typeof enrichAll;
    bulkPinToPano: typeof bulkPinToPano;
    validateLocations: typeof validateLocations;
    needsEnrichment: typeof needsEnrichment;
    fetchSvMetadata: typeof fetchSvMetadata;
    mmaBufUrl: typeof mmaBufUrl;
    _test: {
        openMap: (id: string) => Promise<void>;
        closeMap: () => Promise<void>;
        deleteMap: (id: string) => Promise<void>;
        importPaste: (text: string) => Promise<EditorImportResult[]>;
        importFile: (droppedFields: string[], tagName?: string) => Promise<EditorImportResult>;
    };
};
export type StoreApi = typeof store;
export type ImportStagingApi = typeof importStaging;
export type CommitDiffApi = typeof commitDiff;
export type ScopeApi = typeof scope;
export type MapListApi = typeof mapList;
export type ReviewApi = typeof review;
export type SurfaceApi = typeof surface;
export type LegacyApi = typeof legacy;
export interface MMA extends StoreApi, ImportStagingApi, CommitDiffApi, ScopeApi, MapListApi, ReviewApi, SurfaceApi, LegacyApi {
}
declare global {
    interface Window {
        MMA: MMA;
    }
    const MMA: MMA;
}

export { MMA as MMAApi, PanoType, commands };
export type { CellRemoval, ColorPatchEntry, CommitDelta, CommitDiff, CommitInfo, ComparisonType, CopyToMapResult, DataLocation, DatePart, DbStats, DbTableInfo, EditorImportPreview, EditorImportResult, ExportOpts, ExtraFieldDef, ExtraFieldType, FieldCount, FilterOp, GeoResult, GgUser, ImportPreviewEntry, ImportedMapInfo, KeySpec, Location, LocationPatch, LocationPatch_Deserialize, MapData, MapExtra, MapKeyAction, MapKeyBinding, MapMeta, MapMetaPatch, MapMetaPatch_Deserialize, MapSettings, MutationResult, NumericBinning, PartitionBucket, PluginManifest, PluginManifest_Deserialize, PluginSidecar, PluginSidecar_Deserialize, PolygonGeometry, PresenceActivity, RemoteMappingRow, RenderDelta, RenderEntry, RenderPatchEntry, RenderRequest, ReviewCreate, ReviewSession, ReviewUpdate, SaveResult, Scope, ScoreBounds, SeenEntry, SeenFilter, SeenMapInfo, SeenWriteEntry, Selection, SelectionInput, SelectionProps, SelectionSync, SpacedPickResult, StoreStatus, SummaryResult, Tag, TagPatch, Update, ValiLocation, ValiLocation_Deserialize, VirtualTag };
