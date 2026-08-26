/// <reference types="google.maps" />
/// <reference path="./google-maps.d.ts" />

import * as _tauri_apps_api_window from '@tauri-apps/api/window';
import * as _tauri_apps_api_webview from '@tauri-apps/api/webview';
import * as __TAURI_EVENT from '@tauri-apps/api/event';
import * as React$1 from 'react';
import { ComponentType, SetStateAction, ComponentPropsWithRef, ReactNode, CSSProperties, ElementType, ReactElement } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Layer, PickingInfo } from '@deck.gl/core';
import * as maplibregl from 'maplibre-gl';

/** Commands */
declare const commands: {
    /**  Milliseconds from `run()` to the frontend's first call; logged once. */
    appReady: () => Promise<number>;
    /**
     *  Write text to a named temp file (`mma_{name}`) and return its path. Lets JS hand
     *  large payloads over by file instead of IPC serialization.
     */
    writeTempFile: (name: string, content: string) => Promise<string>;
    /**  Read a file as UTF-8 text (temp files, plugin sources). */
    readFile: (path: string) => Promise<string>;
    getAppDataDir: () => Promise<string>;
    getDataLocation: () => Promise<DataLocation>;
    /**
     *  Set (`Some`) or clear (`None`) the data-folder override. Takes effect after relaunch
     *  and does not move existing data.
     */
    setDataLocation: (path: string | null) => Promise<null>;
    openDataFolder: () => Promise<null>;
    openLogFile: () => Promise<null>;
    /**  Manifests of every installed plugin. */
    listUserPlugins: () => Promise<PluginManifest[]>;
    /**
     *  Install a plugin from the marketplace repo: its `manifest.json`, the main JS file, and
     *  the procedure module it declares.
     */
    installPlugin: (id: string) => Promise<PluginManifest>;
    /**  Delete a plugin's directory. */
    uninstallPlugin: (id: string) => Promise<null>;
    /**
     *  Download a plugin's sidecar bundle from GitHub Releases and extract it under
     *  `{appData}/plugins/{plugin_id}/sidecar/`. Emits `sidecar-install-progress`.
     */
    sidecarInstall: (pluginId: string, name: string, version: string) => Promise<null>;
    /**  Installed sidecar version for a plugin (from `sidecar/version.txt`), or `None`. */
    sidecarInstalledVersion: (pluginId: string) => Promise<string | null>;
    /**
     *  Run one unit of work on a plugin's sidecar. Commands the manifest lists under
     *  `serve` go to the plugin's resident process; the rest get a one-shot child.
     *  Streams `sidecar-line` (one JSON object per unit) and `sidecar-log` (stderr),
     *  then exactly one `sidecar-done`, all keyed by the returned request id.
     */
    sidecarRequest: (pluginId: string, command: string, payload: string | null) => Promise<number>;
    /**
     *  Stop everything a plugin has running. Called when the plugin is disabled or
     *  uninstalled, so a resident process never outlives the plugin that wanted it.
     */
    sidecarStop: (pluginId: string) => Promise<null>;
    /**
     *  Stop every plugin's sidecar processes. Used when the editor tears all plugins
     *  down at once (map close), where nothing should still be running afterwards.
     */
    sidecarStopAll: () => Promise<null>;
    /**
     *  Kill the process behind a one-shot request (no-op if it already finished).
     *  Resident-served requests have no process of their own, so this does not
     *  interrupt them -- the caller simply stops listening.
     */
    sidecarCancel: (reqId: number) => Promise<null>;
    checkBorderFile: (level: string) => Promise<boolean>;
    downloadBorderFile: (level: string) => Promise<null>;
    borderLookup: (lat: number, lng: number, level: string) => Promise<PolygonGeometry | null>;
    /**
     *  Classify each `(lat, lng)` to the name of its containing feature at `level`
     *  (subdivision names for "adm1"). `None` for points outside every feature.
     *  Same bbox-prefiltered parallel scan as `tally_countries`, but per-point names.
     */
    borderClassify: (level: string, points: ([number, number])[]) => Promise<(string | null)[]>;
    /**
     *  Finds the nearest city/country for a coordinate. O(log n) k-d tree lookup.
     *  Always returns `Some` -- the GeoNames dataset covers every landmass.
     */
    reverseGeocode: (lat: number, lng: number) => Promise<GeoResult | null>;
    discordPresenceSet: (activity: PresenceActivity) => Promise<null>;
    discordPresenceClear: () => Promise<null>;
    /**
     *  Begin device-flow sign-in. Returns the code to show the user; call
     *  [`github_poll_login`] afterwards to wait for them to finish authorizing.
     */
    githubStartLogin: () => Promise<DeviceCodeInfo>;
    /**
     *  Wait for the user to authorize the code from [`github_start_login`], then store the token.
     *  Resolves with the signed-in account.
     */
    githubPollLogin: () => Promise<GhUser>;
    /**  The signed-in user, or `None` when there is no session (or it was rejected). */
    githubMe: () => Promise<GhUser | null>;
    githubLogout: () => Promise<null>;
    /**  Local-only check: is a token stored? Says nothing about its validity. */
    githubHasSession: () => Promise<boolean>;
    /**
     *  File an issue as the signed-in user.
     *
     *  Labels are sent even though only accounts with push access may set them: GitHub drops them
     *  silently for everyone else rather than failing, so sending costs nothing and they land for
     *  maintainers. Closing the gap for outside reporters is the worker's job.
     */
    githubCreateIssue: (title: string, body: string, labels: string[]) => Promise<IssueRef>;
    /**  One of our issues and its comments, read as the signed-in user. */
    githubIssueThread: (number: number) => Promise<IssueThread>;
    /**  The tail of `mma.log`, scrubbed. Empty string when there is no log yet. */
    feedbackLogTail: () => Promise<string>;
    /**  Whether the anonymous tier is available in this build. */
    feedbackAnonymousAvailable: () => Promise<boolean>;
    /**
     *  File an issue through the worker, without any account. The worker applies the labels
     *  (a bot has push access, so it can) and returns the reply token.
     */
    feedbackSubmitAnonymous: (title: string, body: string, installId: string) => Promise<AnonIssueRef>;
    /**
     *  Store an image and return the URL a report body can reference it by.
     *
     *  The proof of work is bound to the bytes, so it costs the same per image as a report costs
     *  per body -- which is what keeps an open upload route from being free hosting.
     */
    feedbackUploadAttachment: (path: string, name: string) => Promise<AttachmentRef>;
    /**
     *  Ask the worker to label an issue the user filed themselves.
     *
     *  GitHub drops labels sent by a reporter without push access, so a signed-in outside
     *  contributor's report arrives bare. The worker's installation token has push access and
     *  re-applies them. Best-effort: a report that is filed but unlabelled is not worth failing.
     */
    feedbackRequestLabel: (number: number) => Promise<null>;
    /**  State and replies for an anonymous report, relayed by the worker. */
    feedbackAnonymousThread: (number: number, token: string) => Promise<IssueThread>;
    /**
     *  Look for an update at `endpoint` (a release's `latest.json`). `None` means the announced
     *  version is not newer than the running one, which is the plugin's own comparison.
     */
    updateCheck: (endpoint: string) => Promise<UpdateAvailable | null>;
    /**
     *  Download and install whatever the last [`update_check`] found. The installer replaces the
     *  running app, so nothing after this is guaranteed to run -- the caller saves its state first.
     */
    updateInstall: () => Promise<null>;
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
    storeCopyLocationsToMap: (targetMapId: string, selector: Selector) => Promise<CopyToMapResult>;
    /**  Lightweight status query: location count, version, and dirty flag. */
    storeGetSummary: () => Promise<SummaryResult>;
    /**
     *  Add new locations. IDs are allocated server-side (monotonic). Records an undo entry
     *  and clears the redo stack.
     */
    storeAddLocations: (locations: Location[]) => Promise<MutationResult>;
    /**
     *  Add locations uploaded as chunked JSON in an upload session dir (see `store_upload_begin`),
     *  so the frontend never serializes the whole batch at once. Otherwise identical to
     *  [`store_add_locations`]: one atomic mutation, one undo entry, IDs in uploaded order.
     */
    storeAddLocationsUploaded: (sessionDir: string) => Promise<MutationResult>;
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
    /**  Ids of every location the selector resolves to, ascending. */
    storeResolve: (selector: Selector) => Promise<number[]>;
    /**  How many locations the selector resolves to. Counts rows, never materializes them. */
    storeCount: (selector: Selector) => Promise<number>;
    /**  `n` ids drawn uniformly at random from the selected set, without replacement. */
    storeSample: (selector: Selector, n: number) => Promise<number[]>;
    /**
     *  An evenly spaced subset: exactly one of `target_count` (thin to N, maximizing
     *  spacing) or `min_distance_m` (keep as many as fit at that spacing).
     */
    storeSpaced: (selector: Selector, targetCount: number | null, minDistanceM: number | null) => Promise<SpacedPickResult>;
    /**  Group by a derived key, returning `{ key, ids, bin }` per group. */
    storeGroupBy: (selector: Selector, field: string, key: KeySpec) => Promise<PartitionBucket[]>;
    /**  Group by a derived key, returning counts only -- no member ids on the wire. */
    storeCountBy: (selector: Selector, field: string, key: KeySpec) => Promise<[string, number][]>;
    /**  Distinct values of `field` across the selected set, sorted. */
    storeValues: (selector: Selector, field: string) => Promise<string[]>;
    /**  How many rows carry each top-level `extra` key, key-sorted. */
    storeCoverage: (selector: Selector) => Promise<[string, number][]>;
    /**  Bounding box `[west, south, east, north]`, or `None` when the set is empty. */
    storeBounds: (selector: Selector) => Promise<[number, number, number, number] | null>;
    /**
     *  Full rows. The last resort -- prefer a projection. Every row is materialized in
     *  webview memory, so an `Everything` call costs O(map). Large answers are staged to a file
     *  rather than pushed through the IPC channel.
     */
    storeCollect: (selector: Selector) => Promise<Rows>;
    storeApplyFieldOp: (selector: Selector, op: FieldOp, recordUndo: boolean | null) => Promise<FieldOpResult>;
    /**  The parse error for `src`, or nothing when it parses. For the dialog's live check. */
    fieldExprError: (src: string) => Promise<string | null>;
    /**
     *  Count locations by country (offline point-in-polygon). Returns unsorted (ISO-A2, count) pairs.
     *  `level` selects border precision, falling back to "light" if unavailable.
     */
    storeCountryDistribution: (selector: Selector, level: string) => Promise<[string, number][]>;
    /**  Find all locations within `radius_m` metres of (`lat`, `lng`). */
    storeFindNearby: (lat: number, lng: number, radiusM: number) => Promise<Location[]>;
    /**
     *  For each input point, whether any existing location lies within `radius_m` metres.
     *  Bulk form so callers probing many coordinates (e.g. the map generator skipping
     *  already-covered spots) pay one IPC round-trip, not one per point.
     */
    storeNearAny: (lats: number[], lngs: number[], radiusM: number) => Promise<boolean[]>;
    /**
     *  Create tags by name. Deduplicates case-insensitively: if a tag with the same name
     *  already exists, it is made visible instead of creating a duplicate.
     *
     *  `location_ids` assigns every resulting tag to those locations in the same mutation.
     *  Doing both here is not a convenience: creating and assigning as two commands leaves the
     *  tag visible at count 0 for the round trip in between, and makes the caller fetch every
     *  location into JS just to append an id Rust already has.
     */
    storeCreateTags: (names: string[], selector: Selector) => Promise<MutationResult>;
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
    storePruneDuplicates: (selector: Selector, distance: number, keepTagIds: number[]) => Promise<MutationResult>;
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
    /**
     *  Compute aggregate database statistics (map/location/tag/commit counts,
     *  database file size, journal mode). Tag count is summed across all maps
     *  by parsing each map's tags JSON column.
     */
    storeDbStats: () => Promise<DbStats>;
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
    storeExportCsv: (selector: Selector) => Promise<string>;
    /**
     *  Export locations as a GeoJSON FeatureCollection of Point features.
     *  Each feature carries its tag names in `properties.tags`.
     */
    storeExportGeojson: (selector: Selector, tagsJson: string) => Promise<string>;
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
    /**  Returns all distinct maps that have seen entries, with resolved display names. */
    storeSeenMaps: () => Promise<SeenMapInfo[]>;
    /**  Deletes all seen history entries. */
    storeSeenClear: () => Promise<null>;
    storeReviewCreate: (session: ReviewCreate) => Promise<ReviewSession>;
    storeReviewGet: (mapId: string, sourceKey: string) => Promise<ReviewSession | null>;
    storeReviewList: (mapId: string, status: string | null) => Promise<ReviewSession[]>;
    storeReviewUpdate: (update: ReviewUpdate) => Promise<null>;
    storeReviewDelete: (id: string) => Promise<null>;
    storeListSavedSelections: () => Promise<SavedSelectionInfo[]>;
    storeGetSavedSelections: (ids: string[]) => Promise<SavedSelection[]>;
    storeSaveSelection: (name: string, selector: Selector, tagNames: { [key in number]: string; }, color: [number, number, number]) => Promise<SavedSelection>;
    storeDeleteSavedSelection: (id: string) => Promise<null>;
    storeImportLegacySavedSelections: (json: string) => Promise<number>;
    remoteMappingGet: (provider: string, mapId: string) => Promise<RemoteMappingRow[]>;
    remoteMappingUpsert: (provider: string, mapId: string, rows: RemoteMappingRow[]) => Promise<null>;
    remoteMappingDelete: (provider: string, mapId: string, localIds: number[]) => Promise<null>;
    remoteMappingClear: (provider: string, mapId: string) => Promise<null>;
    /**
     *  Reconcile a linked, open map against its remote. Snapshots local state under the store lock,
     *  drops the lock, then does all network + persistence off the async thread.
     */
    syncReconcile: (provider: string, mapId: string, remoteMapId: string, apiKey: string | null, firstSync: FirstSyncMode | null, resolutions: ([string, ResolutionSide])[] | null) => Promise<SyncReconcileResult>;
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
    /**
     *  Country codes Vali has coverage data for, i.e. the set `vali download` iterates
     *  when no country is given. Display names are the caller's job.
     */
    valiCountries: () => Promise<string[]>;
    /**
     *  Countries whose downloaded coverage data is older than the remote copy. Object metadata
     *  only -- nothing is fetched. Errors while offline, which callers should read as "unknown"
     *  rather than "up to date".
     */
    valiDataStatus: () => Promise<ValiCountryStatus[]>;
    /**
     *  Download exactly the countries `vali_data_status` reports as behind. No-op when nothing
     *  is stale, so the caller can fire it without checking first.
     */
    valiDownloadStale: () => Promise<null>;
    /**
     *  Start a procedure run. Returns immediately with the run id; the work continues
     *  on a background thread and reports through `procedure-progress`.
     */
    procedureRun: (providers: ProviderDecl[], force: boolean) => Promise<number>;
    /**  Stop a run before its next batch. Already-applied patches stay applied. */
    procedureCancel: (runId: number) => Promise<null>;
    /**
     *  Ask a procedure a read-only question. `input` and the result are whatever the
     *  module's `query` export agrees with its caller; the engine only carries the bytes.
     *  `cancel` is a token the caller may later hand to `procedure_query_cancel`.
     */
    procedureQuery: (entry: string, input: string, config: string | null, cancel: number | null) => Promise<string>;
    /**
     *  Decline every request a query still has to make. The query then answers whatever
     *  its module answers for declined requests, which the caller discards.
     */
    procedureQueryCancel: (cancel: number) => Promise<null>;
};
/** Events */
declare const events: {
    bulkExportProgress: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<ExportProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ExportProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ExportProgress) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<ExportProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ExportProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ExportProgress) => Promise<void>;
    };
    bulkImportProgress: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<ImportProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ImportProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ImportProgress) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<ImportProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ImportProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ImportProgress) => Promise<void>;
    };
    procedureProgress: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<ProcedureProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ProcedureProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ProcedureProgress) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<ProcedureProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ProcedureProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ProcedureProgress) => Promise<void>;
    };
    procedureResult: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<ProcedureResult>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ProcedureResult>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ProcedureResult) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<ProcedureResult>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ProcedureResult>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ProcedureResult) => Promise<void>;
    };
    sidecarDone: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<SidecarDone>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<SidecarDone>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: SidecarDone) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<SidecarDone>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<SidecarDone>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: SidecarDone) => Promise<void>;
    };
    sidecarInstallProgress: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<SidecarProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<SidecarProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: SidecarProgress) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<SidecarProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<SidecarProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: SidecarProgress) => Promise<void>;
    };
    sidecarLine: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<SidecarLine>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<SidecarLine>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: SidecarLine) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<SidecarLine>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<SidecarLine>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: SidecarLine) => Promise<void>;
    };
    sidecarLog: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<SidecarLog>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<SidecarLog>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: SidecarLog) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<SidecarLog>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<SidecarLog>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: SidecarLog) => Promise<void>;
    };
    storeExternalMutation: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<ExternalMutation>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ExternalMutation>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ExternalMutation) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<ExternalMutation>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ExternalMutation>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ExternalMutation) => Promise<void>;
    };
    storeWarning: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<string>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<string>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: string) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<string>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<string>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: string) => Promise<void>;
    };
    updateProgress: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<UpdateProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<UpdateProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: UpdateProgress) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<UpdateProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<UpdateProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: UpdateProgress) => Promise<void>;
    };
    valiProgress: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<ValiProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ValiProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ValiProgress) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<ValiProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<ValiProgress>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: ValiProgress) => Promise<void>;
    };
};
declare const BUILTIN_FIELDS: readonly [{
    readonly key: "lat";
    readonly label: "Latitude";
    readonly type: "number";
    readonly kind: "identity";
    readonly comparison: null;
}, {
    readonly key: "lng";
    readonly label: "Longitude";
    readonly type: "number";
    readonly kind: "identity";
    readonly comparison: null;
}, {
    readonly key: "heading";
    readonly label: "Heading";
    readonly type: "number";
    readonly kind: "writable";
    readonly comparison: {
        readonly type: "circular";
        readonly period: 360;
    };
}, {
    readonly key: "pitch";
    readonly label: "Pitch";
    readonly type: "number";
    readonly kind: "writable";
    readonly comparison: null;
}, {
    readonly key: "zoom";
    readonly label: "Zoom";
    readonly type: "number";
    readonly kind: "writable";
    readonly comparison: null;
}, {
    readonly key: "id";
    readonly label: "ID";
    readonly type: "number";
    readonly kind: "identity";
    readonly comparison: null;
}, {
    readonly key: "createdAt";
    readonly label: "Created";
    readonly type: "date";
    readonly kind: null;
    readonly comparison: null;
}, {
    readonly key: "modifiedAt";
    readonly label: "Modified";
    readonly type: "date";
    readonly kind: null;
    readonly comparison: null;
}, {
    readonly key: "panoId";
    readonly label: "Pano ID";
    readonly type: "string";
    readonly kind: null;
    readonly comparison: null;
}, {
    readonly key: "tagCount";
    readonly label: "Tag count";
    readonly type: "number";
    readonly kind: "virtual";
    readonly comparison: null;
}];
declare const KNOWN_FIELDS: readonly [{
    readonly key: "altitude";
    readonly type: "number";
    readonly label: "Altitude";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: false;
}, {
    readonly key: "countryCode";
    readonly type: "string";
    readonly label: "Country code";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: false;
}, {
    readonly key: "cameraType";
    readonly type: "enum";
    readonly label: "Camera type";
    readonly values: readonly ["gen1", "gen2", "gen4", "badcam", "tripod", "trekker"];
    readonly labels: readonly [readonly ["gen1", "Gen 1"], readonly ["gen2", "Gen 2/3"], readonly ["gen4", "Gen 4"], readonly ["badcam", "Bad cam"], readonly ["tripod", "Tripod"], readonly ["trekker", "Trekker"]];
    readonly circularPeriod: null;
    readonly defaultOff: false;
}, {
    readonly key: "panoType";
    readonly type: "enum";
    readonly label: "Pano type";
    readonly values: readonly ["2", "3", "10"];
    readonly labels: readonly [readonly ["2", "Official"], readonly ["3", "Unknown"], readonly ["10", "User uploaded"]];
    readonly circularPeriod: null;
    readonly defaultOff: false;
}, {
    readonly key: "imageDate";
    readonly type: "month";
    readonly label: "Image date";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: false;
}, {
    readonly key: "datetime";
    readonly type: "date";
    readonly label: "Exact date";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
}, {
    readonly key: "timezone";
    readonly type: "enum";
    readonly label: "Timezone";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
}, {
    readonly key: "drivingDirection";
    readonly type: "number";
    readonly label: "Driving direction";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: 360;
    readonly defaultOff: true;
}, {
    readonly key: "uploaderName";
    readonly type: "string";
    readonly label: "Uploader";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
}, {
    readonly key: "coverageDates";
    readonly type: "array";
    readonly label: "Coverage dates";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
}, {
    readonly key: "subdivision";
    readonly type: "string";
    readonly label: "Subdivision";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
}];
type AnonIssueRef = {
    number: number;
    url: string;
    /**
     *  Grants read access to this one issue's relayed comments. Not a credential for anything
     *  else, which is why it is safe to keep in local storage.
     */
    token: string;
};
/**  An image the reporter attached, once it is somewhere the issue can point at. */
type AttachmentRef = {
    url: string;
    /**
     *  Alt text for the reference. The worker decides it -- a client-supplied name reaches the
     *  rendered issue.
     */
    name: string;
};
/**  How a page of rows is cut into procedure calls. */
type BatchMode = {
    mode: "chunk";
    size: number;
} | {
    mode: "perRow";
} | 
/**
 *  Group rows by a row field; the procedure sees one representative per distinct
 *  value and its patch fans back out to every row sharing it. v1 key: `panoId`.
 */
{
    mode: "dedupeBy";
    key: string;
};
type CameraType = "gen1" | "gen2" | "gen4" | "badcam" | "tripod" | "trekker";
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
type Conflict = {
    key: string;
    kind: ConflictKind;
    /**  Base value is not persisted (only its hash), so conflicts surface local vs remote. */
    local: NormalizedSyncLocation | null;
    remote: NormalizedSyncLocation | null;
};
type ConflictKind = 
/**  Both sides modified the same location differently. */
"update-update" | 
/**  One side deleted while the other modified. */
"delete-update" | 
/**  Both sides added the same identity with different content (hash collision only). */
"add-add";
/**  Result of a cross-map location copy. `target_name` feeds the toast. */
type CopyToMapResult = {
    copied: number;
    skipped: number;
    targetName: string;
};
/**  The active and default data-folder paths, plus whether a custom override is in effect. */
type DataLocation = {
    path: string;
    /**  OS default, ignoring any override -- backs the "reset" affordance. */
    default_path: string;
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
/**  What the user needs in order to authorize: the code to type and where to type it. */
type DeviceCodeInfo = {
    userCode: string;
    verificationUri: string;
    /**  Seconds until `user_code` stops working. */
    expiresIn: number;
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
    /**  Which locations to export. */
    selector: Selector;
    mapName: string;
    /**
     *  Serialized `{id: {name, color}}` tag definitions from the store, used to
     *  convert numeric tag IDs back to human-readable names in the output.
     */
    tagsJson: string;
    extraFieldsJson: string | null;
};
/**
 *  Progress event emitted per-map during bulk export, consumed by the frontend
 *  to drive a progress indicator.
 */
type ExportProgress = {
    current: number;
    total: number;
    mapName: string;
};
/**  A mutation another window made to a map this window may have open, routed by `map_id`. */
type ExternalMutation = {
    mapId: string;
} & MutationResult;
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
 *  A field-wide rewrite of the `extra` map. Patches are derived *per row*, which is what
 *  separates these from `store_update_locations`' explicit patch list.
 */
type FieldOp = 
/**
 *  Rename `from` into `to`. Merge is the same operation -- rename is just the case
 *  where nothing holds `to` -- so `winner` decides only where a row holds both.
 */
{
    kind: "move";
    from: string;
    to: string;
    winner: MergeWinner;
} | 
/**  Drop `keys` from every row that has them. */
{
    kind: "delete";
    keys: string[];
} | 
/**
 *  Assign `value` to `key` on every row where it differs. A writable built-in key
 *  (`heading`, `pitch`, `zoom`) patches its column; anything else writes `extra`.
 */
{
    kind: "set";
    key: string;
    value: unknown;
} | 
/**
 *  Assign `key = expr(row)` per row. A row where the expression cannot evaluate (a
 *  missing or non-numeric field, a non-finite result) is skipped and counted.
 */
{
    kind: "expr";
    key: string;
    expr: string;
};
/**  The op's outcome for the caller: the mutation plus the counts its message needs. */
type FieldOpResult = {
    mutation: MutationResult;
    /**  Rows the op patched. */
    changed: number;
    /**  Rows an expression could not evaluate. */
    skipped: number;
};
/**
 *  Filter comparison operator. Single source of truth: specta renders the literal
 *  union, so the TS `FilterOp` type and `OP_LABELS` derive from this enum.
 */
type FilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "between" | "between_anyyear" | "between_anytime" | "has" | "nothas" | "contains" | "notcontains";
/**
 *  First-sync seeding when both sides already have pins. Only meaningful on the first sync
 *  (empty mapping); afterwards it's plain three-way. `Merge` never deletes.
 */
type FirstSyncMode = "merge" | "mirrorFromRemote" | "mirrorFromLocal";
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
    /**  Avatar pin path (e.g. `pin/<hash>.png`), served under `/images/` on geoguessr.com. */
    pin: string | null;
};
type GhUser = {
    login: string;
    avatarUrl: string | null;
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
/**
 *  Progress event emitted per-map during bulk import, consumed by the frontend
 *  to drive a progress indicator.
 */
type ImportProgress = {
    current: number;
    total: number;
    mapName: string;
};
/**  Result returned per map after a successful bulk import. */
type ImportedMapInfo = {
    id: string;
    name: string;
    locationCount: number;
    tagCount: number;
};
type IssueComment = {
    author: string;
    body: string;
    /**  ISO-8601, as GitHub returns it. */
    createdAt: string;
};
type IssueRef = {
    number: number;
    url: string;
};
type IssueState = "open" | "closed";
/**
 *  What became of a report, and what has been said on it. One shape for both transports so a
 *  signed-in and an anonymous report render identically.
 */
type IssueThread = {
    state: IssueState;
    /**
     *  `completed`, `not_planned` or `reopened`. Absent on an open issue, and on issues closed
     *  before GitHub recorded a reason.
     */
    stateReason: string | null;
    comments: IssueComment[];
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
    extra: {
        [key in string]: unknown;
    } | null;
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
    extra?: {
        [key in string]: unknown;
    } | null;
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
    extra: {
        [key in string]: unknown;
    } | null;
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
/**  When a move target already holds a value, which side survives. */
type MergeWinner = "from" | "to";
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
/**
 *  The syncable contract: the only fields that participate in diffing. Everything else is
 *  owned by exactly one side and would register as a phantom change.
 */
type NormalizedSyncLocation = {
    lat: number;
    lng: number;
    heading: number;
    pitch: number;
    zoom: number;
    panoId: string | null;
    /**  Remote-meaningful bits only; virtual bits are stripped. */
    flags: number;
    /**  Tag names, deduped and sorted. Empty for providers with no tag support. */
    tags: string[];
};
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
    id?: string;
    name?: string;
    description?: string;
    icon?: string;
    main?: string;
    /**  Enrichment procedure module this plugin ships, downloaded alongside `main`. */
    procedure?: string | null;
    version?: string;
    experimental?: boolean;
    comingSoon?: boolean;
    minAppVersion?: string | null;
    sidecar?: PluginSidecar_Deserialize | null;
};
/**  Metadata for a user-installed plugin, read from `plugins/{id}/manifest.json`. */
type PluginManifest = {
    id: string;
    name: string;
    description: string;
    icon: string;
    main: string;
    /**  Enrichment procedure module this plugin ships, downloaded alongside `main`. */
    procedure?: string | null;
    version: string;
    experimental?: boolean;
    comingSoon?: boolean;
    minAppVersion?: string | null;
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
type ProcedureProgress = {
    runId: number;
    providerId: string;
    done: number;
    total: number;
    failed: number;
    /**
     *  Rows counted as done without being worked, because they already held every field
     *  the provider produces. Callers subtract these to report what a run actually did.
     */
    skipped: number;
    finished: boolean;
};
/**
 *  What one page hands back to the caller: a `Collect` provider's answers, delivered
 *  instead of being written, and for every sink the rows that failed. Emitted only when
 *  there is something in it.
 */
type ProcedureResult = {
    runId: number;
    providerId: string;
    entries: ResultEntry[];
    /**  Rows the procedure failed, or every row of a batch whose call failed. */
    failed: number[];
};
/**
 *  One provider as declared by the frontend. `fields` are the extra keys it produces
 *  and `requires` the keys it consumes; together they schedule dependency waves.
 */
type ProviderDecl = {
    id: string;
    label?: string | null;
    /**  The procedure module: an absolute path, or `res://<rel>` for one bundled with the app. */
    entry?: string | null;
    fields?: string[];
    requires?: string[];
    select: Selector;
    batch: BatchMode;
    sink?: Sink;
    rate?: RateSpec | null;
    retry?: RetrySpec | null;
    /**
     *  Re-derive this provider's fields even on a run that is not forced. For an
     *  operation whose whole point is to recompute one provider (pinning re-resolves the
     *  panorama) rather than to fill in what is missing.
     */
    force?: boolean | null;
    /**  Requests this provider may have in flight at once, summed over its instances. */
    inflight?: number | null;
    /**
     *  Instances this provider may run at once. Declared only when the procedure
     *  cannot run beside itself; throughput comes from `inflight`.
     */
    instances?: number | null;
    /**
     *  Provider-specific configuration, a JSON value as text. Passed through verbatim
     *  inside the object the procedure's `configure` receives.
     */
    config?: string | null;
};
/**
 *  A remote-originated create for JS to apply. `remote_id` is the handle its mapping row must
 *  carry once created (a positional push reindexes to its desired-document position).
 */
type PullCreate = {
    fields: NormalizedSyncLocation;
    remoteId: number;
    hash: string;
};
/**  A remote-originated update for JS to apply to an existing local id. */
type PullUpdate = {
    localId: number;
    patch: SyncPatch;
};
/**
 *  What one attempt charges the bucket: the call itself, or one per row in its batch
 *  (for APIs that bill multi-row requests per row).
 */
type RateCost = "request" | "row";
/**  Token bucket: `units` calls per `per_ms` milliseconds, refilled continuously. */
type RateSpec = {
    units: number;
    perMs: number;
    cost?: RateCost;
};
/**  One mapping row. `hash` is the plugin's content fingerprint (opaque text to us). */
type RemoteMappingRow = {
    localId: number;
    /**  Remote ids can exceed u32 (observed ~1.2e10), so i64. */
    remoteId: number;
    hash: string;
};
/**
 *  Incremental render update sent to JS after a mutation: adds, patches, and removals.
 *  Every entry states the row's resulting selection state, so applying a delta is
 *  idempotent and the base cells and the selection overlay cannot drift apart.
 *  `full_reset` signals JS to discard all cell data and re-fetch via `store_fill_render_file`.
 */
type RenderDelta = {
    added: RenderEntry[];
    updated: RenderPatchEntry[];
    removed: CellRemoval[];
    fullReset: boolean;
};
/**  A marker appended to a render cell: position, heading, and selection state. */
type RenderEntry = {
    cell: string;
    id: number;
    lng: number;
    lat: number;
    heading: number;
    /**  `None` = drawn by the base layer, `Some(paint)` = drawn by the selection overlay. */
    sel: SelPaint | null;
    /**
     *  The slot this row vacated when it crossed cells. Present only for a move, so JS
     *  mirrors the swap-remove and carries the overlay entry across instead of inferring
     *  a move from an unrelated removed/added pair.
     */
    movedFrom: CellRemoval | null;
};
/**
 *  Update to an existing marker within its cell. Position and heading are `None` when
 *  unchanged; `sel` always states the row's current selection state, so a membership
 *  change with no movement is just a patch with no coordinates.
 */
type RenderPatchEntry = {
    cell: string;
    cellIndex: number;
    lng: number | null;
    lat: number | null;
    heading: number | null;
    sel: SelPaint | null;
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
/**  Which side won a resolved conflict; serialized as "local"/"remote". */
type ResolutionSide = "local" | "remote";
/**
 *  One location's answer from a `Collect` provider: whatever its module emitted for
 *  that row, carried as text exactly as a patch would be.
 */
type ResultEntry = {
    id: number;
    json: string;
};
/**  Retry only the listed HTTP statuses, up to `attempts` total tries. */
type RetrySpec = {
    attempts: number;
    on: number[];
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
 *  JSON-text columns; `source_props` is the originating `Selector` (opaque here).
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
/**
 *  How `store_collect` shipped its answer. A transport choice, not a projection: both
 *  variants carry the same rows, and callers take whichever arrives.
 */
type Rows = {
    kind: "inline";
    locations: Location[];
} | {
    kind: "file";
    path: string;
};
/**  Result of `store_save_dirty`: bytes written to the delta sidecar (0 = skipped). */
type SaveResult = {
    savedBytes: number;
};
type SavedSelection = {
    selector: Selector;
    /**  Tag id -> the name it carried when saved. What makes a map-local `Tag` leaf portable. */
    tagNames: {
        [key in number]: string;
    };
} & SavedSelectionInfo;
/**
 *  A rule's identity and label, with no tree attached. What the UI lists and holds; the
 *  body is a separate read because a single `Polygon` leaf can carry a country border's
 *  coordinates (~1.7MB of JSON at the heavy border detail).
 */
type SavedSelectionInfo = {
    id: string;
    name: string;
    color: [number, number, number];
    createdAt: string;
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
 *  The selection drawing a row: its colour, and its index in `SelectionState::resolved`.
 *  The index is the draw order — a later selection overdraws an earlier one — so the
 *  overlay can be ordered by it instead of by whatever order rows happen to arrive in.
 *  Every marker sits at z=0 in one deck.gl layer, so buffer order is the only z there is.
 */
type SelPaint = {
    idx: number;
    color: [number, number, number];
};
/**
 *  A named, colored selection. `key` is deterministic (e.g., `"tag:5"`, `"polygon:abc"`)
 *  so JS can diff selections across syncs. `color` is the RGB overlay color.
 */
type Selection = {
    key: string;
    color: [number, number, number];
    selector: Selector;
};
/**  Input for `store_sync_selections`: selection criteria + display color. */
type SelectionInput = {
    /**  Deterministic selection key (e.g. `"tag:5"`), used to return per-node counts back keyed. */
    key: string;
    selector: Selector;
    color: [number, number, number];
    /**  Counted, but kept out of the overlay and the selected set. */
    ghosted?: boolean;
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
/**
 *  Discriminated union of all selection types. Serialized with `{ "type": "..." }` tag
 *  for JS interop. Simple types (Tag, Untagged, PanoIds, etc.) resolve in O(N) with
 *   parallel batch scans. Composites (Intersection, Union, Invert) recursively resolve
 *  children. Duplicates uses a grid-accelerated spatial scan.
 */
type Selector = {
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
type SideCounts = {
    create: number;
    update: number;
    delete: number;
};
type SidecarDone = {
    reqId: number;
    error: string | null;
};
type SidecarLine = {
    reqId: number;
    line: string;
};
/**  Same shape as [`SidecarLine`]; distinct so the two event channels can't be cross-wired. */
type SidecarLog = {
    reqId: number;
    line: string;
};
type SidecarProgress = {
    pluginId: string;
    downloaded: number;
    total: number;
};
/**
 *  Where a provider's results go. `Patch` applies them to the locations they name;
 *  `Collect` delivers them to the caller and writes nothing. The declaration decides
 *  this, never the contents of a result.
 */
type Sink = "patch" | "collect";
/**
 *  `pick_spaced`'s answer: the picked ids plus the spacing achieved (count mode) or
 *  enforced (distance mode).
 */
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
/**  User-facing warning toast. */
type StoreWarning = string;
/**  Lightweight status for polling: count, version, and whether unsaved changes exist. */
type SummaryResult = {
    locationCount: number;
    version: number;
    dirtyCount: number;
};
/**
 *  Only the fields a pull genuinely changes. A field the provider cannot represent reads as empty
 *  on the remote side and must not overwrite local data, so absent fields are left untouched.
 *  `pano_id` applies only when `pano_id_set` is true (a cleared panoId is a real change to `null`).
 */
type SyncPatch = {
    lat: number | null;
    lng: number | null;
    heading: number | null;
    pitch: number | null;
    zoom: number | null;
    panoIdSet: boolean;
    panoId: string | null;
    flags: number | null;
    tags: string[] | null;
};
/**  Everything the reconcile settled to, for the JS side. Every array is empty on an unchanged map. */
type SyncReconcileResult = {
    /**  Remote-applied counts; mirror-from-local deletes fold into `delete`. */
    pushed: SideCounts;
    /**  Local-applied counts; mirror-from-remote deletes fold into `delete`. */
    pulled: SideCounts;
    adopted: number;
    conflicts: Conflict[];
    neededTags: string[];
    pullCreates: PullCreate[];
    pullUpdates: PullUpdate[];
    pullDeleteIds: number[];
    mirrorLocalDeleteIds: number[];
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
type UpdateAvailable = {
    version: string;
    currentVersion: string;
    notes: string | null;
};
/**  Download progress, emitted per chunk. `total` is absent when the server sends no length. */
type UpdateProgress = {
    downloaded: number;
    total: number | null;
};
/**  How far behind one country's downloaded coverage data is. */
type ValiCountryStatus = {
    countryCode: string;
    files: number;
    bytes: number;
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
type ValiProgress = {
    kind: "workItems";
    total: number;
} | {
    kind: "workItemDone";
    countryCode: string;
    subdivisionCode: string | null;
    done: number;
    total: number;
} | {
    kind: "countryDownloadStarted";
    countryCode: string;
    files: number;
    bytes: number;
    updates: boolean;
} | {
    kind: "fileDownloaded";
    countryCode: string;
    name: string;
    bytes: number;
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
/** Outcome of a Street View coverage check, as `validate` answers it per row. */
declare enum ValidationState {
    Ok = 0,
    UpdateAvailable = 1,
    UpdateApplied = 2,
    NotFound = 3,
    PanoIdBroke = 4,
    Unofficial = 5,
    GoodcamAvailable = 6
}
/** One decoded GetMetadata image: flat, plain JSON, no live objects. This is the app's
 *  panorama, not a transcription of the Maps JS API's. Anything derivable from these
 *  fields is a function in `@/lib/sv/getMetadata`, not a field here. */
export interface Pano {
    /** This image's own pano id, "" when the response carries no key. */
    pano: string;
    /** Which imagery collection the id belongs to; also what `extra.panoType` stores. */
    panoFrontend: PanoType;
    lat: number;
    lng: number;
    altitude: number;
    /** The camera's orientation. The Maps JS API builds its whole tile frame out of this. */
    pov: {
        heading: number;
        tilt: number;
        roll: number;
    } | null;
    worldSize: {
        width: number;
        height: number;
    };
    tileSize: {
        width: number;
        height: number;
    };
    copyright: string;
    /** `description.description[].text`, joined with ", ". */
    description: string;
    /** The first of those parts alone, which is what the Maps JS API calls the short description. */
    shortDescription: string;
    uploaderName: string | null;
    countryCode: string | null;
    /** Non-null marks an indoor/tripod pano; a level carrying no id still counts. */
    levelId: number | null;
    /** Neighbouring panos, resolved to ids. */
    links: {
        pano: string;
        heading: number;
    }[];
    /** Capture timeline, ascending. `date` is the civil day, `YYYY-MM-DD`. */
    time: {
        pano: string;
        date: string;
    }[];
    /** This image's own capture date; month and day are 0 when absent. */
    date: {
        year: number;
        month: number;
        day: number;
    } | null;
    /** "launch" = car, "scout" = the special-collects pipeline. */
    source: string | null;
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
export type CompositeType = Extract<Selector, {
    selections: Selection[];
}>["type"];
/** Composite variants that wrap exactly one child (operators, not bags). They never collapse — a
 *  one-child group is degenerate, but one child is a unary node's only valid arity. */
export type UnaryType = "Invert";
/** Composite variants that are flat n-ary groups. */
export type GroupType = Exclude<CompositeType, UnaryType>;

export interface MapState {
    mapId: string | null;
    /** Persisted identity slice (metadata + settings). Changes rarely. */
    map: MapData | null;
    locationCount: number;
    canUndo: boolean;
    canRedo: boolean;
    /** All tags by id, including soft-deleted ghosts (visible=false, kept for undo revival). */
    tags: Record<number, Tag>;
    /** Per-tag location counts for the open map, keyed by tag id. */
    tagCounts: Record<number, number>;
    /** Resolved count per selection node (top-level and nested), keyed by `Selection.key`.
     *  The sole source for sidebar counts — refreshed wholesale from Rust on every sync. */
    selectionCounts: Record<string, number>;
    /** Extra-field keys known to exist in location data on the current map. A mirror of
     *  Rust's registry: refreshed wholesale from `StoreStatus.knownFieldKeys` on open and
     *  on every mutation (plus that mutation's `newFieldDefs`), never maintained JS-side. */
    knownFieldKeys: ReadonlySet<string>;
    selections: Selection[];
    /** Keys of selections that are "ghosted": kept in the list but excluded from the
     *  Rust sync, so they neither render nor count toward the selected set. Ephemeral. */
    ghostedSelections: ReadonlySet<string>;
    selectedLocationIds: SelectedIds;
    activeLocationId: number | null;
    /** The location open in the editor, or null. Virtual locations (staged
     *  imports, seen previews) live here with negative ids. */
    activeLocation: Location | null;
    duplicateLocations: Location[];
    workArea: WorkArea;
    activePluginId: string | null;
}
/** Reactive slice of the map state. Re-renders only when the selected value's
 *  reference changes (`Object.is`), so selectors must return state fields or
 *  cached derivations — never construct a value per call. */
declare function useMapState<T>(selector: (s: MapState) => T): T;
/** Imperative snapshot of the map state. */
declare function getMapState(): Readonly<MapState>;
/** Tags that exist from the user's point of view. Raw `tags` also holds soft-deleted ghosts (count=0, visible=false, kept for undo revival) — almost nothing outside the undo/revival machinery should enumerate those. */
declare const getVisibleTags: () => Tag[];
/** Raw by-id tag lookup — includes soft-deleted ghosts so stale references
 *  (e.g. a selection whose tag just died) still resolve to a name. */
declare function getTag(id: number): Tag | undefined;
/** Tag names for the given ids, skipping any that no longer resolve. Tags are staged by
 *  name rather than id, because a staged tag may not exist yet. */
declare function tagIdsToNames(ids: number[]): string[];
/** Defer autosave until the returned release runs. A bulk run that lands many mutations
 *  would otherwise re-serialize the whole overlay on each one; one save at the end is enough. */
declare function holdAutosave(): () => void;
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
declare function openMap$1(id: string): Promise<void>;
/** Close the open map, saving unsaved changes first. */
declare function closeMap$1(): Promise<void>;
/** Drop the open map without persisting anything */
declare function discardOpenMap(): void;
/** Ids of every location the selector resolves to. */
declare function resolveIds(selector: Selector): Promise<number[]>;
/** How many locations the selector resolves to, without shipping any of them. */
declare function countIn(selector: Selector): Promise<number>;
/** Bounding box `[west, south, east, north]`, or null when the selector is empty.
 *  The whole-map box is an O(1) cache hit in Rust; narrower ones scan. */
declare function fetchBounds(selector: Selector): Promise<[number, number, number, number] | null>;
/** `n` ids drawn uniformly at random, without replacement. */
declare function sampleFrom(selector: Selector, n: number): Promise<number[]>;
/** Distinct values of `field`, sorted. */
declare function fieldValues(selector: Selector, field: string): Promise<string[]>;
/** Group by a derived key and count, without shipping member ids. */
declare function countBy(selector: Selector, field: string, key: KeySpec): Promise<[string, number][]>;
/** How many locations carry each `extra` key, key-sorted. */
declare function fieldCoverage(selector: Selector): Promise<[string, number][]>;
/** Group the selected location set by a derived key - entirely in Rust, no locations fetched.
 *  Numeric bins arrive in bound order; projection keys are sorted naturally for display. */
declare function partition(field: string, key: KeySpec, selector: Selector): Promise<PartitionBucket[]>;
/** Materialize a selector's location rows -- by id, by selection, or the whole map.
 *  Rust picks the transport (inline vs staged file) by size. Missing ids are skipped.
 *
 *  Every row lands in webview memory, so an unscoped call costs O(map) -- at millions of
 *  locations that is the tab's whole heap. Prefer a projection, or an enrichment
 *  procedure that runs beside the data. Trusted, not policed: selector it yourself. */
declare function fetchLocations(selector: Selector): Promise<Location[]>;
/** Active (non-ghosted) selections, the default for any operational logic. */
declare const getActiveSelections: () => Selection[];
/** The live selection as a `Selector`: the union of the active selection nodes. What
 *  every "operate on the selection" call site sends -- Rust holds no notion of "selected",
 *  so the tree JS already has is the definition. */
declare function currentSelection(): Selector;
/** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want -- prefer `addSelections`. */
declare function setSelectedLocationIds(ids: SelectedIds): void;
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
declare function addLocations(locs: Location[]): Promise<void>;
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
/** Rewrite a field across `selector` in Rust. The per-location patches never exist in
 *  JS -- which is the point -- so instead of `location:update` this emits a coarse
 *  `location:invalidate` (derived views re-query) and refreshes the open editor's
 *  location. */
declare function applyFieldOp(selector: Selector, op: FieldOp, recordUndo: boolean): Promise<FieldOpResult>;
/** Toggle a selection's ghosted state and re-sync (excludes/includes it from the overlay). */
declare function toggleGhostSelection(key: string): Promise<void>;
/** "Solo" a selection: ghost every other top-level selection, keep this one visible.
 *  If it is already the only visible one, un-ghost everything (toggle back). */
declare function isolateSelection(key: string): Promise<void>;
/** Ghost every top-level selection; if all are already ghosted, un-ghost them all. */
declare function toggleGhostAllSelections(): Promise<void>;
/** Add selections to the sidebar and highlight their locations. Same-key selections replace. */
declare function addSelections(selector: Selector[]): Promise<void>;
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
 *  With `perSelection` it is a per-bucket cap: up to `count` ids from each active selection,
 *  unioned. No-op when nothing is selected. Returns the number of ids actually picked. */
declare function selectRandomFromSelection(count: number, perSelection?: boolean): Promise<number>;
/** Replace the current selection with a single Manual selection of ids picked from the
 *  current selection, spaced apart in Rust: either `count` ids maximizing spacing, or as
 *  many as fit at `minDistanceM`. With `perSelection` each active selection is picked from
 *  separately and the results unioned. No-op when the pick returns nothing. */
declare function selectSpacedFromSelection(opts: {
    count?: number;
    minDistanceM?: number;
}, perSelection?: boolean): Promise<{
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
declare function pruneDuplicates(selector: Selector, distance: number): Promise<number>;
/** Edit an existing filter (or any selection) in place by key, preserving its
 *  position inside any AND/OR/Invert composite. Carries ghost state to the new key. */
declare function updateFilterSelection(oldKey: string, selector: Selector): Promise<void>;
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
/** Tag ids that currently have a Tag selection (cached; keyed on the selection list,
 *  identity-stable while the set of ids is unchanged). */
declare const getSelectedTagIds: () => ReadonlySet<number>;
/** Tag ids of every Tag leaf in the active selection tree, in list order --
 *  composite children included, ghosted selections excluded, ids may repeat.
 *  Deep counterpart of getSelectedTagIds (top-level only, as a set). */
declare const getSelectedTagIdsDeep: () => readonly number[];
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
/** Open a plugin's sidebar (switches the editor pane to "plugin"). */
declare function setPluginMode(pluginId: string): void;
/** Close the plugin sidebar and return to the overview. */
declare function exitPluginMode(): void;
/** Get-or-create tags by name. Returns the tag objects for use
 *  in subsequent location updates. Idempotent — existing tags are returned
 *  as-is, new names get auto-generated colors.
 *
 *  Pass `selector` to assign the tags to those locations in the same mutation. Prefer that
 *  over a follow-up `addTagToLocations`: it is one round trip instead of three, and the
 *  tag never renders at count 0 in between. The default assigns nothing. */
declare function createTags(names: string[], selector?: Selector): Promise<Tag[]>;
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
/** Bake overlay, write the commit delta, create a VCS commit. Resets undo stack. */
declare function commitMap(message?: string): Promise<string>;
/** Restore the map to a previous commit's state and reopen it. Clears undo/redo. */
declare function checkoutCommit(commitId: string): Promise<void>;

export type store_MapState = MapState;
declare const store_addLocations: typeof addLocations;
declare const store_addSelections: typeof addSelections;
declare const store_addTagToLocations: typeof addTagToLocations;
declare const store_applyFieldOp: typeof applyFieldOp;
declare const store_cancelAutosave: typeof cancelAutosave;
declare const store_checkoutCommit: typeof checkoutCommit;
declare const store_closeDuplicates: typeof closeDuplicates;
declare const store_commitMap: typeof commitMap;
declare const store_composeSelections: typeof composeSelections;
declare const store_countBy: typeof countBy;
declare const store_countIn: typeof countIn;
declare const store_createTags: typeof createTags;
declare const store_currentSelection: typeof currentSelection;
declare const store_decomposeChild: typeof decomposeChild;
declare const store_deleteField: typeof deleteField;
declare const store_deleteTags: typeof deleteTags;
declare const store_discardOpenMap: typeof discardOpenMap;
declare const store_duplicateLocation: typeof duplicateLocation;
declare const store_emitBitmask: typeof emitBitmask;
declare const store_exitPluginMode: typeof exitPluginMode;
declare const store_fetchBounds: typeof fetchBounds;
declare const store_fetchLocations: typeof fetchLocations;
declare const store_fieldCoverage: typeof fieldCoverage;
declare const store_fieldValues: typeof fieldValues;
declare const store_flushSave: typeof flushSave;
declare const store_getActiveSelections: typeof getActiveSelections;
declare const store_getMapState: typeof getMapState;
declare const store_getSelectedTagIds: typeof getSelectedTagIds;
declare const store_getSelectedTagIdsDeep: typeof getSelectedTagIdsDeep;
declare const store_getTag: typeof getTag;
declare const store_getVisibleTags: typeof getVisibleTags;
declare const store_holdAutosave: typeof holdAutosave;
declare const store_initStore: typeof initStore;
declare const store_isolateSelection: typeof isolateSelection;
declare const store_mapOpen: typeof mapOpen;
declare const store_mergeDuplicates: typeof mergeDuplicates;
declare const store_mutate: typeof mutate;
declare const store_openDuplicateLocation: typeof openDuplicateLocation;
declare const store_openStagedLocation: typeof openStagedLocation;
declare const store_partition: typeof partition;
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
declare const store_resolveIds: typeof resolveIds;
declare const store_resolveLocation: typeof resolveLocation;
declare const store_sampleFrom: typeof sampleFrom;
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
declare const store_tagIdsToNames: typeof tagIdsToNames;
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
declare const store_useMapState: typeof useMapState;
declare const store_waitForInflightPersist: typeof waitForInflightPersist;
declare namespace store {
  export { store_addLocations as addLocations, store_addSelections as addSelections, store_addTagToLocations as addTagToLocations, store_applyFieldOp as applyFieldOp, store_cancelAutosave as cancelAutosave, store_checkoutCommit as checkoutCommit, store_closeDuplicates as closeDuplicates, closeMap$1 as closeMap, store_commitMap as commitMap, store_composeSelections as composeSelections, store_countBy as countBy, store_countIn as countIn, store_createTags as createTags, store_currentSelection as currentSelection, store_decomposeChild as decomposeChild, store_deleteField as deleteField, store_deleteTags as deleteTags, store_discardOpenMap as discardOpenMap, store_duplicateLocation as duplicateLocation, store_emitBitmask as emitBitmask, store_exitPluginMode as exitPluginMode, store_fetchBounds as fetchBounds, store_fetchLocations as fetchLocations, store_fieldCoverage as fieldCoverage, store_fieldValues as fieldValues, store_flushSave as flushSave, store_getActiveSelections as getActiveSelections, store_getMapState as getMapState, store_getSelectedTagIds as getSelectedTagIds, store_getSelectedTagIdsDeep as getSelectedTagIdsDeep, store_getTag as getTag, store_getVisibleTags as getVisibleTags, store_holdAutosave as holdAutosave, store_initStore as initStore, store_isolateSelection as isolateSelection, store_mapOpen as mapOpen, store_mergeDuplicates as mergeDuplicates, store_mutate as mutate, store_openDuplicateLocation as openDuplicateLocation, openMap$1 as openMap, store_openStagedLocation as openStagedLocation, store_partition as partition, store_previewDuplicateGroups as previewDuplicateGroups, store_previewVirtualLocation as previewVirtualLocation, store_pruneDuplicates as pruneDuplicates, store_redo as redo, store_removeChildFromSelection as removeChildFromSelection, store_removeDuplicate as removeDuplicate, store_removeLocations as removeLocations, store_removeSelections as removeSelections, store_removeTagFromAllLocations as removeTagFromAllLocations, store_removeTagFromLocations as removeTagFromLocations, store_renameField as renameField, store_renameMap as renameMap, store_reorderSelection as reorderSelection, store_reorderTags as reorderTags, store_resetSelections as resetSelections, store_resolveIds as resolveIds, store_resolveLocation as resolveLocation, store_sampleFrom as sampleFrom, store_scheduleAutoCommit as scheduleAutoCommit, store_scheduleSave as scheduleSave, store_selectIntersection as selectIntersection, store_selectInverse as selectInverse, store_selectRandomFromSelection as selectRandomFromSelection, store_selectSpacedFromSelection as selectSpacedFromSelection, store_selectUnion as selectUnion, store_setActiveLocation as setActiveLocation, store_setMapExtraFields as setMapExtraFields, store_setPluginMode as setPluginMode, store_setPolygonName as setPolygonName, store_setSelectedLocationIds as setSelectedLocationIds, store_setSelectionColors as setSelectionColors, store_setWorkArea as setWorkArea, store_tagIdsToNames as tagIdsToNames, store_toggleGhostAllSelections as toggleGhostAllSelections, store_toggleGhostSelection as toggleGhostSelection, store_toggleManualSelection as toggleManualSelection, store_toggleTagSelections as toggleTagSelections, store_undo as undo, store_updateFilterSelection as updateFilterSelection, store_updateLocations as updateLocations, store_updateMapLabels as updateMapLabels, store_updateMapMeta as updateMapMeta, store_updateTags as updateTags, store_useMapState as useMapState, store_waitForInflightPersist as waitForInflightPersist };
  export type { store_MapState as MapState };
}

/** Prompt for GeoJSON file(s) and add their polygons as selections. */
declare function loadGeoJSON(): Promise<void>;

declare const requiresMap: () => boolean;
declare const hasActiveLocation: () => boolean;
declare const hasSelection: () => boolean;
declare const hasAnySelections: () => boolean;
/** Every editor command (palette entries; all are hotkey-bindable in Settings). */
declare const COMMANDS: {
    save: {
        label: "Commit map";
        icon: string;
        group: "Map";
        defaultBinding: string;
        aliases: string[];
        execute: () => void;
        enabled: () => boolean;
    };
    import: {
        label: "Import file";
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    copyToMap: {
        label: "Copy location to map via hotkeys...";
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    quickCopyToMap: {
        label: "Copy location to map...";
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof hasActiveLocation;
    };
    undo: {
        label: "Undo";
        icon: string;
        group: "Map";
        defaultBinding: string;
        execute: typeof undo;
        enabled: () => boolean;
    };
    redo: {
        label: "Redo";
        icon: string;
        group: "Map";
        defaultBinding: string;
        execute: typeof redo;
        enabled: () => boolean;
    };
    export: {
        label: "Export";
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "open-history": {
        label: "Open version history";
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "open-seen": {
        label: "Open seen locations";
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "toggle-seen-overlay": {
        label: "Toggle seen locations overlay";
        icon: string;
        group: "Map";
        execute: () => void;
        enabled: typeof requiresMap;
    };
    selectAll: {
        label: "Select everything";
        icon: string;
        group: "Selections";
        defaultBinding: string;
        execute: () => Promise<void>;
    };
    "select-untagged": {
        label: "Select untagged locations";
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => Promise<void>;
    };
    "select-unpanned": {
        label: "Select unpanned locations";
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "select-panoid": {
        label: "Select Pano ID locations";
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "select-no-panoid": {
        label: "Select non-Pano ID locations";
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "select-uncommitted": {
        label: "Select uncommitted locations";
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "select-reviewed": {
        label: "Select reviewed locations";
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
        enabled: typeof requiresMap;
    };
    "invert-selection": {
        label: "Invert selection";
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "intersect-selections": {
        label: "Intersect (AND) selections";
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "union-selections": {
        label: "Union (OR) selections";
        icon: string;
        group: "Selections";
        execute: () => Promise<void>;
    };
    "load-geojson": {
        label: "Load shapes from GeoJSON as selection";
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: typeof loadGeoJSON;
    };
    "download-polygon-geojson": {
        label: "Download polygon selections as GeoJSON";
        icon: string;
        group: "Selections";
        enabled: () => boolean;
        execute: () => void;
    };
    deselectAll: {
        label: "Deselect everything";
        icon: string;
        group: "Selections";
        defaultBinding: string;
        execute: typeof resetSelections;
        enabled: typeof hasAnySelections;
    };
    "find-duplicates": {
        label: "Find duplicates...";
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
    };
    "merge-duplicates": {
        label: "Merge duplicates...";
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
    };
    "filter-by-metadata": {
        label: "Filter by metadata...";
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
    };
    "top-k": {
        label: "Select top/bottom K...";
        icon: string;
        group: "Selections";
        execute: () => void;
    };
    "review-selected": {
        label: "Review selected locations";
        icon: string;
        group: "Selections";
        enabled: typeof hasSelection;
        execute: () => void;
    };
    "review-sessions": {
        label: "Review sessions";
        icon: string;
        group: "Selections";
        execute: () => void;
    };
    "select-random": {
        label: "Pick random locations from selection";
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
        enabled: typeof hasSelection;
    };
    "select-spaced": {
        label: "Thin selection by minimum distance";
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => void;
        enabled: typeof hasSelection;
    };
    "ghost-selections": {
        label: "Ghost selections";
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => Promise<void>;
        enabled: typeof hasAnySelections;
    };
    "save-selections": {
        label: "Save current selections...";
        icon: string;
        group: "Selections";
        execute: () => void;
        enabled: typeof hasAnySelections;
    };
    "apply-saved-selection": {
        label: "Apply saved selection...";
        icon: string;
        group: "Selections";
        execute: () => void;
    };
    "selection-delete-locations": {
        label: "Delete selected locations";
        icon: string;
        group: "Selections";
        enabled: typeof hasSelection;
        execute: () => Promise<void>;
    };
    "bulk-validate": {
        label: "Validate locations";
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-enrich": {
        label: "Enrich metadata fields";
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-set-field": {
        label: "Set metadata field value";
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-clear-fields": {
        label: "Clear metadata fields";
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-pin-pano": {
        label: "Pin locations to pano ID";
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-heading-road": {
        label: "Pan headings along road";
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "bulk-download-panoramas": {
        label: "Download panoramas";
        icon: string;
        group: "Bulk Operations";
        aliases: string[];
        execute: () => void;
    };
    "delete-selected-tags": {
        label: "Delete selected tags";
        icon: string;
        group: "Tags";
        execute: () => Promise<void>;
        enabled: () => boolean;
    };
    "tag-download-csv": {
        label: "Download tag counts as CSV";
        icon: string;
        group: "Tags";
        execute: () => void;
    };
    "tag-find-replace": {
        label: "Find and replace in tag names";
        icon: string;
        group: "Tags";
        aliases: string[];
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "apply-field-as-tags": {
        label: "Apply metadata as tags";
        icon: string;
        group: "Tags";
        aliases: string[];
        execute: () => void;
        enabled: typeof requiresMap;
    };
    "assign-doclinks": {
        label: "Assign document links...";
        icon: string;
        group: "Tags";
        aliases: string[];
        execute: () => void;
        enabled: typeof requiresMap;
    };
};
export type CommandId = keyof typeof COMMANDS;
export type PinnedEntry = CommandId | "---" | (string & {});

export type RGB = [number, number, number];

/** Language names stay in their own language, the way every language picker does it -- a reader
 *  looking for their own has to recognise it without already reading English.
 *  `en-XA` is the generated pseudolocale: accented and ~40% longer, so unextracted strings and
 *  layout overflow are visible without a translator. Offered in dev builds only. */
declare const LANGUAGES: {
    readonly en: "English";
    readonly de: "Deutsch";
    readonly es: "Español";
    readonly fr: "Français";
    readonly ja: "日本語";
    readonly pl: "Polski";
    readonly ru: "Русский";
    readonly "zh-Hans": "简体中文";
    readonly "en-XA": "Pseudolocale";
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
declare const OPACITY_TOGGLE_MODES: {
    readonly previous: "Last used opacity";
    readonly full: "Full opacity";
};
declare const POLYGON_COLOR_MODES: {
    readonly random: "Random";
    readonly fixed: "Fixed color";
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
export type Language = keyof typeof LANGUAGES;
export type MovementMode = keyof typeof MOVEMENT_MODES;
export type ExactDateFormat = keyof typeof EXACT_DATE_FORMATS;
export type DateTimezone = keyof typeof DATE_TIMEZONES;
export type SeenResolution = keyof typeof SEEN_RESOLUTIONS;
export type MapListField = keyof typeof MAP_LIST_FIELDS;
export type DiscordPresenceMode = keyof typeof DISCORD_PRESENCE_MODES;
export type GeocodeProvider = keyof typeof GEOCODE_PROVIDERS;
export type TagViewMode = keyof typeof TAG_VIEW_MODES;
export type TagFolderColorMode = keyof typeof TAG_FOLDER_COLOR_MODES;
export type OpacityToggleMode = keyof typeof OPACITY_TOGGLE_MODES;
export type PolygonColorMode = keyof typeof POLYGON_COLOR_MODES;
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
    showScreenshotButton: boolean;
    showPanoMetadata: boolean;
    exactDateFormat: ExactDateFormat;
    dateTimezone: DateTimezone;
    showNavArrow: boolean;
    showGroundArrow: boolean;
    hidePanoUI: boolean;
    /** Hiding the pano UI also hides navigation: link arrows, ground arrow, click-to-go X. */
    hideNavWithUI: boolean;
    fullscreenMap: boolean;
    showFullscreenMapMeta: boolean;
    showFullscreenMiniLocationPreview: boolean;
    fullscreenMiniLocationScale: number;
    showFullscreenMinimap: boolean;
    fullscreenMinimapScale: number;
    /** Milliseconds the fullscreen minimap stays expanded after the pointer leaves it. */
    fullscreenMinimapCloseDelay: number;
    showFullscreenTagbar: boolean;
    /** Tag bar dropped down to a thin strip. Toggled from the bar itself, not Settings. */
    fullscreenTagbarCollapsed: boolean;
    showFullscreenDatePicker: boolean;
    showFullscreenReviewBar: boolean;
    showFullscreenGeocode: boolean;
    customCss: string;
    enableSeen: boolean;
    enableSeenThumbnails: boolean;
    seenResolution: SeenResolution;
    mapPanSpeed: number;
    panoLookSpeed: number;
    slowModifier: number;
    showFps: boolean;
    mapListFields: MapListField[];
    /** Read once at boot; changing it relaunches the app rather than re-rendering. */
    language: Language;
    /** Reopen the maps that were open when the session last ended (main window closed). */
    restoreSession: boolean;
    /** Offer pre-release builds to the updater as well as full releases. */
    prereleaseUpdates: boolean;
    /** Discord Rich Presence: off, generic (no map name), or full (map name + count). */
    discordPresence: DiscordPresenceMode;
    /** Per-label color overrides (hex), keyed by lowercased label name. Shared across all maps. */
    labelColors: Record<string, string>;
    geocodeProvider: GeocodeProvider;
    nominatimApiKey: string;
    panToImported: boolean;
    /** With no location open, Enter shows a center crosshair and opens the location under it. */
    enterOpensCenter: boolean;
    /** Min half-extent (degrees) a single pasted/imported point is padded to before fitBounds */
    pastePadding: number;
    followActiveInReview: boolean;
    markerColor: RGB;
    activeLocationColor: RGB;
    importPreviewColor: RGB;
    panoDotColor: RGB;
    /** Color a newly drawn polygon selection starts with. `random` hashes it from the polygon's
     *  key; `fixed` uses polygonColor. Either way it's only the initial value -- recoloring a
     *  polygon by hand still wins. */
    /** What the layer opacity hotkeys restore a layer to when toggling it back on. */
    opacityToggleMode: OpacityToggleMode;
    polygonColorMode: PolygonColorMode;
    polygonColor: RGB;
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
    /** Copy-to-map hotkeys that work in every map (assigned in the copy-to-map dialog);
     *  a map's own binding on the same key shadows them. */
    globalCopyBindings: MapKeyBinding[];
    /** Local REST transport for window.MMA (Settings > Advanced). */
    remoteApi: boolean;
    remoteApiKey: string;
    pinnedCommands: PinnedEntry[];
    hasSeenWelcome: boolean;
    /** Off = Commit applies immediately with no message prompt. */
    askCommitMessage: boolean;
};
export type AppSettings = typeof DEFAULTS;
declare function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;

/** Parsed-but-not-committed import shown while `workArea === "import"`. */
export interface ImportStaging {
    preview: EditorImportPreview;
    source: "file" | "paste";
}
declare function getImportPreviewPositions(): Float32Array<ArrayBufferLike>;
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

declare function hasCommitDiff(): boolean;
/** Zero the cached counts (a commit just cleared the overlay). */
declare function resetCommitDiffCounts(): void;
declare function useCommitDiff(): CommitDiff;
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
declare const commitDiff_hasCommitDiff: typeof hasCommitDiff;
declare const commitDiff_resetCommitDiffCounts: typeof resetCommitDiffCounts;
declare const commitDiff_resetCommitDiffState: typeof resetCommitDiffState;
declare const commitDiff_useCommitDiff: typeof useCommitDiff;
declare namespace commitDiff {
  export { commitDiff_beginCommitDiffPreview as beginCommitDiffPreview, commitDiff_categorizeCommitDelta as categorizeCommitDelta, commitDiff_diffPositions as diffPositions, commitDiff_endCommitDiffPreview as endCommitDiffPreview, commitDiff_getCommitDiffPreview as getCommitDiffPreview, commitDiff_hasCommitDiff as hasCommitDiff, commitDiff_resetCommitDiffCounts as resetCommitDiffCounts, commitDiff_resetCommitDiffState as resetCommitDiffState, commitDiff_useCommitDiff as useCommitDiff };
  export type { commitDiff_CommitDiffPreview as CommitDiffPreview };
}

/** What the selector picker offers. Not a location set -- `selectorForPick` turns it
 *  into a `Selector`. */
export type SelectorPick = {
    pick: "all";
} | {
    pick: "selection";
} | {
    pick: "saved";
    id: string;
};
export interface SelectorPickController {
    /** The picked locations. Hand it straight to any `Selector` consumer. */
    selector: Selector;
    /** The picker's own state. Persist this, not `selector`: it tracks the live selection. */
    choice: SelectorPick;
    setChoice(c: SelectorPick): void;
    allCount: number;
    selectionCount: number;
    /** Opt-in: the picker additionally offers saved selections. */
    saved?: boolean;
}
declare function selectorForPick(choice: SelectorPick): Selector;
/** Reactive selector state + live counts, owned by the calling React component. Defaults to
 *  the current selection when one exists at mount, else all locations. Use this for plugins
 *  whose selector lives entirely in a React sidebar; reach for `createSelectorPick` when an imperative
 *  renderer (e.g. a deck.gl overlay) outside React also needs to read the selector. */
declare function useSelectorPick(initial?: SelectorPick): SelectorPickController;
/** A per-consumer selector store that lives outside React, so an imperative renderer can read it
 *  synchronously and subscribe to changes while a React sidebar drives it via `use()`.
 *  Isolated per call - one consumer's choice never leaks into another's. */
export interface SelectorPickHandle {
    get(): Selector;
    getChoice(): SelectorPick;
    set(choice: SelectorPick): void;
    subscribe(listener: () => void): () => void;
    /** React view of this handle: re-renders on change, with live counts. */
    use(): SelectorPickController;
}
/** A standalone "all locations vs current selection" switch, for features that operate on a subset. */
declare function createSelectorPick(initial?: SelectorPick): SelectorPickHandle;

export type picker_SelectorPick = SelectorPick;
export type picker_SelectorPickController = SelectorPickController;
export type picker_SelectorPickHandle = SelectorPickHandle;
declare const picker_createSelectorPick: typeof createSelectorPick;
declare const picker_selectorForPick: typeof selectorForPick;
declare const picker_useSelectorPick: typeof useSelectorPick;
declare namespace picker {
  export { picker_createSelectorPick as createSelectorPick, picker_selectorForPick as selectorForPick, picker_useSelectorPick as useSelectorPick };
  export type { picker_SelectorPick as SelectorPick, picker_SelectorPickController as SelectorPickController, picker_SelectorPickHandle as SelectorPickHandle };
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
declare function deleteMap$1(id: string): Promise<void>;
declare function renameFolder(from: string, to: string): Promise<void>;
declare function moveMapToFolder(mapId: string, folder: string | null): Promise<void>;
declare function deleteFolder(name: string): Promise<void>;

declare const mapList_createMap: typeof createMap;
declare const mapList_deleteFolder: typeof deleteFolder;
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
    deleteMap$1 as deleteMap,
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
 *  refreshProjection's selector so the key and color match an in-progress projection. */
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
    experimental?: boolean;
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

export interface JobContext<P> {
    signal: AbortSignal;
    /** Push a progress value to the UI. Ignored once the job is cancelled. */
    report: (progress: P) => void;
}
export interface Job<R, P> {
    running: boolean;
    progress: P | null;
    result: R | null;
    /** Message from a failed run. Cancelling is not a failure and leaves this null. */
    error: string | null;
    run: () => void;
    cancel: () => void;
}
/** A user-triggered async job that reports progress and can be cancelled -- the
 *  run/cancel/progress/error state every long plugin action was keeping by hand.
 *  Cancelling aborts the signal and stops the UI immediately; nothing the job does
 *  afterwards can write back. Unmounting cancels. `run` while running is a no-op,
 *  so a double-clicked button cannot start two.
 *
 *  For work driven by changing deps rather than a click, use `useAsync`. */
declare function useJob<R = void, P = string>(fn: (ctx: JobContext<P>) => Promise<R>): Job<R, P>;

export type ButtonVariant = "primary" | "destructive" | "ghost";
declare function Button({ variant, small, type, className, ...props }: ComponentPropsWithRef<"button"> & {
    variant?: ButtonVariant;
    small?: boolean;
}): React$1.JSX.Element;

declare function Checkbox({ className, ...props }: ComponentPropsWithRef<"input">): React$1.JSX.Element;

/** The picker surface itself, debounced. Sole place the `{r,g,b}` shape react-colorful
 *  wants exists -- every caller in the app passes and receives an [r, g, b] tuple. */
declare function RgbPicker({ color, onChange }: {
    color: RGB;
    onChange: (color: RGB) => void;
}): React$1.JSX.Element;
/** A color swatch that opens the picker in a popover on click. */
declare function ColorPicker({ color, onChange, ariaLabel, }: {
    color: RGB;
    onChange: (color: RGB) => void;
    ariaLabel?: string;
}): React$1.JSX.Element;

export interface DatePickerProps {
    mode: "date" | "month";
    value: string;
    onChange: (v: string) => void;
    anyYear?: boolean;
    onAnyYearToggle?: (v: boolean) => void;
    showAnyYear?: boolean;
    showTime?: boolean;
    anyTime?: boolean;
    onAnyTimeToggle?: (v: boolean) => void;
    showAnyTime?: boolean;
    tzLocal?: boolean;
    onTzLocalToggle?: (v: boolean) => void;
    showTzLocal?: boolean;
    onYearSelect?: (year: number) => void;
    /** Treat the value as a wall-clock instant encoded as a UTC epoch (the picked
     *  numbers survive unshifted by the viewer's timezone). Used by location-time
     *  date filtering, where Rust re-interprets the wall-clock in each pano's zone. */
    wallClock?: boolean;
}
declare function DatePicker({ mode, value, onChange, anyYear, onAnyYearToggle, showAnyYear, showTime, anyTime, onAnyTimeToggle, showAnyTime, tzLocal, onTzLocalToggle, showTzLocal, onYearSelect, wallClock, }: DatePickerProps): React$1.JSX.Element;

declare const NODES: readonly ["a", "button", "div", "form", "h2", "h3", "img", "input", "label", "li", "nav", "ol", "p", "select", "span", "svg", "ul"];
export type Primitives = {
    [E in (typeof NODES)[number]]: PrimitiveForwardRefComponent<E>;
};
export type PrimitivePropsWithRef<E extends React$1.ElementType> = React$1.ComponentPropsWithRef<E> & {
    asChild?: boolean;
};
export interface PrimitiveForwardRefComponent<E extends React$1.ElementType> extends React$1.ForwardRefExoticComponent<PrimitivePropsWithRef<E>> {
}
declare const Primitive: Primitives;

export type PrimitiveDivProps$1 = React$1.ComponentPropsWithoutRef<typeof Primitive.div>;
export interface DismissableLayerProps$1 extends PrimitiveDivProps$1 {
    /**
     * When `true`, hover/focus/click interactions will be disabled on elements outside
     * the `DismissableLayer`. Users will need to click twice on outside elements to
     * interact with them: once to close the `DismissableLayer`, and again to trigger the element.
     */
    disableOutsidePointerEvents?: boolean;
    /**
     * When `true`, a `'pointerdown'` event outside of the layered element will
     * wait for the interaction's click event before dispatching, allowing
     * third-party code to stop propagation of later events and cancel dismissal.
     */
    deferPointerDownOutside?: boolean;
    /**
     * Event handler called when the escape key is down.
     * Can be prevented.
     */
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    /**
     * Event handler called when the a `pointerdown` event happens outside of the `DismissableLayer`.
     * Can be prevented.
     */
    onPointerDownOutside?: (event: PointerDownOutsideEvent) => void;
    /**
     * Event handler called when the focus moves outside of the `DismissableLayer`.
     * Can be prevented.
     */
    onFocusOutside?: (event: FocusOutsideEvent) => void;
    /**
     * Event handler called when an interaction happens outside the `DismissableLayer`.
     * Specifically, when a `pointerdown` event happens outside or focus moves outside of it.
     * Can be prevented.
     */
    onInteractOutside?: (event: PointerDownOutsideEvent | FocusOutsideEvent) => void;
    /**
     * Handler called when the `DismissableLayer` should be dismissed
     */
    onDismiss?: () => void;
}
declare const DismissableLayer: React$1.ForwardRefExoticComponent<DismissableLayerProps$1 & React$1.RefAttributes<HTMLDivElement>>;
export type PointerDownOutsideEvent = CustomEvent<{
    originalEvent: PointerEvent;
}>;
export type FocusOutsideEvent = CustomEvent<{
    originalEvent: FocusEvent;
}>;

export type PrimitiveDivProps = React$1.ComponentPropsWithoutRef<typeof Primitive.div>;
export interface FocusScopeProps$1 extends PrimitiveDivProps {
    /**
     * When `true`, tabbing from last item will focus first tabbable
     * and shift+tab from first item will focus last tababble.
     * @defaultValue false
     */
    loop?: boolean;
    /**
     * When `true`, focus cannot escape the focus scope via keyboard,
     * pointer, or a programmatic focus.
     * @defaultValue false
     */
    trapped?: boolean;
    /**
     * Event handler called when auto-focusing on mount.
     * Can be prevented.
     */
    onMountAutoFocus?: (event: Event) => void;
    /**
     * Event handler called when auto-focusing on unmount.
     * Can be prevented.
     */
    onUnmountAutoFocus?: (event: Event) => void;
}
declare const FocusScope: React$1.ForwardRefExoticComponent<FocusScopeProps$1 & React$1.RefAttributes<HTMLDivElement>>;

export interface DialogProps$1 {
    children?: React$1.ReactNode;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?(open: boolean): void;
    modal?: boolean;
}
export type PrimitiveButtonProps = React$1.ComponentPropsWithoutRef<typeof Primitive.button>;
export interface DialogTriggerProps extends PrimitiveButtonProps {
}
export interface DialogContentProps extends DialogContentTypeProps {
    /**
     * Used to force mounting when more control is needed. Useful when
     * controlling animation with React animation libraries.
     */
    forceMount?: true;
}
export interface DialogContentTypeProps extends Omit<DialogContentImplProps, 'trapFocus' | 'disableOutsidePointerEvents'> {
}
export type DismissableLayerProps = React$1.ComponentPropsWithoutRef<typeof DismissableLayer>;
export type FocusScopeProps = React$1.ComponentPropsWithoutRef<typeof FocusScope>;
export interface DialogContentImplProps extends Omit<DismissableLayerProps, 'onDismiss'> {
    /**
     * When `true`, focus cannot escape the `Content` via keyboard,
     * pointer, or a programmatic focus.
     * @defaultValue false
     */
    trapFocus?: FocusScopeProps['trapped'];
    /**
     * Event handler called when auto-focusing on open.
     * Can be prevented.
     */
    onOpenAutoFocus?: FocusScopeProps['onMountAutoFocus'];
    /**
     * Event handler called when auto-focusing on close.
     * Can be prevented.
     */
    onCloseAutoFocus?: FocusScopeProps['onUnmountAutoFocus'];
}

/** Controlled open/close pair every dialog component takes. */
export interface DialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}
declare function useCloseDialog(): () => void;
declare function Dialog({ open, onOpenChange, children, ...props }: DialogProps$1): React$1.JSX.Element;
declare const DialogTrigger: React$1.ForwardRefExoticComponent<DialogTriggerProps & React$1.RefAttributes<HTMLButtonElement>>;
declare function DialogContent({ className, title, children, ...props }: DialogContentProps & {
    title: string;
}): React$1.JSX.Element;

/** Country flag from the bundled SVG set. Renders nothing for a missing or malformed code. */
declare function Flag({ code, height, className, }: {
    code: string | null | undefined;
    height?: number;
    className?: string;
}): React$1.JSX.Element | null;

/** Click-to-record key combo input. Backspace/Delete clears, Escape cancels. */
declare function HotkeyInput({ value, onChange, }: {
    value: string;
    onChange: (combo: string) => void;
}): React$1.JSX.Element;

export interface IconProps {
    path: string;
    size?: number;
    className?: string;
    style?: React.CSSProperties;
}
declare function Icon({ path, size, className, style }: IconProps): React$1.JSX.Element;

declare function NSelect({ className, onWheel, ...props }: ComponentPropsWithRef<"select">): React$1.JSX.Element;

declare function Radio({ className, ...props }: ComponentPropsWithRef<"input">): React$1.JSX.Element;

declare function SelectorPicker({ ctl, className, }: {
    ctl: SelectorPickController;
    className?: string;
}): React$1.JSX.Element;

/** `label` stays a plain string so settings search can match on it; `badge` is the escape hatch
 *  for a marker sitting beside it, like the flask on an experimental plugin card. */
export type Base = {
    label: string;
    badge?: ReactNode;
    description?: string;
    disabled?: boolean;
    sub?: boolean;
};
export type BoolRow = Base & {
    checked: boolean;
    onChange: (v: boolean) => void;
};
export type AutoBoolRow = Base & {
    setting: keyof AppSettings;
};
export type ControlRow = Base & {
    control: ReactNode;
};
declare function SettingRow(props: BoolRow | ControlRow | AutoBoolRow): React$1.JSX.Element | null;

/** Standard right-hand sidebar chrome (title, back button, scrollable body). Use for plugin sidebars. */
declare function Sidebar({ title, onBack, actions, className, flush, children, }: {
    title: ReactNode;
    onBack?: () => void;
    actions?: ReactNode;
    className?: string;
    flush?: boolean;
    children: ReactNode;
}): React$1.JSX.Element;
/** Collapsible titled section inside a Sidebar. */
declare function Section({ title, defaultOpen, collapsible, addons, children, }: {
    title: ReactNode;
    defaultOpen?: boolean;
    collapsible?: boolean;
    addons?: ReactNode;
    children: ReactNode;
}): React$1.JSX.Element;
/** Labelled form row (label left, control right) for sidebar sections. */
declare function Field({ label, hint, row, children, }: {
    label: ReactNode;
    hint?: ReactNode;
    row?: boolean;
    children: ReactNode;
}): React$1.JSX.Element;
/** Centered icon + message for empty panels. */
declare function EmptyState({ icon, children }: {
    icon?: string;
    children: ReactNode;
}): React$1.JSX.Element;
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
}): React$1.JSX.Element;

/** Range input whose track fills with the accent up to the current value.
 *  Controlled only: the fill derives from the value prop. */
declare function Slider({ className, ...props }: ComponentPropsWithRef<"input">): React$1.JSX.Element;

/** Autocomplete input: owns open/close state, outside-click dismissal,
 *  Enter-picks-first, and Escape-closes. Suggestion sourcing stays at the call
 *  site (sync filter or debounced fetch) — the dropdown shows whenever
 *  `suggestions` is non-empty and not dismissed. Default classes render the
 *  standard `.search-results` dropdown; override them for other skins. */
declare function SuggestInput<T>({ value, onChange, suggestions, onPick, renderItem, getKey, placeholder, containerClassName, inputClassName, listClassName, itemClassName, listStyle, autoFocus, disabled, pickOnEnter, portal, }: {
    value: string;
    onChange: (v: string) => void;
    suggestions: T[];
    onPick: (item: T) => void;
    renderItem: (item: T) => ReactNode;
    getKey: (item: T) => string | number;
    placeholder?: string;
    containerClassName?: string;
    inputClassName?: string;
    listClassName?: string;
    itemClassName?: string;
    listStyle?: CSSProperties;
    autoFocus?: boolean;
    disabled?: boolean;
    /** When false, Enter closes the dropdown and falls through (e.g. to a form submit). */
    pickOnEnter?: boolean;
    /** Render the dropdown in a body portal (fixed, anchored to the input) so it floats
     *  over clipping ancestors like `.modal__content`. Clicks on it are exempted from
     *  dialog outside-dismissal via the `suggest-portal` class (see DialogContent). */
    portal?: boolean;
}): React$1.JSX.Element;

declare function Switch({ checked, onChange, disabled, label, }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    label?: string;
}): React$1.JSX.Element;

/** A compact, control-left row whose whole surface toggles an immediate-effect
 *  boolean. The Switch owns keyboard + a11y; the row forwards mouse clicks to
 *  the same toggle. The control wrapper stops propagation so a direct switch
 *  click does not also fire the row handler. Used by MapSettingsPanel and any
 *  surface outside the Settings dialog (SettingRow is the Settings dialog row). */
declare function SwitchRow({ checked, onChange, label, disabled, className, children, }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    disabled?: boolean;
    className?: string;
    children?: ReactNode;
}): React$1.JSX.Element;

export type TagPillButtonVariant = "add" | "delete" | "edit";
/** The leading affordance inside a TagPill: remove, apply, or open the editor. */
declare function TagPillButton({ variant, className, ...props }: ComponentPropsWithRef<"button"> & {
    variant: TagPillButtonVariant;
}): React$1.JSX.Element;
export type TagPillOwnProps = {
    color: string;
    label: ReactNode;
    count?: number;
    small?: boolean;
    button?: ReactNode;
    children?: ReactNode;
};
export type TagPillProps<E extends ElementType> = TagPillOwnProps & {
    as?: E;
} & Omit<ComponentPropsWithRef<E>, keyof TagPillOwnProps | "as">;
/** The one tag pill. Owns the tag color's rendering: every surface that shows a tag
 *  goes through here, so the look changes in one place. */
declare function TagPill<E extends ElementType = "span">({ as, color, label, count, small, button, children, ...rest }: TagPillProps<E>): React$1.JSX.Element;

declare function TextInput({ className, ...props }: ComponentPropsWithRef<"input">): React$1.JSX.Element;

export interface ToolBlockProps {
    title: string;
    className?: string;
    addons?: ReactNode;
    children?: ReactNode;
    isCollapsed?: boolean;
    onCollapse?: (collapsed: boolean) => void;
    collapsedAddons?: ReactNode;
}
declare function ToolBlock(props: ToolBlockProps): React$1.JSX.Element;

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";
/** Marks its child as a tooltip trigger. Adds attributes to the existing element instead of
 *  wrapping it, so a trigger costs no extra fibers and hovering re-renders only the single
 *  host below -- one portal for the whole app rather than one per trigger. */
declare function Tooltip({ content, side, align, children, }: {
    content: string;
    side?: Side;
    align?: Align;
    children: ReactElement;
}): ReactElement<Record<string, unknown>, string | React$1.JSXElementConstructor<any>>;

/**
 * The public widget set, re-exported as one surface so `MMA.ui` is this list and
 * nothing else. Membership is deliberate: whatever a plugin can reach here has to
 * keep working (see legacy.ts), so a primitive is added when a plugin needs it,
 * not because it happens to live in this folder.
 *
 * Deliberately absent: ToastContainer (singleton mount -- use `MMA.toast`),
 * MeasurementBar (reads map state), SettingsSearchContext/useSettingsSearch
 * (Settings-dialog plumbing), Trans (i18n infra).
 */

declare const ui_Button: typeof Button;
declare const ui_Checkbox: typeof Checkbox;
declare const ui_ColorPicker: typeof ColorPicker;
declare const ui_DatePicker: typeof DatePicker;
declare const ui_Dialog: typeof Dialog;
declare const ui_DialogContent: typeof DialogContent;
export type ui_DialogProps = DialogProps;
declare const ui_DialogTrigger: typeof DialogTrigger;
declare const ui_EmptyState: typeof EmptyState;
declare const ui_Field: typeof Field;
declare const ui_Flag: typeof Flag;
declare const ui_HotkeyInput: typeof HotkeyInput;
declare const ui_Icon: typeof Icon;
declare const ui_NSelect: typeof NSelect;
declare const ui_Radio: typeof Radio;
declare const ui_RgbPicker: typeof RgbPicker;
declare const ui_Section: typeof Section;
declare const ui_SegmentedControl: typeof SegmentedControl;
export type ui_SegmentedOption<T extends string | number> = SegmentedOption<T>;
declare const ui_SelectorPicker: typeof SelectorPicker;
declare const ui_SettingRow: typeof SettingRow;
declare const ui_Sidebar: typeof Sidebar;
declare const ui_Slider: typeof Slider;
declare const ui_SuggestInput: typeof SuggestInput;
declare const ui_Switch: typeof Switch;
declare const ui_SwitchRow: typeof SwitchRow;
declare const ui_TagPill: typeof TagPill;
declare const ui_TagPillButton: typeof TagPillButton;
declare const ui_TextInput: typeof TextInput;
declare const ui_ToolBlock: typeof ToolBlock;
declare const ui_Tooltip: typeof Tooltip;
declare const ui_useCloseDialog: typeof useCloseDialog;
declare namespace ui {
  export { ui_Button as Button, ui_Checkbox as Checkbox, ui_ColorPicker as ColorPicker, ui_DatePicker as DatePicker, ui_Dialog as Dialog, ui_DialogContent as DialogContent, ui_DialogTrigger as DialogTrigger, ui_EmptyState as EmptyState, ui_Field as Field, ui_Flag as Flag, ui_HotkeyInput as HotkeyInput, ui_Icon as Icon, ui_NSelect as NSelect, ui_Radio as Radio, ui_RgbPicker as RgbPicker, ui_Section as Section, ui_SegmentedControl as SegmentedControl, ui_SelectorPicker as SelectorPicker, ui_SettingRow as SettingRow, ui_Sidebar as Sidebar, ui_Slider as Slider, ui_SuggestInput as SuggestInput, ui_Switch as Switch, ui_SwitchRow as SwitchRow, ui_TagPill as TagPill, ui_TagPillButton as TagPillButton, ui_TextInput as TextInput, ui_ToolBlock as ToolBlock, ui_Tooltip as Tooltip, ui_useCloseDialog as useCloseDialog };
  export type { ui_DialogProps as DialogProps, ui_SegmentedOption as SegmentedOption };
}

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
/** A unit of work for the procedure engine: which module, and how to drive it. This is
 *  everything the engine needs and nothing about enrichment; `runProcedure` takes one
 *  directly. Locations never reach JS: the engine pages them and applies the patches
 *  itself. `TCollected` is the shape of one answer under the `collect` sink, as the
 *  module defines it; the engine carries it as JSON and never checks it. */
export interface ProcedureSpec<TCollected = unknown> {
    /** Never set. Carries `TCollected` on the value so `runProcedure` can type its answers. */
    readonly collects?: TCollected;
    /** Module entry point: absolute path, or "res://procedures/<name>.js" for app-bundled
     *  core procedures, or a bare relative filename for user-plugin-shipped modules (resolved
     *  against the registering plugin's directory by the plugin loader). */
    entry: string;
    /** Rows the engine feeds the procedure. Omitted, the driver supplies its own. */
    select?: Selector;
    batch: BatchMode;
    /** Where the answers go: `patch` (the default) writes them to the locations they
     *  name, `collect` hands them to the caller and writes nothing. `runProcedure` can
     *  override it, which is how a caller borrows a writing procedure for its answers
     *  alone. */
    sink?: Sink;
    rate?: RateSpec;
    retry?: {
        attempts: number;
        on: number[];
    };
    /** Requests this provider may keep in flight at once, summed over its instances.
     *  This is where a network-bound provider's throughput comes from: the engine holds
     *  the budget, so a procedure reaches it by asking for many requests at once
     *  (`fetchMany`), never by running more instances. */
    inflight?: number;
    /** Procedure instances the provider may run at once. Only for a procedure that cannot
     *  run beside itself (one sidecar process, one large model); otherwise the engine
     *  takes one per core, which is not a throughput knob. */
    instances?: number;
    /** Provider-specific settings for the module, any JSON value. The engine splices it
     *  into the configuration it hands the procedure: `{fields, force, config}`. */
    config?: unknown;
    /** Awaited before the provider joins a run; false drops it (e.g. a dataset download failed). */
    prepare?: () => Promise<boolean>;
}
/** What the enrichment scheduler needs on top of a procedure: the fields it produces
 *  (which the field picker offers and the skip-if-present check reads), the columns it
 *  writes, and what it must wait for. Only the enrichment path registers these; a
 *  consumer that just wants a procedure run declares a `ProcedureSpec` and calls
 *  `runProcedure`. */
export interface EnrichmentProvider {
    id: string;
    /** Bulk progress label for slow providers; omit for instant ones. */
    label?: string;
    /** The procedure the Rust engine runs for this provider. */
    procedure: ProcedureSpec;
    /** Selectable `extra` keys this provider produces. Omitted, the provider writes
     *  core columns instead: it is always active, and `enrichAll` never runs it
     *  implicitly -- only a caller naming it does. */
    fieldDefs?: Record<string, ExtraFieldDef>;
    /** Core columns this provider writes, e.g. `panoId`. Scheduled into the dependency
     *  waves and used to skip rows that already hold them, exactly like `fieldDefs`. */
    provides?: string[];
    /** Fields this provider reads: the engine schedules it into a later dependency
     *  wave than any provider producing them. */
    requires?: string[];
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
    /** Location data changed in bulk without per-location patches (e.g. a Rust-side
     *  field op). Anything derived from location data must re-query. */
    "location:invalidate": void;
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
    "map-list:changed": void;
    "saved-selections:changed": void;
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
    "commit-diff:changed": void;
};
export type EditorEventMap = typeof EVENT_DEFS;
export type EditorEvent = keyof EditorEventMap;
export type EventHandler<E extends EditorEvent> = (payload: EditorEventMap[E]) => void;

/** Saved selection rules: global, name-based, stored in SQLite.
 *
 *  A rule is one `Selector` tree plus the names its `Tag` leaves carried at save time.
 *  Tag ids are map-local, so the names are what makes a rule portable -- the tree itself
 *  is stored verbatim and re-resolved against whatever map is open. */

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
declare function savedParts(saved: SavedSelection): SavedPart[];
/** The rules that exist, as identity only. Empty until the index arrives -- the first
 *  call starts the read and `saved-selections:changed` announces it. */
declare function getSavedSelectionIndex(): SavedSelectionInfo[];
/** Bodies for `ids`, fetching only the ones not already held. */
declare function loadSavedSelections(ids: string[]): Promise<SavedSelection[]>;
/** A saved rule as a single `Selector`, resolved against the open map. Matches nothing
 *  until the body arrives; fetching it emits `saved-selections:changed`, so a caller that
 *  re-reads on that event gets the real tree. */
declare function savedSelector(id: string): Selector;

/** Fetch a page of the seen (visited-panorama) history. */
declare function getSeenEntries(limit?: number, offset?: number, filter?: SeenFilter, thumbnails?: boolean): Promise<SeenEntry[]>;
/** Number of seen entries matching the filter (all when omitted). */
declare function getSeenCount(filter?: SeenFilter): Promise<number>;
/** Delete the entire seen history. Not undoable. */
declare function clearSeen(): Promise<void>;

/** Open a seen entry's panorama in the Street View viewer. */
declare function loadSeenPano(entry: SeenEntry): Promise<void>;

/**
 * Driver for the Rust procedure engine. A bulk operation is one or more procedures plus
 * a `Selector`: the engine resolves the selector, schedules the dependency waves, pages
 * the locations, calls each procedure and delivers what it answers, as patches or back
 * to the caller. Locations never reach JS.
 */

/** Entry point of a procedure this app bundles. Plugins ship their own paths. */
declare const procedureEntry: (name: string) => string;
/** One location's answer from a `collect` run, as its module defines it. */
export interface CollectedEntry<T = unknown> {
    id: number;
    value: T;
}
export interface ResolverOutcome<TCollected = unknown> {
    /** Rows the procedure worked and did not fail. A count: the engine never ships the
     *  ids of what went right. */
    success: number;
    /** Rows the procedure failed, by id, so a caller can select them. */
    failed: number[];
    /** Answers from a `collect` run, in page order. Absent for a run whose results were
     *  written as patches. Typed by the spec's declaration, not checked: the value still
     *  crosses a JSON boundary, so a reader guards it. */
    collected?: CollectedEntry<TCollected>[];
}
export interface RunOpts {
    signal?: AbortSignal;
    force?: boolean;
    /** The `extra` keys the run should produce; null means the default set. */
    enrichFields?: string[] | null;
    /** `label` names the current phase; undefined = no labelled provider is running.
     *  `done`/`total` are phase-relative and net of skipped rows, so they reset as each
     *  dependency wave begins. */
    onProgress?: (done: number, total: number, label?: string) => void;
}
/** What a run may set on top of what the spec declares. */
export interface DeclOpts {
    label?: string;
    /** Replaces the spec's `config`. */
    config?: unknown;
    /** `collect` takes the answers instead of writing them. */
    sink?: Sink;
    /** Re-derive even on an unforced run: recompute rather than fill in what is missing. */
    force?: boolean;
    fields?: string[];
    requires?: string[];
}
/** Run one procedure over `selector`, on its own. The primitive: a consumer that is not
 *  enrichment (validation, a download resolving pano ids) declares a spec and calls this,
 *  and gets its collected answers typed by the spec. */
declare function runProcedure<T>(spec: ProcedureSpec<T>, selector: Selector, opts: RunOpts & Omit<DeclOpts, "fields" | "requires"> & {
    id: string;
}): Promise<ResolverOutcome<T>>;

/** True when the location is missing any of the given enrich fields (default: the enabled set). */
declare function needsEnrichment(loc: Location, enrichFields?: string[]): boolean;
/** One summary row per pass that did work: the core metadata pass, then every
 *  provider that updated or failed at least one location. */
export interface EnrichOutcome extends ResolverOutcome {
    id: string;
    label: string;
}
export type EnrichResult = EnrichOutcome[];
/** Bulk enrich a selector: resolve missing pano ids, then run every field-producing
 *  provider (metadata, exact date, timezone, subdivision) through the Rust engine. */
declare function enrichAll(selector: Selector, opts?: {
    signal?: AbortSignal;
    force?: boolean;
    onProgress?: (done: number, total: number, label?: string) => void;
}): Promise<EnrichResult>;

/** Pin each location in the selector to a resolved panorama (sets `panoId`), so it always
 *  loads the same pano. Returns the number of locations pinned. */
declare function bulkPinToPano(selector: Selector, opts?: {
    signal?: AbortSignal;
    force?: boolean;
    useLatest?: boolean;
    onProgress?: (done: number, total: number) => void;
}): Promise<number>;

/** Check that each location's Street View coverage still exists; returns the location
 *  ids grouped by the state they validated to. */
declare function validateLocations(selector: Selector, opts?: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
}): Promise<Map<ValidationState, number[]>>;

/**
 * The surface a procedure module runs against: the global `mma` object and the values
 * that cross the boundary. Every host call is synchronous -- the guest blocks while the
 * host works, which is how `fetchMany` (never a loop over `fetch`) buys a procedure its
 * request concurrency.
 *
 * A procedure is an ES module bundled to one file. Its named exports are the entry
 * points: `request` + `map` (RequestMap), `map` (MapOnly) or `run` (Run), plus the
 * optional `query` and `configure`. Rows arrive as `Location`s and `run`/`map` answer
 * with `Update<LocationPatch>`s under the `patch` sink, or `Update<T>` of the module's
 * own answer under `collect`.
 */
interface ProcedureRequest {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | ArrayBuffer;
}
interface ProcedureResponse {
    /** 0 when the host could not issue the request at all. */
    status: number;
    body: Uint8Array;
}
interface ProcedureHost {
    fetch(req: ProcedureRequest): ProcedureResponse;
    fetchMany(reqs: ProcedureRequest[]): ProcedureResponse[];
    classify(dataset: string, lat: number, lng: number): string | null;
    /** Run one sidecar command. `onLine` sees each output line as it arrives, so a
     *  procedure can report progress mid-run; the lines are also returned together. */
    sidecar(pluginId: string, command: string, payloadJson: string, onLine?: (line: string) => void): string[];
    /** 0 debug, 1 info, 2 warn, 3 error. `console.*` routes here. */
    log(level: number, msg: string): void;
    progress(units: number): void;
    /** Marks a row as failed rather than skipped. */
    fail(id: number): void;
    aborted(): boolean;
}
declare global {
    /** Reachable inside a procedure module only. `fetch`, `fetchMany` and `sidecar` are
     *  detached outside `run` and `query`; calling one elsewhere throws. */
    const mma: ProcedureHost;
}

/** Full pano metadata for arbitrarily many panos, aligned to `panoIds`. The procedure
 *  dedupes and splits at GetMetadata's 200-per-request cap itself. */
declare function svMetadata(panoIds: string[], signal?: AbortSignal): Promise<(Pano | null)[]>;

/** URL that serves a local file over the `mma-buf://` protocol (binary Rust-to-JS transfers). */
declare function mmaBufUrl(path: string): string;

export interface MapEmbedPrefs {
    svOpacity: number;
    svVisible: boolean;
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
    markerVisible: boolean;
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
    /** The camera came to rest after a pan/zoom (Google `idle`, maplibre `idle`). */
    idle: void;
    tilesloaded: void;
}
export interface BasemapOpts {
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
    /** CSS cursor over the map; null restores the host's default. */
    setCursor(v: string | null): void;
    setDoubleClickZoom(v: boolean): void;
    createDeckOverlay(): DeckOverlayHandle;
    triggerClickAt(latLng: LatLng): void;
    applyPrefs(prefs: MapEmbedPrefs, opts: BasemapOpts): void;
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

/** @deprecated v0.8.1. Use `MMA.getMapHost()` and narrow via `hostInstance`. */
declare function getGoogleMap(): google.maps.Map | null;
/** @deprecated v0.8.1. Use `MMA.waitForMapHost()`. */
declare function waitForGoogleMap(): Promise<google.maps.Map | null>;
/** @deprecated v0.8.2. Read `MMA.getMapState().map`. */
declare function getCurrentMap(): MapData | null;
/** @deprecated v0.8.2. Read `MMA.getMapState().mapId`. */
declare function getCurrentMapId(): string | null;
/** @deprecated v0.8.2. Read `MMA.getMapState().activeLocation`. */
declare function getActiveLocation(): Location | null;
/** @deprecated v0.8.2. Read `MMA.getMapState().selectedLocationIds`. */
declare function getSelectedLocationIds(): SelectedIds;
/** @deprecated v0.8.2. Read `MMA.getMapState().workArea`. */
declare function getWorkArea(): WorkArea;
/** @deprecated v0.8.2. Read `MMA.getMapState().tagCounts`. */
declare function getTagCounts(): Record<number, number>;
/** @deprecated v0.8.2. Read `MMA.getMapState().knownFieldKeys`. */
declare function getKnownFieldKeys(): ReadonlySet<string>;
/** @deprecated v0.8.2. Read `MMA.getMapState().selections`. */
declare function getAllSelections(): Selection[];
/** @deprecated v0.8.2. Read `MMA.getMapState().ghostedSelections`. */
declare function getGhostedSelections(): ReadonlySet<string>;
/** @deprecated v0.8.2. Use `MMA.getActiveSelections()`. */
declare function getSelections(): Selection[];
/** @deprecated v0.8.2. Read `(await MMA.cmd.storeGetSummary()).dirtyCount`. */
declare function getDirtyCount(): Promise<number>;
/** @deprecated v0.8.4. Use `MMA.fetchLocations({ type: "Locations", locations: [id], name: null })`. */
declare function fetchLocation(id: number): Promise<Location>;
/** @deprecated v0.8.4. Use `MMA.fetchLocations({ type: "Locations", locations: ids, name: null })`. */
declare function fetchLocationsByIds(ids: number[]): Promise<Location[]>;
/** @deprecated v0.8.4. Use `MMA.fetchLocations({ type: "Everything" })`. */
declare function fetchAllLocations(): Promise<Location[]>;

declare const legacy_fetchAllLocations: typeof fetchAllLocations;
declare const legacy_fetchLocation: typeof fetchLocation;
declare const legacy_fetchLocationsByIds: typeof fetchLocationsByIds;
declare const legacy_getActiveLocation: typeof getActiveLocation;
declare const legacy_getAllSelections: typeof getAllSelections;
declare const legacy_getCurrentMap: typeof getCurrentMap;
declare const legacy_getCurrentMapId: typeof getCurrentMapId;
declare const legacy_getDirtyCount: typeof getDirtyCount;
declare const legacy_getGhostedSelections: typeof getGhostedSelections;
declare const legacy_getGoogleMap: typeof getGoogleMap;
declare const legacy_getKnownFieldKeys: typeof getKnownFieldKeys;
declare const legacy_getSelectedLocationIds: typeof getSelectedLocationIds;
declare const legacy_getSelections: typeof getSelections;
declare const legacy_getTagCounts: typeof getTagCounts;
declare const legacy_getWorkArea: typeof getWorkArea;
declare const legacy_waitForGoogleMap: typeof waitForGoogleMap;
declare namespace legacy {
  export {
    legacy_fetchAllLocations as fetchAllLocations,
    legacy_fetchLocation as fetchLocation,
    legacy_fetchLocationsByIds as fetchLocationsByIds,
    legacy_getActiveLocation as getActiveLocation,
    legacy_getAllSelections as getAllSelections,
    legacy_getCurrentMap as getCurrentMap,
    legacy_getCurrentMapId as getCurrentMapId,
    legacy_getDirtyCount as getDirtyCount,
    legacy_getGhostedSelections as getGhostedSelections,
    legacy_getGoogleMap as getGoogleMap,
    legacy_getKnownFieldKeys as getKnownFieldKeys,
    legacy_getSelectedLocationIds as getSelectedLocationIds,
    legacy_getSelections as getSelections,
    legacy_getTagCounts as getTagCounts,
    legacy_getWorkArea as getWorkArea,
    legacy_waitForGoogleMap as waitForGoogleMap,
  };
}

/** Forces a full selection re-resolve in Rust and returns the raw selected IDs.
 *  App code reads `getMapState().selectedLocationIds` — mutations already sync
 *  selections via MutationResult. */
declare function syncSelections(): Promise<{
    ids: number[];
}>;
declare function openMap(id: string): Promise<void>;
declare function closeMap(): Promise<void>;
declare function deleteMap(id: string): Promise<void>;
declare function importPaste(text: string): Promise<EditorImportResult[]>;
declare function importFile(droppedFields: string[], tagName?: string): Promise<EditorImportResult>;

declare const testApi_closeMap: typeof closeMap;
declare const testApi_deleteMap: typeof deleteMap;
declare const testApi_importFile: typeof importFile;
declare const testApi_importPaste: typeof importPaste;
declare const testApi_openMap: typeof openMap;
declare const testApi_procedureEntry: typeof procedureEntry;
declare const testApi_runProcedure: typeof runProcedure;
declare const testApi_syncSelections: typeof syncSelections;
declare namespace testApi {
  export {
    testApi_closeMap as closeMap,
    testApi_deleteMap as deleteMap,
    testApi_importFile as importFile,
    testApi_importPaste as importPaste,
    testApi_openMap as openMap,
    testApi_procedureEntry as procedureEntry,
    testApi_runProcedure as runProcedure,
    testApi_syncSelections as syncSelections,
  };
}

export interface SidecarOptions<T> {
    /** Fires once per JSON object the sidecar emits, in order. */
    onLine?(item: T): void;
    /** Sidecar diagnostics (stderr), one-shot runs only. Resident-served commands
     *  write theirs to the app log instead. */
    onLog?(line: string): void;
    signal?: AbortSignal;
}
/** Run one unit of work on a plugin's sidecar and resolve with its last emitted
 *  object (null if it emitted none). The app owns the process: commands the manifest
 *  lists under `serve` are answered by the plugin's resident sidecar, the rest by a
 *  one-shot run. `payload` is handed to the sidecar as JSON. */
declare function sidecarRequest<T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T>): Promise<T | null>;
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
        request: typeof sidecarRequest;
    };
    registerPlugin: typeof registerPlugin;
    registerEnrichFields: typeof registerEnrichFields;
    registerEnrichmentProvider: typeof registerEnrichmentProvider;
    preloadModules: typeof preloadModules;
    getAvailableExternals: typeof getAvailableExternals;
    ui: typeof ui;
    toast: typeof toast;
    storage: typeof createPluginStorage;
    usePluginState: typeof usePluginState;
    useJob: typeof useJob;
    getFieldDef: typeof getFieldDef;
    getAllFieldDefs: typeof getAllFieldDefs;
    createLocation: typeof createLocation;
    getMapHost: typeof getMapHost;
    waitForMapHost: typeof waitForMapHost;
    /** Snapshot of every rendered location: `ids` plus interleaved `[lng, lat, ...]`, read
     *  from the render buffers the app already keeps current. The way for an overlay that
     *  draws all locations to see the map without a store round trip; refresh on
     *  `scene:changed`. */
    getScenePositions(): {
        ids: Uint32Array;
        positions: Float32Array;
    };
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
        showScreenshotButton: boolean;
        showPanoMetadata: boolean;
        exactDateFormat: ExactDateFormat;
        dateTimezone: DateTimezone;
        showNavArrow: boolean;
        showGroundArrow: boolean;
        hidePanoUI: boolean;
        hideNavWithUI: boolean;
        fullscreenMap: boolean;
        showFullscreenMapMeta: boolean;
        showFullscreenMiniLocationPreview: boolean;
        fullscreenMiniLocationScale: number;
        showFullscreenMinimap: boolean;
        fullscreenMinimapScale: number;
        fullscreenMinimapCloseDelay: number;
        showFullscreenTagbar: boolean;
        fullscreenTagbarCollapsed: boolean;
        showFullscreenDatePicker: boolean;
        showFullscreenReviewBar: boolean;
        showFullscreenGeocode: boolean;
        customCss: string;
        enableSeen: boolean;
        enableSeenThumbnails: boolean;
        seenResolution: SeenResolution;
        mapPanSpeed: number;
        panoLookSpeed: number;
        slowModifier: number;
        showFps: boolean;
        mapListFields: MapListField[];
        language: Language;
        restoreSession: boolean;
        prereleaseUpdates: boolean;
        discordPresence: DiscordPresenceMode;
        labelColors: Record<string, string>;
        geocodeProvider: GeocodeProvider;
        nominatimApiKey: string;
        panToImported: boolean;
        enterOpensCenter: boolean;
        pastePadding: number;
        followActiveInReview: boolean;
        markerColor: RGB;
        activeLocationColor: RGB;
        importPreviewColor: RGB;
        panoDotColor: RGB;
        opacityToggleMode: OpacityToggleMode;
        polygonColorMode: PolygonColorMode;
        polygonColor: RGB;
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
        globalCopyBindings: MapKeyBinding[];
        remoteApi: boolean;
        remoteApiKey: string;
        pinnedCommands: PinnedEntry[];
        hasSeenWelcome: boolean;
        askCommitMessage: boolean;
    };
    getSavedSelectionIndex: typeof getSavedSelectionIndex;
    loadSavedSelections: typeof loadSavedSelections;
    savedParts: typeof savedParts;
    savedSelector: typeof savedSelector;
    on<E extends EditorEvent>(event: E, handler: EventHandler<E>): () => void;
    getSeenEntries: typeof getSeenEntries;
    getSeenCount: typeof getSeenCount;
    clearSeen: typeof clearSeen;
    loadSeenPano: typeof loadSeenPano;
    enrichAll: typeof enrichAll;
    bulkPinToPano: typeof bulkPinToPano;
    validateLocations: typeof validateLocations;
    needsEnrichment: typeof needsEnrichment;
    svMetadata: typeof svMetadata;
    mmaBufUrl: typeof mmaBufUrl;
    _test: typeof testApi;
};
export type StoreApi = typeof store;
export type ImportStagingApi = typeof importStaging;
export type CommitDiffApi = typeof commitDiff;
export type SelectorPickApi = typeof picker;
export type MapListApi = typeof mapList;
export type ReviewApi = typeof review;
export type SurfaceApi = typeof surface;
export type LegacyApi = typeof legacy;
export interface MMA extends StoreApi, ImportStagingApi, CommitDiffApi, SelectorPickApi, MapListApi, ReviewApi, SurfaceApi, LegacyApi {
}
declare global {
    interface Window {
        MMA: MMA;
    }
    const MMA: MMA;
}

export { BUILTIN_FIELDS, KNOWN_FIELDS, MMA as MMAApi, PanoType, commands, events };
export type { AnonIssueRef, AttachmentRef, BatchMode, CameraType, CellRemoval, CommitDelta, CommitDiff, CommitInfo, ComparisonType, Conflict, ConflictKind, CopyToMapResult, DataLocation, DatePart, DbStats, DeviceCodeInfo, EditorImportPreview, EditorImportResult, ExportOpts, ExportProgress, ExternalMutation, ExtraFieldDef, ExtraFieldType, FieldCount, FieldOp, FieldOpResult, FilterOp, FirstSyncMode, GeoResult, GgUser, GhUser, ImportPreviewEntry, ImportProgress, ImportedMapInfo, IssueComment, IssueRef, IssueState, IssueThread, KeySpec, Location, LocationPatch, LocationPatch_Deserialize, MapData, MapExtra, MapKeyAction, MapKeyBinding, MapMeta, MapMetaPatch, MapMetaPatch_Deserialize, MapSettings, MergeWinner, MutationResult, NormalizedSyncLocation, NumericBinning, PartitionBucket, PluginManifest, PluginManifest_Deserialize, PluginSidecar, PluginSidecar_Deserialize, PolygonGeometry, PresenceActivity, ProcedureHost, ProcedureProgress, ProcedureRequest, ProcedureResponse, ProcedureResult, ProviderDecl, PullCreate, PullUpdate, RateCost, RateSpec, RemoteMappingRow, RenderDelta, RenderEntry, RenderPatchEntry, RenderRequest, ResolutionSide, ResultEntry, RetrySpec, ReviewCreate, ReviewSession, ReviewUpdate, Rows, SaveResult, SavedSelection, SavedSelectionInfo, ScoreBounds, SeenEntry, SeenFilter, SeenMapInfo, SeenWriteEntry, SelPaint, Selection, SelectionInput, SelectionSync, Selector, SideCounts, SidecarDone, SidecarLine, SidecarLog, SidecarProgress, Sink, SpacedPickResult, StoreStatus, StoreWarning, SummaryResult, SyncPatch, SyncReconcileResult, Tag, TagPatch, Update, UpdateAvailable, UpdateProgress, ValiCountryStatus, ValiLocation, ValiLocation_Deserialize, ValiProgress, VirtualTag };
