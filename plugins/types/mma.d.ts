/// <reference types="google.maps" />
/// <reference path="./google-maps.d.ts" />

import * as _tauri_apps_api_window from '@tauri-apps/api/window';
import * as _tauri_apps_api_webview from '@tauri-apps/api/webview';
import * as __TAURI_EVENT from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';
import { open, save } from '@tauri-apps/plugin-dialog';
import * as React$1 from 'react';
import { ComponentType, SetStateAction, ComponentPropsWithRef, ReactNode, CSSProperties, ElementType, ReactElement } from 'react';
import { Layer, PickingInfo } from '@deck.gl/core';
import * as maplibregl from 'maplibre-gl';

/** Per-location bitfield, serialized as a plain `u32` over IPC and Arrow. */
declare const LocationFlag: {
    readonly None: 0;
    readonly LoadAsPanoId: 1;
    readonly Informational: 2;
    readonly ImportPreview: 4;
    readonly SeenOverlay: 8;
};
type LocationFlag = (typeof LocationFlag)[keyof typeof LocationFlag];
/** Panorama source type, as Google's metadata reports it. */
declare const PanoType: {
    readonly Official: 2;
    readonly Unknown: 3;
    readonly UserUploaded: 10;
};
type PanoType = (typeof PanoType)[keyof typeof PanoType];
/** Outcome of a Street View coverage check, as `validate` answers it per row. */
declare const ValidationState: {
    readonly Ok: 0;
    readonly UpdateAvailable: 1;
    readonly UpdateApplied: 2;
    readonly GoodcamAvailable: 6;
    readonly PanoIdBroke: 4;
    readonly Unofficial: 5;
    readonly NotFound: 3;
};
type ValidationState = (typeof ValidationState)[keyof typeof ValidationState];
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
}, {
    readonly key: "loadAsPanoId";
    readonly label: "Load as pano ID";
    readonly type: "number";
    readonly kind: "term";
    readonly comparison: null;
}];
declare const CLEARABLE_BUILTINS: readonly ["panoId"];
declare const DEFAULT_DUPLICATE_SCORE: "tagCount + has(panoId) + loadAsPanoId + (heading != 0)";
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
declare const PROJECTIONS: readonly [{
    readonly id: "value";
    readonly appliesTo: readonly ["string", "enum", "number", "month"];
    readonly needsTz: false;
}, {
    readonly id: "year";
    readonly appliesTo: readonly ["date", "month"];
    readonly needsTz: true;
}, {
    readonly id: "yearMonth";
    readonly appliesTo: readonly ["date"];
    readonly needsTz: true;
}, {
    readonly id: "day";
    readonly appliesTo: readonly ["date"];
    readonly needsTz: true;
}, {
    readonly id: "monthOfYear";
    readonly appliesTo: readonly ["date", "month"];
    readonly needsTz: true;
}, {
    readonly id: "hourOfDay";
    readonly appliesTo: readonly ["date"];
    readonly needsTz: true;
}];
declare const SCRATCH_MAP_ID: "scratch";
/** The bits a preview carries that a real location must not. */
declare const VIRTUAL_FLAGS: 12;

declare const consts_BUILTIN_FIELDS: typeof BUILTIN_FIELDS;
declare const consts_CLEARABLE_BUILTINS: typeof CLEARABLE_BUILTINS;
declare const consts_DEFAULT_DUPLICATE_SCORE: typeof DEFAULT_DUPLICATE_SCORE;
declare const consts_KNOWN_FIELDS: typeof KNOWN_FIELDS;
export type consts_LocationFlag = LocationFlag;
declare const consts_PROJECTIONS: typeof PROJECTIONS;
export type consts_PanoType = PanoType;
declare const consts_SCRATCH_MAP_ID: typeof SCRATCH_MAP_ID;
declare const consts_VIRTUAL_FLAGS: typeof VIRTUAL_FLAGS;
export type consts_ValidationState = ValidationState;
declare namespace consts {
  export { consts_BUILTIN_FIELDS as BUILTIN_FIELDS, consts_CLEARABLE_BUILTINS as CLEARABLE_BUILTINS, consts_DEFAULT_DUPLICATE_SCORE as DEFAULT_DUPLICATE_SCORE, consts_KNOWN_FIELDS as KNOWN_FIELDS, consts_PROJECTIONS as PROJECTIONS, consts_SCRATCH_MAP_ID as SCRATCH_MAP_ID, consts_VIRTUAL_FLAGS as VIRTUAL_FLAGS };
  export type { consts_LocationFlag as LocationFlag, consts_PanoType as PanoType, consts_ValidationState as ValidationState };
}

/** Commands @unstable */
declare const commands$1: {
    /**  Milliseconds from `run()` to the frontend's first call; logged once. @unstable */
    appReady: () => Promise<number>;
    /**
     *  Write text to a temp file and return its path. `name` is a leaf filename
     *  (cannot contain path separators).
     *  @unstable
     */
    writeTempFile: (name: string, content: string) => Promise<string>;
    /**  Read a file as UTF-8 text (temp files, plugin sources). @unstable */
    readFile: (path: string) => Promise<string>;
    /**  Return the app's data directory path. @unstable */
    getAppDataDir: () => Promise<string>;
    /**  Return the current and default data-folder paths, and whether a custom override is active. @unstable */
    getDataLocation: () => Promise<DataLocation>;
    /**
     *  Set or clear the data-folder override. Takes effect after relaunch and does not
     *  move existing data.
     *  @unstable
     */
    setDataLocation: (path: string | null) => Promise<null>;
    /**  Open the app's data folder in the OS file explorer. @unstable */
    openDataFolder: () => Promise<null>;
    /**  Open the app's log file in the OS default handler. @unstable */
    openLogFile: () => Promise<null>;
    /**
     *  First caller per app run wins the silent update pass. Every webview boots the
     *  plugin loader, so without this a restored editor window plus the map list run
     *  two full passes -- double registry fetches, double downloads, and interleaved
     *  install progress for the same plugin.
     *  @unstable
     */
    claimPluginUpdatePass: () => Promise<boolean>;
    /**  Manifests of every installed plugin. @unstable */
    listUserPlugins: () => Promise<PluginManifest[]>;
    /**
     *  Install a plugin from the marketplace repo: its `manifest.json`, the main JS file, and
     *  the procedure module it declares. `git_ref` pins an older build; `None` takes master.
     *  @unstable
     */
    installPlugin: (id: string, gitRef: string | null) => Promise<PluginManifest>;
    /**  Delete a plugin's directory. @unstable */
    uninstallPlugin: (id: string) => Promise<null>;
    /**
     *  Download a plugin's sidecar bundle from GitHub Releases and extract it under
     *  `{appData}/plugins/{plugin_id}/sidecar/`. Emits `sidecar-install-progress`.
     *  @unstable
     */
    sidecarInstall: (pluginId: string, name: string, version: string) => Promise<null>;
    /**  Installed sidecar version for a plugin, or `None` if not installed. @unstable */
    sidecarInstalledVersion: (pluginId: string) => Promise<string | null>;
    /**
     *  Run one unit of work on a plugin's sidecar. Commands the manifest lists under
     *  `serve` go to the plugin's resident process; the rest get a one-shot child.
     *  Streams `sidecar-line` (one JSON object per unit) and `sidecar-log` (stderr),
     *  then exactly one `sidecar-done`, all keyed by the returned request id.
     *  @unstable
     */
    sidecarRequest: (pluginId: string, command: string, payload: string | null) => Promise<number>;
    /**  Stop all sidecar processes for a plugin. @unstable */
    sidecarStop: (pluginId: string) => Promise<null>;
    /**  Stop all sidecar processes across every plugin. @unstable */
    sidecarStopAll: () => Promise<null>;
    /**  Cancel a running sidecar request. No-op if the request already finished. @unstable */
    sidecarCancel: (reqId: number) => Promise<null>;
    /**  Whether the border dataset for `level` is available on disk. @unstable */
    checkBorderFile: (level: string) => Promise<boolean>;
    /**  Download the border dataset for `level` from the repository. @unstable */
    downloadBorderFile: (level: string) => Promise<null>;
    /**
     *  Return the border polygon containing (`lat`, `lng`) at the given detail
     *  `level`, or `None` if the point falls outside every feature.
     *  @unstable
     */
    borderLookup: (lat: number, lng: number, level: string) => Promise<PolygonGeometry | null>;
    /**
     *  Classify each `(lat, lng)` to the name of its containing border feature at
     *  `level` (subdivision names for "adm1"). `None` for points outside every feature.
     *  @unstable
     */
    borderClassify: (level: string, points: ([number, number])[]) => Promise<(string | null)[]>;
    /**
     *  Return the nearest city, administrative region, and country for a coordinate.
     *  Always returns `Some` - the dataset covers every landmass.
     *  @unstable
     */
    reverseGeocode: (lat: number, lng: number) => Promise<GeoResult | null>;
    /**  Set the Discord Rich Presence activity. No-op when Discord is not running. @unstable */
    discordPresenceSet: (activity: PresenceActivity) => Promise<null>;
    /**  Clear the Discord Rich Presence activity. No-op when Discord is not running. @unstable */
    discordPresenceClear: () => Promise<null>;
    /**
     *  Begin device-flow sign-in. Returns the code to show the user; call
     *  [`github_poll_login`] afterwards to wait for them to finish authorizing.
     *  @unstable
     */
    githubStartLogin: () => Promise<DeviceCodeInfo>;
    /**
     *  Wait for the user to authorize the code from [`github_start_login`].
     *  Resolves with the signed-in account.
     *  @unstable
     */
    githubPollLogin: () => Promise<GhUser>;
    /**  The signed-in user, or `None` when there is no session (or it was rejected). @unstable */
    githubMe: () => Promise<GhUser | null>;
    /**  Sign out of GitHub and clear the stored session. @unstable */
    githubLogout: () => Promise<null>;
    /**  Local-only check: is a token stored? Says nothing about its validity. @unstable */
    githubHasSession: () => Promise<boolean>;
    /**  File a bug report as the signed-in GitHub user. @unstable */
    githubCreateIssue: (title: string, body: string, labels: string[]) => Promise<IssueRef>;
    /**  Fetch a report's current state and comments as the signed-in GitHub user. @unstable */
    githubIssueThread: (number: number) => Promise<IssueThread>;
    /**  The tail of `mma.log`, scrubbed. Empty string when there is no log yet. @unstable */
    feedbackLogTail: () => Promise<string>;
    /**  Whether the anonymous tier is available in this build. @unstable */
    feedbackAnonymousAvailable: () => Promise<boolean>;
    /**
     *  File a bug report anonymously (no account required). Returns a reference the
     *  caller can use to check for replies via [`feedback_anonymous_thread`].
     *  @unstable
     */
    feedbackSubmitAnonymous: (title: string, body: string, installId: string) => Promise<AnonIssueRef>;
    /**  Upload an image attachment for a bug report and return its URL. @unstable */
    feedbackUploadAttachment: (path: string, name: string) => Promise<AttachmentRef>;
    /**
     *  Request that standard labels be applied to a report the user filed. Best-effort:
     *  a failure here does not affect the report itself.
     *  @unstable
     */
    feedbackRequestLabel: (number: number) => Promise<null>;
    /**  Fetch the current state and replies for an anonymous report. @unstable */
    feedbackAnonymousThread: (number: number, token: string) => Promise<IssueThread>;
    /**
     *  Check for an update at `endpoint` (a release's `latest.json`). Returns `None`
     *  when the announced version is not newer than the running one.
     *  @unstable
     */
    updateCheck: (endpoint: string) => Promise<UpdateAvailable | null>;
    /**
     *  Download and install whatever the last [`update_check`] found. The installer replaces the
     *  running app, so nothing after this is guaranteed to run -- the caller saves its state first.
     *  @unstable
     */
    updateInstall: () => Promise<null>;
    /**
     *  Start (or re-key) the remote API server. Idempotent: a running server just
     *  picks up the new key. Returns the base URL.
     *  @unstable
     */
    remoteApiStart: (key: string) => Promise<string>;
    /**  Stop the remote API server. @unstable */
    remoteApiStop: () => Promise<null>;
    /**  Deliver the result for remote API request `id`. `payload` is JSON text. @unstable */
    remoteApiRespond: (id: number, ok: boolean, payload: string) => Promise<void>;
    /**
     *  Open a map and return its initial state (tag counts, undo/redo availability).
     *  Must be called before any other store commands.
     *  @unstable
     */
    storeOpenMap: (mapId: string) => Promise<StoreStatus>;
    /**  Close the open map, saving unsaved changes first. @unstable */
    storeCloseMap: () => Promise<null>;
    /**  Save uncommitted changes to disk. No-op when nothing has changed. @unstable */
    storeSaveDirty: () => Promise<SaveResult>;
    /**  Copy locations already stored in this map into another map. @unstable */
    storeCopyLocationsToMap: (targetMapId: string, selector: Selector) => Promise<CopyToMapResult>;
    /**
     *  Add caller-supplied locations to another map. Tags are matched by name against this
     *  map's tag table.
     *  @unstable
     */
    storeAddLocationsToMap: (targetMapId: string, locations: Location[]) => Promise<CopyToMapResult>;
    /**  Return the map's current location count, store version, and unsaved-change count. @unstable */
    storeGetSummary: () => Promise<SummaryResult>;
    /**  Add new locations, allocating sequential IDs. Undoable. @unstable */
    storeAddLocations: (locations: Location[]) => Promise<MutationResult>;
    /**
     *  Add locations from a chunked upload session (see `store_upload_begin`).
     *  Same behavior as `store_add_locations`: one atomic mutation, undoable.
     *  @unstable
     */
    storeAddLocationsUploaded: (sessionDir: string) => Promise<MutationResult>;
    /**  Remove locations by ID. Undoable. @unstable */
    storeRemoveLocations: (ids: number[]) => Promise<MutationResult>;
    /**
     *  Apply partial patches to existing locations. `record_undo` defaults to true;
     *  set to false for ephemeral updates (e.g., plugin-driven batch modifications
     *  that manage their own undo).
     *  @unstable
     */
    storeUpdateLocations: (updates: Update<LocationPatch_Deserialize>[], recordUndo: boolean | null) => Promise<MutationResult>;
    /**  Set (or clear) the active location. @unstable */
    storeSetActive: (id: number | null) => Promise<null>;
    /**  Set the default marker color for new render updates. @unstable */
    storeSetMarkerColor: (color: [number, number, number]) => Promise<null>;
    /**  Ids of every location the selector resolves to, ascending. @unstable */
    storeResolve: (selector: Selector) => Promise<number[]>;
    /**  Count how many locations the selector matches. @unstable */
    storeCount: (selector: Selector) => Promise<number>;
    /**  `n` ids drawn uniformly at random from the selected set, without replacement. @unstable */
    storeSample: (selector: Selector, n: number) => Promise<number[]>;
    /**
     *  An evenly spaced subset: exactly one of `target_count` (thin to N, maximizing
     *  spacing) or `min_distance_m` (keep as many as fit at that spacing).
     *  @unstable
     */
    storeSpaced: (selector: Selector, targetCount: number | null, minDistanceM: number | null) => Promise<SpacedPickResult>;
    /**  Group by a derived key, returning `{ key, ids, bin }` per group. @unstable */
    storeGroupBy: (selector: Selector, field: string, key: KeySpec) => Promise<PartitionBucket[]>;
    /**  Group locations by a derived key, returning counts only (no member ids). @unstable */
    storeCountBy: (selector: Selector, field: string, key: KeySpec) => Promise<[string, number][]>;
    /**  Distinct values of `field` across the selected set, sorted. @unstable */
    storeValues: (selector: Selector, field: string) => Promise<string[]>;
    /**
     *  How many rows hold a value for each field, key-sorted: `extra` keys and the built-in
     *  columns a row can lack.
     *  @unstable
     */
    storeCoverage: (selector: Selector) => Promise<[string, number][]>;
    /**  Read specific fields across matched locations, returned as one column per field. @unstable */
    storeColumns: (selector: Selector, fields: string[]) => Promise<Columns>;
    /**  Bounding box `[west, south, east, north]`, or `None` when the set is empty. @unstable */
    storeBounds: (selector: Selector) => Promise<[number, number, number, number] | null>;
    /**
     *  Collect all matched locations as full rows. Prefer a projection (`store_columns`,
     *  `store_values`) when only specific fields are needed.
     *  @unstable
     */
    storeCollect: (selector: Selector) => Promise<Rows>;
    /**  Apply a field operation to every location matched by `selector`. @unstable */
    storeApplyFieldOp: (selector: Selector, op: FieldOp, recordUndo: boolean | null) => Promise<FieldOpResult>;
    /**  The parse error for `src`, or nothing when it parses. For the dialog's live check. @unstable */
    fieldExprError: (src: string) => Promise<string | null>;
    /**
     *  Count locations by country using offline point-in-polygon. Returns (ISO-A2, count) pairs.
     *  `level` selects border precision, falling back to "light" if unavailable.
     *  @unstable
     */
    storeCountryDistribution: (selector: Selector, level: string) => Promise<[string, number][]>;
    /**  Find all locations within `radius_m` metres of (`lat`, `lng`). @unstable */
    storeFindNearby: (lat: number, lng: number, radiusM: number) => Promise<Location[]>;
    /**
     *  For each input point, whether any existing location lies within `radius_m` metres.
     *  Batch form for probing many coordinates at once.
     *  @unstable
     */
    storeNearAny: (lats: number[], lngs: number[], radiusM: number) => Promise<boolean[]>;
    /**
     *  Create tags by name and assign them to the locations matched by `selector`.
     *  Deduplicates case-insensitively: if a tag with the same name already exists, it is reused.
     *  @unstable
     */
    storeCreateTags: (names: string[], selector: Selector) => Promise<MutationResult>;
    /**
     *  Rename and/or recolor tags in one batch. Renaming onto an existing name (case-insensitive)
     *  merges the two tags.
     *  @unstable
     */
    storeUpdateTags: (updates: Update<TagPatch>[]) => Promise<MutationResult>;
    /**  Remove tags and strip them from all locations that carry them. Undoable. @unstable */
    storeDeleteTags: (tagIds: number[]) => Promise<MutationResult>;
    /**  Set the display order of tags. Each tag's position is its index in `ordered_ids`. @unstable */
    storeReorderTags: (orderedIds: number[]) => Promise<MutationResult>;
    /**  Undo the last edit. @unstable */
    storeUndo: () => Promise<MutationResult>;
    /**  Redo the last undone edit. @unstable */
    storeRedo: () => Promise<MutationResult>;
    /**  Clear both undo and redo stacks. @unstable */
    storeResetUndo: () => Promise<MutationResult>;
    /**  Return the uncommitted change counts (added, removed, modified) since the last commit. @unstable */
    storeCommitDiff: () => Promise<[number, number, number]>;
    /**
     *  Replace all active selections and resolve them against current data. Returns
     *  per-selection counts and a bitmask for the marker overlay.
     *  @unstable
     */
    storeSyncSelections: (sels: SelectionInput[]) => Promise<SelectionSync>;
    /**
     *  Find groups of locations within `distance` metres of each other (transitive).
     *  Returns groups of IDs, each with at least two members.
     *  @unstable
     */
    storeDuplicateGroups: (distance: number) => Promise<number[][]>;
    /**
     *  Merge each duplicate group within `distance` metres into one location, unioning tags
     *  and extra fields. `score` ranks which location survives; blank uses the default ranking.
     *  Undoable.
     *  @unstable
     */
    storeMergeDuplicates: (distance: number, score: string | null) => Promise<MutationResult>;
    /**
     *  Remove duplicate locations within `distance` metres of each other, keeping the
     *  best-scored survivor per cluster. Undoable.
     *  @unstable
     */
    storePruneDuplicates: (selector: Selector, distance: number, score: string | null) => Promise<MutationResult>;
    /**  Rebuild all marker render data from scratch and return the file path to fetch it from. @unstable */
    storeFillRenderFile: (req: RenderRequest) => Promise<string>;
    /**  Resolve a marker pick (cell key + index within cell) to a location ID. @unstable */
    storeResolvePick: (cell: string, cellIndex: number) => Promise<number | null>;
    /**  Return metadata for every map in the database. @unstable */
    storeListMaps: () => Promise<MapMeta[]>;
    /**  Fetch a single map's metadata by ID. Returns `None` if not found. @unstable */
    storeGetMap: (id: string) => Promise<MapMeta | null>;
    /**  Create a new empty map with default settings. Returns the full metadata. @unstable */
    storeCreateMap: (name: string, folder: string | null) => Promise<MapMeta>;
    /**
     *  Open the scratch map, creating it if this is its first use. Ordinary in every way
     *  except that [`store_list_maps`] hides it and startup wipes it.
     *  @unstable
     */
    storeScratchMap: () => Promise<MapMeta>;
    /**  Delete a map and all its data permanently. @unstable */
    storeDeleteMap: (id: string) => Promise<null>;
    /**
     *  Apply a partial update to a map's metadata. `None` fields are left unchanged.
     *  Returns a mutation result when the open map's field definitions changed.
     *  @unstable
     */
    storeUpdateMapMeta: (id: string, patch: MapMetaPatch_Deserialize) => Promise<MutationResult | null>;
    /**
     *  Update `last_opened_at` to the current timestamp. Used to sort the map
     *  list by recency in the dashboard.
     *  @unstable
     */
    storeTouchMapOpened: (mapId: string) => Promise<null>;
    /**  Rename a folder across all maps that reference it. @unstable */
    storeRenameFolder: (from: string, to: string) => Promise<null>;
    /**  Delete a folder, moving its maps to the root level. @unstable */
    storeDeleteFolder: (name: string) => Promise<null>;
    /**  Return aggregate database statistics: counts, file size, and configuration. @unstable */
    storeDbStats: () => Promise<DbStats>;
    /**
     *  Parse a file (JSON or ZIP of JSONs) and return a preview of each map found,
     *  without persisting anything. Call [`bulk_import_confirm`] to import the maps.
     *  @unstable
     */
    bulkImportPreview: (path: string) => Promise<ImportPreviewEntry[]>;
    /**
     *  Import the maps at `selected_indices` from a previously previewed file.
     *  Emits `bulk-import-progress` per map.
     *  @unstable
     */
    bulkImportConfirm: (path: string, selectedIndices: number[]) => Promise<ImportedMapInfo[]>;
    /**
     *  Discard the previewed import without importing. Call when the user cancels the
     *  import dialog.
     *  @unstable
     */
    bulkImportCancel: () => Promise<null>;
    /**
     *  Parse a file and return field-level statistics and preview positions for the
     *  editor import dialog. Call [`store_import_file`] to commit the import.
     *  @unstable
     */
    storeImportPreview: (path: string) => Promise<EditorImportPreview>;
    /**
     *  Parse pasted text (JSON or CSV) and stage it for preview. Works like
     *  [`store_import_preview`] but reads from a string instead of a file.
     *  @unstable
     */
    storeImportPastePreview: (text: string) => Promise<EditorImportPreview>;
    /**
     *  Return one staged (not yet imported) location by its preview `index`, for
     *  read-only preview in the editor.
     *  @unstable
     */
    storeImportStagedLocation: (index: number) => Promise<Location>;
    /**
     *  Commit a previously previewed editor import into the open map, optionally
     *  dropping fields in `dropped_fields` (e.g. `"heading"`, `"extra.countryCode"`)
     *  and/or applying `tag_name` to every imported location.
     *  @unstable
     */
    storeImportFile: (droppedFields: string[], tagName: string | null) => Promise<EditorImportResult>;
    /**  Export locations as a `{name, customCoordinates}` JSON file, including tags and field defs. @unstable */
    storeExportJson: (opts: ExportOpts) => Promise<string>;
    /**  Export locations as a minimal lat/lng CSV file. @unstable */
    storeExportCsv: (selector: Selector) => Promise<string>;
    /**
     *  Export locations as a GeoJSON FeatureCollection of Point features.
     *  Each feature carries its tag names in `properties.tags`.
     *  @unstable
     */
    storeExportGeojson: (selector: Selector, tagsJson: string) => Promise<string>;
    /**  Move a temp export file to `dest_path` and remove the temp source. @unstable */
    storeSaveExportFile: (srcPath: string, destPath: string) => Promise<null>;
    /**
     *  Export every map as a ZIP of JSON files. Duplicate map names get a numeric suffix.
     *  Emits `bulk-export-progress` per map.
     *  @unstable
     */
    storeExportBulkZip: () => Promise<string>;
    /**
     *  Create a temp session directory for binary uploads. Files written into it are
     *  packaged by [`store_upload_finish`].
     *  @unstable
     */
    storeUploadBegin: () => Promise<string>;
    /**
     *  Package an upload session's files into a single output and remove the session
     *  directory. Returns a temp path for [`store_save_export_file`].
     *  @unstable
     */
    storeUploadFinish: (sessionDir: string) => Promise<string>;
    /**  Remove an abandoned upload session dir (e.g. cancelled operation). @unstable */
    storeUploadAbort: (sessionDir: string) => Promise<null>;
    /**
     *  Commit the map's uncommitted changes. Returns the new commit ID. `message`
     *  defaults to a generated `+a -r ~m` summary. Clears undo/redo.
     *  @unstable
     */
    storeCommit: (mapId: string, message: string | null) => Promise<CommitResult>;
    /**  List all commits for a map, newest first. @unstable */
    storeListCommits: (mapId: string) => Promise<CommitInfo[]>;
    /**
     *  Restore a map to the state captured by a previous commit. The caller must reopen
     *  the map afterwards (undo/redo is cleared).
     *  @unstable
     */
    storeCheckoutCommit: (mapId: string, commitId: string) => Promise<null>;
    /**  Read a single commit's delta (created and removed locations). @unstable */
    storeGetCommitDelta: (mapId: string, commitId: string) => Promise<CommitDelta>;
    /**  Record a panorama visit. The history is capped; oldest entries are evicted when full. @unstable */
    storeSeenWrite: (entry: SeenWriteEntry) => Promise<null>;
    /**  Returns a page of seen entries, newest first, with optional filtering. @unstable */
    storeSeenList: (limit: number, offset: number, filter: SeenFilter | null, thumbnails: boolean) => Promise<SeenEntry[]>;
    /**  Returns the total number of seen entries matching the filter (for pagination). @unstable */
    storeSeenCount: (filter: SeenFilter | null) => Promise<number>;
    /**  Return all distinct country codes in the seen history, sorted alphabetically. @unstable */
    storeSeenCountries: () => Promise<string[]>;
    /**  Returns all distinct maps that have seen entries, with resolved display names. @unstable */
    storeSeenMaps: () => Promise<SeenMapInfo[]>;
    /**  Deletes all seen history entries. @unstable */
    storeSeenClear: () => Promise<null>;
    /**  Create a new review session from a frozen worklist of location IDs. @unstable */
    storeReviewCreate: (session: ReviewCreate) => Promise<ReviewSession>;
    /**  Look up the most recent active review session for a map and source key. @unstable */
    storeReviewGet: (mapId: string, sourceKey: string) => Promise<ReviewSession | null>;
    /**  List review sessions for a map, newest first. Optionally filter by `status`. @unstable */
    storeReviewList: (mapId: string, status: string | null) => Promise<ReviewSession[]>;
    /**  Apply a partial update to a review session. @unstable */
    storeReviewUpdate: (update: ReviewUpdate) => Promise<null>;
    /**  Delete a review session. @unstable */
    storeReviewDelete: (id: string) => Promise<null>;
    /**  List every saved selection rule (name, color, date), without their selector trees. @unstable */
    storeListSavedSelections: () => Promise<SavedSelectionInfo[]>;
    /**  Fetch the full saved selection rules for the given `ids`, including their selector trees. @unstable */
    storeGetSavedSelections: (ids: string[]) => Promise<SavedSelection[]>;
    /**  Save a new selection rule. @unstable */
    storeSaveSelection: (name: string, selector: Selector, tagNames: { [key in number]: string; }, color: [number, number, number]) => Promise<SavedSelection>;
    /**  Delete a saved selection rule by `id`. @unstable */
    storeDeleteSavedSelection: (id: string) => Promise<null>;
    /**
     *  Import saved selections from the pre-0.10 localStorage format. No-op when
     *  rules already exist. Returns the number of rules imported.
     *  @unstable
     */
    storeImportLegacySavedSelections: (json: string) => Promise<number>;
    /**  Get all local-to-remote id mapping rows for a linked map. @unstable */
    remoteMappingGet: (provider: string, mapId: string) => Promise<RemoteMappingRow[]>;
    /**  Insert or update local-to-remote id mapping rows for a linked map. @unstable */
    remoteMappingUpsert: (provider: string, mapId: string, rows: RemoteMappingRow[]) => Promise<null>;
    /**  Remove specific mapping rows by `local_ids` for a linked map. @unstable */
    remoteMappingDelete: (provider: string, mapId: string, localIds: number[]) => Promise<null>;
    /**  Drop all mapping rows for a linked map (unlink). @unstable */
    remoteMappingClear: (provider: string, mapId: string) => Promise<null>;
    /**
     *  Reconcile a linked map against its remote, pushing local changes and pulling
     *  remote ones. Returns the creates, updates, and deletes for each side to apply.
     *  @unstable
     */
    syncReconcile: (provider: string, mapId: string, remoteMapId: string, apiKey: string | null, firstSync: FirstSyncMode | null, resolutions: ([string, ResolutionSide])[] | null) => Promise<SyncReconcileResult>;
    /**
     *  Open the GeoGuessr sign-in window and wait for authentication to complete.
     *  Returns the signed-in nickname.
     *  @unstable
     */
    geoguessrLogin: () => Promise<string>;
    /**  The signed-in user, or `None` when there is no session (or it was rejected). @unstable */
    geoguessrMe: () => Promise<GgUser | null>;
    /**  Sign out of GeoGuessr and clear the stored session. @unstable */
    geoguessrLogout: () => Promise<null>;
    /**  Local-only check: is a token stored? Says nothing about its validity. @unstable */
    geoguessrHasSession: () => Promise<boolean>;
    /**
     *  Generate locations from a Vali map definition (JSON/JSONC text). Missing country
     *  data is auto-downloaded like the Vali CLI. Returns the generated locations.
     *  @unstable
     */
    valiGenerate: (definition: string) => Promise<ValiLocation[]>;
    /**  Download Vali coverage data. `country` = code/continent alias/None for all. @unstable */
    valiDownload: (country: string | null, full: boolean, updates: boolean) => Promise<null>;
    /**  Cancel an in-flight vali generate or download. @unstable */
    valiCancel: () => Promise<void>;
    /**  Subdivision weights for a country (JSON text, same shape as `vali subdivisions`). @unstable */
    valiSubdivisions: (country: string) => Promise<string>;
    /**
     *  Country codes Vali has coverage data for, i.e. the set `vali download` iterates
     *  when no country is given. Display names are the caller's job.
     *  @unstable
     */
    valiCountries: () => Promise<string[]>;
    /**
     *  Countries whose downloaded coverage data is older than the remote copy. Object metadata
     *  only -- nothing is fetched. Errors while offline, which callers should read as "unknown"
     *  rather than "up to date".
     *  @unstable
     */
    valiDataStatus: () => Promise<ValiCountryStatus[]>;
    /**
     *  Download exactly the countries `vali_data_status` reports as behind. No-op when nothing
     *  is stale, so the caller can fire it without checking first.
     *  @unstable
     */
    valiDownloadStale: () => Promise<null>;
    /**
     *  Start a procedure run over the open map's locations. Returns immediately with
     *  the run id. Emits `procedure-progress` and `procedure-result` as work completes.
     *  @unstable
     */
    procedureRun: (providers: ProviderDecl[], force: boolean) => Promise<number>;
    /**
     *  Run providers over caller-supplied `rows` and return them as modified. Does not
     *  affect the open map. `cancel` is a token for [`procedure_query_cancel`].
     *  @unstable
     */
    procedureRunRows: (providers: ProviderDecl[], force: boolean, rows: Location[], cancel: number | null) => Promise<RowsRun>;
    /**  Stop a run before its next batch. Already-applied patches stay applied. @unstable */
    procedureCancel: (runId: number) => Promise<null>;
    /**
     *  Run a procedure's read-only `query` export. `input` and the result are defined
     *  by the procedure module. `cancel` is a token for [`procedure_query_cancel`].
     *  @unstable
     */
    procedureQuery: (entry: string, input: string, config: string | null, cancel: number | null) => Promise<string>;
    /**  Cancel a running procedure query by its `cancel` token. @unstable */
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
 *  Per-field columns of the selected set. One value per row per field, `null` where a
 *  row lacks it; `"tags"` is a column of tag-id arrays.
 */
type Columns = unknown[][];
/**
 *  A commit's created and removed locations. An updated location appears in both
 *  `created` (new version) and `removed` (old version).
 */
type CommitDelta = {
    created: Location[];
    removed: Location[];
};
/**  Added, removed, and modified counts for a commit. */
type CommitDiff = {
    added: number;
    removed: number;
    modified: number;
};
/**  Metadata for a single commit. */
type CommitInfo = {
    id: string;
    mapId: string;
    parentId: string | null;
    message: string | null;
    treeHash: string | null;
    locationCount: number;
    createdAt: string;
} & CommitDiff;
/**  The new commit's ID and the resulting state update. */
type CommitResult = {
    id: string;
    status: MutationResult;
};
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
 *  The engine-owned values JS mirrors into its state, each `None` when unchanged since
 *  it last shipped. The open-time form ([`super::StoreStatus`]) has every field present.
 *  The JS mirror's type and merge are derived from this struct.
 */
type EngineValues = {
    locationCount: number | null;
    canUndo: boolean | null;
    canRedo: boolean | null;
    /**  Every tag's count, when any count moved. */
    tagCounts: {
        [key in number]: number;
    } | null;
    /**
     *  The whole registry, when any tag was created, edited, deleted, or flipped visible.
     *  Includes soft-deleted ghosts (visible=false, kept for undo revival).
     */
    tags: {
        [key in number]: Tag;
    } | null;
    /**
     *  The whole extra-field registry (`MapMeta.extra.fields` mirror), when a key was
     *  seen for the first time, erased, or the user edited a definition.
     */
    fieldDefs: {
        [key in string]: ExtraFieldDef;
    } | null;
};
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
    label: string | null;
    values: string[] | null;
    labels: {
        [key in string]: string;
    } | null;
    /**
     *  Optional override for how this field is compared during disambiguation.
     *  `None` => inferred from `field_type` on the analysis side.
     */
    comparison: ComparisonType | null;
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
 *  missing or non-numeric field, a non-finite result) is reported back by id.
 */
{
    kind: "expr";
    key: string;
    expr: string;
};
/**  The op's outcome for the caller: the mutation plus what its message needs. */
type FieldOpResult = {
    mutation: MutationResult;
    /**  Rows the op patched. */
    changed: number;
    /**  Rows an expression could not evaluate. */
    failed: number[];
};
/**
 *  A filter's predicate: the operator with its operands. Single source of truth: specta
 *  renders the tagged union, so the TS `FilterOp` type and `OP_LABELS` derive from it.
 *  The range operators can read a date in the row's own timezone (`tzLocal`); the
 *  `between_*` shapes bucket a timestamp by month-day or time-of-day before comparing.
 */
type FilterOp = {
    op: "has";
} | {
    op: "nothas";
} | {
    op: "eq";
    value: any;
} | {
    op: "neq";
    value: any;
} | {
    op: "contains";
    value: any;
} | {
    op: "notcontains";
    value: any;
} | {
    op: "gt";
    value: any;
    tzLocal?: boolean;
} | {
    op: "lt";
    value: any;
    tzLocal?: boolean;
} | {
    op: "gte";
    value: any;
    tzLocal?: boolean;
} | {
    op: "lte";
    value: any;
    tzLocal?: boolean;
} | {
    op: "between";
    lo: any;
    hi: any;
    tzLocal?: boolean;
} | {
    op: "between_anyyear";
    lo: string;
    hi: string;
    tzLocal?: boolean;
} | {
    op: "between_anytime";
    lo: string;
    hi: string;
    tzLocal?: boolean;
};
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
/**
 *  Top-level `extra` JSON blob on a map row. Currently only holds field definitions,
 *  but structured as an object to allow future extensions.
 */
type MapExtra = {
    fields: {
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
/**  Full metadata for a map. */
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
 *  Partial update for map metadata. `None` fields are left unchanged.
 *  Setting `folder` to null moves the map to root.
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
 *  Partial update for map metadata. `None` fields are left unchanged.
 *  Setting `folder` to null moves the map to root.
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
    /**
     *  Which member of a duplicate group survives a merge: a `field_expr` scoring the
     *  location, highest wins. `None` (or blank) keeps the built-in ranking.
     */
    duplicateScore?: string | null;
};
/**  When a move target already holds a value, which side survives. */
type MergeWinner = "from" | "to";
/**
 *  What one mutation changed, and nothing else. `values` are merged into the JS state
 *  mirror (an untouched slice keeps its reference and its subscribers sleep); `delta`
 *  and `selection_sync` are operations applied once to the render buffers.
 */
type MutationResult = {
    version: number;
    delta: RenderDelta;
    selectionSync: SelectionSync | null;
    values: EngineValues;
};
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
/**
 *  A published build of a plugin, pinned to the commit its files live at. Carries only
 *  what picking a build needs -- the rest comes from the manifest at `git_ref`.
 */
type PluginBuild_Deserialize = {
    version: string;
    ref: string;
    minAppVersion: string | null;
};
/**
 *  A published build of a plugin, pinned to the commit its files live at. Carries only
 *  what picking a build needs -- the rest comes from the manifest at `git_ref`.
 */
type PluginBuild = {
    version: string;
    ref: string;
    minAppVersion?: string | null;
};
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
    /**
     *  Registry-only: prior builds an app under `min_app_version` can fall back to.
     *  An installed manifest never carries these.
     */
    builds?: PluginBuild_Deserialize[];
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
    /**
     *  Registry-only: prior builds an app under `min_app_version` can fall back to.
     *  An installed manifest never carries these.
     */
    builds?: PluginBuild[];
};
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
    extraPolygons: ((([number, number])[])[])[] | null;
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
 *  and `requires` the keys it consumes; together they gate who waits for whom.
 */
type ProviderDecl = {
    id: string;
    label?: string | null;
    /**  The procedure module: an absolute path, or `res://<rel>` for one bundled with the app. */
    entry?: string | null;
    fields?: string[];
    requires?: string[];
    invalidates?: {
        [key in string]: string[];
    };
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
 *  Parameters for creating a review session. `order` is the frozen worklist (must be
 *  non-empty); the cursor starts at its first id.
 */
type ReviewCreate = {
    mapId: string;
    name: string;
    sourceKey: string;
    sourceProps: any;
    order: number[];
};
/**  A review session: a frozen worklist of locations with progress tracking. */
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
/**  Partial update for a review session. `None` fields are left unchanged. */
type ReviewUpdate = {
    id: string;
    name?: string | null;
    cursorId: number | null;
    reviewed: number[] | null;
    ordering: number[] | null;
    status: string | null;
};
/**  Result of `store_collect`: locations returned inline, or a file path to read them from. */
type Rows = {
    kind: "inline";
    locations: Location[];
} | {
    kind: "file";
    path: string;
};
/**  Rows after a run over them, and the ids each provider failed. */
type RowsRun = {
    rows: Location[];
    failed: {
        [key in string]: number[];
    };
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
/**  A panorama visit record. */
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
 *  Filters for seen-history queries. All fields are AND-combined.
 *  `search` matches against the address.
 */
type SeenFilter = {
    country?: string | null;
    mapId?: string | null;
    search?: string | null;
};
/**  Map ID and display name for seen-history filtering. */
type SeenMapInfo = {
    id: string;
    name: string;
};
/**  Parameters for recording a panorama visit. */
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
 *  The index is the draw order - a later selection overdraws an earlier one - so the
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
/**
 *  A top-level row of `store_sync_selections`: the selection itself, plus whether it is
 *  ghosted. Ghosting means nothing for a nested child, which is why the flag lives here
 *  and not on `Selection`.
 */
type SelectionInput = {
    /**  Counted, but kept out of the overlay and the selected set. */
    ghosted?: boolean;
} & Selection;
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
    test: FilterOp;
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
 *  Open-time snapshot: the same `values` a mutation result carries, with every field
 *  present. The one full picture JS ever receives; everything after is a delta.
 */
type StoreStatus = {
    version: number;
    values: EngineValues;
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
    order: number | null;
    /**
     *  Document links from the map JSON's `extra.tags[name].doclinks` --
     *  URLs into external docs (e.g. Google Docs heading links). Read-only
     *  in the app; round-trips through import/export.
     */
    doclinks?: string[];
};
/**  Patchable fields of a `Tag`. Subset by design: id/visible aren't editable here. */
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
 *  Per-map config for a virtual tag-tree node - a folder node with no underlying
 *  tag (e.g. "a" when only "a/b" and "a/c" exist). Keyed by the node's full slash
 *  path in `MapSettings::virtual_tags`. Tree-view only; never creates a real tag.
 */
type VirtualTag = {
    color?: string | null;
};

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

export type Digits = {
    "0": [];
    "1": [0];
    "2": [0, 0];
    "3": [0, 0, 0];
    "4": [0, 0, 0, 0];
    "5": [0, 0, 0, 0, 0];
    "6": [0, 0, 0, 0, 0, 0];
    "7": [0, 0, 0, 0, 0, 0, 0];
    "8": [0, 0, 0, 0, 0, 0, 0, 0];
    "9": [0, 0, 0, 0, 0, 0, 0, 0, 0];
};
export type D = keyof Digits;
/** Lift a single-item curried transform into one that folds over an array of items. */
declare const batch: <T, S>(op: (item: T) => (state: S) => S) => (items: T[]) => (state: S) => S;
export type RequireNonNull<T> = {
    [P in keyof T]-?: NonNullable<T[P]>;
};
export type Nullable<T> = {
    [K in keyof T]: T[K] | null;
};
export type Rename<T, Map extends Record<string, string>> = {
    [K in keyof T as K extends keyof Map ? Map[K] : K]: T[K];
};
/** The member(s) of union `U` whose discriminant `D` (default `"type"`) is `V`. */
export type Variant<U, V extends U[D], D extends keyof U = "type" & keyof U> = Extract<U, Record<D, V>>;
/** The value union of a `const` object. */
export type EnumOf<T> = T[keyof T];

/** A field definition with every optional attribute spelled absent. */
declare function createFieldDef(type: ExtraFieldType, over?: Partial<Omit<ExtraFieldDef, "type">>): ExtraFieldDef;
/** Street View camera orientation (POV). */
export type LocationPOV = Pick<Location, "heading" | "pitch" | "zoom">;
/** Where the camera looks: the POV without its zoom. */
export type CameraFrame = Pick<LocationPOV, "heading" | "pitch">;
/** A view on a specific panorama. */
export type PanoView = LocationPOV & RequireNonNull<Pick<Location, "panoId">>;
/** The camera fields a Location and the live Street View viewer share. */
export type PanoCapture = LocationPOV & Pick<Location, "lat" | "lng" | "panoId">;
/** A {lat, lng} coordinate pair. */
export type LatLng = google.maps.LatLngLiteral;
/** A {west, south, east, north} bounding box. */
export type Bounds = google.maps.LatLngBoundsLiteral;
/** True when bounds span the entire world. */
declare function isWorldBounds(b: Bounds): boolean;
/** Convert a [south, west, north, east] tuple to a Bounds object. */
declare function scoreTupleToBounds([s, w, n, e]: [number, number, number, number]): Bounds;
/** Convert a [west, south, east, north] bbox tuple to Bounds, or null. */
declare function bboxTupleToBounds(t: [number, number, number, number] | null): Bounds | null;
/** Convert a Bounds object to a [south, west, north, east] tuple. */
declare function boundsToScoreTuple(b: Bounds): [number, number, number, number];
/** A decoded Street View panorama: flat JSON with no live objects. */
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
/** Pinned: the location always opens this exact pano. */
declare function isPinned(loc: Location): loc is Location & {
    panoId: string;
};
/** The `extra` merge patch that turns `before` into `after`: changed keys carry their
 *  new value, keys `after` lacks carry null. */
declare function extraPatch(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Record<string, unknown>;
/** The same location on the same pano: what makes one row's answer another row's. */
declare function sameRow(a: Location, b: Location): boolean;
/** True for virtual (preview-only) locations, which have negative ids and are not
 *  part of the map. */
declare function isVirtualLocation(loc: {
    id: number;
}): boolean;
/** A full location or just its id (to be fetched on demand). */
export type MaybeLocation = Location | number;
/** Extract the id from a MaybeLocation. */
declare function locId(m: MaybeLocation): number;
/** True when the location is an import preview (not yet committed). */
declare function isImportPreview(loc: Location): boolean;
/** True when the location is a seen-history overlay preview. */
declare function isSeenPreview(loc: Location): boolean;
/** Build a Location from lat/lng plus overrides. `id` stays 0 until `addLocations`
 *  writes the real id back into the object. */
declare function createLocation(partial: Partial<Location> & LatLng): Location;
/** A new Location at the viewer's live camera, carrying `source`'s flags and the given
 *  tags. `extra` describes the pano it was fetched for, so it only survives a drop that
 *  stayed on that pano. */
declare function dropLocation(source: Location, live: PanoCapture, panoId: string | null, tags: number[]): Location;
/** Apply a LocationPatch to a location. `extra` follows JSON Merge Patch (RFC 7386):
 *  keys shallow-merge, a null value deletes its key, and a null patch clears extra. */
declare function applyLocationPatch(loc: Location, patch: LocationPatch_Deserialize): Location;
export type SortMode = "name" | "created" | "opened" | "amount";
export type TagSortMode = "default" | "name" | "amount";
export type WorkArea = "overview" | "location" | "duplicates" | "import" | "plugin" | "diff";
/** Hex like "#1098ad"; legacy stored prefs may hold an Open Props ramp name. */
export type SvColor = string;
export type MapTypeKey = "map" | "satellite" | "osm" | "vector";
export type SvCoverageType = "official" | "unofficial" | "default";
export type SvThickness = "default" | "high";
export type MarkerStyle = "pin" | "circle" | "arrow";

export type types_Bounds = Bounds;
export type types_CameraFrame = CameraFrame;
export type types_LatLng = LatLng;
export type types_LocationPOV = LocationPOV;
export type types_MapTypeKey = MapTypeKey;
export type types_MarkerStyle = MarkerStyle;
export type types_MaybeLocation = MaybeLocation;
export type types_Pano = Pano;
export type types_PanoCapture = PanoCapture;
export type types_PanoView = PanoView;
export type types_SortMode = SortMode;
export type types_SvColor = SvColor;
export type types_SvCoverageType = SvCoverageType;
export type types_SvThickness = SvThickness;
export type types_TagSortMode = TagSortMode;
export type types_WorkArea = WorkArea;
declare const types_applyLocationPatch: typeof applyLocationPatch;
declare const types_bboxTupleToBounds: typeof bboxTupleToBounds;
declare const types_boundsToScoreTuple: typeof boundsToScoreTuple;
declare const types_createFieldDef: typeof createFieldDef;
declare const types_createLocation: typeof createLocation;
declare const types_dropLocation: typeof dropLocation;
declare const types_extraPatch: typeof extraPatch;
declare const types_isImportPreview: typeof isImportPreview;
declare const types_isPinned: typeof isPinned;
declare const types_isSeenPreview: typeof isSeenPreview;
declare const types_isVirtualLocation: typeof isVirtualLocation;
declare const types_isWorldBounds: typeof isWorldBounds;
declare const types_locId: typeof locId;
declare const types_sameRow: typeof sameRow;
declare const types_scoreTupleToBounds: typeof scoreTupleToBounds;
declare namespace types {
  export { types_applyLocationPatch as applyLocationPatch, types_bboxTupleToBounds as bboxTupleToBounds, types_boundsToScoreTuple as boundsToScoreTuple, types_createFieldDef as createFieldDef, types_createLocation as createLocation, types_dropLocation as dropLocation, types_extraPatch as extraPatch, types_isImportPreview as isImportPreview, types_isPinned as isPinned, types_isSeenPreview as isSeenPreview, types_isVirtualLocation as isVirtualLocation, types_isWorldBounds as isWorldBounds, types_locId as locId, types_sameRow as sameRow, types_scoreTupleToBounds as scoreTupleToBounds };
  export type { types_Bounds as Bounds, types_CameraFrame as CameraFrame, types_LatLng as LatLng, types_LocationPOV as LocationPOV, types_MapTypeKey as MapTypeKey, types_MarkerStyle as MarkerStyle, types_MaybeLocation as MaybeLocation, types_Pano as Pano, types_PanoCapture as PanoCapture, types_PanoView as PanoView, types_SortMode as SortMode, types_SvColor as SvColor, types_SvCoverageType as SvCoverageType, types_SvThickness as SvThickness, types_TagSortMode as TagSortMode, types_WorkArea as WorkArea };
}

/** An [r, g, b] byte tuple. */
export type RGB = [number, number, number];
/** An [r, g, b, a] byte tuple. */
export type RGBA = [...RGB, number];
/** Parse "#rrggbb" to an [r, g, b] byte tuple. */
declare function hexToRgb(hex: string): RGB;
/** Return "#000" or "#fff" for readable text on the given hex background. */
declare function textColorFor(bg: string): string;
/** Resolve an SV coverage color to hex. Accepts "#rrggbb" or a CSS custom-property
 *  ramp name (legacy stored format). */
declare function resolveSvColorHex(color: string): string;
/** Set the app's `--accent` and `--on-accent` CSS custom properties from a hex color. */
declare function applyAccentColor(hex: string): void;
/** Convert "#rrggbb" to {h, s, l} (degrees, percent, percent). */
declare function hexToHsl(hex: string): {
    h: number;
    s: number;
    l: number;
};
/** Convert HSL (degrees, percent, percent) to "#rrggbb". */
declare function hslToHex(h: number, s: number, l: number): string;
/** Convert HSL (h in degrees, s and l in 0-1) to an RGB byte tuple. */
declare function hslToRgb(h: number, s: number, l: number): RGB;
/**
 * Deterministic tag color from a name.
 */
declare function colorForName(name: string): string;
/** Format an RGB tuple as a CSS `rgb(r, g, b)` string. */
declare function rgbCss([r, g, b]: RGB): string;
/** Convert an RGB byte tuple to "#rrggbb". */
declare function rgbToHex([r, g, b]: RGB): string;
/** A label's color: a user override if set, else a deterministic color from its name. */
declare function labelColor(name: string, overrides: Record<string, string>): string;

export type colorUtils_RGB = RGB;
export type colorUtils_RGBA = RGBA;
declare const colorUtils_applyAccentColor: typeof applyAccentColor;
declare const colorUtils_colorForName: typeof colorForName;
declare const colorUtils_hexToHsl: typeof hexToHsl;
declare const colorUtils_hexToRgb: typeof hexToRgb;
declare const colorUtils_hslToHex: typeof hslToHex;
declare const colorUtils_hslToRgb: typeof hslToRgb;
declare const colorUtils_labelColor: typeof labelColor;
declare const colorUtils_resolveSvColorHex: typeof resolveSvColorHex;
declare const colorUtils_rgbCss: typeof rgbCss;
declare const colorUtils_rgbToHex: typeof rgbToHex;
declare const colorUtils_textColorFor: typeof textColorFor;
declare namespace colorUtils {
  export { colorUtils_applyAccentColor as applyAccentColor, colorUtils_colorForName as colorForName, colorUtils_hexToHsl as hexToHsl, colorUtils_hexToRgb as hexToRgb, colorUtils_hslToHex as hslToHex, colorUtils_hslToRgb as hslToRgb, colorUtils_labelColor as labelColor, colorUtils_resolveSvColorHex as resolveSvColorHex, colorUtils_rgbCss as rgbCss, colorUtils_rgbToHex as rgbToHex, colorUtils_textColorFor as textColorFor };
  export type { colorUtils_RGB as RGB, colorUtils_RGBA as RGBA };
}

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
    /** Shared empty selection (no map open / cleared). */
    static readonly EMPTY: SelectedIds;
    private readonly bits;
    /** Count of distinct selected ids (not overlay entries - an id selected by N
     *  overlapping selections still counts once). */
    readonly size: number;
    constructor(bits: Uint8Array, size: number);
    has(id: number): boolean;
    /** Yields each selected id once, ascending. Scans the bit array, so it's O(maxId/8);
     *  used by deliberate bulk consumers (export, bulk-tag, delete), not the per-frame path. */
    [Symbol.iterator](): Iterator<number>;
}
/**
 * The markers drawn by the selection overlay, keyed by location id.
 *
 * Sole authority on "is this row drawn by the overlay rather than the base layer" - the
 * base cells hold no selection state, they derive their visibility byte from `has`.
 * Presence is a bit array and id -> slot is a plain `Uint32Array`, so nothing here
 * hashes: a bulk rebuild costs one extra store per marker over writing the draw arrays
 * alone, and every by-id operation is O(1).
 *
 * Writes swap-remove, so slots land unordered - but the overlay is one deck.gl layer and
 * every marker sits at z=0, which makes slot order the only z-stacking there is. `order()`
 * puts the slots back in selection order, and the batch entry points call it once they
 * settle. Nothing else may hand these arrays to a layer.
 */
declare class SelectionOverlay {
    positions: Float32Array<ArrayBuffer>;
    colors: Uint8Array<ArrayBuffer>;
    angles: Float32Array<ArrayBuffer>;
    ids: Uint32Array<ArrayBuffer>;
    /** Per-entry index of the selection drawing it, and the sort key `order()` uses.
     *  CPU-side bookkeeping like `ids` - never an attribute, never uploaded. */
    sel: Uint32Array<ArrayBuffer>;
    count: number;
    version: number;
    private capacity;
    private bits;
    /** id -> slot. Only meaningful where `bits` is set, so it needs no empty sentinel. */
    private slot;
    /** Scratch for `order()`: entry -> destination slot. Reused across calls. */
    private dest;
    has(id: number): boolean;
    /** Add `id` to the overlay, or restate an existing entry. `selIdx` is the drawing
     *  selection's index - the sort key `order()` needs, which no caller can recover from
     *  the colour alone once two selections share one. */
    set(id: number, lng: number, lat: number, heading: number, color: Readonly<RGB>, selIdx: number): void;
    /** Follow a row that moved. No-op when the row isn't in the overlay. */
    move(id: number, lng?: number, lat?: number, heading?: number): void;
    delete(id: number): void;
    clear(): void;
    /**
     * Sort the entries by selection index, so a later selection's markers overdraw an
     * earlier one's everywhere rather than wherever slot order happens to favour them.
     *
     * Counting sort: the key is a small dense integer, so it is two O(n) passes and an
     * array sized by the selection count. The leading scan makes the cases that need no
     * work - already ordered, or one selection in play - a single pass with no allocation,
     * which covers a plain single-selection map entirely.
     */
    order(): void;
    /** Exchange two slots, keeping `slot` pointing at where each id actually lives. */
    private swap;
    /** Snapshot of the selected ids. Copies the bit array so later edits can't mutate it. */
    selectedIds(): SelectedIds;
    /** Replace every entry with arrays sliced straight out of Rust's render binary, which
     *  ships them in emission order, then put them in selection order. */
    load(positions: Float32Array<ArrayBuffer>, colors: Uint8Array<ArrayBuffer>, angles: Float32Array<ArrayBuffer>, ids: Uint32Array<ArrayBuffer>, sel: Uint32Array<ArrayBuffer>, maxId: number): void;
    /** Size up front for a rebuild of known size, so `set` never reallocates mid-loop. */
    reserve(n: number, maxId: number): void;
    /** Grow the draw arrays to hold `n` entries and the id-keyed arrays to cover `maxId`. */
    private ensure;
}
/**
 * Typed-array backed buffer for one geohash cell's marker data.
 * Grows by doubling. Removals use swap-remove (O(1), order not preserved).
 * Versioned per-attribute so deck.gl can skip unchanged layers.
 */
declare class CellBuffer {
    ids: number[];
    idToIndex: Map<number, number>;
    positions: Float32Array;
    /** Per-marker visibility, 255 draws and 0 hides. Every base marker is drawn in the one
     *  global marker colour, which the layer supplies as a constant, so the only per-marker
     *  colour fact is whether a selection or the active highlight is covering it. */
    visible: Uint8Array;
    angles: Float32Array;
    count: number;
    capacity: number;
    positionVersion: number;
    colorVersion: number;
    constructor(capacity?: number);
    /** Append a marker, growing the buffer if needed. Visibility is corrected by the
     *  caller's `syncVisible` once the overlay knows about the row. */
    append(entry: RenderEntry): void;
    /** O(1) removal by swapping with the last element. Mirrors Rust's cell_remove_render. */
    swapRemove(index: number): void;
    patchPosition(index: number, lng?: number, lat?: number, heading?: number): void;
    /** Show (255) or hide (0) one marker in the base layer. */
    patchVisible(index: number, visible: number): void;
    private ensureCapacity;
}
/**
 * Owns all marker render data as 32 geohash-cell CellBuffers plus a selection overlay.
 * Initialized from a binary blob built by Rust (`initFromBinary`), then kept in sync
 * via incremental deltas (`applyDelta`) and selection bitmasks (`applySelectionBitmasks`).
 * deck.gl layers read the typed arrays directly - no JSON serialization in the render loop.
 */
declare class CellManager {
    cells: Map<string, CellBuffer>;
    totalCount: number;
    version: number;
    /** Largest location id seen - sizes the selection bitset. Monotonic (never shrinks on
     *  removal; an overestimate just over-allocates a few bytes). */
    maxId: number;
    /** The rows the selection overlay draws, and the only record of which rows are selected. */
    readonly overlay: SelectionOverlay;
    /** The row the active-location layer draws, hidden in its base cell. */
    private activeId;
    /** Parse the full render binary from Rust. Replaces all cells and the selection overlay. */
    initFromBinary(buf: ArrayBuffer): void;
    /** Scratch for `applySelectionBitmasks`: per-row winning selection index, reused across
     *  cells so a full sync does not allocate one array per cell. */
    private selWinner;
    /**
     * Apply an incremental delta. Every entry states the row's resulting selection state,
     * so the base cells and the overlay are written from one fact rather than inferred
     * from each other. Returns the affected cell keys.
     */
    applyDelta(delta: RenderDelta): Set<string>;
    /** Put the row at `cb[i]` in or out of the selection overlay and set its base visibility.
     *  Idempotent, so restating a row's current state costs nothing but is always safe.
     *  Takes the buffer and index the caller already has - `syncVisible` is for the
     *  active-location path, which only knows an id. */
    private setSelection;
    /** Set the active location, whose marker the active layer draws instead of the base cell.
     *  Returns whether the active row actually moved. */
    setActive(id: number | null): boolean;
    /**
     * A base row is hidden exactly when something else is drawing it: the selection overlay
     * or the active-location layer. The only place `visible` is decided for a single row, so
     * "selected" and "active" never have to negotiate over the byte.
     */
    private syncVisible;
    /** Visit every rendered location's position. The cells hold all alive rows (a `visible`
     *  0 only means the overlay or active layer draws that row instead), so this is the
     *  maintained full-map position set. */
    forEachPosition(f: (id: number, lng: number, lat: number) => void): void;
    /** Map a deck.gl pick (cell + index) back to a location ID. */
    resolvePickFromCell(cellKey: string, cellIndex: number): number | null;
    /** Selected-id set, snapshotted from the overlay. */
    selectedIds(): SelectedIds;
    /**
     * Decode per-cell bitmasks from Rust into the selection overlay. Selected rows are drawn
     * by the overlay in their selection's color and hidden in their base cell.
     *
     * Partial updates are supported: only the cells named in `cellEntries` are restated,
     * and overlay entries for every other cell survive untouched.
     */
    applySelectionBitmasks(selColors: RGB[], cellEntries: SelCellEntry[]): SelectedIds;
    clear(): void;
}

/** Pure selection transforms: build, compose, invert, rewrite, and remove selections. */

export interface SelectionState {
    selections: Selection[];
    ghosted: ReadonlySet<string>;
}
export type SelectionPatch = Partial<SelectionState>;
/** Selector variants that wrap child selections (Intersection, Union, Invert). */
export type CompositeType = Extract<Selector, {
    selections: Selection[];
}>["type"];
/** Composite variants that wrap exactly one child (e.g. Invert). */
export type UnaryType = "Invert";
/** Composite variants that are flat n-ary groups. */
export type GroupType = Exclude<CompositeType, UnaryType>;
declare const UNARY_TYPES: readonly ["Invert"];
export type FilterOpKind = FilterOp["op"];
/** Whether a predicate reads the location's clock in its own timezone. Only a range can. */
declare const filterIsLocalTime: (test: FilterOp) => boolean;
/** Display symbol/word for each filter operator. Symbols are language-neutral; only the worded
 *  operators are marked for translation. */
declare const OP_LABELS: Record<FilterOpKind, string>;
/** Deterministic color derived from a selection key string. */
declare function colorForKey(key: string): RGB;
/** Ghost keys that "solo" `key`: everything except it. Returns an empty set when `key`
 *  is already the sole visible selection, so a repeat call un-isolates (clears all ghosts). */
declare function isolateGhostKeys(keys: string[], ghosted: ReadonlySet<string>, key: string): Set<string>;
/** Toggle one selection's ghosted (dimmed) state. */
declare const toggleGhost: (key: string) => (_sels: Selection[], ghosted: ReadonlySet<string>) => SelectionPatch;
/** Solo one selection by ghosting all others. Repeat to clear all ghosts. */
declare const isolateGhost: (key: string) => (sels: Selection[], ghosted: ReadonlySet<string>) => SelectionPatch;
/** Ghost all selections, or clear all ghosts if every selection is already ghosted. */
declare const toggleGhostAll: () => (sels: Selection[], ghosted: ReadonlySet<string>) => SelectionPatch;
/** Pick `n` distinct ids uniformly at random from `ids` using `Math.random`.
 *  `n` is floored and clamped to `[0, ids.length]` (so over-large counts return all ids).
 *  Uses a partial Fisher–Yates shuffle, so the result contains no duplicates and `ids` is not mutated. */
declare function sampleIds(ids: number[], n: number): number[];
/** What one selection type answers about itself; optional answers default at the lookup. */
export interface SelectionDescriptor<K extends Selector["type"]> {
    key(selector: Variant<Selector, K>, locations: number[]): string;
    label(selector: Variant<Selector, K>, tagNames?: Record<number, string>): string;
    /** Null falls through to the key hash. */
    color?(selector: Variant<Selector, K>): RGB | null;
    locations?(selector: Variant<Selector, K>): number[];
}
/** Per-type descriptor for each selector variant: key derivation, display label, and optional color/location overrides. */
declare const SELECTIONS: {
    [K in Selector["type"]]: SelectionDescriptor<K>;
};
/** Create a Selection with a deterministic key and color from its selector. */
declare function buildSelection(selector: Selector): Selection;
/** Append a new selection built from `selector`, deduplicating by key. */
declare const addSelection: (selector: Selector) => (current: Selection[]) => Selection[];
/** Keys of every Polygon selection whose geometry contains the point. */
declare function polygonSelectionsContaining(selections: Selection[], lat: number, lng: number): string[];
/** Remove a selection by key. Composites unwrap their children back into the list. */
declare const removeSelection: (key: string) => (current: Selection[]) => Selection[];
/** Merge the targeted selections (or all, when `keys` is null) into a single Intersection. */
declare const intersectSelections: (keys?: string[] | null) => (current: Selection[]) => Selection[];
/** Merge the targeted selections (or all, when `keys` is null) into a single Union. */
declare const unionSelections: (keys?: string[] | null) => (current: Selection[]) => Selection[];
/** Invert targeted selections. Single target toggles in-place at any depth; multiple are wrapped in Union then Invert. */
declare const invertSelections: (keys?: string[] | null) => (current: Selection[]) => Selection[];
/** Add or remove a location from the Manual selection, creating it if needed. */
declare const toggleManualSelection: (locationId: number) => (current: Selection[]) => Selection[];
/** Move selection `fromKey` before or after `toKey` in the list. */
declare const reorderSelections: (fromKey: string, toKey: string, position: "before" | "after") => (current: Selection[]) => Selection[];
/** Merge the dragged selection into the drop target as a composite, absorbing existing
 *  children of the same type. Handles nested cases across parent groups. */
declare const composeSelections: (dragKey: string, dropKey: string, mode: GroupType, dragParent?: string | null, dropParent?: string | null) => (current: Selection[]) => Selection[];
/** Pull a child out of a composite back into the top-level list, children and all. Parent collapses
 *  if only one child remains, and disappears if none do. */
declare const decomposeChild: (parentKey: string, childKey: string) => (current: Selection[]) => Selection[];
/** Remove a child from a composite, ungrouping any nested group's children into the parent. */
declare const removeFromComposite: (parentKey: string, childKey: string) => (current: Selection[]) => Selection[];
/** Compose two siblings inside the same parent group into a nested composite. */
declare function composeSiblings(current: Selection[], parentKey: string, dragKey: string, dropKey: string, mode: GroupType): Selection[];
/** Compose a top-level selection with a child inside a parent group. */
declare function composeWithChild(current: Selection[], dragKey: string, parentKey: string, childKey: string, mode: GroupType): Selection[];
/** Replace the selection at `oldKey` (at any depth) with one built from `selector`. If the new
 *  key collides with an existing selection, the existing one wins and the replacement is dropped. */
declare function replaceSelection(current: Selection[], oldKey: string, selector: Selector): Selection[];
/** Human-readable label for a selection. Pass `tagNames` to resolve tags by saved name
 *  rather than the open map's tags (used by saved selection rules). */
declare function selectionDisplayName(sel: Selection, tagNames?: Record<number, string>): string;
/** Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
 *  the `/`-path to its shortest unique suffix; otherwise returns the name verbatim. */
declare function displayTagName(name: string): string;
/** Update the colors of selections by matching keys from `entries`. */
declare const setSelectionColors: (entries: Selection[]) => (current: Selection[]) => Selection[];
/** Rename a Polygon selection's display name. */
declare const setPolygonName: (key: string, name: string) => (current: Selection[]) => Selection[];
/** Rename or remove a field across all Filter selections. When `to` is null, filters on that field are dropped. */
declare const rewriteSelectionFields: (from: string, to: string | null) => (selections: Selection[]) => Selection[];

export type selectionOps_CompositeType = CompositeType;
export type selectionOps_FilterOpKind = FilterOpKind;
export type selectionOps_GroupType = GroupType;
declare const selectionOps_OP_LABELS: typeof OP_LABELS;
declare const selectionOps_SELECTIONS: typeof SELECTIONS;
export type selectionOps_SelectionPatch = SelectionPatch;
export type selectionOps_SelectionState = SelectionState;
declare const selectionOps_UNARY_TYPES: typeof UNARY_TYPES;
export type selectionOps_UnaryType = UnaryType;
declare const selectionOps_addSelection: typeof addSelection;
declare const selectionOps_batch: typeof batch;
declare const selectionOps_buildSelection: typeof buildSelection;
declare const selectionOps_colorForKey: typeof colorForKey;
declare const selectionOps_composeSelections: typeof composeSelections;
declare const selectionOps_composeSiblings: typeof composeSiblings;
declare const selectionOps_composeWithChild: typeof composeWithChild;
declare const selectionOps_decomposeChild: typeof decomposeChild;
declare const selectionOps_displayTagName: typeof displayTagName;
declare const selectionOps_filterIsLocalTime: typeof filterIsLocalTime;
declare const selectionOps_intersectSelections: typeof intersectSelections;
declare const selectionOps_invertSelections: typeof invertSelections;
declare const selectionOps_isolateGhost: typeof isolateGhost;
declare const selectionOps_isolateGhostKeys: typeof isolateGhostKeys;
declare const selectionOps_polygonSelectionsContaining: typeof polygonSelectionsContaining;
declare const selectionOps_removeFromComposite: typeof removeFromComposite;
declare const selectionOps_removeSelection: typeof removeSelection;
declare const selectionOps_reorderSelections: typeof reorderSelections;
declare const selectionOps_replaceSelection: typeof replaceSelection;
declare const selectionOps_rewriteSelectionFields: typeof rewriteSelectionFields;
declare const selectionOps_sampleIds: typeof sampleIds;
declare const selectionOps_selectionDisplayName: typeof selectionDisplayName;
declare const selectionOps_setPolygonName: typeof setPolygonName;
declare const selectionOps_setSelectionColors: typeof setSelectionColors;
declare const selectionOps_toggleGhost: typeof toggleGhost;
declare const selectionOps_toggleGhostAll: typeof toggleGhostAll;
declare const selectionOps_toggleManualSelection: typeof toggleManualSelection;
declare const selectionOps_unionSelections: typeof unionSelections;
declare namespace selectionOps {
  export { selectionOps_OP_LABELS as OP_LABELS, selectionOps_SELECTIONS as SELECTIONS, selectionOps_UNARY_TYPES as UNARY_TYPES, selectionOps_addSelection as addSelection, selectionOps_batch as batch, selectionOps_buildSelection as buildSelection, selectionOps_colorForKey as colorForKey, selectionOps_composeSelections as composeSelections, selectionOps_composeSiblings as composeSiblings, selectionOps_composeWithChild as composeWithChild, selectionOps_decomposeChild as decomposeChild, selectionOps_displayTagName as displayTagName, selectionOps_filterIsLocalTime as filterIsLocalTime, selectionOps_intersectSelections as intersectSelections, selectionOps_invertSelections as invertSelections, selectionOps_isolateGhost as isolateGhost, selectionOps_isolateGhostKeys as isolateGhostKeys, selectionOps_polygonSelectionsContaining as polygonSelectionsContaining, selectionOps_removeFromComposite as removeFromComposite, selectionOps_removeSelection as removeSelection, selectionOps_reorderSelections as reorderSelections, selectionOps_replaceSelection as replaceSelection, selectionOps_rewriteSelectionFields as rewriteSelectionFields, selectionOps_sampleIds as sampleIds, selectionOps_selectionDisplayName as selectionDisplayName, selectionOps_setPolygonName as setPolygonName, selectionOps_setSelectionColors as setSelectionColors, selectionOps_toggleGhost as toggleGhost, selectionOps_toggleGhostAll as toggleGhostAll, selectionOps_toggleManualSelection as toggleManualSelection, selectionOps_unionSelections as unionSelections };
  export type { selectionOps_CompositeType as CompositeType, selectionOps_FilterOpKind as FilterOpKind, selectionOps_GroupType as GroupType, selectionOps_SelectionPatch as SelectionPatch, selectionOps_SelectionState as SelectionState, selectionOps_UnaryType as UnaryType };
}

/** The engine-owned mirror: exactly the value slice Rust ships (`EngineValues`), with every field required. */
export type EngineState = {
    [K in keyof EngineValues]: NonNullable<EngineValues[K]>;
};
export interface UiState {
    mapId: string | null;
    /** Persisted identity slice (metadata + settings). Changes rarely. */
    map: MapMeta | null;
    /** Resolved count per selection node (top-level and nested), keyed by `Selection.key`.
     *  The sole source for sidebar counts — refreshed wholesale from Rust on every sync. */
    selectionCounts: Record<string, number>;
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
export type MapState = UiState & EngineState;
/** Reactive slice of the map state. Re-renders only when the selected value's
 *  reference changes (`Object.is`), so selectors must return state fields or
 *  cached derivations — never construct a value per call. */
declare function useMapState<T>(selector: (s: MapState) => T): T;
/** Imperative snapshot of the map state. */
declare function getMapState(): Readonly<MapState>;
/** Tags that exist from the user's point of view. Raw `tags` also holds soft-deleted ghosts (count=0, visible=false) - almost nothing outside the undo machinery should enumerate those. */
declare const getVisibleTags: () => Tag[];
/** Raw by-id tag lookup — includes soft-deleted ghosts so stale references
 *  (e.g. a selection whose tag just died) still resolve to a name. */
declare function getTag(id: number): Tag | undefined;
/** Tag names for the given ids, skipping any that no longer resolve. */
declare function tagIdsToNames(ids: number[]): string[];
/** Defer autosave until the returned release function runs. Useful for batches that land many mutations. @unstable */
declare function holdAutosave(): () => void;
/** Schedule a debounced autosave. Mutations call this automatically. @unstable */
declare function scheduleSave(): void;
/** Cancel any pending autosave timer. @unstable */
declare function cancelAutosave(): void;
/** Wait for any in-progress save to finish. @unstable */
declare function waitForInflightPersist(): Promise<void> | null;
/** Background auto-commit after an import with autoCommit set. @unstable */
declare function scheduleAutoCommit(mapId: string, importedCount: number): void;
/** Save any unsaved changes now instead of waiting for the autosave timer. @unstable */
declare function flushSave(): Promise<void>;
/** One-time store startup. The app calls this; plugins never need to. @unstable */
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
/** Drop the open map without persisting anything @unstable */
declare function discardOpenMap(): void;
/** Ids of every location the selector resolves to. */
declare function resolveIds(selector: Selector): Promise<number[]>;
/** How many locations the selector resolves to. */
declare function countIn(selector: Selector): Promise<number>;
/** Bounding box `[west, south, east, north]`, or null when the selector is empty. */
declare function fetchBounds(selector: Selector): Promise<[number, number, number, number] | null>;
/** `n` ids drawn uniformly at random, without replacement. */
declare function sampleFrom(selector: Selector, n: number): Promise<number[]>;
/** Distinct values of `field`, sorted. */
declare function fieldValues(selector: Selector, field: string): Promise<string[]>;
/** Group by a derived key and count. */
declare function countBy(selector: Selector, field: string, key: KeySpec): Promise<[string, number][]>;
/** How many locations hold a value for each field, key-sorted. */
declare function coverage(selector: Selector): Promise<[string, number][]>;
/** One column per field over the selected set. `null` where a location
 *  lacks the field; `"tags"` returns a column of tag-id arrays. */
declare function fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]>;
/** Group the selected location set by a derived key. Numeric bins arrive in bound order;
 *  other keys are sorted naturally. */
declare function partition(field: string, key: KeySpec, selector: Selector): Promise<PartitionBucket[]>;
/** Fetch full location rows matching a selector. Missing ids are skipped.
 *
 *  Every row lands in memory, so an unscoped call on a large map is expensive.
 *  Prefer a narrower selector or a projection (`fetchColumns`, `countBy`) when possible. */
declare function fetchLocations(selector: Selector): Promise<Location[]>;
/** Active (non-ghosted) selections, the default for any operational logic. */
declare const getActiveSelections: () => Selection[];
/** The live selection as a `Selector`: the union of the active selection nodes. */
declare function currentSelection(): Selector;
/** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want. */
declare function setSelectedLocationIds(ids: SelectedIds): void;
/** Patch any map's metadata by id and persist it. Updates the open map's state when it is that map. */
declare function patchMapMeta(id: string, patch: MapMetaPatch_Deserialize): Promise<void>;
/** [`patchMapMeta`] for the map open in this window. */
declare function updateMapMeta(patch: MapMetaPatch_Deserialize): Promise<void> | undefined;
/** Replace the map's extra-field definitions (types/labels for `Location.extra` keys). */
declare function setMapExtraFields(fields: Record<string, ExtraFieldDef>): Promise<void>;
/** Decode a selection bitmask and emit it to the render pipeline. @unstable */
declare function emitBitmask(bytes: number[]): void;
/** Run a mutation, apply its result to the map, and schedule a save. */
declare function mutate(fn: () => Promise<MutationResult>): Promise<MutationResult>;
/** Add locations to the map. Real ids are assigned and written back into the passed
 *  objects - build with `createLocation` (id 0) and read `loc.id` after. Undoable.
 *  Emits `location:add`. */
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
/** Rename extra-field `from` to `to` across all locations, its definition, and selections.
 *  When a location already holds `to`, `winner` decides which value survives. */
declare function renameField(from: string, to: string, winner?: MergeWinner): Promise<void>;
/** Delete extra-field `key` from every location, its definition, and references. */
declare function deleteField(key: string): Promise<void>;
/** Apply a field operation across all locations matching `selector`. Emits `location:invalidate`. */
declare function applyFieldOp(selector: Selector, op: FieldOp, recordUndo: boolean): Promise<FieldOpResult>;
/** Add selectors to the active selection list. */
declare function addSelections(selectors: Selector[]): Promise<void>;
/** Drop selections by key. */
declare function removeSelections(keys: string[]): Promise<void>;
/** Apply a selection transform function and re-resolve the selection.
 *  The function receives the current selections and ghosted set, and returns either
 *  a new `Selection[]` or a `SelectionPatch`. No-op when nothing changed. */
declare function applySelectionUpdate(op: (sels: Selection[], ghosted: ReadonlySet<string>) => Selection[] | SelectionPatch): Promise<void>;
/** Re-resolve all selections against the current map data and update the overlay.
 *  Use when the underlying data changed but the selections themselves did not. */
declare function syncSelections$1(): Promise<void>;
/** Clear all selections. */
declare function resetSelections(): Promise<void>;
/** Replace the current selection with up to `count` ids picked at random.
 *  With `perSelection`, picks up to `count` from each active selection separately.
 *  Returns the number of ids actually picked (0 when nothing is selected). */
declare function selectRandomFromSelection(count: number, perSelection?: boolean): Promise<number>;
/** Replace the current selection with spatially spaced ids - either `count` ids maximizing
 *  spacing, or as many as fit at `minDistanceM`. With `perSelection`, each active selection
 *  is picked from separately. Returns the count picked and the minimum distance achieved. */
declare function selectSpacedFromSelection(opts: {
    count?: number;
    minDistanceM?: number;
}, perSelection?: boolean): Promise<{
    picked: number;
    distanceM: number;
}>;
/** Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres. @unstable */
declare function previewDuplicateGroups(distance: number): Promise<number[][]>;
/** Merge each transitive duplicate group into one survivor (tags unioned), ranked by the
 *  map's duplicate preference. One undoable edit. @unstable */
declare function mergeDuplicates(distance: number): Promise<void>;
/**
 * Prune duplicates within a resolved selection: keeps the most relevant location per
 * cluster (<= 25m) or thins to enforce spacing (> 25m). Returns the number pruned.
 *  @unstable
 */
declare function pruneDuplicates(selector: Selector, distance: number): Promise<number>;
/** Edit an existing filter (or any selection) in place by key, preserving its
 *  position inside any AND/OR/Invert composite. Carries ghost state to the new key. */
declare function updateFilterSelection(oldKey: string, selector: Selector): Promise<void>;
/** Toggle tag selections on/off for the given tags (used by tag-pill clicks). */
declare function toggleTagSelections(tagIds: number[]): void;
/** Tag ids that currently have a top-level Tag selection active. */
declare const getSelectedTagIds: () => ReadonlySet<number>;
/** Tag ids of every Tag leaf in the active selection tree, in list order.
 *  Includes composite children, excludes ghosted selections; ids may repeat. */
declare const getSelectedTagIdsDeep: () => readonly number[];
/** Open a staged-import location read-only, "as if" it were active. The location becomes
 *  virtual (negative id; ImportPreview flag) so identity and mutate-guards derive from it. @unstable */
declare function openStagedLocation(index: number): Promise<void>;
/** Open an arbitrary location read-only as a virtual seen-preview: loads its pano without
 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. @unstable */
declare function previewVirtualLocation(loc: Location): void;
/** Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found. */
declare function resolveLocation(m: MaybeLocation): Promise<Location | null>;
/** Open a location in the editor (null closes it). With `checkDuplicates`, opening a spot
 *  with 2+ locations within 2m opens the duplicate-resolution panel instead. */
declare function setActiveLocation(target: MaybeLocation | null, checkDuplicates?: boolean): Promise<void>;
/** Open one location from the duplicate-resolution panel in the editor. @unstable */
declare function openDuplicateLocation(loc: Location): void;
/** Drop a location from the duplicate-resolution panel (does not delete it). @unstable */
declare function removeDuplicate(id: number): void;
/** Close the duplicate-resolution panel and return to the overview. @unstable */
declare function closeDuplicates(): void;
/** Transition the editor pane, enforcing state invariants:
 *  leaving "location" clears the active location, leaving "plugin" clears the plugin id. */
declare function setWorkArea(area: WorkArea): void;
/** Open a plugin's sidebar (switches the editor pane to "plugin"). */
declare function setPluginMode(pluginId: string): void;
/** Close the plugin sidebar and return to the overview. */
declare function exitPluginMode(): void;
/** Get-or-create tags by name. Existing tags are returned as-is; new names get
 *  auto-generated colors. Pass `selector` to assign the tags to those locations
 *  atomically. Emits `tag:add`. */
declare function createTags(names: string[], selector?: Selector): Promise<Tag[]>;
/** Rename or recolor tags. If a rename collides with an existing tag name
 *  (case-insensitive), the two tags are merged — all locations are remapped
 *  to the survivor. */
declare function updateTags(updates: Update<TagPatch>[]): Promise<void>;
/** Delete tags and strip them from all locations. Undoable. Emits `tag:remove`. */
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
/** Commit all pending changes to the map's version history. Clears the undo stack. */
declare function commitMap(message?: string): Promise<string>;
/** Restore the map to a previous commit's state and reopen it. Clears undo/redo. */
declare function checkoutCommit(commitId: string): Promise<void>;

export type store_MapState = MapState;
export type store_UiState = UiState;
declare const store_addLocations: typeof addLocations;
declare const store_addSelections: typeof addSelections;
declare const store_addTagToLocations: typeof addTagToLocations;
declare const store_applyFieldOp: typeof applyFieldOp;
declare const store_applySelectionUpdate: typeof applySelectionUpdate;
declare const store_cancelAutosave: typeof cancelAutosave;
declare const store_checkoutCommit: typeof checkoutCommit;
declare const store_closeDuplicates: typeof closeDuplicates;
declare const store_commitMap: typeof commitMap;
declare const store_countBy: typeof countBy;
declare const store_countIn: typeof countIn;
declare const store_coverage: typeof coverage;
declare const store_createTags: typeof createTags;
declare const store_currentSelection: typeof currentSelection;
declare const store_deleteField: typeof deleteField;
declare const store_deleteTags: typeof deleteTags;
declare const store_discardOpenMap: typeof discardOpenMap;
declare const store_duplicateLocation: typeof duplicateLocation;
declare const store_emitBitmask: typeof emitBitmask;
declare const store_exitPluginMode: typeof exitPluginMode;
declare const store_fetchBounds: typeof fetchBounds;
declare const store_fetchColumns: typeof fetchColumns;
declare const store_fetchLocations: typeof fetchLocations;
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
declare const store_mapOpen: typeof mapOpen;
declare const store_mergeDuplicates: typeof mergeDuplicates;
declare const store_mutate: typeof mutate;
declare const store_openDuplicateLocation: typeof openDuplicateLocation;
declare const store_openStagedLocation: typeof openStagedLocation;
declare const store_partition: typeof partition;
declare const store_patchMapMeta: typeof patchMapMeta;
declare const store_previewDuplicateGroups: typeof previewDuplicateGroups;
declare const store_previewVirtualLocation: typeof previewVirtualLocation;
declare const store_pruneDuplicates: typeof pruneDuplicates;
declare const store_redo: typeof redo;
declare const store_removeDuplicate: typeof removeDuplicate;
declare const store_removeLocations: typeof removeLocations;
declare const store_removeSelections: typeof removeSelections;
declare const store_removeTagFromAllLocations: typeof removeTagFromAllLocations;
declare const store_removeTagFromLocations: typeof removeTagFromLocations;
declare const store_renameField: typeof renameField;
declare const store_reorderTags: typeof reorderTags;
declare const store_resetSelections: typeof resetSelections;
declare const store_resolveIds: typeof resolveIds;
declare const store_resolveLocation: typeof resolveLocation;
declare const store_sampleFrom: typeof sampleFrom;
declare const store_scheduleAutoCommit: typeof scheduleAutoCommit;
declare const store_scheduleSave: typeof scheduleSave;
declare const store_selectRandomFromSelection: typeof selectRandomFromSelection;
declare const store_selectSpacedFromSelection: typeof selectSpacedFromSelection;
declare const store_setActiveLocation: typeof setActiveLocation;
declare const store_setMapExtraFields: typeof setMapExtraFields;
declare const store_setPluginMode: typeof setPluginMode;
declare const store_setSelectedLocationIds: typeof setSelectedLocationIds;
declare const store_setWorkArea: typeof setWorkArea;
declare const store_tagIdsToNames: typeof tagIdsToNames;
declare const store_toggleTagSelections: typeof toggleTagSelections;
declare const store_undo: typeof undo;
declare const store_updateFilterSelection: typeof updateFilterSelection;
declare const store_updateLocations: typeof updateLocations;
declare const store_updateMapMeta: typeof updateMapMeta;
declare const store_updateTags: typeof updateTags;
declare const store_useMapState: typeof useMapState;
declare const store_waitForInflightPersist: typeof waitForInflightPersist;
declare namespace store {
  export { store_addLocations as addLocations, store_addSelections as addSelections, store_addTagToLocations as addTagToLocations, store_applyFieldOp as applyFieldOp, store_applySelectionUpdate as applySelectionUpdate, store_cancelAutosave as cancelAutosave, store_checkoutCommit as checkoutCommit, store_closeDuplicates as closeDuplicates, closeMap$1 as closeMap, store_commitMap as commitMap, store_countBy as countBy, store_countIn as countIn, store_coverage as coverage, store_createTags as createTags, store_currentSelection as currentSelection, store_deleteField as deleteField, store_deleteTags as deleteTags, store_discardOpenMap as discardOpenMap, store_duplicateLocation as duplicateLocation, store_emitBitmask as emitBitmask, store_exitPluginMode as exitPluginMode, store_fetchBounds as fetchBounds, store_fetchColumns as fetchColumns, store_fetchLocations as fetchLocations, store_fieldValues as fieldValues, store_flushSave as flushSave, store_getActiveSelections as getActiveSelections, store_getMapState as getMapState, store_getSelectedTagIds as getSelectedTagIds, store_getSelectedTagIdsDeep as getSelectedTagIdsDeep, store_getTag as getTag, store_getVisibleTags as getVisibleTags, store_holdAutosave as holdAutosave, store_initStore as initStore, store_mapOpen as mapOpen, store_mergeDuplicates as mergeDuplicates, store_mutate as mutate, store_openDuplicateLocation as openDuplicateLocation, openMap$1 as openMap, store_openStagedLocation as openStagedLocation, store_partition as partition, store_patchMapMeta as patchMapMeta, store_previewDuplicateGroups as previewDuplicateGroups, store_previewVirtualLocation as previewVirtualLocation, store_pruneDuplicates as pruneDuplicates, store_redo as redo, store_removeDuplicate as removeDuplicate, store_removeLocations as removeLocations, store_removeSelections as removeSelections, store_removeTagFromAllLocations as removeTagFromAllLocations, store_removeTagFromLocations as removeTagFromLocations, store_renameField as renameField, store_reorderTags as reorderTags, store_resetSelections as resetSelections, store_resolveIds as resolveIds, store_resolveLocation as resolveLocation, store_sampleFrom as sampleFrom, store_scheduleAutoCommit as scheduleAutoCommit, store_scheduleSave as scheduleSave, store_selectRandomFromSelection as selectRandomFromSelection, store_selectSpacedFromSelection as selectSpacedFromSelection, store_setActiveLocation as setActiveLocation, store_setMapExtraFields as setMapExtraFields, store_setPluginMode as setPluginMode, store_setSelectedLocationIds as setSelectedLocationIds, store_setWorkArea as setWorkArea, syncSelections$1 as syncSelections, store_tagIdsToNames as tagIdsToNames, store_toggleTagSelections as toggleTagSelections, store_undo as undo, store_updateFilterSelection as updateFilterSelection, store_updateLocations as updateLocations, store_updateMapMeta as updateMapMeta, store_updateTags as updateTags, store_useMapState as useMapState, store_waitForInflightPersist as waitForInflightPersist };
  export type { store_MapState as MapState, store_UiState as UiState };
}

/** Saved selection rules: portable named rules that persist across maps. A rule stores a
 *  `Selector` tree plus the tag names its `Tag` leaves carried at save time, so it can
 *  re-resolve against whatever map is open. */

/** Selection types that cannot be saved as rules because they are bound to the open map. */
declare const MAP_LOCAL_TYPES: readonly ["Locations", "Manual", "ValidationState", "Reviewed"];
/** Whether the selector tree contains only portable types (no map-local leaves). */
declare function isSaveable(selector: Selector): boolean;
/** One part of a saved rule: what its chip reads as, and what it resolves to here. The
 *  label comes from the tree as saved, so a tag this map doesn't have still reads by the
 *  name it was saved under. */
export interface SavedPart {
    label: string;
    color: RGB;
    selector: Selector;
}
/** A rule's parts: its top-level `Union` is the list it was saved from, anything else is
 *  a single part. */
declare function savedParts(saved: SavedSelection): SavedPart[];
/** The rules that exist, as identity only. Empty until the index arrives -- the first
 *  call starts the read and `saved-selections:changed` announces it. */
declare function getSavedSelectionIndex(): SavedSelectionInfo[];
/** React hook: the saved selection index, re-rendering on changes. */
declare function useSavedSelectionIndex(): SavedSelectionInfo[];
/** Load the full rule bodies for the given `ids`. */
declare function loadSavedSelections(ids: string[]): Promise<SavedSelection[]>;
/** Every rule with its body. */
declare function loadAllSavedSelections(): Promise<SavedSelection[]>;
/** A saved rule as a single `Selector`, resolved against the open map. Matches nothing
 *  until the body arrives; fetching it emits `saved-selections:changed`, so a caller that
 *  re-reads on that event gets the real tree. */
declare function savedSelector(id: string): Selector;
/** Persists the saveable selections as one rule. False when none of them are saveable. */
declare function saveCurrentSelections(name: string, selections: Selection[]): Promise<boolean>;
/** Permanently delete a saved selection rule. */
declare function deleteSavedSelection(id: string): Promise<void>;
/** Adds the rule's parts to the sidebar, resolved against the open map. Returns how many
 *  were added. */
declare function applySavedSelection(saved: SavedSelection): number;

declare const savedSelections_MAP_LOCAL_TYPES: typeof MAP_LOCAL_TYPES;
export type savedSelections_SavedPart = SavedPart;
declare const savedSelections_applySavedSelection: typeof applySavedSelection;
declare const savedSelections_deleteSavedSelection: typeof deleteSavedSelection;
declare const savedSelections_getSavedSelectionIndex: typeof getSavedSelectionIndex;
declare const savedSelections_isSaveable: typeof isSaveable;
declare const savedSelections_loadAllSavedSelections: typeof loadAllSavedSelections;
declare const savedSelections_loadSavedSelections: typeof loadSavedSelections;
declare const savedSelections_saveCurrentSelections: typeof saveCurrentSelections;
declare const savedSelections_savedParts: typeof savedParts;
declare const savedSelections_savedSelector: typeof savedSelector;
declare const savedSelections_useSavedSelectionIndex: typeof useSavedSelectionIndex;
declare namespace savedSelections {
  export { savedSelections_MAP_LOCAL_TYPES as MAP_LOCAL_TYPES, savedSelections_applySavedSelection as applySavedSelection, savedSelections_deleteSavedSelection as deleteSavedSelection, savedSelections_getSavedSelectionIndex as getSavedSelectionIndex, savedSelections_isSaveable as isSaveable, savedSelections_loadAllSavedSelections as loadAllSavedSelections, savedSelections_loadSavedSelections as loadSavedSelections, savedSelections_saveCurrentSelections as saveCurrentSelections, savedSelections_savedParts as savedParts, savedSelections_savedSelector as savedSelector, savedSelections_useSavedSelectionIndex as useSavedSelectionIndex };
  export type { savedSelections_SavedPart as SavedPart };
}

/** A localStorage-backed blob: its key and its defaults, declared where the shape is defined so
 *  no call site restates the pair. Older stored shapes are handled by `store/migrations.ts`. @unstable */
export interface PersistedStore<T> {
    /** @unstable */
    key: string;
    /** @unstable */
    defaults: T;
}

/** Prompt for GeoJSON file(s) and add their polygons as selections. */
declare function loadGeoJSON(): Promise<void>;

declare const requiresMap: () => boolean;
declare const requiresVersioning: () => boolean;
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
    basemapPrev: {
        label: "Previous basemap";
        icon: string;
        group: "Map";
        defaultBinding: string;
        execute: () => void;
        enabled: typeof requiresMap;
    };
    basemapNext: {
        label: "Next basemap";
        icon: string;
        group: "Map";
        defaultBinding: string;
        execute: () => void;
        enabled: typeof requiresMap;
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
        enabled: () => NonNullable<boolean | null>;
    };
    redo: {
        label: "Redo";
        icon: string;
        group: "Map";
        defaultBinding: string;
        execute: typeof redo;
        enabled: () => NonNullable<boolean | null>;
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
        enabled: typeof requiresVersioning;
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

/** Supported languages, labeled in their own script. `en-XA` is a dev-only pseudolocale. @unstable */
declare const LANGUAGES: {
    /** @unstable */
    readonly en: "English";
    /** @unstable */
    readonly de: "Deutsch";
    /** @unstable */
    readonly es: "Español";
    /** @unstable */
    readonly fr: "Français";
    /** @unstable */
    readonly ja: "日本語";
    /** @unstable */
    readonly pl: "Polski";
    /** @unstable */
    readonly ru: "Русский";
    /** @unstable */
    readonly "zh-Hans": "简体中文";
    /** @unstable */
    readonly "en-XA": "Pseudolocale";
};
/** @unstable */
declare const MOVEMENT_MODES: {
    /** @unstable */
    readonly moving: "Moving";
    /** @unstable */
    readonly "no-move": "No Move";
    /** @unstable */
    readonly nmpz: "NMPZ";
};
/** @unstable */
declare const SEEN_RESOLUTIONS: {
    /** @unstable */
    readonly low: "Low (160x90)";
    /** @unstable */
    readonly medium: "Medium (320x180)";
    /** @unstable */
    readonly high: "High (640x360)";
};
/** @unstable */
declare const EXACT_DATE_FORMATS: {
    /** @unstable */
    readonly date: "Date only";
    /** @unstable */
    readonly datetime: "Date + time";
};
/** @unstable */
declare const DATE_TIMEZONES: {
    /** @unstable */
    readonly location: "Location timezone";
    /** @unstable */
    readonly utc: "UTC";
};
/** @unstable */
declare const MAP_LIST_FIELDS: {
    /** @unstable */
    readonly locationCount: "Location count";
    /** @unstable */
    readonly lastOpened: "Last opened";
    /** @unstable */
    readonly created: "Date created";
};
/** @unstable */
declare const DISCORD_PRESENCE_MODES: {
    /** @unstable */
    readonly off: "Off";
    /** @unstable */
    readonly generic: "Generic (no map name)";
    /** @unstable */
    readonly full: "Full (map name + count)";
};
/** @unstable */
declare const GEOCODE_PROVIDERS: {
    /** @unstable */
    readonly local: "Local (offline)";
    /** @unstable */
    readonly nominatim: "Nominatim";
    /** @unstable */
    readonly google: "Google (from panorama)";
};
declare const GEOCODE_PROVIDER_LABELS: Record<keyof typeof GEOCODE_PROVIDERS, string>;
/** Distance units. `auto` reads the system locale's region, so a US/UK machine gets miles. @unstable */
declare const UNIT_SYSTEMS: {
    /** @unstable */
    readonly auto: "Automatic";
    /** @unstable */
    readonly metric: "Metric (m / km)";
    /** @unstable */
    readonly imperial: "Imperial (ft / mi)";
};
/** @unstable */
declare const TAG_VIEW_MODES: {
    /** @unstable */
    readonly flat: "Flat";
    /** @unstable */
    readonly tree: "Tree";
};
/** @unstable */
declare const TAG_FOLDER_COLOR_MODES: {
    /** @unstable */
    readonly direct: "Fixed color";
    /** @unstable */
    readonly firstChild: "Inherit first child";
};
/** @unstable */
declare const OPACITY_TOGGLE_MODES: {
    /** @unstable */
    readonly previous: "Last used opacity";
    /** @unstable */
    readonly full: "Full opacity";
};
/** @unstable */
declare const POLYGON_COLOR_MODES: {
    /** @unstable */
    readonly random: "Random";
    /** @unstable */
    readonly fixed: "Fixed color";
};
/** @unstable */
declare const BORDER_DETAILS: {
    /** @unstable */
    readonly light: "Standard (bundled)";
    /** @unstable */
    readonly medium: "High ({size})";
    /** @unstable */
    readonly heavy: "Ultra ({size})";
};
/** On-disk size of each downloadable archive under `data/borders/`. @unstable */
declare const BORDER_ARCHIVE_BYTES: {
    /** @unstable */
    readonly medium: 7460312;
    /** @unstable */
    readonly heavy: 21514464;
    /** @unstable */
    readonly adm1: 56891952;
};
/** @unstable */
declare const SUBDIVISION_DETAILS: {
    /** @unstable */
    readonly off: "Off";
    /** @unstable */
    readonly adm1: "States / provinces";
};
/** Tag-suggestion list cap stops (slider indices); 0 = unlimited ("All"). */
declare const TAG_SUGGESTION_LIMITS: readonly [5, 10, 25, 50, 0];
/** @unstable */
declare const PREVIEW_ASPECT_RATIOS: {
    /** @unstable */
    readonly "4 / 3": "4:3";
    /** @unstable */
    readonly "16 / 10": "16:10";
    /** @unstable */
    readonly "16 / 9": "16:9";
    /** @unstable */
    readonly "21 / 9": "21:9";
    /** @unstable */
    readonly "32 / 9": "32:9";
    /** @unstable */
    readonly free: "Free";
};
export type Language = keyof typeof LANGUAGES;
export type MovementMode = keyof typeof MOVEMENT_MODES;
declare const MOVEMENT_CYCLE: MovementMode[];
export type ExactDateFormat = keyof typeof EXACT_DATE_FORMATS;
export type DateTimezone = keyof typeof DATE_TIMEZONES;
export type SeenResolution = keyof typeof SEEN_RESOLUTIONS;
export type MapListField = keyof typeof MAP_LIST_FIELDS;
export type DiscordPresenceMode = keyof typeof DISCORD_PRESENCE_MODES;
export type GeocodeProvider = keyof typeof GEOCODE_PROVIDERS;
export type UnitSystem = keyof typeof UNIT_SYSTEMS;
export type TagViewMode = keyof typeof TAG_VIEW_MODES;
export type TagFolderColorMode = keyof typeof TAG_FOLDER_COLOR_MODES;
export type OpacityToggleMode = keyof typeof OPACITY_TOGGLE_MODES;
export type PolygonColorMode = keyof typeof POLYGON_COLOR_MODES;
export type BorderDetail = keyof typeof BORDER_DETAILS;
export type SubdivisionDetail = keyof typeof SUBDIVISION_DETAILS;
export type PreviewAspectRatio = keyof typeof PREVIEW_ASPECT_RATIOS;
/** Default values for every app setting. @unstable */
declare const DEFAULTS: {
    /** @unstable */
    showCameraBadges: boolean;
    /** @unstable */
    showLinksControl: boolean;
    /** @unstable */
    clickToGo: boolean;
    /** @unstable */
    showRoadLabels: boolean;
    /** @unstable */
    defaultMovementMode: MovementMode;
    /** @unstable */
    showCar: boolean;
    /** @unstable */
    showCrosshair: boolean;
    /** @unstable */
    showCompass: boolean;
    /** @unstable */
    showCompassTape: boolean;
    /** @unstable */
    showZoom: boolean;
    /** @unstable */
    showReturnToSpawn: boolean;
    /** @unstable */
    showJumpButtons: boolean;
    /** @unstable */
    showMapLinks: boolean;
    /** @unstable */
    showCoordinateDisplay: boolean;
    /** @unstable */
    showFullscreenButton: boolean;
    /** @unstable */
    showScreenshotButton: boolean;
    /** @unstable */
    showPanoMetadata: boolean;
    /** @unstable */
    exactDateFormat: ExactDateFormat;
    /** @unstable */
    dateTimezone: DateTimezone;
    /** @unstable */
    showNavArrow: boolean;
    /** @unstable */
    showGroundArrow: boolean;
    /** @unstable */
    hidePanoUI: boolean;
    /** Hiding the pano UI also hides navigation: link arrows, ground arrow, click-to-go X. @unstable */
    hideNavWithUI: boolean;
    /** @unstable */
    fullscreenMap: boolean;
    /** @unstable */
    showFullscreenMapMeta: boolean;
    /** @unstable */
    showFullscreenMiniLocationPreview: boolean;
    /** @unstable */
    fullscreenMiniLocationScale: number;
    /** @unstable */
    showFullscreenMinimap: boolean;
    /** @unstable */
    fullscreenMinimapScale: number;
    /** Milliseconds the fullscreen minimap stays expanded after the pointer leaves it. @unstable */
    fullscreenMinimapCloseDelay: number;
    /** @unstable */
    showFullscreenTagbar: boolean;
    /** Tag bar dropped down to a thin strip. Toggled from the bar itself, not Settings. @unstable */
    fullscreenTagbarCollapsed: boolean;
    /** @unstable */
    showFullscreenDatePicker: boolean;
    /** @unstable */
    showFullscreenReviewBar: boolean;
    /** @unstable */
    showFullscreenGeocode: boolean;
    /** @unstable */
    customCss: string;
    /** @unstable */
    enableSeen: boolean;
    /** @unstable */
    enableSeenThumbnails: boolean;
    /** @unstable */
    seenResolution: SeenResolution;
    /** @unstable */
    mapPanSpeed: number;
    /** @unstable */
    panoLookSpeed: number;
    /** @unstable */
    slowModifier: number;
    /** @unstable */
    showFps: boolean;
    /** @unstable */
    mapListFields: MapListField[];
    /** Read once at boot; changing it relaunches the app rather than re-rendering. @unstable */
    language: Language;
    /** Every distance the UI shows or accepts; stored values stay metric. @unstable */
    units: UnitSystem;
    /** Reopen the maps that were open when the session last ended (main window closed). @unstable */
    restoreSession: boolean;
    /** Offer pre-release builds to the updater as well as full releases. @unstable */
    prereleaseUpdates: boolean;
    /** Discord Rich Presence: off, generic (no map name), or full (map name + count). @unstable */
    discordPresence: DiscordPresenceMode;
    /** Per-label color overrides (hex), keyed by lowercased label name. Shared across all maps. @unstable */
    labelColors: Record<string, string>;
    /** @unstable */
    geocodeProvider: GeocodeProvider;
    /** @unstable */
    nominatimApiKey: string;
    /** @unstable */
    panToImported: boolean;
    /** With no location open, Enter shows a center crosshair and opens the location under it. @unstable */
    enterOpensCenter: boolean;
    /** Min half-extent (degrees) a single pasted/imported point is padded to before fitBounds @unstable */
    pastePadding: number;
    /** @unstable */
    followActiveInReview: boolean;
    /** @unstable */
    markerColor: RGB;
    /** @unstable */
    activeLocationColor: RGB;
    /** @unstable */
    importPreviewColor: RGB;
    /** @unstable */
    panoDotColor: RGB;
    /** What the layer opacity hotkeys restore a layer to when toggling it back on. @unstable */
    opacityToggleMode: OpacityToggleMode;
    /** Initial color mode for newly drawn polygon selections. Recoloring by hand overrides either mode. @unstable */
    polygonColorMode: PolygonColorMode;
    /** @unstable */
    polygonColor: RGB;
    /** @unstable */
    panoDotScaled: boolean;
    /** @unstable */
    tagViewMode: TagViewMode;
    /** Tree view only: render each tag as the shortest path suffix that's still unique. @unstable */
    truncateTagPaths: boolean;
    /** Tree view: how a colorless folder row gets its color. `direct` uses tagFolderColor;
     *  `firstChild` inherits the first own-colored descendant in display order,
     *  with tagFolderColor as the fallback for colorless subtrees. @unstable */
    tagFolderColorMode: TagFolderColorMode;
    /** @unstable */
    tagFolderColor: RGB;
    /** @unstable */
    tagSortMode: TagSortMode;
    /** Gap between tag pills (px), shared by flat and tree views via `--tag-gap`. @unstable */
    tagGap: number;
    /** @unstable */
    animateTagReorder: boolean;
    /** @unstable */
    borderDetail: BorderDetail;
    /** @unstable */
    subdivisionDetail: SubdivisionDetail;
    /** @unstable */
    previewAspectRatio: PreviewAspectRatio;
    /** @unstable */
    tagSuggestionLimit: number;
    /** Copy-to-map hotkeys that work in every map (assigned in the copy-to-map dialog);
     *  a map's own binding on the same key shadows them. @unstable */
    globalCopyBindings: MapKeyBinding[];
    /** Local REST transport for window.MMA (Settings > Advanced). @unstable */
    remoteApi: boolean;
    /** @unstable */
    remoteApiKey: string;
    /** @unstable */
    pinnedCommands: PinnedEntry[];
};
export type AppSettings = typeof DEFAULTS;
/** Settings holding private information that should not be exfiltrated. */
declare const PRIVATE_SETTINGS: ReadonlySet<keyof AppSettings>;
/** App settings exposed as CSS custom properties on `:root`. */
declare const CSS_VAR_SETTINGS: ReadonlyArray<readonly [cssVar: string, value: (s: AppSettings) => string]>;
/** localStorage descriptor for the persisted settings object. */
declare const APP_SETTINGS: PersistedStore<{
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
    /** Every distance the UI shows or accepts; stored values stay metric. */
    units: UnitSystem;
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
    /** What the layer opacity hotkeys restore a layer to when toggling it back on. */
    opacityToggleMode: OpacityToggleMode;
    /** Initial color mode for newly drawn polygon selections. Recoloring by hand overrides either mode. */
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
}>;
/** The current app settings snapshot. @unstable */
declare function getSettings(): AppSettings;
/** True while the pano-UI toggle covers the navigation visuals too. @unstable */
declare function navHiddenWithUI(s: AppSettings): boolean;
/** Effective StreetViewPanorama display options derived from the current settings. @unstable */
declare function panoDisplayOptions(s: AppSettings): {
    linksControl: boolean;
    clickToGo: boolean;
    showRoadLabels: boolean;
    scrollwheel: boolean;
};
/** Update one setting and persist. Emits `settings:changed`. @unstable */
declare function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
/** Reset all settings to defaults, preserving global copy bindings. @unstable */
declare function resetSettings(): void;
/** React hook: all settings, re-rendering on any change. @unstable */
declare function useSettings(): AppSettings;
/** React hook: one setting value, re-rendering only when that key changes. @unstable */
declare function useSetting<K extends keyof AppSettings>(key: K): AppSettings[K];

declare const settings_APP_SETTINGS: typeof APP_SETTINGS;
export type settings_AppSettings = AppSettings;
declare const settings_BORDER_ARCHIVE_BYTES: typeof BORDER_ARCHIVE_BYTES;
declare const settings_BORDER_DETAILS: typeof BORDER_DETAILS;
export type settings_BorderDetail = BorderDetail;
declare const settings_CSS_VAR_SETTINGS: typeof CSS_VAR_SETTINGS;
declare const settings_DATE_TIMEZONES: typeof DATE_TIMEZONES;
declare const settings_DEFAULTS: typeof DEFAULTS;
declare const settings_DISCORD_PRESENCE_MODES: typeof DISCORD_PRESENCE_MODES;
export type settings_DateTimezone = DateTimezone;
export type settings_DiscordPresenceMode = DiscordPresenceMode;
declare const settings_EXACT_DATE_FORMATS: typeof EXACT_DATE_FORMATS;
export type settings_ExactDateFormat = ExactDateFormat;
declare const settings_GEOCODE_PROVIDERS: typeof GEOCODE_PROVIDERS;
declare const settings_GEOCODE_PROVIDER_LABELS: typeof GEOCODE_PROVIDER_LABELS;
export type settings_GeocodeProvider = GeocodeProvider;
declare const settings_LANGUAGES: typeof LANGUAGES;
export type settings_Language = Language;
declare const settings_MAP_LIST_FIELDS: typeof MAP_LIST_FIELDS;
declare const settings_MOVEMENT_CYCLE: typeof MOVEMENT_CYCLE;
declare const settings_MOVEMENT_MODES: typeof MOVEMENT_MODES;
export type settings_MapListField = MapListField;
export type settings_MovementMode = MovementMode;
declare const settings_OPACITY_TOGGLE_MODES: typeof OPACITY_TOGGLE_MODES;
export type settings_OpacityToggleMode = OpacityToggleMode;
declare const settings_POLYGON_COLOR_MODES: typeof POLYGON_COLOR_MODES;
declare const settings_PREVIEW_ASPECT_RATIOS: typeof PREVIEW_ASPECT_RATIOS;
declare const settings_PRIVATE_SETTINGS: typeof PRIVATE_SETTINGS;
export type settings_PolygonColorMode = PolygonColorMode;
export type settings_PreviewAspectRatio = PreviewAspectRatio;
declare const settings_SEEN_RESOLUTIONS: typeof SEEN_RESOLUTIONS;
declare const settings_SUBDIVISION_DETAILS: typeof SUBDIVISION_DETAILS;
export type settings_SeenResolution = SeenResolution;
export type settings_SubdivisionDetail = SubdivisionDetail;
declare const settings_TAG_FOLDER_COLOR_MODES: typeof TAG_FOLDER_COLOR_MODES;
declare const settings_TAG_SUGGESTION_LIMITS: typeof TAG_SUGGESTION_LIMITS;
declare const settings_TAG_VIEW_MODES: typeof TAG_VIEW_MODES;
export type settings_TagFolderColorMode = TagFolderColorMode;
export type settings_TagViewMode = TagViewMode;
declare const settings_UNIT_SYSTEMS: typeof UNIT_SYSTEMS;
export type settings_UnitSystem = UnitSystem;
declare const settings_getSettings: typeof getSettings;
declare const settings_navHiddenWithUI: typeof navHiddenWithUI;
declare const settings_panoDisplayOptions: typeof panoDisplayOptions;
declare const settings_resetSettings: typeof resetSettings;
declare const settings_setSetting: typeof setSetting;
declare const settings_useSetting: typeof useSetting;
declare const settings_useSettings: typeof useSettings;
declare namespace settings {
  export { settings_APP_SETTINGS as APP_SETTINGS, settings_BORDER_ARCHIVE_BYTES as BORDER_ARCHIVE_BYTES, settings_BORDER_DETAILS as BORDER_DETAILS, settings_CSS_VAR_SETTINGS as CSS_VAR_SETTINGS, settings_DATE_TIMEZONES as DATE_TIMEZONES, settings_DEFAULTS as DEFAULTS, settings_DISCORD_PRESENCE_MODES as DISCORD_PRESENCE_MODES, settings_EXACT_DATE_FORMATS as EXACT_DATE_FORMATS, settings_GEOCODE_PROVIDERS as GEOCODE_PROVIDERS, settings_GEOCODE_PROVIDER_LABELS as GEOCODE_PROVIDER_LABELS, settings_LANGUAGES as LANGUAGES, settings_MAP_LIST_FIELDS as MAP_LIST_FIELDS, settings_MOVEMENT_CYCLE as MOVEMENT_CYCLE, settings_MOVEMENT_MODES as MOVEMENT_MODES, settings_OPACITY_TOGGLE_MODES as OPACITY_TOGGLE_MODES, settings_POLYGON_COLOR_MODES as POLYGON_COLOR_MODES, settings_PREVIEW_ASPECT_RATIOS as PREVIEW_ASPECT_RATIOS, settings_PRIVATE_SETTINGS as PRIVATE_SETTINGS, settings_SEEN_RESOLUTIONS as SEEN_RESOLUTIONS, settings_SUBDIVISION_DETAILS as SUBDIVISION_DETAILS, settings_TAG_FOLDER_COLOR_MODES as TAG_FOLDER_COLOR_MODES, settings_TAG_SUGGESTION_LIMITS as TAG_SUGGESTION_LIMITS, settings_TAG_VIEW_MODES as TAG_VIEW_MODES, settings_UNIT_SYSTEMS as UNIT_SYSTEMS, settings_getSettings as getSettings, settings_navHiddenWithUI as navHiddenWithUI, settings_panoDisplayOptions as panoDisplayOptions, settings_resetSettings as resetSettings, settings_setSetting as setSetting, settings_useSetting as useSetting, settings_useSettings as useSettings };
  export type { settings_AppSettings as AppSettings, settings_BorderDetail as BorderDetail, settings_DateTimezone as DateTimezone, settings_DiscordPresenceMode as DiscordPresenceMode, settings_ExactDateFormat as ExactDateFormat, settings_GeocodeProvider as GeocodeProvider, settings_Language as Language, settings_MapListField as MapListField, settings_MovementMode as MovementMode, settings_OpacityToggleMode as OpacityToggleMode, settings_PolygonColorMode as PolygonColorMode, settings_PreviewAspectRatio as PreviewAspectRatio, settings_SeenResolution as SeenResolution, settings_SubdivisionDetail as SubdivisionDetail, settings_TagFolderColorMode as TagFolderColorMode, settings_TagViewMode as TagViewMode, settings_UnitSystem as UnitSystem };
}

/** Parsed-but-not-committed import shown while `workArea === "import"`. */
export interface ImportStaging {
    preview: EditorImportPreview;
    source: "file" | "paste";
}
/** The preview marker positions for the staged import. @unstable */
declare function getImportPreviewPositions(): Float32Array<ArrayBufferLike>;
/** The current staged import, or null if none. @unstable */
declare function getImportStaging(): ImportStaging | null;
/** Clear staged import state. @unstable */
declare function resetImportState(): void;
/** Import from a known file path. Used by file picker and drag-and-drop. @unstable */
declare function beginImportFromPath(path: string): Promise<void>;
/** Stage pasted text for preview. Throws if no locations are found. @unstable */
declare function beginImportPaste(text: string): Promise<void>;
/** Commit the staged import, optionally dropping fields and applying a bulk tag. @unstable */
declare function confirmImport(droppedFields: string[], tagName?: string): Promise<EditorImportResult | null>;
/** Discard the staged import without committing. @unstable */
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

/** Whether there are uncommitted changes (adds, removes, or modifications). @unstable */
declare function hasCommitDiff(): boolean;
/** Reset the uncommitted-change counts to zero. @unstable */
declare function resetCommitDiffCounts(): void;
/** React hook: the uncommitted add/remove/modify counts, kept in sync with the store. @unstable */
declare function useCommitDiff(): CommitDiff;
/** Commit-diff preview state shown while `workArea === "diff"`. Position arrays are
 *  interleaved `[lng, lat]` Float32Arrays. */
export interface CommitDiffPreview {
    commitId: string;
    hash: string;
    counts: CommitDiff;
    added: Float32Array;
    removed: Float32Array;
    modified: Float32Array;
}
/** The current commit-diff preview, or null when not previewing. @unstable */
declare function getCommitDiffPreview(): CommitDiffPreview | null;
/** Clear commit-diff preview state. @unstable */
declare function resetCommitDiffState(): void;
/** Pack `[lng, lat]` pairs into an interleaved Float32Array. @unstable */
declare function diffPositions(locs: LatLng[]): Float32Array;
/** Split a commit delta into added / removed / modified. An updated location appears in
 *  both `created` (new) and `removed` (old), keyed by id. @unstable */
declare function categorizeCommitDelta(delta: CommitDelta): {
    added: Location[];
    removed: Location[];
    modified: Location[];
};
/** Fetch a commit's delta and overlay its added/removed/modified locations on the map,
 *  temporarily replacing the regular markers. @unstable */
declare function beginCommitDiffPreview(commit: CommitInfo): Promise<void>;
/** Leave commit-diff preview and restore the regular markers. @unstable */
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
/** Convert a picker choice into the corresponding `Selector`. */
declare function selectorForPick(choice: SelectorPick): Selector;
/** React hook: selector state with live counts. Defaults to the current selection when one
 *  exists, else all locations. Use `createSelectorPick` when non-React code also reads the selector. */
declare function useSelectorPick(initial?: SelectorPick): SelectorPickController;
/** A standalone selector store that can be read from both React and non-React code.
 *  Each `createSelectorPick` call returns an isolated instance. */
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
/** Refresh the map list from disk. */
declare function reloadMapList(): Promise<void>;
/** Refresh the map list and notify other windows of the change. */
declare function invalidateMapList(): Promise<void>;
/** Set the map list directly without a disk read. */
declare function setCachedMapList(list: MapMeta[]): void;
/** Create a new empty map and return its metadata. */
declare function createMap(name: string, folder?: string | null): Promise<MapMeta>;
/** Open the scratch map, creating it on first use. */
declare function openScratchMap(): Promise<void>;
/** Whether `id` belongs to an app fixture rather than a user-created map. */
declare function isReservedMap(id: string | null): boolean;
/** Permanently delete a map and all its data. Not undoable. */
declare function deleteMap$1(id: string): Promise<void>;
/** Rename a folder, moving all its maps to the new name. */
declare function renameFolder(from: string, to: string): Promise<void>;
/** Move a map into a folder, or to the root when `folder` is null. */
declare function moveMapToFolder(mapId: string, folder: string | null): Promise<void>;
/** Delete a folder. Maps in it become unfoldered. */
declare function deleteFolder(name: string): Promise<void>;

declare const mapList_createMap: typeof createMap;
declare const mapList_deleteFolder: typeof deleteFolder;
declare const mapList_getMapList: typeof getMapList;
declare const mapList_invalidateMapList: typeof invalidateMapList;
declare const mapList_isReservedMap: typeof isReservedMap;
declare const mapList_moveMapToFolder: typeof moveMapToFolder;
declare const mapList_openScratchMap: typeof openScratchMap;
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
    mapList_isReservedMap as isReservedMap,
    mapList_moveMapToFolder as moveMapToFolder,
    mapList_openScratchMap as openScratchMap,
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
/** Remove `removed` ids from a session's worklist and reviewed set. Advances the
 *  cursor when the cursor id itself was removed. @unstable */
declare function pruneSession(s: ReviewSession, removed: Set<number>): PruneResult;
/** Mark the current cursor reviewed and step forward. `done` is true when the
 *  session has no remaining items. @unstable */
declare function advance(s: ReviewSession): {
    session: ReviewSession;
    done: boolean;
};
/** Step backward without marking anything reviewed. Null when already at the start. @unstable */
declare function retreat(s: ReviewSession): ReviewSession | null;
/** Position of the session cursor within its review order. @unstable */
declare function reviewIndex(s: ReviewSession): number;
/** Union of reviewed ids across sessions, de-duplicated. Pure (unit-tested). @unstable */
declare function reviewedHistoryIds(sessions: ReviewSession[]): number[];
/** True when the cursor is on the session's first location. @unstable */
declare function isAtStart(s: ReviewSession): boolean;
/** Current cursor location is in the reviewed set. @unstable */
declare function isCurrentReviewed(s: ReviewSession): boolean;
/** Reactive active review session, or null. @unstable */
declare function useReviewSession(): ReviewSession | null;
/** The active review session, or null. @unstable */
declare function getReviewSession(): ReviewSession | null;
/** Start or resume a review over `ids`. When `source` is a selection, re-reviewing
 *  that selection resumes any in-progress session for it. @unstable */
declare function beginReview(ids: number[], source?: Selection): Promise<void>;
/** Resume a session picked from the resume modal. @unstable */
declare function resumeReview(s: ReviewSession): Promise<void>;
/** Mark the current location reviewed and step to the next one. @unstable */
declare function reviewNext(): Promise<void>;
/** Step back to the previous location in the session. @unstable */
declare function reviewPrev(): Promise<void>;
/** Delete the current location and advance to the next one. Exits the pass if it
 *  was the last item. Emits `location:remove`. @unstable */
declare function reviewDelete(): Promise<void>;
/** Exit the review UI but keep the session resumable (persisted as active). @unstable */
declare function cancelReview(): void;
/** Rename a review session. @unstable */
declare function renameReview(id: string, name: string): Promise<void>;
/** Delete a review session (its progress, not the locations). @unstable */
declare function deleteSession(id: string): Promise<void>;
/** Review sessions for the open map, optionally filtered by status. @unstable */
declare function listSessions(status?: "active" | "done"): Promise<ReviewSession[]>;
/** Select every location marked reviewed across all sessions on this map. @unstable */
declare function selectReviewedHistory(): Promise<void>;
/** Add a reviewed or unreviewed overlay selection for a session. @unstable */
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

export type Cmd = typeof commands$1;
/** Every Rust command, typed. Any of them can change in a release. @unstable */
declare const cmd: Cmd;

export type commands_Cmd = Cmd;
declare const commands_cmd: typeof cmd;
declare namespace commands {
  export { commands_cmd as cmd };
  export type { commands_Cmd as Cmd };
}

/** Tauri primitives, handed to plugins as-is. */

declare const shell: {
    Command: typeof Command;
};
declare const dialog: {
    open: typeof open;
    save: typeof save;
};

declare const tauri_dialog: typeof dialog;
declare const tauri_invoke: typeof invoke;
declare const tauri_shell: typeof shell;
declare namespace tauri {
  export {
    tauri_dialog as dialog,
    tauri_invoke as invoke,
    tauri_shell as shell,
  };
}

export interface PluginSettingDef {
    key: string;
    label: string;
    type: "boolean" | "string" | "number";
    default: unknown;
}
/** The fields a plugin shows as itself, declared once by its manifest. */
export type PluginIdentity = Pick<PluginManifest, "id" | "name" | "description" | "icon" | "comingSoon" | "experimental">;
export interface Plugin extends PluginIdentity {
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
/** True when `appVersion` meets the plugin's minimum version requirement. @unstable */
declare function isPluginCompatible(minAppVersion: string | null | undefined, appVersion: string): boolean;
/** True when a newer version is published and the installed version is known. @unstable */
declare function isPluginUpdatable(installedVersion: string | undefined, latestVersion: string | undefined): boolean;
/** True when either the plugin or its sidecar has a newer published version. @unstable */
declare function needsUpdate(installedVersion: string | undefined, latestVersion: string | undefined, installedSidecarVersion: string | null | undefined, latestSidecarVersion: string | undefined): boolean;
/** The build of a plugin to install. `ref` is the commit, null for the latest. */
export interface ResolvedBuild {
    version: string;
    ref: string | null;
    minAppVersion: string | null;
}
/** The newest build of a plugin this app version can run. Falls back through older
 *  pinned builds when the latest is incompatible. Null when none fit. @unstable */
declare function resolveBuild(entry: PluginManifest, appVersion: string): ResolvedBuild | null;
/** True when the installed plugin should be refreshed to `target`. @unstable */
declare function needsBuildUpdate(installedVersion: string | undefined, target: ResolvedBuild, installedSidecarVersion: string | null | undefined, latestSidecarVersion: string | undefined): boolean;
/** Fetch the marketplace plugin registry (cached for the session). @unstable */
declare function fetchPluginRegistry(): Promise<PluginManifest[]>;
/** Auto-update a plugin to the newest compatible build before loading it. Falls back
 *  to what is on disk on failure. @unstable */
declare function autoUpdatePlugin(m: PluginManifest, latest: PluginManifest | undefined, appVersion: string): Promise<PluginManifest>;
/** Set the manifest used to fill identity fields on the next `registerPlugin` call. @unstable */
declare function setPendingManifest(manifest: PluginManifest | null): void;
/** Register a plugin. `activate` runs when a map opens; its returned cleanup runs on map close. */
declare function registerPlugin(plugin: Plugin | PluginBehavior): void;
/** All registered plugins, sorted by name. */
declare function getPlugins(): Plugin[];
/** Look up a registered plugin by id. */
declare function getPlugin(id: string): Plugin | undefined;
/** True when the plugin contributes data only and has no UI surfaces. */
declare function isBackgroundPlugin(id: string): boolean;
/** Remove a plugin from the registry. @unstable */
declare function unregisterPlugin(id: string): void;
/** True when the plugin is enabled by the user. */
declare function isPluginEnabled(id: string): boolean;
/** Enable or disable a plugin. */
declare function setPluginEnabled(id: string, enabled: boolean): void;
/** All registered plugins the user has enabled. */
declare function getEnabledPlugins(): Plugin[];
export interface PluginStorage {
    get<T = unknown>(key: string, fallback?: T): T;
    set(key: string, value: unknown): void;
    remove(key: string): void;
    keys(): string[];
}
/** Persistent key-value storage namespaced to a plugin. Survives restarts. */
declare function createPluginStorage(id: string): PluginStorage;
/** React state hook backed by the plugin's persistent store. Survives sidebar
 *  unmount and app restart. Values are global, not per-map. */
declare function usePluginState<T>(pluginId: string, key: string, initial: T | (() => T)): readonly [T, (action: SetStateAction<T>) => void];
/** Read a plugin's declared setting value, falling back to the setting's default. */
declare function getPluginSetting<T = unknown>(plugin: Plugin, key: string): T;
/** Write a plugin's declared setting value. */
declare function setPluginSetting(id: string, key: string, value: unknown): void;
/** Activate all enabled plugins. Called when a map opens. @unstable */
declare function activatePlugins(): void;
/** Deactivate all plugins and stop their sidecars. Called when a map closes. @unstable */
declare function deactivatePlugins(): void;
/** Activate a single plugin by id. @unstable */
declare function activatePlugin(id: string): void;
/** Deactivate a single plugin and stop its sidecar. @unstable */
declare function deactivatePlugin(id: string): void;
/** The per-plugin key-value store, under the name the surface uses. */
declare const storage: typeof createPluginStorage;
/** True once the MMA surface is installed and plugins are safe to call it. */
declare function isReady(): boolean;
/** Mark the plugin surface as ready. @unstable */
declare function markReady(): void;

export type registry_Plugin = Plugin;
export type registry_PluginBehavior = PluginBehavior;
export type registry_PluginIdentity = PluginIdentity;
export type registry_PluginSettingDef = PluginSettingDef;
export type registry_PluginStorage = PluginStorage;
export type registry_ResolvedBuild = ResolvedBuild;
declare const registry_activatePlugin: typeof activatePlugin;
declare const registry_activatePlugins: typeof activatePlugins;
declare const registry_autoUpdatePlugin: typeof autoUpdatePlugin;
declare const registry_createPluginStorage: typeof createPluginStorage;
declare const registry_deactivatePlugin: typeof deactivatePlugin;
declare const registry_deactivatePlugins: typeof deactivatePlugins;
declare const registry_fetchPluginRegistry: typeof fetchPluginRegistry;
declare const registry_getEnabledPlugins: typeof getEnabledPlugins;
declare const registry_getPlugin: typeof getPlugin;
declare const registry_getPluginSetting: typeof getPluginSetting;
declare const registry_getPlugins: typeof getPlugins;
declare const registry_isBackgroundPlugin: typeof isBackgroundPlugin;
declare const registry_isPluginCompatible: typeof isPluginCompatible;
declare const registry_isPluginEnabled: typeof isPluginEnabled;
declare const registry_isPluginUpdatable: typeof isPluginUpdatable;
declare const registry_isReady: typeof isReady;
declare const registry_markReady: typeof markReady;
declare const registry_needsBuildUpdate: typeof needsBuildUpdate;
declare const registry_needsUpdate: typeof needsUpdate;
declare const registry_registerPlugin: typeof registerPlugin;
declare const registry_resolveBuild: typeof resolveBuild;
declare const registry_setPendingManifest: typeof setPendingManifest;
declare const registry_setPluginEnabled: typeof setPluginEnabled;
declare const registry_setPluginSetting: typeof setPluginSetting;
declare const registry_storage: typeof storage;
declare const registry_unregisterPlugin: typeof unregisterPlugin;
declare const registry_usePluginState: typeof usePluginState;
declare namespace registry {
  export { registry_activatePlugin as activatePlugin, registry_activatePlugins as activatePlugins, registry_autoUpdatePlugin as autoUpdatePlugin, registry_createPluginStorage as createPluginStorage, registry_deactivatePlugin as deactivatePlugin, registry_deactivatePlugins as deactivatePlugins, registry_fetchPluginRegistry as fetchPluginRegistry, registry_getEnabledPlugins as getEnabledPlugins, registry_getPlugin as getPlugin, registry_getPluginSetting as getPluginSetting, registry_getPlugins as getPlugins, registry_isBackgroundPlugin as isBackgroundPlugin, registry_isPluginCompatible as isPluginCompatible, registry_isPluginEnabled as isPluginEnabled, registry_isPluginUpdatable as isPluginUpdatable, registry_isReady as isReady, registry_markReady as markReady, registry_needsBuildUpdate as needsBuildUpdate, registry_needsUpdate as needsUpdate, registry_registerPlugin as registerPlugin, registry_resolveBuild as resolveBuild, registry_setPendingManifest as setPendingManifest, registry_setPluginEnabled as setPluginEnabled, registry_setPluginSetting as setPluginSetting, registry_storage as storage, registry_unregisterPlugin as unregisterPlugin, registry_usePluginState as usePluginState };
  export type { registry_Plugin as Plugin, registry_PluginBehavior as PluginBehavior, registry_PluginIdentity as PluginIdentity, registry_PluginSettingDef as PluginSettingDef, registry_PluginStorage as PluginStorage, registry_ResolvedBuild as ResolvedBuild };
}

export interface SelectionBitmaskPayload {
    selColors: RGB[];
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
    "map:open": MapMeta;
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

export type Disposable = () => void;
/** Run `fn` as plugin `id`. Registrations made during `fn` are tracked for teardown. @unstable */
declare function runAsPlugin<T>(id: string, fn: () => T): T;
/** Enroll a teardown callback under the current plugin. No-op outside activation. @unstable */
declare function trackDisposable(dispose: Disposable): void;
/** Set the base directory for a plugin's assets on disk. @unstable */
declare function setPluginBaseDir(id: string, dir: string): void;
/** Resolve a relative path against the current plugin's base directory. Absolute
 *  paths and `res://` URLs pass through unchanged. @unstable */
declare function resolvePluginPath(path: string): string;
/** Run all teardowns a plugin registered (in reverse order) and clear them. @unstable */
declare function disposePlugin(id: string): void;
/** Subscribe to an editor event, automatically unsubscribed on plugin deactivation. */
declare function on<E extends EditorEvent>(event: E, handler: EventHandler<E>): () => void;

declare const scope_disposePlugin: typeof disposePlugin;
declare const scope_on: typeof on;
declare const scope_resolvePluginPath: typeof resolvePluginPath;
declare const scope_runAsPlugin: typeof runAsPlugin;
declare const scope_setPluginBaseDir: typeof setPluginBaseDir;
declare const scope_trackDisposable: typeof trackDisposable;
declare namespace scope {
  export {
    scope_disposePlugin as disposePlugin,
    scope_on as on,
    scope_resolvePluginPath as resolvePluginPath,
    scope_runAsPlugin as runAsPlugin,
    scope_setPluginBaseDir as setPluginBaseDir,
    scope_trackDisposable as trackDisposable,
  };
}

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

declare const externals_getAvailableExternals: typeof getAvailableExternals;
declare const externals_mmaRequire: typeof mmaRequire;
declare const externals_preloadModules: typeof preloadModules;
declare namespace externals {
  export {
    externals_getAvailableExternals as getAvailableExternals,
    externals_mmaRequire as mmaRequire,
    externals_preloadModules as preloadModules,
  };
}

export interface SidecarOptions<T> {
    /** Fires once per JSON object the sidecar emits, in order. */
    onLine?(item: T): void;
    /** Sidecar diagnostic output, one-shot runs only. */
    onLog?(line: string): void;
    signal?: AbortSignal;
}
/** Send a command to a plugin's sidecar and resolve with its last emitted JSON
 *  object (null if it emitted none). `payload` is sent as JSON. */
declare function request<T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T>): Promise<T | null>;
/** The sidecar version installed for a plugin, or null when it has none yet. */
declare function installedVersion(pluginId: string): Promise<string | null>;
/** The nested `sidecar` namespace on the plugin surface. */
declare const sidecar: {
    request: typeof request;
    installedVersion: typeof installedVersion;
};

export type sidecar$1_SidecarOptions<T> = SidecarOptions<T>;
declare const sidecar$1_installedVersion: typeof installedVersion;
declare const sidecar$1_request: typeof request;
declare const sidecar$1_sidecar: typeof sidecar;
declare namespace sidecar$1 {
  export { sidecar$1_installedVersion as installedVersion, sidecar$1_request as request, sidecar$1_sidecar as sidecar };
  export type { sidecar$1_SidecarOptions as SidecarOptions };
}

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
    code: string | null;
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
    /** Extra search terms, e.g. the option labels of a select control. */
    keywords?: string[];
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

declare const primitives_Button: typeof Button;
declare const primitives_Checkbox: typeof Checkbox;
declare const primitives_ColorPicker: typeof ColorPicker;
declare const primitives_DatePicker: typeof DatePicker;
declare const primitives_Dialog: typeof Dialog;
declare const primitives_DialogContent: typeof DialogContent;
export type primitives_DialogProps = DialogProps;
declare const primitives_DialogTrigger: typeof DialogTrigger;
declare const primitives_EmptyState: typeof EmptyState;
declare const primitives_Field: typeof Field;
declare const primitives_Flag: typeof Flag;
declare const primitives_HotkeyInput: typeof HotkeyInput;
declare const primitives_Icon: typeof Icon;
declare const primitives_NSelect: typeof NSelect;
declare const primitives_Radio: typeof Radio;
declare const primitives_RgbPicker: typeof RgbPicker;
declare const primitives_Section: typeof Section;
declare const primitives_SegmentedControl: typeof SegmentedControl;
export type primitives_SegmentedOption<T extends string | number> = SegmentedOption<T>;
declare const primitives_SelectorPicker: typeof SelectorPicker;
declare const primitives_SettingRow: typeof SettingRow;
declare const primitives_Sidebar: typeof Sidebar;
declare const primitives_Slider: typeof Slider;
declare const primitives_SuggestInput: typeof SuggestInput;
declare const primitives_Switch: typeof Switch;
declare const primitives_SwitchRow: typeof SwitchRow;
declare const primitives_TagPill: typeof TagPill;
declare const primitives_TagPillButton: typeof TagPillButton;
declare const primitives_TextInput: typeof TextInput;
declare const primitives_ToolBlock: typeof ToolBlock;
declare const primitives_Tooltip: typeof Tooltip;
declare const primitives_useCloseDialog: typeof useCloseDialog;
declare namespace primitives {
  export { primitives_Button as Button, primitives_Checkbox as Checkbox, primitives_ColorPicker as ColorPicker, primitives_DatePicker as DatePicker, primitives_Dialog as Dialog, primitives_DialogContent as DialogContent, primitives_DialogTrigger as DialogTrigger, primitives_EmptyState as EmptyState, primitives_Field as Field, primitives_Flag as Flag, primitives_HotkeyInput as HotkeyInput, primitives_Icon as Icon, primitives_NSelect as NSelect, primitives_Radio as Radio, primitives_RgbPicker as RgbPicker, primitives_Section as Section, primitives_SegmentedControl as SegmentedControl, primitives_SelectorPicker as SelectorPicker, primitives_SettingRow as SettingRow, primitives_Sidebar as Sidebar, primitives_Slider as Slider, primitives_SuggestInput as SuggestInput, primitives_Switch as Switch, primitives_SwitchRow as SwitchRow, primitives_TagPill as TagPill, primitives_TagPillButton as TagPillButton, primitives_TextInput as TextInput, primitives_ToolBlock as ToolBlock, primitives_Tooltip as Tooltip, primitives_useCloseDialog as useCloseDialog };
  export type { primitives_DialogProps as DialogProps, primitives_SegmentedOption as SegmentedOption };
}

/** The nested `ui` namespace on the plugin surface: the primitives module and nothing else. */
declare const ui: typeof primitives;

declare const uiSurface_ui: typeof ui;
declare namespace uiSurface {
  export {
    uiSurface_ui as ui,
  };
}

export interface EnrichFieldOption {
    key: string;
    label: string;
    /** Excluded from the default field set (null enrichFields); user must opt in. */
    defaultOff?: boolean;
}
/** Build field definitions for well-known keys (e.g. `"altitude"`, `"countryCode"`). */
declare function knownFieldDefs(...keys: string[]): Record<string, ExtraFieldDef>;
/** All enrichment field options (core and plugin-registered). */
declare function getEnrichFieldOptions(): EnrichFieldOption[];
/** Offer extra fields in the enrichment UI. Unregistered when the plugin deactivates. */
declare function registerEnrichFields(fields: EnrichFieldOption[]): void;
/** All enrichment field keys (core and plugin-registered). */
declare function getAllEnrichKeys(): string[];
/** Keys enriched when enrichFields is null (the default set: all options except defaultOff ones). */
declare function getDefaultEnrichKeys(): string[];
/** A unit of work for the procedure engine: which module to run, and how. */
export interface ProcedureSpec<TCollected = unknown> {
    /** Phantom field carrying the `TCollected` type. Never set at runtime. */
    readonly collects?: TCollected;
    /** Module entry point: absolute path, `res://procedures/<name>.js` for built-in
     *  procedures, or a relative filename (resolved against the plugin's directory). */
    entry: string;
    /** Rows the engine feeds the procedure. Omitted, the driver supplies its own. */
    select?: Selector;
    batch: BatchMode;
    /** Where answers go: `patch` writes to locations (default), `collect` returns them
     *  to the caller. */
    sink?: Sink;
    rate?: RateSpec;
    retry?: {
        attempts: number;
        on: number[];
    };
    /** Maximum concurrent in-flight requests across all instances. */
    inflight?: number;
    /** Maximum concurrent procedure instances. */
    instances?: number;
    /** Provider-specific configuration passed to the procedure module. */
    config?: unknown;
    /** Awaited before the provider joins a run; returning false excludes it. */
    prepare?: () => Promise<boolean>;
}
/** A named procedure with dependency-graph placement. Providers that declare
 *  `fieldDefs` are enrichment providers whose fields appear in the enrichment UI. */
export interface Provider {
    id: string;
    /** Bulk progress label for slow providers; omit for instant ones. */
    label?: string;
    /** The procedure that computes this provider's fields. */
    procedure: ProcedureSpec;
    /** Extra-field keys this provider produces. */
    fieldDefs?: Record<string, ExtraFieldDef>;
    /** Core columns this provider writes (e.g. `panoId`). */
    provides?: string[];
    /** Fields this provider reads; it runs after their producers finish. */
    requires?: string[];
}
/** Register a provider (e.g. a plugin's sun position). Unregistered when the plugin
 *  deactivates. */
declare function registerProvider(provider: Provider): void;
/** All registered providers. */
declare function getProviders(): Provider[];
/** The provider that produces a given extra field, if any. */
declare function getProviderForField(field: string): Provider | undefined;
/** True when `key` is in the given enrichment set (or in the default set when null). */
declare function isFieldEnabled(enrichFields: string[] | null, key: string): boolean;
/** Every field transitively derived from the `changed` keys via the provider graph. */
declare function derivedFrom(changed: Iterable<string>): Set<string>;
/** Remove fields transitively derived from `changed` from an `extra` record. */
declare function withoutDerivedFrom(extra: Record<string, unknown> | null, changed: Iterable<string>): Record<string, unknown> | null;

export type fieldDefs_EnrichFieldOption = EnrichFieldOption;
export type fieldDefs_ProcedureSpec<TCollected = unknown> = ProcedureSpec<TCollected>;
export type fieldDefs_Provider = Provider;
declare const fieldDefs_derivedFrom: typeof derivedFrom;
declare const fieldDefs_getAllEnrichKeys: typeof getAllEnrichKeys;
declare const fieldDefs_getDefaultEnrichKeys: typeof getDefaultEnrichKeys;
declare const fieldDefs_getEnrichFieldOptions: typeof getEnrichFieldOptions;
declare const fieldDefs_getProviderForField: typeof getProviderForField;
declare const fieldDefs_getProviders: typeof getProviders;
declare const fieldDefs_isFieldEnabled: typeof isFieldEnabled;
declare const fieldDefs_knownFieldDefs: typeof knownFieldDefs;
declare const fieldDefs_registerEnrichFields: typeof registerEnrichFields;
declare const fieldDefs_registerProvider: typeof registerProvider;
declare const fieldDefs_withoutDerivedFrom: typeof withoutDerivedFrom;
declare namespace fieldDefs {
  export { fieldDefs_derivedFrom as derivedFrom, fieldDefs_getAllEnrichKeys as getAllEnrichKeys, fieldDefs_getDefaultEnrichKeys as getDefaultEnrichKeys, fieldDefs_getEnrichFieldOptions as getEnrichFieldOptions, fieldDefs_getProviderForField as getProviderForField, fieldDefs_getProviders as getProviders, fieldDefs_isFieldEnabled as isFieldEnabled, fieldDefs_knownFieldDefs as knownFieldDefs, fieldDefs_registerEnrichFields as registerEnrichFields, fieldDefs_registerProvider as registerProvider, fieldDefs_withoutDerivedFrom as withoutDerivedFrom };
  export type { fieldDefs_EnrichFieldOption as EnrichFieldOption, fieldDefs_ProcedureSpec as ProcedureSpec, fieldDefs_Provider as Provider };
}

/** True when `key` is a built-in Location field (stored top-level, not under `extra`). */
declare function isBuiltinField(key: string): boolean;
declare function isWritableField(key: string): boolean;
/** True when the field can be bulk-cleared. */
declare function isClearableField(key: string): boolean;
/** True when the field should appear in field pickers. */
declare function isListableField(key: string): boolean;
/** All built-in field keys (excluding virtual). */
declare function getBuiltinKeys(): string[];
/** Register field definitions from an enrichment provider (called at activation). */
declare function registerPluginFieldDefs(defs: Record<string, ExtraFieldDef>): void;
/** Remove plugin field definitions by key (called when a plugin is deactivated). */
declare function unregisterPluginFieldDefs(keys: string[]): void;
/** Keys some location on this map carries. Same reference until the user layer moves. */
declare const getKnownFieldKeys: () => ReadonlySet<string>;
/** Look up metadata for a field key. Returns `undefined` if no layer declares it. */
declare function getFieldDef(key: string): ExtraFieldDef | undefined;
/** Display label for a field key, falling back to a sentence-cased version of the key. */
declare function fieldLabel(key: string): string;
/** Display label for a field value. Enum values use their translated display name. */
declare function fieldValueLabel(def: ExtraFieldDef | undefined, value: unknown): string;
/** Merged view of all field definitions across all layers. */
declare function getAllFieldDefs(): Record<string, ExtraFieldDef>;
export interface FieldProjection {
    id: string;
    label: string;
    /** True when this projection uses the location's timezone. */
    needsTz: boolean;
}
/** Projections valid for a field type, in display order (first = dialog default). */
declare function projectionsForType(type: ExtraFieldType): FieldProjection[];
/** The "Range" partition option (numeric binning). */
declare const RANGE_ID = "range";
/** Partition-key dropdown options for a field type. */
declare function partitionKeyOptions(type: ExtraFieldType, rangeForDates: boolean): {
    id: string;
    label: string;
}[];

export type fieldDefRegistry_FieldProjection = FieldProjection;
declare const fieldDefRegistry_RANGE_ID: typeof RANGE_ID;
declare const fieldDefRegistry_fieldLabel: typeof fieldLabel;
declare const fieldDefRegistry_fieldValueLabel: typeof fieldValueLabel;
declare const fieldDefRegistry_getAllFieldDefs: typeof getAllFieldDefs;
declare const fieldDefRegistry_getBuiltinKeys: typeof getBuiltinKeys;
declare const fieldDefRegistry_getFieldDef: typeof getFieldDef;
declare const fieldDefRegistry_getKnownFieldKeys: typeof getKnownFieldKeys;
declare const fieldDefRegistry_isBuiltinField: typeof isBuiltinField;
declare const fieldDefRegistry_isClearableField: typeof isClearableField;
declare const fieldDefRegistry_isListableField: typeof isListableField;
declare const fieldDefRegistry_isWritableField: typeof isWritableField;
declare const fieldDefRegistry_partitionKeyOptions: typeof partitionKeyOptions;
declare const fieldDefRegistry_projectionsForType: typeof projectionsForType;
declare const fieldDefRegistry_registerPluginFieldDefs: typeof registerPluginFieldDefs;
declare const fieldDefRegistry_unregisterPluginFieldDefs: typeof unregisterPluginFieldDefs;
declare namespace fieldDefRegistry {
  export { fieldDefRegistry_RANGE_ID as RANGE_ID, fieldDefRegistry_fieldLabel as fieldLabel, fieldDefRegistry_fieldValueLabel as fieldValueLabel, fieldDefRegistry_getAllFieldDefs as getAllFieldDefs, fieldDefRegistry_getBuiltinKeys as getBuiltinKeys, fieldDefRegistry_getFieldDef as getFieldDef, fieldDefRegistry_getKnownFieldKeys as getKnownFieldKeys, fieldDefRegistry_isBuiltinField as isBuiltinField, fieldDefRegistry_isClearableField as isClearableField, fieldDefRegistry_isListableField as isListableField, fieldDefRegistry_isWritableField as isWritableField, fieldDefRegistry_partitionKeyOptions as partitionKeyOptions, fieldDefRegistry_projectionsForType as projectionsForType, fieldDefRegistry_registerPluginFieldDefs as registerPluginFieldDefs, fieldDefRegistry_unregisterPluginFieldDefs as unregisterPluginFieldDefs };
  export type { fieldDefRegistry_FieldProjection as FieldProjection };
}

/** Entry point of a procedure this app bundles. Plugins ship their own paths. */
declare const procedureEntry: (name: string) => string;
/** Ask a procedure a read-only question. Rejects when the procedure exports no `query`,
 *  when the call fails, or when `signal` aborts. */
declare function queryProcedure<T = unknown>(entry: string, input: unknown, config?: unknown, signal?: AbortSignal): Promise<T>;
/** Display labels for a field's partition keys. Falls back to the keys themselves when
 *  the field's procedure has no `label` query or returns a non-matching array. */
declare function resolveFieldLabels(field: string, keys: string[]): Promise<string[]>;
/** One location's answer from a `collect` run. */
export interface CollectedEntry<T = unknown> {
    id: number;
    value: T;
}
export interface BatchOutcome {
    /** Count of rows the procedure processed successfully. */
    succeeded: number;
    /** IDs of rows the procedure failed on. */
    failed: number[];
}
export interface ProcedureOutcome<TCollected = unknown> extends BatchOutcome {
    /** Answers from a `collect` run, in page order. Absent when results were written as patches. */
    collected?: CollectedEntry<TCollected>[];
}
/** Every declaration a run scheduled, by provider id. */
export type ProviderOutcomes = Record<string, ProcedureOutcome>;
declare const noWork: () => BatchOutcome;
/** One provider's own progress. Counts are net of skipped rows. */
export interface ProviderPart {
    label: string;
    done: number;
    total: number;
    failed: number;
    finished: boolean;
}
export interface RunOpts {
    signal?: AbortSignal;
    force?: boolean;
    /** `done`/`total` reflect the slowest provider. `parts` carries each labeled
     *  provider's own counts, ordered as declared. */
    onProgress?: (done: number, total: number, parts: ProviderPart[]) => void;
    /** Each row as a provider finishes with it (rows-only runs). The same row arrives
     *  again from each subsequent provider. */
    onPartial?: (rows: Location[]) => void;
}
export type BulkOpts = Pick<RunOpts, "signal" | "onProgress">;
/** A provider to run, optionally overriding the config its procedure declares. */
export interface ProviderRun {
    provider: Provider;
    config?: unknown;
    /** Re-derive this provider's fields even on an unforced run. For an operation whose
     *  point is to recompute one provider rather than fill in what is missing. */
    force?: boolean;
    /** The `fieldDefs` keys to produce; omitted, every key it declares. */
    fields?: string[];
}
/** Run a set of providers over `rows`. When `rows` is a Selector, matching locations
 *  are processed in place and results are written back. When `rows` is a Location array,
 *  locations are processed independently and returned as modified copies. Resolves once
 *  every provider finishes, or on abort. */
declare function runProviders(items: ProviderRun[], rows: Selector, opts?: RunOpts): Promise<ProviderOutcomes>;
declare function runProviders(items: ProviderRun[], rows: Location[], opts?: RunOpts): Promise<RowsRun>;
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
    invalidates?: Record<string, string[]>;
}
/** Run a single procedure over `selector` and return its typed results. @unstable */
declare function runProcedure<T>(spec: ProcedureSpec<T>, selector: Selector, opts: Omit<RunOpts, "force"> & Omit<DeclOpts, "fields" | "requires"> & {
    id: string;
}): Promise<ProcedureOutcome<T>>;

export type procedures_BatchOutcome = BatchOutcome;
export type procedures_BulkOpts = BulkOpts;
export type procedures_CollectedEntry<T = unknown> = CollectedEntry<T>;
export type procedures_ProcedureOutcome<TCollected = unknown> = ProcedureOutcome<TCollected>;
export type procedures_ProviderOutcomes = ProviderOutcomes;
export type procedures_ProviderPart = ProviderPart;
export type procedures_ProviderRun = ProviderRun;
export type procedures_RunOpts = RunOpts;
declare const procedures_noWork: typeof noWork;
declare const procedures_procedureEntry: typeof procedureEntry;
declare const procedures_queryProcedure: typeof queryProcedure;
declare const procedures_resolveFieldLabels: typeof resolveFieldLabels;
declare const procedures_runProcedure: typeof runProcedure;
declare const procedures_runProviders: typeof runProviders;
declare namespace procedures {
  export { procedures_noWork as noWork, procedures_procedureEntry as procedureEntry, procedures_queryProcedure as queryProcedure, procedures_resolveFieldLabels as resolveFieldLabels, procedures_runProcedure as runProcedure, procedures_runProviders as runProviders };
  export type { procedures_BatchOutcome as BatchOutcome, procedures_BulkOpts as BulkOpts, procedures_CollectedEntry as CollectedEntry, procedures_ProcedureOutcome as ProcedureOutcome, procedures_ProviderOutcomes as ProviderOutcomes, procedures_ProviderPart as ProviderPart, procedures_ProviderRun as ProviderRun, procedures_RunOpts as RunOpts };
}

export interface GeoDisplay {
    address: string;
    countryCode: string | null;
}

export type PendingEntryLocation = RequireNonNull<Pick<Location, "lat" | "lng" | "panoId">> & Nullable<Rename<Pick<Location, "id">, {
    id: "locationId";
}>>;
/** Suppress the next seen-history entry for `panoId`. */
declare function seenSkipNext(panoId: string): void;
/** Update the pending seen entry's geocode info (country, address). */
declare function seenUpdateGeo(geo: GeoDisplay): void;
/** Record a panorama change for the seen history. Flushes the previous entry and stages the new one. */
declare function seenPanoChanged(location: PendingEntryLocation, geo: GeoDisplay | null, getPov: () => LocationPOV): void;
/** Write the pending seen entry to disk, if any. */
declare function seenFlush(getPov: () => LocationPOV): void;
/** Fetch a page of the seen (visited-panorama) history. */
declare function getSeenEntries(limit?: number, offset?: number, filter?: SeenFilter, thumbnails?: boolean): Promise<SeenEntry[]>;
/** Number of seen entries matching the filter (all when omitted). */
declare function getSeenCount(filter?: SeenFilter): Promise<number>;
/** Distinct country codes that appear in the seen history. */
declare function getSeenCountries(): Promise<string[]>;
/** Maps that have seen-history entries. */
declare function getSeenMaps(): Promise<SeenMapInfo[]>;
/** Delete the entire seen history. Not undoable. */
declare function clearSeen(): Promise<void>;

declare const seen_clearSeen: typeof clearSeen;
declare const seen_getSeenCount: typeof getSeenCount;
declare const seen_getSeenCountries: typeof getSeenCountries;
declare const seen_getSeenEntries: typeof getSeenEntries;
declare const seen_getSeenMaps: typeof getSeenMaps;
declare const seen_seenFlush: typeof seenFlush;
declare const seen_seenPanoChanged: typeof seenPanoChanged;
declare const seen_seenSkipNext: typeof seenSkipNext;
declare const seen_seenUpdateGeo: typeof seenUpdateGeo;
declare namespace seen {
  export {
    seen_clearSeen as clearSeen,
    seen_getSeenCount as getSeenCount,
    seen_getSeenCountries as getSeenCountries,
    seen_getSeenEntries as getSeenEntries,
    seen_getSeenMaps as getSeenMaps,
    seen_seenFlush as seenFlush,
    seen_seenPanoChanged as seenPanoChanged,
    seen_seenSkipNext as seenSkipNext,
    seen_seenUpdateGeo as seenUpdateGeo,
  };
}

/** The app-wide Street View panorama instance, null until first created. */
declare let singletonPano: google.maps.StreetViewPanorama | null;
/** The DOM container for the singleton Street View panorama. */
declare const singletonDiv: HTMLDivElement;
/** Return the singleton Street View panorama, creating it on first call. @unstable */
declare function getPanorama(): google.maps.StreetViewPanorama | null;
/** The live viewer's camera in the stored zoom domain. Zeroed if there is no viewer. @unstable */
declare function capturePov(): LocationPOV;
/** Read the live viewer back into Location fields, the inverse of {@link applyResolved}.
 *  Null until the viewer has a position. @unstable */
declare function capturePano(): PanoCapture | null;
/** Hide and release the singleton panorama. @unstable */
declare function clearSingletonPano(): void;
/** Point the viewer at a resolved panorama for `loc`, setting its position, POV, and zoom. @unstable */
declare function applyResolved(sv: google.maps.StreetViewPanorama, resolved: Pano | null, loc: Location): void;
/** Open a seen entry's panorama in the Street View viewer. @unstable */
declare function loadSeenPano(entry: SeenEntry): Promise<void>;

declare const panoSingleton_applyResolved: typeof applyResolved;
declare const panoSingleton_capturePano: typeof capturePano;
declare const panoSingleton_capturePov: typeof capturePov;
declare const panoSingleton_clearSingletonPano: typeof clearSingletonPano;
declare const panoSingleton_getPanorama: typeof getPanorama;
declare const panoSingleton_loadSeenPano: typeof loadSeenPano;
declare const panoSingleton_singletonDiv: typeof singletonDiv;
declare const panoSingleton_singletonPano: typeof singletonPano;
declare namespace panoSingleton {
  export {
    panoSingleton_applyResolved as applyResolved,
    panoSingleton_capturePano as capturePano,
    panoSingleton_capturePov as capturePov,
    panoSingleton_clearSingletonPano as clearSingletonPano,
    panoSingleton_getPanorama as getPanorama,
    panoSingleton_loadSeenPano as loadSeenPano,
    panoSingleton_singletonDiv as singletonDiv,
    panoSingleton_singletonPano as singletonPano,
  };
}

/** Enrich a single location with the map's enabled metadata fields. Existing fields are
 *  kept unless `force` re-derives all of them. Returns the enriched location without
 *  writing it. Returns the location unchanged when enrichment is disabled. */
declare function enrich(loc: Location, opts?: Omit<RunOpts, "onProgress">): Promise<Location>;
/** Build the provider run list for enrichment, narrowed to `enrichFields`. Fields not
 *  offered in the enrichment settings are always included. */
declare function enrichRuns(enrichFields: string[] | null, exclude?: string[]): ProviderRun[];
/** Configuration for panorama resolution (search radius). */
export interface PanoResolveConfig {
    radius: number;
}
/** Resolve a pano id from coordinates. Rows that already have a pano id are skipped
 *  unless the run is forced. */
declare const panoResolveSpec: ProcedureSpec<{
    panoId: string;
}>;
/** Pano-resolve provider for enrichment. Writes the `panoId` field and runs before
 *  any provider that depends on it. */
declare const panoResolveProvider: Provider;
/** Exact capture timestamp, narrowed from the `imageDate` month via binary search. */
declare const exactDateProvider: Provider;
/** Timezone at the location's coordinates. Requires `datetime` to be present. */
declare const timezoneProvider: Provider;
/** Subdivision (adm1) via offline point-in-polygon against the local border dataset.
 *  No Google dependency; downloads the adm1 archive on first use. */
declare const subdivisionProvider: Provider;
/** Core panorama metadata via Google's GetMetadata RPC. */
declare const svMetaProvider: Provider;
/** One summary row per pass that did work: the core metadata pass, then every
 *  provider that updated or failed at least one location. */
export interface EnrichOutcome extends ProcedureOutcome {
    id: string;
    label: string;
}
/** Bulk-enrich a selector: resolve missing pano ids, then run every field-producing
 *  provider (metadata, exact date, timezone, subdivision). */
declare function enrichAll(selector: Selector, opts?: RunOpts): Promise<EnrichOutcome[]>;

export type enrich$1_EnrichOutcome = EnrichOutcome;
export type enrich$1_PanoResolveConfig = PanoResolveConfig;
declare const enrich$1_enrich: typeof enrich;
declare const enrich$1_enrichAll: typeof enrichAll;
declare const enrich$1_enrichRuns: typeof enrichRuns;
declare const enrich$1_exactDateProvider: typeof exactDateProvider;
declare const enrich$1_panoResolveProvider: typeof panoResolveProvider;
declare const enrich$1_panoResolveSpec: typeof panoResolveSpec;
declare const enrich$1_subdivisionProvider: typeof subdivisionProvider;
declare const enrich$1_svMetaProvider: typeof svMetaProvider;
declare const enrich$1_timezoneProvider: typeof timezoneProvider;
declare namespace enrich$1 {
  export { enrich$1_enrich as enrich, enrich$1_enrichAll as enrichAll, enrich$1_enrichRuns as enrichRuns, enrich$1_exactDateProvider as exactDateProvider, enrich$1_panoResolveProvider as panoResolveProvider, enrich$1_panoResolveSpec as panoResolveSpec, enrich$1_subdivisionProvider as subdivisionProvider, enrich$1_svMetaProvider as svMetaProvider, enrich$1_timezoneProvider as timezoneProvider };
  export type { enrich$1_EnrichOutcome as EnrichOutcome, enrich$1_PanoResolveConfig as PanoResolveConfig };
}

/** Configuration for the pin-to-pano operation. */
export interface PinPanoConfig {
    useLatest?: boolean;
}
/** Pin to pano ID: set the LoadAsPanoId flag so the location always loads the same
 *  panorama. With `useLatest`, move to the newest official pano in the timeline first. */
declare const pinPanoProvider: Provider;
/** Pin each location in the selector to a resolved panorama (sets `panoId`), so it always
 *  loads the same pano. */
declare function bulkPinToPano(selector: Selector, opts?: RunOpts & {
    useLatest?: boolean;
}): Promise<BatchOutcome>;

export type pinPano_PinPanoConfig = PinPanoConfig;
declare const pinPano_bulkPinToPano: typeof bulkPinToPano;
declare const pinPano_pinPanoProvider: typeof pinPanoProvider;
declare namespace pinPano {
  export { pinPano_bulkPinToPano as bulkPinToPano, pinPano_pinPanoProvider as pinPanoProvider };
  export type { pinPano_PinPanoConfig as PinPanoConfig };
}

/** Configuration for Street View validation (search radius). */
export interface ValidateConfig {
    radius: number;
}
/** Street View coverage validation. Checks each location's stored pano, coordinate
 *  lookup, unofficial status, camera quality, and timeline. Answers with a
 *  `ValidationState` per location without writing anything. */
declare const validateSpec: ProcedureSpec<ValidationState>;
/** What a validation run answered: the ids grouped by the state they validated to, over
 *  the outcome every run reports. */
export interface ValidationOutcome extends BatchOutcome {
    states: Map<ValidationState, number[]>;
}
/** Check that each location's Street View coverage still exists. */
declare function validateLocations(selector: Selector, opts?: BulkOpts): Promise<ValidationOutcome>;

export type validate_ValidateConfig = ValidateConfig;
export type validate_ValidationOutcome = ValidationOutcome;
declare const validate_validateLocations: typeof validateLocations;
declare const validate_validateSpec: typeof validateSpec;
declare namespace validate {
  export { validate_validateLocations as validateLocations, validate_validateSpec as validateSpec };
  export type { validate_ValidateConfig as ValidateConfig, validate_ValidationOutcome as ValidationOutcome };
}

/**
 * Google's SingleImageSearch RPC. The bodies are array-JSON ("json+protobuf"): a JSON
 * array whose element positions are the protobuf field numbers.
 *
 * `buildLocationSearchBody` mirrors what the Maps JS API sends for
 * `StreetViewService.getPanorama({location, radius})`: context.productId "apiv3"
 * (field 1), the LatLng + radius (field 2), and in the options (field 3) the search
 * preference (field 9) plus the source set (field 11: frontends 2, 3 and 10, each
 * enabled). Field 4 is the component mask. Locale and region are
 * omitted -- they only localize descriptions nothing here reads.
 *
 * Leaf module: `panosAtCoords` runs against the procedure host (`mma`)
 * and only work inside a procedure. The body builders and the reader are pure.
 */

/** Which pano a location search picks. An omitted preference goes on the wire as
 *  `Nearest`; the Maps JS API's encoder has no other default, whatever its docs say. */
declare const SearchPreference: {
    readonly Best: 1;
    readonly Nearest: 2;
};
export type SearchPreference = EnumOf<typeof SearchPreference>;
export interface SearchOpts {
    sources?: PanoType[];
    preference?: SearchPreference;
}

/** Full pano metadata for one or more panos, aligned to `panoIds`. Duplicates are
 *  deduped and large batches are split automatically. */
declare function svMetadata(panoIds: string[], signal?: AbortSignal): Promise<(Pano | null)[]>;
/** The nearest pano to each point, aligned to `points`, null where there is no coverage.
 *  `opts.sources` narrows which collections are searched and `opts.preference` picks
 *  nearest or best. */
declare function panosAt(points: LatLng[], radius?: number, opts?: SearchOpts, signal?: AbortSignal): Promise<(Pano | null)[]>;

declare const query_panosAt: typeof panosAt;
declare const query_svMetadata: typeof svMetadata;
declare namespace query {
  export {
    query_panosAt as panosAt,
    query_svMetadata as svMetadata,
  };
}

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

/** Set or clear the main editor map host. */
declare function setMapHost(host: MapHost | null): void;
/** Return the main editor map host, or null if not mounted. */
declare function getMapHost(): MapHost | null;
/** Wait for the main editor map to be ready. */
declare function waitForMapHost(): Promise<MapHost>;
/** Fit the editor map's viewport to `bounds`. A `minExtent` prevents over-zoom on tiny areas. */
declare function fitMapToBounds(bounds: Bounds | null, padding?: number, minExtent?: number): void;
export type ClickInterceptor = (lat: number, lng: number, shiftKey: boolean) => boolean;
/** Register a map-click interceptor. Returns a removal function. The most recently
 *  added interceptor that returns true consumes the click. */
declare function addClickInterceptor(fn: ClickInterceptor): () => void;
/** Run registered click interceptors (newest first). True if one consumed the click. */
declare function tryInterceptClick(lat: number, lng: number, shiftKey?: boolean): boolean;
export type DrawInterceptor = (rings: number[][][]) => boolean;
/** Set the callback for completed polygon draws. Null clears it. */
declare function setDrawInterceptor(fn: DrawInterceptor | null): void;
/** Pass completed polygon rings to the draw interceptor. True if it consumed them. */
declare function tryInterceptDraw(rings: number[][][]): boolean;

declare const mapState_addClickInterceptor: typeof addClickInterceptor;
declare const mapState_fitMapToBounds: typeof fitMapToBounds;
declare const mapState_getMapHost: typeof getMapHost;
declare const mapState_setDrawInterceptor: typeof setDrawInterceptor;
declare const mapState_setMapHost: typeof setMapHost;
declare const mapState_tryInterceptClick: typeof tryInterceptClick;
declare const mapState_tryInterceptDraw: typeof tryInterceptDraw;
declare const mapState_waitForMapHost: typeof waitForMapHost;
declare namespace mapState {
  export {
    mapState_addClickInterceptor as addClickInterceptor,
    mapState_fitMapToBounds as fitMapToBounds,
    mapState_getMapHost as getMapHost,
    mapState_setDrawInterceptor as setDrawInterceptor,
    mapState_setMapHost as setMapHost,
    mapState_tryInterceptClick as tryInterceptClick,
    mapState_tryInterceptDraw as tryInterceptDraw,
    mapState_waitForMapHost as waitForMapHost,
  };
}

/** The shared scene that all map surfaces render from. */
declare function getScene(): CellManager;
/** Snapshot of every rendered location's id and position (`[lng, lat, ...]`). */
declare function getScenePositions(): {
    ids: Uint32Array;
    positions: Float32Array;
};
/** Set the default marker color (RGB bytes). @unstable */
declare function setMarkerDefaultColor(r: number, g: number, b: number): void;
/** Change the default marker color and repaint. @unstable */
declare function recolorScene(mc: RGB): void;
/** Current default marker color as RGBA. */
declare function getMarkerDefaultColor(): RGBA;
/** Resolves when the most recently started full scene load has finished (or immediately if none is in flight). @unstable */
declare function whenSceneSettled(): Promise<void>;
/** Rebuild the full scene for all locations. @unstable */
declare function loadScene(markerStyle: MarkerStyle, mc?: RGB): Promise<void>;
/** Clear all marker data from the scene. @unstable */
declare function clearScene(): void;
/** Start listening for deltas, selections, and active-location changes. Returns a stop function. @unstable */
declare function startSceneEngine(): () => void;

declare const sceneStore_clearScene: typeof clearScene;
declare const sceneStore_getMarkerDefaultColor: typeof getMarkerDefaultColor;
declare const sceneStore_getScene: typeof getScene;
declare const sceneStore_getScenePositions: typeof getScenePositions;
declare const sceneStore_loadScene: typeof loadScene;
declare const sceneStore_recolorScene: typeof recolorScene;
declare const sceneStore_setMarkerDefaultColor: typeof setMarkerDefaultColor;
declare const sceneStore_startSceneEngine: typeof startSceneEngine;
declare const sceneStore_whenSceneSettled: typeof whenSceneSettled;
declare namespace sceneStore {
  export {
    sceneStore_clearScene as clearScene,
    sceneStore_getMarkerDefaultColor as getMarkerDefaultColor,
    sceneStore_getScene as getScene,
    sceneStore_getScenePositions as getScenePositions,
    sceneStore_loadScene as loadScene,
    sceneStore_recolorScene as recolorScene,
    sceneStore_setMarkerDefaultColor as setMarkerDefaultColor,
    sceneStore_startSceneEngine as startSceneEngine,
    sceneStore_whenSceneSettled as whenSceneSettled,
  };
}

export interface ToastEntry {
    id: number;
    message: string;
    progress?: {
        fraction: number;
        label?: string;
    };
}
/** Show a brief toast notification. Optionally scoped to a `container` element. */
declare function toast(message: string, duration?: number, container?: HTMLElement): void;
/** Handle for updating or finishing a progress toast. */
export interface ProgressHandle {
    /** Set the progress bar fraction (0-1) and optional label. */
    update(fraction: number, label?: string): void;
    /** Remove the progress toast, optionally replacing it with a brief message. */
    finish(message?: string, duration?: number): void;
}
/** Show a toast with a progress bar. Returns a handle to update or finish it. */
declare function progressToast(message: string): ProgressHandle;
/** Current list of visible toasts. */
declare function getToasts(): ToastEntry[];

export type toast$1_ProgressHandle = ProgressHandle;
declare const toast$1_getToasts: typeof getToasts;
declare const toast$1_progressToast: typeof progressToast;
declare const toast$1_toast: typeof toast;
declare namespace toast$1 {
  export { toast$1_getToasts as getToasts, toast$1_progressToast as progressToast, toast$1_toast as toast };
  export type { toast$1_ProgressHandle as ProgressHandle };
}

/** Context passed to the job function. */
export interface JobContext<P> {
    signal: AbortSignal;
    /** Push a progress value to the UI. Ignored once the job is cancelled. */
    report: (progress: P) => void;
}
/** State and controls for a cancellable async job. */
export interface Job<R, P> {
    running: boolean;
    progress: P | null;
    result: R | null;
    /** Message from a failed run. Cancelling is not a failure and leaves this null. */
    error: string | null;
    run: () => void;
    cancel: () => void;
}
/** A user-triggered async job that reports progress and can be cancelled.
 *  Cancelling aborts the signal and stops the UI immediately; nothing the job does
 *  afterwards can write back. Unmounting cancels. `run` while running is a no-op,
 *  so a double-clicked button cannot start two.
 *
 *  For work driven by changing deps rather than a click, use `useAsync`. */
declare function useJob<R = void, P = string>(fn: (ctx: JobContext<P>) => Promise<R>): Job<R, P>;

export type useJob$1_Job<R, P> = Job<R, P>;
export type useJob$1_JobContext<P> = JobContext<P>;
declare const useJob$1_useJob: typeof useJob;
declare namespace useJob$1 {
  export { useJob$1_useJob as useJob };
  export type { useJob$1_Job as Job, useJob$1_JobContext as JobContext };
}

/** @deprecated v0.8.1. Use `MMA.getMapHost()` and narrow via `hostInstance`. @unstable */
declare function getGoogleMap(): google.maps.Map | null;
/** @deprecated v0.8.1. Use `MMA.waitForMapHost()`. @unstable */
declare function waitForGoogleMap(): Promise<google.maps.Map | null>;
/** @deprecated v0.8.2. Read `MMA.getMapState().map`. @unstable */
declare function getCurrentMap(): MapMeta | null;
/** @deprecated v0.8.2. Read `MMA.getMapState().mapId`. @unstable */
declare function getCurrentMapId(): string | null;
/** @deprecated v0.8.2. Read `MMA.getMapState().activeLocation`. @unstable */
declare function getActiveLocation(): Location | null;
/** @deprecated v0.8.2. Read `MMA.getMapState().selectedLocationIds`. @unstable */
declare function getSelectedLocationIds(): SelectedIds;
/** @deprecated v0.8.2. Read `MMA.getMapState().workArea`. @unstable */
declare function getWorkArea(): WorkArea;
/** @deprecated v0.8.2. Read `MMA.getMapState().tagCounts`. @unstable */
declare function getTagCounts(): {
    [x: number]: number;
};
/** @deprecated v0.8.2. Read `MMA.getMapState().selections`. @unstable */
declare function getAllSelections(): Selection[];
/** @deprecated v0.8.2. Read `MMA.getMapState().ghostedSelections`. @unstable */
declare function getGhostedSelections(): ReadonlySet<string>;
/** @deprecated v0.8.2. Use `MMA.getActiveSelections()`. @unstable */
declare function getSelections(): Selection[];
/** @deprecated v0.8.2. Read `(await MMA.cmd.storeGetSummary()).dirtyCount`. @unstable */
declare function getDirtyCount(): Promise<number>;
/** @deprecated v0.8.4. Use `MMA.fetchLocations({ type: "Locations", locations: [id], name: null })`. @unstable */
declare function fetchLocation(id: number): Promise<Location>;
/** @deprecated v0.8.4. Use `MMA.fetchLocations({ type: "Locations", locations: ids, name: null })`. @unstable */
declare function fetchLocationsByIds(ids: number[]): Promise<Location[]>;
/** @deprecated v0.8.4. Use `MMA.fetchLocations({ type: "Everything" })`. @unstable */
declare function fetchAllLocations(): Promise<Location[]>;
/** @deprecated v0.10.2. Use `MMA.coverage()`. @unstable */
declare function fieldCoverage(selector: Selector): Promise<[string, number][]>;
/** @deprecated v0.10.2. Use `MMA.registerProvider()`. @unstable */
declare function registerEnrichmentProvider(provider: Provider): void;
/** @deprecated v0.10.5. The user layer is Rust-owned state (`MMA.getMapState().fieldDefs`);
 *  use `MMA.setMapExtraFields()` to change it, or `MMA.registerPluginFieldDefs()` for
 *  plugin-owned defs. @unstable */
declare function setUserFieldDefs(defs: Record<string, ExtraFieldDef>): Promise<void>;

declare const legacy_fetchAllLocations: typeof fetchAllLocations;
declare const legacy_fetchLocation: typeof fetchLocation;
declare const legacy_fetchLocationsByIds: typeof fetchLocationsByIds;
declare const legacy_fieldCoverage: typeof fieldCoverage;
declare const legacy_getActiveLocation: typeof getActiveLocation;
declare const legacy_getAllSelections: typeof getAllSelections;
declare const legacy_getCurrentMap: typeof getCurrentMap;
declare const legacy_getCurrentMapId: typeof getCurrentMapId;
declare const legacy_getDirtyCount: typeof getDirtyCount;
declare const legacy_getGhostedSelections: typeof getGhostedSelections;
declare const legacy_getGoogleMap: typeof getGoogleMap;
declare const legacy_getSelectedLocationIds: typeof getSelectedLocationIds;
declare const legacy_getSelections: typeof getSelections;
declare const legacy_getTagCounts: typeof getTagCounts;
declare const legacy_getWorkArea: typeof getWorkArea;
declare const legacy_registerEnrichmentProvider: typeof registerEnrichmentProvider;
declare const legacy_setUserFieldDefs: typeof setUserFieldDefs;
declare const legacy_waitForGoogleMap: typeof waitForGoogleMap;
declare namespace legacy {
  export {
    legacy_fetchAllLocations as fetchAllLocations,
    legacy_fetchLocation as fetchLocation,
    legacy_fetchLocationsByIds as fetchLocationsByIds,
    legacy_fieldCoverage as fieldCoverage,
    legacy_getActiveLocation as getActiveLocation,
    legacy_getAllSelections as getAllSelections,
    legacy_getCurrentMap as getCurrentMap,
    legacy_getCurrentMapId as getCurrentMapId,
    legacy_getDirtyCount as getDirtyCount,
    legacy_getGhostedSelections as getGhostedSelections,
    legacy_getGoogleMap as getGoogleMap,
    legacy_getSelectedLocationIds as getSelectedLocationIds,
    legacy_getSelections as getSelections,
    legacy_getTagCounts as getTagCounts,
    legacy_getWorkArea as getWorkArea,
    legacy_registerEnrichmentProvider as registerEnrichmentProvider,
    legacy_setUserFieldDefs as setUserFieldDefs,
    legacy_waitForGoogleMap as waitForGoogleMap,
  };
}

/** Force a full selection re-resolve and return the selected IDs. @unstable */
declare function syncSelections(): Promise<{
    ids: number[];
}>;
/** Open a map by id and navigate to it. @unstable */
declare function openMap(id: string): Promise<void>;
/** Close the current map and return to the map list. @unstable */
declare function closeMap(): Promise<void>;
/** Delete a map by id. @unstable */
declare function deleteMap(id: string): Promise<void>;
/** Import locations from pasted text and commit them to the map. @unstable */
declare function importPaste(text: string): Promise<EditorImportResult[]>;
/** Import a previewed file, optionally assigning a tag. @unstable */
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

/** The nested `_test` namespace on the plugin surface. @unstable */
declare const _test: typeof testApi;

declare const testSurface__test: typeof _test;
declare namespace testSurface {
  export {
    testSurface__test as _test,
  };
}

/** Base URL for a custom URI scheme, platform-adjusted. */
declare function schemeBase(scheme: string): string;
/** URL that serves a local file over the `mma-buf://` protocol. */
declare function mmaBufUrl(path: string): string;
/** Message for an unknown thrown value. */
declare function errText(e: unknown): string;
/** Copy of `set` with `value` toggled, or forced on/off by `on`. */
declare function toggleInSet<T>(set: ReadonlySet<T>, value: T, on?: boolean): Set<T>;
/** The item `isBetter` prefers over every other, or null when there are none. */
declare function bestBy<T>(items: Iterable<T>, isBetter: (a: T, b: T) => boolean): T | null;
/** Split `arr` into sub-arrays of at most `n` elements. */
declare function chunk<T>(arr: readonly T[], n: number): T[][];
/** Compare two semver strings (e.g. "0.6.1", "0.7.0-rc.2"). Returns >0 if a > b.
 *  Build metadata is ignored; a pre-release sorts below the release it precedes. */
declare function cmpVersion(a: string, b: string): number;
/** `["0.7.0", "rc.2"]` for `"v0.7.0-rc.2+build"`; the pre-release part is `""` when absent. */
declare function splitVersion(v: string): [core: string, pre: string];
/** True when `v` carries a semver pre-release tag, e.g. "1.0.0-beta.1". */
declare function isPrereleaseVersion(v: string): boolean;
/** True when running under the web-serve bridge (a plain browser, no native shell). */
declare function isWeb(): boolean;
/** Trigger a browser download from an in-memory Blob. */
declare function downloadBlob(blob: Blob, fileName: string): void;
/** Copy an image Blob to the clipboard. False when the platform refuses it. */
declare function copyImageToClipboard(blob: Blob): Promise<boolean>;
/** Compare strings with natural (numeric-aware) ordering. */
declare function compareNatural(a: string, b: string): number;
/** Sort tags by the chosen mode: name, location count, or manual order. */
declare function sortTagsByMode(tags: Tag[], mode: TagSortMode, counts: Record<number, number>): Tag[];
/** Color for a tag named `name`. An existing tag uses its stored color. */
declare function tagColorFor(name: string, tags: Tag[]): string;
/** Add a name to a staged list: dedup case-insensitively, normalizing to an existing tag's
 *  canonical casing. Returns the original array unchanged if already present. */
declare function appendTagName(pending: string[], name: string, tags: Tag[]): string[];
/** Convert a field-of-view angle (degrees) to a zoom level. */
declare function fovToZoom(fov: number): number;
/** Current time as Unix seconds, the form Location timestamps use. */
declare function nowUnix(): number;
/** Rolling anchor for a phase-relative locations/second average. */
export interface PhaseRate {
    t0: number;
    done0: number;
    done: number;
    total: number;
}
/** Compute a locations/second rate for the current progress phase. Re-anchors when a
 *  new phase is detected (done went backward or total grew). Null until a quarter second
 *  of work has elapsed. */
declare function phaseRate(prev: PhaseRate | null, done: number, total: number, now: number): {
    state: PhaseRate;
    rate: number | null;
};

export type util_PhaseRate = PhaseRate;
declare const util_appendTagName: typeof appendTagName;
declare const util_bestBy: typeof bestBy;
declare const util_chunk: typeof chunk;
declare const util_cmpVersion: typeof cmpVersion;
declare const util_compareNatural: typeof compareNatural;
declare const util_copyImageToClipboard: typeof copyImageToClipboard;
declare const util_downloadBlob: typeof downloadBlob;
declare const util_errText: typeof errText;
declare const util_fovToZoom: typeof fovToZoom;
declare const util_isPrereleaseVersion: typeof isPrereleaseVersion;
declare const util_isWeb: typeof isWeb;
declare const util_mmaBufUrl: typeof mmaBufUrl;
declare const util_nowUnix: typeof nowUnix;
declare const util_phaseRate: typeof phaseRate;
declare const util_schemeBase: typeof schemeBase;
declare const util_sortTagsByMode: typeof sortTagsByMode;
declare const util_splitVersion: typeof splitVersion;
declare const util_tagColorFor: typeof tagColorFor;
declare const util_toggleInSet: typeof toggleInSet;
declare namespace util {
  export { util_appendTagName as appendTagName, util_bestBy as bestBy, util_chunk as chunk, util_cmpVersion as cmpVersion, util_compareNatural as compareNatural, util_copyImageToClipboard as copyImageToClipboard, util_downloadBlob as downloadBlob, util_errText as errText, util_fovToZoom as fovToZoom, util_isPrereleaseVersion as isPrereleaseVersion, util_isWeb as isWeb, util_mmaBufUrl as mmaBufUrl, util_nowUnix as nowUnix, util_phaseRate as phaseRate, util_schemeBase as schemeBase, util_sortTagsByMode as sortTagsByMode, util_splitVersion as splitVersion, util_tagColorFor as tagColorFor, util_toggleInSet as toggleInSet };
  export type { util_PhaseRate as PhaseRate };
}

/**
 * Unified MMA API -- the single public surface for plugins, tests, and app code.
 * Exposed as `window.MMA` (and the global `MMA`).
 */

export type ConstsApi = typeof consts;
export type StoreApi = typeof store;
export type SelectionOpsApi = typeof selectionOps;
export type SavedSelectionsApi = typeof savedSelections;
/** App settings and their option tables; the shape moves with every setting added. @unstable */
export type SettingsApi = typeof settings;
/** Import dialog internals. @unstable */
export type ImportStagingApi = typeof importStaging;
/** Commit diff internals. @unstable */
export type CommitDiffApi = typeof commitDiff;
export type SelectorPickApi = typeof picker;
export type MapListApi = typeof mapList;
/** Review screen internals. @unstable */
export type ReviewApi = typeof review;
/** The raw command layer under the app-level API; any of them can change in a release. @unstable */
export type CommandsApi = typeof commands;
export type TauriApi = typeof tauri;
export type RegistryApi = typeof registry;
export type ScopeApi = typeof scope;
export type ExternalsApi = typeof externals;
export type SidecarApi = typeof sidecar$1;
export type UiApi = typeof uiSurface;
export type FieldDefsApi = typeof fieldDefs;
export type FieldDefRegistryApi = typeof fieldDefRegistry;
export type ProceduresApi = typeof procedures;
export type SeenApi = typeof seen;
/** The shared panorama viewer's internals. @unstable */
export type PanoSingletonApi = typeof panoSingleton;
export type EnrichApi = typeof enrich$1;
export type PinPanoApi = typeof pinPano;
export type ValidateApi = typeof validate;
export type QueryApi = typeof query;
export type MapStateApi = typeof mapState;
export type SceneStoreApi = typeof sceneStore;
export type ColorApi = typeof colorUtils;
export type ToastApi = typeof toast$1;
export type UseJobApi = typeof useJob$1;
/** Shims for removed APIs. @unstable */
export type LegacyApi = typeof legacy;
/** @unstable */
export type TestApi = typeof testSurface;
export type TypesApi = typeof types;
export type UtilApi = typeof util;
interface MMA extends ConstsApi, StoreApi, SelectionOpsApi, SavedSelectionsApi, SettingsApi, ImportStagingApi, CommitDiffApi, SelectorPickApi, MapListApi, ReviewApi, CommandsApi, TauriApi, RegistryApi, ScopeApi, ExternalsApi, SidecarApi, UiApi, FieldDefsApi, FieldDefRegistryApi, ProceduresApi, SeenApi, PanoSingletonApi, EnrichApi, PinPanoApi, ValidateApi, QueryApi, MapStateApi, SceneStoreApi, ColorApi, ToastApi, UseJobApi, TestApi, TypesApi, UtilApi, LegacyApi {
}

declare global {
    interface Window {
        MMA: MMA;
    }
    const MMA: MMA;
}

export type { BUILTIN_FIELDS, CLEARABLE_BUILTINS, DEFAULT_DUPLICATE_SCORE, KNOWN_FIELDS, LocationFlag, MMA, MMA as MMAApi, PROJECTIONS, PanoType, SCRATCH_MAP_ID, VIRTUAL_FLAGS, ValidationState, commands$1 as commands, events };
export type { AnonIssueRef, AttachmentRef, BatchMode, CameraType, CellRemoval, Columns, CommitDelta, CommitDiff, CommitInfo, CommitResult, ComparisonType, Conflict, ConflictKind, CopyToMapResult, DataLocation, DatePart, DbStats, DeviceCodeInfo, EditorImportPreview, EditorImportResult, EngineValues, ExportOpts, ExportProgress, ExternalMutation, ExtraFieldDef, ExtraFieldType, FieldCount, FieldOp, FieldOpResult, FilterOp, FirstSyncMode, GeoResult, GgUser, GhUser, ImportPreviewEntry, ImportProgress, ImportedMapInfo, IssueComment, IssueRef, IssueState, IssueThread, KeySpec, Location, LocationPatch, LocationPatch_Deserialize, MapExtra, MapKeyAction, MapKeyBinding, MapMeta, MapMetaPatch, MapMetaPatch_Deserialize, MapSettings, MergeWinner, MutationResult, NormalizedSyncLocation, NumericBinning, PartitionBucket, PluginBuild, PluginBuild_Deserialize, PluginManifest, PluginManifest_Deserialize, PluginSidecar, PluginSidecar_Deserialize, PolygonGeometry, PresenceActivity, ProcedureHost, ProcedureProgress, ProcedureRequest, ProcedureResponse, ProcedureResult, ProviderDecl, PullCreate, PullUpdate, RateCost, RateSpec, RemoteMappingRow, RenderDelta, RenderEntry, RenderPatchEntry, RenderRequest, ResolutionSide, ResultEntry, RetrySpec, ReviewCreate, ReviewSession, ReviewUpdate, Rows, RowsRun, SaveResult, SavedSelection, SavedSelectionInfo, ScoreBounds, SeenEntry, SeenFilter, SeenMapInfo, SeenWriteEntry, SelPaint, Selection, SelectionInput, SelectionSync, Selector, SideCounts, SidecarDone, SidecarLine, SidecarLog, SidecarProgress, Sink, SpacedPickResult, StoreStatus, StoreWarning, SummaryResult, SyncPatch, SyncReconcileResult, Tag, TagPatch, Update, UpdateAvailable, UpdateProgress, ValiCountryStatus, ValiLocation, ValiLocation_Deserialize, ValiProgress, VirtualTag };
