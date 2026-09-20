/// <reference types="google.maps" />

import * as _tauri_apps_api_window from '@tauri-apps/api/window';
import * as _tauri_apps_api_webview from '@tauri-apps/api/webview';
import * as __TAURI_EVENT from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';
import { open, save } from '@tauri-apps/plugin-dialog';
import * as react from 'react';
import { ComponentType, SetStateAction, ComponentPropsWithRef, ReactNode, ComponentProps, CSSProperties, ElementType, ReactElement } from 'react';
import { Dialog as Dialog$1 } from '@base-ui-components/react/dialog';
import { Layer, PickingInfo } from '@deck.gl/core';
import * as maplibregl from 'maplibre-gl';

declare const CameraType: {
    /** First-generation Street View camera. */
    readonly Gen1: "gen1";
    /** Second- or third-generation camera. */
    readonly Gen2: "gen2";
    /** Fourth-generation camera. */
    readonly Gen4: "gen4";
    /** A capture from a known bad camera. */
    readonly Badcam: "badcam";
    /** An indoor capture from a tripod. */
    readonly Tripod: "tripod";
    /** A special collect carried on foot or on another vehicle, such as a trekker. */
    readonly Trekker: "trekker";
};
type CameraType = (typeof CameraType)[keyof typeof CameraType];
/** A capture of a pano's timeline to settle on. */
declare const CapturePick: {
    /** The newest official capture. */
    readonly Newest: "newest";
    /** The oldest official capture. */
    readonly Oldest: "oldest";
};
type CapturePick = (typeof CapturePick)[keyof typeof CapturePick];
/** A calendar component to group dates by. */
declare const DatePart: {
    /** The calendar year. */
    readonly Year: "year";
    /** The year and month. */
    readonly YearMonth: "yearMonth";
    /** The calendar date. */
    readonly Day: "day";
    /** The month, the same in every year. */
    readonly MonthOfYear: "monthOfYear";
    /** The hour of the day. */
    readonly HourOfDay: "hourOfDay";
};
type DatePart = (typeof DatePart)[keyof typeof DatePart];
/**
 * Type discriminant for `Location.extra` field definitions.
 * Determines how the field is displayed and filtered in the UI.
 */
declare const FieldType: {
    /** Text. */
    readonly String: "string";
    /** A number. */
    readonly Number: "number";
    /** True or false. */
    readonly Boolean: "boolean";
    /** A point in time. */
    readonly Date: "date";
    /** A year and month. */
    readonly Month: "month";
    /** One of a fixed set of values. */
    readonly Enum: "enum";
    /** A list of values. */
    readonly Array: "array";
};
type FieldType = (typeof FieldType)[keyof typeof FieldType];
/**
 * First-sync seeding when both sides already have pins. Only meaningful on the first sync
 * (empty mapping); afterwards it's plain three-way. `Merge` never deletes.
 * @unstable
 */
declare const FirstSyncMode: {
    /** Both maps keep everything; nothing is deleted. */
    readonly Merge: "merge";
    /** Locations only on this map are deleted so it matches the remote map. */
    readonly MirrorFromRemote: "mirrorFromRemote";
    /** Locations only on the remote map are deleted so it matches this map. */
    readonly MirrorFromLocal: "mirrorFromLocal";
};
/** @unstable */
type FirstSyncMode = (typeof FirstSyncMode)[keyof typeof FirstSyncMode];
/** @unstable */
declare const IssueState: {
    /** The issue is still open. */
    readonly Open: "open";
    /** The issue has been closed. */
    readonly Closed: "closed";
};
/** @unstable */
type IssueState = (typeof IssueState)[keyof typeof IssueState];
/** When a move target already holds a value, which side survives. */
declare const MergeWinner: {
    /** The moved value replaces what the target already holds. */
    readonly From: "from";
    /** The target keeps its own value and the moved value is dropped. */
    readonly To: "to";
};
type MergeWinner = (typeof MergeWinner)[keyof typeof MergeWinner];
/**
 * What one attempt charges the bucket: the call itself, or one per row in its batch
 * (for APIs that bill multi-row requests per row).
 */
declare const RateCost: {
    /** Each attempt charges the rate limit once, however many rows it carries. */
    readonly Request: "request";
    /** Each attempt charges the rate limit once per row it carries; a query carries no rows and charges once. */
    readonly Row: "row";
};
type RateCost = (typeof RateCost)[keyof typeof RateCost];
/** Which side won a resolved conflict. @unstable */
declare const ResolutionSide: {
    /** This map's version won the conflict. */
    readonly Local: "local";
    /** The remote map's version won the conflict. */
    readonly Remote: "remote";
};
/** @unstable */
type ResolutionSide = (typeof ResolutionSide)[keyof typeof ResolutionSide];
/**
 * Where a provider's results go. `Patch` applies them to the locations they name;
 * `Collect` delivers them to the caller and writes nothing. The declaration decides
 * this, never the contents of a result.
 */
declare const Sink: {
    /** Results are written to the locations they name. */
    readonly Patch: "patch";
    /** Results are handed back and nothing is written. */
    readonly Collect: "collect";
};
type Sink = (typeof Sink)[keyof typeof Sink];
/** Per-location bitfield, serialized as a plain `u32` over IPC and Arrow. */
declare const LocationFlag: {
    /** No flags set. */
    readonly None: 0;
    /** When the location has a stored pano, it opens exactly that pano instead of the nearest coverage. */
    readonly LoadAsPanoId: 1;
    /** Legacy marker (web). Kept as imported, with no effect in the app. */
    readonly Informational: 2;
    /** A location from a pending import, opened for preview and not yet on the map. */
    readonly ImportPreview: 4;
    /** A pano opened from the seen history overlay, not yet on the map. */
    readonly SeenOverlay: 8;
};
type LocationFlag = (typeof LocationFlag)[keyof typeof LocationFlag];
/** Which imagery collection a pano id belongs to. */
declare const PanoType: {
    /** Official Street View coverage. */
    readonly Official: 2;
    /** Unofficial imagery from outside the user-uploaded collection. */
    readonly Unknown: 3;
    /** Imagery uploaded by users. */
    readonly UserUploaded: 10;
};
type PanoType = (typeof PanoType)[keyof typeof PanoType];
/**
 * Which pano the search picks; omitted means closest. BEST at a small radius can return a
 * neighbouring pano from the same capture run, so probe a pano's own coordinate with CLOSEST.
 */
declare const RankingStrategy: {
    /** The pano the search ranks best within the radius, which may not be the nearest. */
    readonly Best: 1;
    /** The pano nearest the searched point, and the choice when none is given. */
    readonly Closest: 2;
};
type RankingStrategy = (typeof RankingStrategy)[keyof typeof RankingStrategy];
/** Outcome of a Street View coverage check, as `validate` answers it per row. */
declare const ValidationState: {
    /** The location's coverage checked out, with nothing to report. */
    readonly Ok: 0;
    /** The location is pinned to a pano, and newer official coverage exists that it does not show. */
    readonly UpdateAvailable: 1;
    /** Newer official coverage exists here, and the unpinned location already shows it. */
    readonly UpdateApplied: 2;
    /** The location shows bad-camera coverage, but its timeline holds a better camera capture. */
    readonly GoodcamAvailable: 6;
    /** The location's pinned pano no longer loads, though coverage still exists at its coordinates. */
    readonly PanoIdBroke: 4;
    /** The coverage the location shows is unofficial. */
    readonly Unofficial: 5;
    /** No coverage was found, neither the stored pano nor any within the search radius. */
    readonly NotFound: 3;
};
type ValidationState = (typeof ValidationState)[keyof typeof ValidationState];
declare const BUILTIN_FIELDS: readonly [{
    readonly key: "id";
    readonly label: "ID";
    readonly type: "number";
    readonly kind: "identity";
    readonly comparison: null;
    readonly interned: false;
}, {
    readonly key: "lat";
    readonly label: "Latitude";
    readonly type: "number";
    readonly kind: "identity";
    readonly comparison: null;
    readonly interned: false;
}, {
    readonly key: "lng";
    readonly label: "Longitude";
    readonly type: "number";
    readonly kind: "identity";
    readonly comparison: null;
    readonly interned: false;
}, {
    readonly key: "heading";
    readonly label: "Heading";
    readonly type: "number";
    readonly kind: "writable";
    readonly comparison: {
        readonly type: "circular";
        readonly period: 360;
    };
    readonly interned: false;
}, {
    readonly key: "pitch";
    readonly label: "Pitch";
    readonly type: "number";
    readonly kind: "writable";
    readonly comparison: null;
    readonly interned: false;
}, {
    readonly key: "zoom";
    readonly label: "Zoom";
    readonly type: "number";
    readonly kind: "writable";
    readonly comparison: null;
    readonly interned: false;
}, {
    readonly key: "panoId";
    readonly label: "Pano ID";
    readonly type: "string";
    readonly kind: null;
    readonly comparison: null;
    readonly interned: false;
}, {
    readonly key: "tags";
    readonly label: "Tags";
    readonly type: "array";
    readonly kind: "writable";
    readonly comparison: null;
    readonly interned: true;
}, {
    readonly key: "createdAt";
    readonly label: "Created";
    readonly type: "date";
    readonly kind: null;
    readonly comparison: null;
    readonly interned: false;
}, {
    readonly key: "modifiedAt";
    readonly label: "Modified";
    readonly type: "date";
    readonly kind: null;
    readonly comparison: null;
    readonly interned: false;
}, {
    readonly key: "tagCount";
    readonly label: "Tag count";
    readonly type: "number";
    readonly kind: "virtual";
    readonly comparison: null;
    readonly interned: false;
}, {
    readonly key: "loadAsPanoId";
    readonly label: "Load as pano ID";
    readonly type: "boolean";
    readonly kind: "writable";
    readonly comparison: null;
    readonly interned: false;
}];
declare const OFFICIAL_ID_PATTERN: "^[-_A-Za-z0-9]{21}[AQgw]$";
/** @unstable */
declare const CLEARABLE_BUILTINS: readonly ["panoId"];
/** @unstable */
declare const EFFECT_CALLS: readonly ["fetch", "fetchMany", "panos", "sidecar"];
/** @unstable */
declare const PLAIN_CALLS: readonly ["classify", "neighbors", "progress", "fail", "emit", "aborted"];
/** @unstable */
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
/** @unstable */
declare const PROJECTIONS: readonly [{
    readonly id: "value";
    readonly appliesTo: readonly ["string", "enum", "boolean", "number", "month", "array"];
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
/** @unstable */
declare const SCRATCH_MAP_ID: "scratch";
/** @unstable */
declare const ERROR_CODES: readonly ["auth", "attachment-not-staged", "attachment-too-large", "attachment-not-image", "upload-rejected", "report-rejected", "report-unreadable", "sign-in-timed-out", "sign-in-token-rejected", "issue-rejected", "geoguessr-polygonal", "geoguessr-draft-too-large"];
/** The bits a preview carries that a real location must not. @unstable */
declare const VIRTUAL_FLAGS: 12;

declare const consts_BUILTIN_FIELDS: typeof BUILTIN_FIELDS;
declare const consts_CLEARABLE_BUILTINS: typeof CLEARABLE_BUILTINS;
declare const consts_CameraType: typeof CameraType;
/** @unstable */
export type consts_CameraType = CameraType;
declare const consts_CapturePick: typeof CapturePick;
/** @unstable */
export type consts_CapturePick = CapturePick;
declare const consts_DEFAULT_DUPLICATE_SCORE: typeof DEFAULT_DUPLICATE_SCORE;
declare const consts_DatePart: typeof DatePart;
/** @unstable */
export type consts_DatePart = DatePart;
declare const consts_EFFECT_CALLS: typeof EFFECT_CALLS;
declare const consts_ERROR_CODES: typeof ERROR_CODES;
declare const consts_FieldType: typeof FieldType;
/** @unstable */
export type consts_FieldType = FieldType;
declare const consts_FirstSyncMode: typeof FirstSyncMode;
/** @unstable */
export type consts_FirstSyncMode = FirstSyncMode;
declare const consts_IssueState: typeof IssueState;
/** @unstable */
export type consts_IssueState = IssueState;
declare const consts_KNOWN_FIELDS: typeof KNOWN_FIELDS;
declare const consts_LocationFlag: typeof LocationFlag;
/** @unstable */
export type consts_LocationFlag = LocationFlag;
declare const consts_MergeWinner: typeof MergeWinner;
/** @unstable */
export type consts_MergeWinner = MergeWinner;
declare const consts_OFFICIAL_ID_PATTERN: typeof OFFICIAL_ID_PATTERN;
declare const consts_PLAIN_CALLS: typeof PLAIN_CALLS;
declare const consts_PROJECTIONS: typeof PROJECTIONS;
declare const consts_PanoType: typeof PanoType;
/** @unstable */
export type consts_PanoType = PanoType;
declare const consts_RankingStrategy: typeof RankingStrategy;
/** @unstable */
export type consts_RankingStrategy = RankingStrategy;
declare const consts_RateCost: typeof RateCost;
/** @unstable */
export type consts_RateCost = RateCost;
declare const consts_ResolutionSide: typeof ResolutionSide;
/** @unstable */
export type consts_ResolutionSide = ResolutionSide;
declare const consts_SCRATCH_MAP_ID: typeof SCRATCH_MAP_ID;
declare const consts_Sink: typeof Sink;
/** @unstable */
export type consts_Sink = Sink;
declare const consts_VIRTUAL_FLAGS: typeof VIRTUAL_FLAGS;
declare const consts_ValidationState: typeof ValidationState;
/** @unstable */
export type consts_ValidationState = ValidationState;
declare namespace consts {
  export { consts_BUILTIN_FIELDS as BUILTIN_FIELDS, consts_CLEARABLE_BUILTINS as CLEARABLE_BUILTINS, consts_DEFAULT_DUPLICATE_SCORE as DEFAULT_DUPLICATE_SCORE, consts_EFFECT_CALLS as EFFECT_CALLS, consts_ERROR_CODES as ERROR_CODES, consts_KNOWN_FIELDS as KNOWN_FIELDS, consts_OFFICIAL_ID_PATTERN as OFFICIAL_ID_PATTERN, consts_PLAIN_CALLS as PLAIN_CALLS, consts_PROJECTIONS as PROJECTIONS, consts_SCRATCH_MAP_ID as SCRATCH_MAP_ID, consts_VIRTUAL_FLAGS as VIRTUAL_FLAGS };
  export { consts_CameraType as CameraType, consts_CapturePick as CapturePick, consts_DatePart as DatePart, consts_FieldType as FieldType, consts_FirstSyncMode as FirstSyncMode, consts_IssueState as IssueState, consts_LocationFlag as LocationFlag, consts_MergeWinner as MergeWinner, consts_PanoType as PanoType, consts_RankingStrategy as RankingStrategy, consts_RateCost as RateCost, consts_ResolutionSide as ResolutionSide, consts_Sink as Sink, consts_ValidationState as ValidationState };
}

/** Commands @unstable */
declare const commands$1: {
    /**  Milliseconds from app launch until the window was ready. @unstable */
    appReady: () => Promise<number>;
    /**
     *  Seconds the app has been running, counted from launch rather than from whenever a
     *  window last loaded its page.
     *  @unstable
     */
    appUptime: () => Promise<number>;
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
    /**  True for the first caller per app run, which runs the background plugin update check. @unstable */
    claimPluginUpdatePass: () => Promise<boolean>;
    /**  Manifests of every installed plugin. @unstable */
    listUserPlugins: () => Promise<PluginManifest[]>;
    /**
     *  Install a plugin from the marketplace: its manifest, main script, and procedure module.
     *  `gitRef` pins an older build; `null` installs the latest.
     *  @unstable
     */
    installPlugin: (id: string, gitRef: string | null) => Promise<PluginManifest>;
    /**  Delete a plugin's directory. @unstable */
    uninstallPlugin: (id: string) => Promise<null>;
    /**  Download and install a plugin's sidecar bundle. Emits `sidecar-install-progress`. @unstable */
    sidecarInstall: (pluginId: string, name: string, version: string) => Promise<null>;
    /**  Installed sidecar version for a plugin, or `null` if not installed. @unstable */
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
     *  `level`, or `null` if the point falls outside every feature.
     *  @unstable
     */
    borderLookup: (lat: number, lng: number, level: string) => Promise<PolygonGeometry | null>;
    /**
     *  Classify each `(lat, lng)` to the name of its containing border feature at
     *  `level` (subdivision names for "adm1"). `null` for points outside every feature.
     *  @unstable
     */
    borderClassify: (level: string, points: ([number, number])[]) => Promise<(string | null)[]>;
    /**
     *  Return the nearest city, administrative region, and country for a coordinate.
     *  Never `null`: every landmass is covered.
     *  @unstable
     */
    reverseGeocode: (lat: number, lng: number) => Promise<GeoResult | null>;
    /**  IANA timezone at a coordinate, or `null` outside the valid range. @unstable */
    timezoneAt: (lat: number, lng: number) => Promise<string | null>;
    /**  Show the window with the system open animation, maximized if `maximized` is set. @unstable */
    revealWindow: (maximized: boolean) => Promise<void>;
    /**  Set the Discord Rich Presence activity. No-op when Discord is not running. @unstable */
    discordPresenceSet: (activity: PresenceActivity) => Promise<null>;
    /**  Clear the Discord Rich Presence activity. No-op when Discord is not running. @unstable */
    discordPresenceClear: () => Promise<null>;
    /**
     *  Begin device-flow sign-in. Returns the code to show the user; call
     *  `githubPollLogin` afterwards to wait for them to finish authorizing.
     *  @unstable
     */
    githubStartLogin: () => Promise<DeviceCodeInfo>;
    /**
     *  Wait for the user to authorize the code from `githubStartLogin`.
     *  Resolves with the signed-in account.
     *  @unstable
     */
    githubPollLogin: () => Promise<GhUser>;
    /**  The signed-in user, or `null` when there is no session (or it was rejected). @unstable */
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
     *  caller can use to check for replies via `feedbackAnonymousThread`.
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
     *  Check for an update at `endpoint` (a release's `latest.json`). Returns `null`
     *  when the announced version is not newer than the running one.
     *  @unstable
     */
    updateCheck: (endpoint: string) => Promise<UpdateAvailable | null>;
    /**
     *  Download and install whatever the last `updateCheck` found. The installer replaces the
     *  running app, so nothing after this is guaranteed to run. Save state first.
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
     *  Open a map and return its initial state (per-value counts, metadata, undo/redo availability).
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
    /**  Add locations from an upload session (see `storeUploadBegin`) as one undoable change. @unstable */
    storeAddLocationsUploaded: (sessionDir: string) => Promise<MutationResult>;
    /**  Remove locations by ID. Undoable. @unstable */
    storeRemoveLocations: (ids: number[]) => Promise<MutationResult>;
    /**
     *  Apply partial patches to existing locations. `recordUndo` defaults to true;
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
     *  An evenly spaced subset: exactly one of `targetCount` (thin to N, maximizing
     *  spacing) or `minDistanceM` (keep as many as fit at that spacing).
     *  @unstable
     */
    storeSpaced: (selector: Selector, targetCount: number | null, minDistanceM: number | null) => Promise<SpacedPickResult>;
    /**
     *  An evenly spaced subset laid out on a honeycomb: exactly one of `targetCount` (at most
     *  N, spaced as widely as that allows) or `spacingM` (about that far apart, and never
     *  closer than half of it).
     *  @unstable
     */
    storeEvenlySpaced: (selector: Selector, targetCount: number | null, spacingM: number | null) => Promise<SpacedPickResult>;
    /**
     *  The points of a honeycomb about `spacingM` metres apart that fall inside the polygon,
     *  one entry per row of points.
     *  @unstable
     */
    honeycombPoints: (polygon: PolygonGeometry, spacingM: number) => Promise<HoneycombRun[]>;
    /**
     *  Up to `count` points drawn uniformly at random inside the polygon, as `[lng, lat]`
     *  pairs. Fewer come back when the polygon fills little of its bounding box.
     *  @unstable
     */
    polygonRandomPoints: (polygon: PolygonGeometry, count: number) => Promise<[number, number][]>;
    /**
     *  Points covering the polygon with no two closer than `spacingM` metres and no gap
     *  wider than about twice that, in random order.
     *  @unstable
     */
    polygonPoissonPoints: (polygon: PolygonGeometry, spacingM: number) => Promise<[number, number][]>;
    /**  Whether each of the points sits inside the polygon. @unstable */
    polygonContainsPoints: (polygon: PolygonGeometry, lats: number[], lngs: number[]) => Promise<boolean[]>;
    /**
     *  Bounding box `[west, south, east, north]` of the polygon itself, or `null` when it
     *  has no vertices. `west > east` means the box crosses the antimeridian.
     *  @unstable
     */
    polygonBounds: (polygon: PolygonGeometry) => Promise<[number, number, number, number] | null>;
    /**  Group by a derived key, returning `{ key, ids, bin }` per group. @unstable */
    storeGroupBy: (selector: Selector, field: string, key: KeySpec) => Promise<PartitionBucket[]>;
    /**
     *  Group locations by a derived key, returning counts only (no member ids) and how many
     *  distinct locations those groups cover.
     *  @unstable
     */
    storeCountBy: (selector: Selector, field: string, key: KeySpec) => Promise<CountBy>;
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
    /**  Bounding box `[west, south, east, north]`, or `null` when the set is empty. @unstable */
    storeBounds: (selector: Selector) => Promise<[number, number, number, number] | null>;
    /**
     *  Collect all matched locations as full rows. Prefer a projection (`storeColumns`,
     *  `storeValues`) when only specific fields are needed.
     *  @unstable
     */
    storeCollect: (selector: Selector) => Promise<Rows>;
    /**  Apply a field operation to every location matched by `selector`. @unstable */
    storeApplyFieldOp: (selector: Selector, op: FieldOp, recordUndo: boolean | null) => Promise<FieldOpResult>;
    /**  The parse error for `src`, or `null` when it parses. @unstable */
    fieldExprError: (src: string) => Promise<ExprError | null>;
    /**
     *  Count locations by country using offline point-in-polygon. Returns (ISO-A2, count) pairs.
     *  `level` selects border precision, falling back to "light" if unavailable.
     *  @unstable
     */
    storeCountryDistribution: (selector: Selector, level: string) => Promise<[string, number][]>;
    /**  Find all locations within `radiusM` metres of (`lat`, `lng`). @unstable */
    storeFindNearby: (lat: number, lng: number, radiusM: number) => Promise<Location[]>;
    /**
     *  For each input point, whether any existing location lies within `radiusM` metres.
     *  Batch form for probing many coordinates at once.
     *  @unstable
     */
    storeNearAny: (lats: number[], lngs: number[], radiusM: number) => Promise<boolean[]>;
    /**
     *  Patch an interned field's value metadata: get-or-create names, edit display
     *  metadata, reorder. Metadata only - membership writes go through the ordinary
     *  `listSet` field op. `tags` is the first (and so far only) interned field.
     *  @unstable
     */
    storePatchFieldValues: (field: string, patch: FieldValuesPatch) => Promise<FieldValuesResult>;
    /**  Undo the last edit. @unstable */
    storeUndo: () => Promise<MutationResult>;
    /**  Redo the last undone edit. @unstable */
    storeRedo: () => Promise<MutationResult>;
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
    /**  Fetch a single map's metadata by ID. Returns `null` if not found. @unstable */
    storeGetMap: (id: string) => Promise<MapMeta | null>;
    /**  Create a new empty map with default settings. Returns the full metadata. @unstable */
    storeCreateMap: (name: string, folder: string | null) => Promise<MapMeta>;
    /**
     *  Open the scratch map, creating it if this is its first use. Ordinary in every way
     *  except that `storeListMaps` leaves it out and it is emptied on every launch.
     *  @unstable
     */
    storeScratchMap: () => Promise<MapMeta>;
    /**  Delete a map and all its data permanently. @unstable */
    storeDeleteMap: (id: string) => Promise<null>;
    /**
     *  Apply a partial update to a map's metadata. Omitted fields are left unchanged.
     *  Returns a mutation result when the open map's field definitions changed.
     *  @unstable
     */
    storeUpdateMapMeta: (id: string, patch: MapMetaPatch_Deserialize) => Promise<MutationResult | null>;
    /**  Mark a map as opened now, for sorting the map list by recency. @unstable */
    storeTouchMapOpened: (mapId: string) => Promise<null>;
    /**  Rename a folder across all maps that reference it. @unstable */
    storeRenameFolder: (from: string, to: string) => Promise<null>;
    /**  Delete a folder, moving its maps to the root level. @unstable */
    storeDeleteFolder: (name: string) => Promise<null>;
    /**  Return aggregate database statistics: counts, file size, and configuration. @unstable */
    storeDbStats: () => Promise<DbStats>;
    /**
     *  Parse a file (JSON or ZIP of JSONs) and return a preview of each map found,
     *  without persisting anything. Call `bulkImportConfirm` to import the maps.
     *  @unstable
     */
    bulkImportPreview: (path: string) => Promise<ImportPreviewEntry[]>;
    /**
     *  Import the maps at `selectedIndices` from a previously previewed file.
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
     *  editor import dialog. Call `storeImportFile` to commit the import.
     *  @unstable
     */
    storeImportPreview: (path: string) => Promise<EditorImportPreview>;
    /**
     *  Parse pasted text (JSON or CSV) and stage it for preview. Works like
     *  `storeImportPreview` but reads from a string instead of a file.
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
     *  dropping fields in `droppedFields` (e.g. `"heading"`, `"extra.countryCode"`)
     *  and/or applying `tagName` to every imported location.
     *  @unstable
     */
    storeImportFile: (droppedFields: string[], tagName: string | null) => Promise<EditorImportResult>;
    /**  The location a pasted Maps URL names, short links resolved. @unstable */
    parseMapsUrl: (input: string) => Promise<ParsedLocation | null>;
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
    /**  Move a temp export file to `destPath` and remove the temp source. @unstable */
    storeSaveExportFile: (srcPath: string, destPath: string) => Promise<null>;
    /**
     *  Export every map as a ZIP of JSON files. Duplicate map names get a numeric suffix.
     *  Emits `bulk-export-progress` per map.
     *  @unstable
     */
    storeExportBulkZip: () => Promise<string>;
    /**
     *  Create a temp session directory for binary uploads. Files written into it are
     *  packaged by `storeUploadFinish`.
     *  @unstable
     */
    storeUploadBegin: () => Promise<string>;
    /**
     *  Package an upload session's files into a single output and remove the session
     *  directory. Returns a temp path for `storeSaveExportFile`.
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
     *  Import saved selections kept in local storage by older versions. No-op when
     *  rules already exist. Returns the number of rules imported.
     *  @unstable
     */
    storeImportLegacySavedSelections: (json: string) => Promise<number>;
    /**  Get all local-to-remote id mapping rows for a linked map. @unstable */
    remoteMappingGet: (provider: string, mapId: string) => Promise<RemoteMappingRow[]>;
    /**  Insert or update local-to-remote id mapping rows for a linked map. @unstable */
    remoteMappingUpsert: (provider: string, mapId: string, rows: RemoteMappingRow[]) => Promise<null>;
    /**  Remove specific mapping rows by `localIds` for a linked map. @unstable */
    remoteMappingDelete: (provider: string, mapId: string, localIds: number[]) => Promise<null>;
    /**  Drop all mapping rows for a linked map (unlink). @unstable */
    remoteMappingClear: (provider: string, mapId: string) => Promise<null>;
    /**
     *  Reconcile a linked map against its remote, pushing local changes and pulling
     *  remote ones. Returns the creates, updates, and deletes for each side to apply.
     *  @unstable
     */
    syncReconcile: (provider: string, mapId: string, remoteMapId: string, firstSync: FirstSyncMode | null, resolutions: ([string, ResolutionSide])[] | null) => Promise<SyncReconcileResult>;
    /**  The account behind the stored key, or null when no key is stored. @unstable */
    mapMakingMe: () => Promise<MmUser | null>;
    /**  Check `key` against the remote without storing it. @unstable */
    mapMakingValidate: (key: string) => Promise<MmUser>;
    /**  Linkable maps for the stored key. @unstable */
    mapMakingMaps: () => Promise<MmMapSummary[]>;
    /**  Store the API key, or clear it with null. @unstable */
    mapMakingSetKey: (key: string | null) => Promise<null>;
    /**  Local-only check: is a key stored? Says nothing about its validity. @unstable */
    mapMakingHasKey: () => Promise<boolean>;
    /**
     *  Open the GeoGuessr sign-in window and wait for authentication to complete.
     *  Returns the signed-in nickname.
     *  @unstable
     */
    geoguessrLogin: () => Promise<string>;
    /**  The signed-in user, or `null` when there is no session (or it was rejected). @unstable */
    geoguessrMe: () => Promise<GgUser | null>;
    /**  Sign out of GeoGuessr and clear the stored session. @unstable */
    geoguessrLogout: () => Promise<null>;
    /**  Local-only check: is a token stored? Says nothing about its validity. @unstable */
    geoguessrHasSession: () => Promise<boolean>;
    /**
     *  Generate locations from a Vali map definition (JSON text). Missing country
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
    /**  Country codes Vali has coverage data for. @unstable */
    valiCountries: () => Promise<string[]>;
    /**
     *  Countries whose downloaded coverage data is older than the published copy. Fails while
     *  offline; treat that as unknown, not up to date.
     *  @unstable
     */
    valiDataStatus: () => Promise<ValiCountryStatus[]>;
    /**
     *  Download exactly the countries `valiDataStatus` reports as out of date. No-op when nothing
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
     *  affect the open map. A `runId` from `procedureReserveRun` streams results under it and
     *  lets `procedureCancel` stop the run.
     *  @unstable
     */
    procedureRunRows: (providers: ProviderDecl[], force: boolean, rows: Location[], runId: number | null) => Promise<RowsRun>;
    /**  Stop a run before its next batch. Already-applied patches stay applied. @unstable */
    procedureCancel: (runId: number) => Promise<null>;
    /**
     *  Run a procedure's read-only `query` export. `input` and the result are defined
     *  by the procedure module. A `runId` from `procedureReserveRun` streams partial results
     *  under it and lets `procedureCancel` stop the query.
     *  @unstable
     */
    procedureQuery: (procedure: ProcedureDecl, input: string, runId: number | null) => Promise<string>;
    /**
     *  Reserve a run id up front, for a query or row run that answers only when it is over:
     *  its streamed results carry the id, and `procedureCancel` stops it.
     *  @unstable
     */
    procedureReserveRun: () => Promise<number>;
    /**  What the procedure engine is working on right now. @unstable */
    procedureActivity: () => Promise<ProcedureActivity>;
};
/** Events @unstable */
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
        listen: (cb: __TAURI_EVENT.EventCallback<StoreWarning>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<StoreWarning>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: StoreWarning) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<StoreWarning>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<StoreWarning>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: StoreWarning) => Promise<void>;
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
/** @unstable */
type AnonIssueRef = {
    number: number;
    url: string;
    /**
     *  Grants read access to this one issue's relayed comments. Not a credential for anything
     *  else, which is why it is safe to keep in local storage.
     */
    token: string;
};
/**  An image the reporter attached, once it is somewhere the issue can point at. @unstable */
type AttachmentRef = {
    url: string;
    /**
     *  Alt text for the reference. The worker decides it -- a client-supplied name reaches the
     *  rendered issue.
     */
    name: string;
};
/**  How a page of rows is cut into procedure calls. @unstable */
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
/**  Where the camera looks: the heading it faces and its pitch off level, in degrees. */
type CameraFrame = {
    heading: number;
    pitch: number;
};
/**  A marker removed from a render cell. */
type CellRemoval = {
    cell: string;
    cellIndex: number;
    id: number;
};
/**
 *  Per-field columns of the selected set. One value per row per field, `null` where a
 *  row lacks it; `"tags"` is a column of tag-id arrays.
 *  @unstable
 */
type Columns = unknown[][];
/**
 *  A commit's created and removed locations. An updated location appears in both
 *  `created` (new version) and `removed` (old version).
 *  @unstable
 */
type CommitDelta = {
    created: Location[];
    removed: Location[];
};
/**  Added, removed, and modified counts for a commit. @unstable */
type CommitDiff = {
    added: number;
    removed: number;
    modified: number;
};
/**  Metadata for a single commit. @unstable */
type CommitInfo = {
    id: string;
    mapId: string;
    parentId: string | null;
    message: string | null;
    treeHash: string | null;
    locationCount: number;
    createdAt: string;
} & CommitDiff;
/**  The new commit's ID and the resulting state update. @unstable */
type CommitResult = {
    id: string;
    status: MutationResult;
};
/**
 *  How a field's values are compared when measuring how strongly it separates
 *  groups (selection disambiguation). The only un-inferrable property a field can
 *  declare is circularity (heading/azimuth=360, hour-of-day=24, month=12);
 *  everything else is inferred from `FieldType`.
 */
type ComparisonType = {
    type: "linear";
} | {
    type: "circular";
    period: number;
} | {
    type: "categorical";
};
/** @unstable */
type Conflict = {
    key: string;
    kind: ConflictKind;
    /**  Base value is not persisted (only its hash), so conflicts surface local vs remote. */
    local: NormalizedSyncLocation | null;
    remote: NormalizedSyncLocation | null;
};
/** @unstable */
type ConflictKind = 
/**  Both sides modified the same location differently. */
"update-update" | 
/**  One side deleted while the other modified. */
"delete-update" | 
/**  Both sides added the same identity with different content (hash collision only). */
"add-add";
/**  Result of copying locations to another map. @unstable */
type CopyToMapResult = {
    copied: number;
    skipped: number;
    targetName: string;
};
/**
 *  Group counts. A list field puts one row in several groups, so the counts do not sum to
 *  the rows grouped.
 */
type CountBy = {
    counts: ([string, number])[];
    /**  Rows held by at least one group. */
    covered: number;
};
/**  The active and default data-folder paths, plus whether a custom override is in effect. @unstable */
type DataLocation = {
    path: string;
    /**  OS default, ignoring any override -- backs the "reset" affordance. */
    default_path: string;
    is_custom: boolean;
};
/**  Aggregate database statistics for the debug panel. @unstable */
type DbStats = {
    maps: number;
    /**  Locations across every map as of the last time each was saved. */
    locations: number;
    tags: number;
    commits: number;
    /**  Bytes the metadata database occupies, its write-ahead log included. */
    dbSizeBytes: number;
    /**  Bytes every map's location data occupies, saved commits included. */
    locationSizeBytes: number;
    journalMode: string;
    foreignKeys: boolean;
};
/**  What the user needs in order to authorize: the code to type and where to type it. @unstable */
type DeviceCodeInfo = {
    userCode: string;
    verificationUri: string;
    /**  Seconds until `userCode` stops working. */
    expiresIn: number;
};
/**
 *  Preview data for importing a file into the currently open map.
 *  Unlike bulk import, this shows per-field counts so the user can
 *  selectively drop fields (heading, panoId, etc.) before importing.
 *  @unstable
 */
type EditorImportPreview = {
    locationCount: number;
    /**  The file's tag piles, for the preview's tag list; ids are not meaningful yet. */
    tags: {
        [key in string]: unknown;
    }[];
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
 *  @unstable
 */
type EditorImportResult = {
    mutation: MutationResult;
    importedCount: number;
    warnings: string[];
    /**  True when the import was large enough to autocommit; the caller commits it. */
    autoCommit: boolean;
    /**  Settings carried by the import (`extra.settings`) */
    settings: {
        [key in string]: any;
    };
};
/**  Map state a change affected. Each field is `null` when it did not change. */
type EngineValues = {
    locationCount: number | null;
    canUndo: boolean | null;
    canRedo: boolean | null;
    /**
     *  Per-value row counts, keyed by field then by index key: one complete map per
     *  indexed field whose postings moved. Fields that did not move are absent.
     */
    valueCounts: {
        [key in string]: {
            [key in string]: number;
        };
    } | null;
    /**
     *  Per-value records (opaque piles), keyed by field then by interned id: one
     *  complete map per interned field whose records changed. JS coerces piles to its
     *  typed views (a tag) at its own boundary.
     */
    valueMeta: {
        [key in string]: {
            [key in number]: {
                [key in string]: unknown;
            };
        };
    } | null;
    /**
     *  The whole extra-field registry (`MapMeta.extra.fields` mirror), when a key was
     *  seen for the first time, erased, or the user edited a definition.
     */
    fieldDefs: {
        [key in string]: FieldDef;
    } | null;
};
/**
 *  Configuration for JSON export. Controls which fields are included and
 *  whether the export covers all locations or a specific selection.
 *  @unstable
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
 *  @unstable
 */
type ExportProgress = {
    current: number;
    total: number;
    mapName: string;
};
/**  Why an expression failed to parse. The sentence is TS's to write. @unstable */
type ExprError = {
    kind: "invalidNumber";
    position: number;
} | {
    kind: "unterminatedString";
} | {
    kind: "unexpectedCharacter";
    character: string;
    position: number;
} | {
    kind: "expectedSymbol";
    symbol: string;
} | {
    kind: "chainedComparison";
} | {
    kind: "unexpectedEnd";
} | {
    kind: "missingLeftOperand";
} | {
    kind: "hasTakesFieldName";
} | {
    kind: "unknownFunction";
    name: string;
} | {
    kind: "wrongArgCount";
    name: string;
    expected: number;
} | {
    kind: "unexpectedToken";
    token: string;
} | {
    kind: "trailingToken";
    token: string;
};
/**  A change another window made to a map, identified by `mapId`. @unstable */
type ExternalMutation = {
    mapId: string;
} & MutationResult;
/**
 *  Field presence count for the editor import preview dialog, letting
 *  the user see which optional fields exist and decide which to keep/drop.
 *  @unstable
 */
type FieldCount = {
    key: string;
    count: number;
};
/**
 *  Schema definition for a single `Location.extra` field. Stored in the map's
 *  `extra.fields` JSON. For enumerable types, `values` declares the value space in
 *  display order, each member carrying its own display name.
 */
type FieldDef = {
    type: FieldType;
    label: string | null;
    /**  The declared value space, in display order. */
    values: FieldValue[] | null;
    /**  How this field is compared during disambiguation. `null` infers it from the field type. */
    comparison: ComparisonType | null;
};
/**  A rewrite of one `extra` field across every location, computed per row. @unstable */
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
} | 
/**
 *  Add `add` and strip `remove` from a list-valued field, per row. The only op that
 *  reads the row's current value as a set rather than replacing it, which is what
 *  membership needs: `tags` is this op's first caller, `array` extras its second.
 *  `add` wins for a value named in both lists, and a row already in the requested
 *  state keeps its member order.
 */
{
    kind: "listSet";
    key: string;
    add: unknown[];
    remove: unknown[];
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
 *  One member of an enumerable field's value space: the stored value plus its display
 *  name. The value is the identity, so a rename is a label change and membership is
 *  untouched.
 */
type FieldValue = {
    value: string;
    label: string | null;
};
/**  One batch of record edits for an interned field's values. @unstable */
type FieldValuesPatch = {
    /**
     *  Seed piles to get-or-create, matched case-insensitively on their `name`.
     *  An existing name resolves to its id and the seed is dropped; a new one is
     *  interned as the seed.
     */
    create?: {
        [key in string]: unknown;
    }[];
    /**
     *  Merge patches into existing piles (null deletes a key). A patch whose `name`
     *  collides with another record's merges the two values instead of renaming:
     *  every row is remapped to the survivor in one undoable edit and the emptied
     *  record goes dark.
     */
    update?: (Update<{
        [key in string]: unknown;
    }>)[];
    /**  New display order: each id gets its index in this list as `order`. */
    reorder?: number[] | null;
};
/**
 *  The id resolved for each `create` seed in request order, plus the mutation carrying
 *  the updated records (and any rows a merge moved). JS coerces piles to its own view;
 *  nothing typed rides here.
 *  @unstable
 */
type FieldValuesResult = {
    resolved: number[];
    mutation: MutationResult;
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
/**  Reverse geocode result: nearest populated place to a coordinate. @unstable */
type GeoResult = {
    city: string;
    /**  First-level administrative division (state, province, region). */
    admin: string;
    /**  ISO 3166-1 alpha-2 (e.g. "US", "FR"). */
    country_code: string;
};
/**  The signed-in GeoGuessr account. @unstable */
type GgUser = {
    id: string;
    nick: string;
    /**  Avatar pin path (e.g. `pin/<hash>.png`), served under `/images/` on geoguessr.com. */
    pin: string | null;
};
/** @unstable */
type GhUser = {
    login: string;
    avatarUrl: string | null;
};
/**
 *  One row of honeycomb points: `count` points from `lng` eastward, each `lngStep` degrees
 *  apart.
 *  @unstable
 */
type HoneycombRun = {
    lat: number;
    lng: number;
    lngStep: number;
    count: number;
};
/** @unstable */
type IdQuery = {
    panoId: string;
};
type ImageSize = {
    height: number;
    width: number;
};
/**
 *  Summary of a single map found during bulk import preview.
 *  Shown in the import dialog so the user can select which maps to import.
 *  @unstable
 */
type ImportPreviewEntry = {
    /**  `null` when the file doesn't name the map. */
    name: string | null;
    folder: string | null;
    locationCount: number;
    tagCount: number;
    warnings: string[];
};
/**
 *  Progress event emitted per-map during bulk import, consumed by the frontend
 *  to drive a progress indicator.
 *  @unstable
 */
type ImportProgress = {
    current: number;
    total: number;
    mapName: string;
};
/**  Result returned per map after a successful bulk import. @unstable */
type ImportedMapInfo = {
    id: string;
    name: string;
    locationCount: number;
    tagCount: number;
};
/** @unstable */
type IssueComment = {
    author: string;
    body: string;
    /**  ISO-8601, as GitHub returns it. */
    createdAt: string;
};
/** @unstable */
type IssueRef = {
    number: number;
    url: string;
};
/**
 *  What became of a report, and what has been said on it. One shape for both transports so a
 *  signed-in and an anonymous report render identically.
 *  @unstable
 */
type IssueThread = {
    state: IssueState;
    /**
     *  `"completed"`, `"not_planned"` or `"reopened"`. Absent on an open issue, and on issues closed
     *  before GitHub recorded a reason.
     */
    stateReason: string | null;
    comments: IssueComment[];
};
/**  How a field value becomes a group key, for `storeGroupBy` and `storeCountBy`. */
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
    /**  The empty string means absent, the same absence a missing key has. */
    panoId: string | null;
    /**  The location's bits, such as whether it opens exactly its stored pano. */
    flags: number;
    /**
     *  Tag IDs applied to this location. References interned values of the `tags`
     *  field (`Tag.id`). Empty resolves to absent, so "untagged" is the ordinary
     *  `Nothas` on an absent field.
     */
    tags: number[];
    /**
     *  Arbitrary key-value metadata. Its keys are the `extra` fields, resolved by
     *  name past the builtins.
     */
    extra: {
        [key in string]: unknown;
    } | null;
    /**  Unix timestamp (seconds) */
    createdAt: number;
    modifiedAt: number | null;
};
/**
 *  Partial location update. Omitted fields are unchanged; `null` on panoId, extra or
 *  modifiedAt clears the field. `extra` is a JSON Merge Patch (RFC 7386): keys
 *  shallow-merge, null values delete.
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
 *  Partial location update. Omitted fields are unchanged; `null` on panoId, extra or
 *  modifiedAt clears the field. `extra` is a JSON Merge Patch (RFC 7386): keys
 *  shallow-merge, null values delete.
 *  @unstable
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
        [key in string]: FieldDef;
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
    /**
     *  The map's tag value records (opaque piles keyed by id-as-string), an open-time
     *  snapshot of the `maps.tags` column. JS coerces them to its tag view.
     */
    tags: {
        [key in string]: {
            [key in string]: unknown;
        };
    };
    labels: string[];
    locationCount: number;
    createdAt: string;
    updatedAt: string;
    lastOpenedAt: string | null;
};
/**
 *  Partial update for map metadata. Omitted fields are left unchanged.
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
        [key in string]: {
            [key in string]: unknown;
        };
    } | null;
    labels?: string[] | null;
};
/**
 *  Partial update for map metadata. Omitted fields are left unchanged.
 *  Setting `folder` to null moves the map to root.
 *  @unstable
 */
type MapMetaPatch = {
    name: string | null;
    description: string | null;
    folder: string | null;
    settings: MapSettings | null;
    scoreBounds: ScoreBounds | null;
    extra: MapExtra | null;
    tags: {
        [key in string]: {
            [key in string]: unknown;
        };
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
     *  Which member of a duplicate group survives a merge: a field expression scoring the
     *  location, highest wins. `null` (or blank) keeps the built-in ranking.
     */
    duplicateScore?: string | null;
    /**
     *  The order a review pass walks its worklist: a field expression scoring the location,
     *  highest first. `null` (or blank) keeps the order the selection resolved in.
     */
    reviewOrder?: string | null;
    /**  Whether a bulk pin resolves pano ids before pinning. */
    pinResolve?: boolean;
    /**  Which capture a bulk pin's resolve settles on; `null` keeps the pano as found. */
    pinCapture?: CapturePick | null;
};
/**  A map the key holder can link to. @unstable */
type MmMapSummary = {
    id: string;
    name: string;
    locationCount: number;
};
/**  The account an API key belongs to. @unstable */
type MmUser = {
    id: number;
    username: string;
};
/**  What one change did to the open map. */
type MutationResult = {
    version: number;
    delta: RenderDelta;
    selectionSync: SelectionSync | null;
    values: EngineValues;
};
/**
 *  The syncable contract: the only fields that participate in diffing. Everything else is
 *  owned by exactly one side and would register as a phantom change.
 *  @unstable
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
/**  A decoded Street View panorama: flat data with no live objects. */
type Pano = {
    /**  This image's own pano id, "" when the response carries no key. */
    id: string;
    /**  Which imagery collection the id belongs to; also what `extra.panoType` stores. */
    panoFrontend: number;
    lat: number;
    lng: number;
    altitude: number;
    /**  The camera's orientation. The Maps JS API builds its whole tile frame out of this. */
    pov: Pov | null;
    worldSize: ImageSize;
    tileSize: ImageSize;
    copyright: string;
    /**  `description.description[].text`, joined with ", ". */
    description: string;
    /**  The first of those parts alone, which is what the Maps JS API calls the short description. */
    shortDescription: string;
    uploaderName: string | null;
    countryCode: string | null;
    /**  Non-null marks an indoor/tripod pano; a level carrying no id still counts. */
    levelId: number | null;
    /**  Neighbouring panos, resolved to ids. */
    links: PanoLink[];
    /**  Capture timeline, ascending. */
    time: PanoTime[];
    /**  This image's own capture date; month and day are 0 when absent. */
    date: PanoDate | null;
    /**  "launch" = car, "scout" = the special-collects pipeline. */
    source: string | null;
    /**  This image's own capture month as `YYYY-MM`, "" when it carries no date. */
    imageDate: string;
    /**  Every capture month in the timeline, ascending. */
    coverageDates: string[];
    /**
     *  The heading at the horizontal centre of the image, which is also the driving
     *  direction on car coverage.
     */
    centerHeading: number;
    cameraFrame: CameraFrame;
    cameraType: CameraType | null;
};
/**
 *  What one query resolved to. `skipped` is a query the host never answered: an aborted
 *  run, or an id query whose id is empty.
 *  @unstable
 */
type PanoAnswer = {
    state: "found";
    pano: Pano;
} | {
    state: "notFound";
} | {
    state: "failed";
} | {
    state: "skipped";
};
type PanoDate = {
    year: number;
    month: number;
    day: number;
};
type PanoLink = {
    panoId: string;
    heading: number;
};
/**  One pano lookup: a pano id resolves over GetMetadata, a search over SingleImageSearch. @unstable */
type PanoQuery = IdQuery | SearchQuery;
type PanoTime = {
    panoId: string;
    /**  The civil day, `YYYY-MM-DD`. */
    date: string;
};
/**  A single location parsed out of a pasted Maps URL. @unstable */
type ParsedLocation = {
    lat: number;
    lng: number;
    heading: number;
    pitch: number;
    zoom: number;
    panoId: string | null;
    flags: number;
    /**  Tag names. */
    tags: string[];
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
/**  A published build of a plugin. @unstable */
type PluginBuild_Deserialize = {
    version: string;
    ref: string;
    minAppVersion: string | null;
};
/**  A published build of a plugin. */
type PluginBuild = {
    version: string;
    ref: string;
    minAppVersion?: string | null;
};
/**  Metadata for a user-installed plugin, read from `plugins/{id}/manifest.json`. @unstable */
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
    /**  Older builds, for apps below `minAppVersion`. Only present in the marketplace registry. */
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
    /**  Older builds, for apps below `minAppVersion`. Only present in the marketplace registry. */
    builds?: PluginBuild[];
};
/**  A plugin's declared sidecar binary (downloaded from GitHub Releases on install). @unstable */
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
 *  GeoJSON-like polygon geometry. `coordinates` is the primary polygon (outer ring and
 *  optional holes); `extraPolygons` holds any further polygons of a multipolygon.
 */
type PolygonGeometry = {
    coordinates: (([number, number])[])[];
    extraPolygons: ((([number, number])[])[])[] | null;
    properties?: any | null;
};
type Pov = {
    heading: number;
    tilt: number;
    roll: number;
};
/** @unstable */
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
/**  Everything the procedure engine has in flight at one instant. @unstable */
type ProcedureActivity = {
    /**  The providers working right now. */
    runs: ProviderActivity[];
    /**  The procedures answering a question right now. */
    queries: QueryActivity[];
    /**  Requests answered per second over the last few seconds, across everything running. */
    requestsPerSecond: number;
};
/**
 *  What every entry point of a procedure receives as its last argument: the engine's view of
 *  the run and the procedure's own configuration.
 *  @unstable
 */
type ProcedureConfig<T> = {
    /**  The extra-field keys the run wants written. Empty means every key the procedure produces. */
    fields: string[];
    /**  Recompute rows that already hold every wanted field. */
    force: boolean;
    /**  The procedure's own configuration, or null when none was declared or it did not parse. */
    config: T | null;
};
/**
 *  A procedure module and the network limits every call to it gets, whether it runs over
 *  locations or answers a question.
 *  @unstable
 */
type ProcedureDecl = {
    /**  The procedure module: an absolute path, or `res://<rel>` for one bundled with the app. */
    entry: string;
    rate?: RateSpec | null;
    retry?: RetrySpec | null;
    /**
     *  Requests one run or one query of the procedure may have in flight at once. A run's
     *  instances share the budget; a separate run or query gets its own.
     */
    inflight?: number | null;
    /**
     *  Procedure-specific configuration, a JSON value as text. Passed through verbatim
     *  inside the config object every entry point receives.
     */
    config?: string | null;
};
/** @unstable */
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
 *  @unstable
 */
type ProcedureResult = {
    runId: number;
    providerId: string;
    entries: ResultEntry[];
    /**  Rows the procedure failed, or every row of a batch whose call failed. */
    failed: number[];
};
/**  One provider working its share of a run. @unstable */
type ProviderActivity = {
    /**  The run this provider belongs to. */
    runId: number;
    /**  The provider's id. */
    providerId: string;
    /**  The provider's display name, where it has one. */
    label: string | null;
    /**  Locations the provider was handed. */
    total: number;
    /**  Locations it has finished. */
    done: number;
    /**  Locations it could not work. */
    failed: number;
    /**  Locations that already held everything it produces. */
    skipped: number;
    /**  Copies of the procedure working its queue. */
    instances: number;
    /**  Requests outstanding at this instant. */
    inflight: number;
    /**  The most requests the provider may keep outstanding. */
    inflightLimit: number;
    /**  Requests parked until the provider's rate limit lets them through. */
    rateWaiting: number;
    /**  Requests retried so far in this run. */
    retries: number;
};
/**
 *  One provider as declared by the frontend. `fields` are the extra keys it produces
 *  and `requires` the keys it consumes; together they gate who waits for whom.
 *  @unstable
 */
type ProviderDecl = {
    id: string;
    label?: string | null;
    fields?: string[];
    requires?: string[];
    invalidates?: {
        [key in string]: string[];
    };
    select: Selector;
    batch: BatchMode;
    sink?: Sink;
    /**
     *  Re-derive this provider's fields even on a run that is not forced. For an
     *  operation whose whole point is to recompute one provider (pinning re-resolves the
     *  panorama) rather than to fill in what is missing.
     */
    force?: boolean | null;
    /**
     *  Instances this provider may run at once. Declared only when the procedure
     *  cannot run beside itself; throughput comes from `inflight`.
     */
    instances?: number | null;
} & ProcedureDecl;
/**  A location created on the remote side, to add locally. @unstable */
type PullCreate = {
    fields: NormalizedSyncLocation;
    remoteId: number;
    hash: string;
};
/**  A remote-originated update for JS to apply to an existing local id. @unstable */
type PullUpdate = {
    localId: number;
    patch: SyncPatch;
};
/**  The questions one procedure is answering, taken together. @unstable */
type QueryActivity = {
    /**  The procedure answering. */
    entry: string;
    /**  Requests outstanding at this instant. */
    inflight: number;
    /**  The most requests it may keep outstanding. */
    inflightLimit: number;
    /**  Requests retried so far by the queries in flight. */
    retries: number;
};
/**  Rate limit: `units` calls per `perMs` milliseconds, refilled continuously. @unstable */
type RateSpec = {
    units: number;
    perMs: number;
    cost?: RateCost;
};
/**  One mapping row. `hash` is the plugin's content fingerprint (opaque text to us). @unstable */
type RemoteMappingRow = {
    localId: number;
    /**  Remote ids can exceed u32 (observed ~1.2e10), so i64. */
    remoteId: number;
    hash: string;
};
/**  Marker changes after an edit: added, updated, and removed markers. */
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
    /**  The selection drawing this marker, or `null` when no selection does. */
    sel: SelPaint | null;
    /**
     *  The slot this row vacated when it crossed cells. Present only for a move, so JS
     *  mirrors the swap-remove and carries the overlay entry across instead of inferring
     *  a move from an unrelated removed/added pair.
     */
    movedFrom: CellRemoval | null;
};
/**
 *  Update to an existing marker within its cell. Position and heading are `null` when
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
 *  Parameters for a full marker rebuild. `markerStyle` ("arrow" or "pin") decides whether
 *  headings are drawn.
 *  @unstable
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
 *  One location's answer from a `Collect` provider: whatever its module emitted for
 *  that row, carried as text exactly as a patch would be.
 *  @unstable
 */
type ResultEntry = {
    id: number;
    json: string;
};
/**  Retry only the listed HTTP statuses, up to `attempts` total tries. @unstable */
type RetrySpec = {
    attempts: number;
    on: number[];
};
/**
 *  Parameters for creating a review session. `order` is the frozen worklist (must be
 *  non-empty); the cursor starts at its first id.
 *  @unstable
 */
type ReviewCreate = {
    mapId: string;
    name: string;
    sourceKey: string;
    sourceProps: any;
    order: number[];
};
/**  A review session: a frozen worklist of locations with progress tracking. @unstable */
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
/**  Partial update for a review session. Omitted fields are left unchanged. @unstable */
type ReviewUpdate = {
    id: string;
    name?: string | null;
    cursorId: number | null;
    reviewed: number[] | null;
    ordering: number[] | null;
    status: string | null;
};
/**  Matched locations: returned inline, or as a file path to read them from. @unstable */
type Rows = {
    kind: "inline";
    locations: Location[];
} | {
    kind: "file";
    path: string;
};
/**  Rows after a run over them, and the ids each provider failed. @unstable */
type RowsRun = {
    rows: Location[];
    failed: {
        [key in string]: number[];
    };
};
/**  Bytes written by a save; 0 when there was nothing to save. @unstable */
type SaveResult = {
    savedBytes: number;
};
/** @unstable */
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
 *  @unstable
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
/**
 *  The full SingleImageSearch request surface. Every optional field defaults to what the
 *  Maps JS API sends for `getPanorama({location, radius})`.
 *  @unstable
 */
type SearchQuery = {
    lat: number;
    lng: number;
    radius: number;
    /**  Frontends to search, as `PanoType` values; all of them when absent. */
    sources?: number[] | null;
    /**  A `RankingStrategy` value; closest when absent, matching the wire default. */
    preference?: number | null;
    /**  Only coverage captured in `(start, end]`, Unix seconds. */
    dateRange?: [number, number] | null;
    /**  Component mask; the full set when absent. */
    components?: number[] | null;
};
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
    locationIds?: number[] | null;
    since?: number | null;
};
/**  Map ID and display name for seen-history filtering. */
type SeenMapInfo = {
    id: string;
    name: string;
};
/**  Parameters for recording a panorama visit. @unstable */
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
 *  A named, colored selection. `key` is deterministic (JS mints it) so selections can be
 *  diffed across syncs; `Selection::of` keys internal queries by their serialized selector.
 *  `color` is the RGB overlay color.
 */
type Selection = {
    key: string;
    color: [number, number, number];
    selector: Selector;
};
/**  A top-level selection, plus whether it is ghosted. @unstable */
type SelectionInput = {
    /**  Counted, but kept out of the overlay and the selected set. */
    ghosted?: boolean;
} & Selection;
/**  Updated selection state after a change. `counts` gives each selection's match count. */
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
 *  for JS interop. Simple types resolve in O(N) with parallel batch scans, or from an
 *  inverted index when one covers the filtered field. Composites (Intersection, Union,
 *  Invert) recursively resolve children. Duplicates uses a grid-accelerated spatial scan.
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
} | 
/**
 *  Rank a selection by a field expression, optionally keeping only the first `k`. Emits
 *  a ranked root in rank order, where every other selector answers ascending. With no
 *  `k` this selects its child unchanged and states only how to walk it. A member the
 *  expression cannot score ranks last, so ranking never drops anything.
 */
{
    type: "Ranked";
    /**  What to rank; `null` ranks the whole map. */
    selection: Selection | null;
    expr: string;
    k: number | null;
    ascending: boolean;
};
/** @unstable */
type SideCounts = {
    create: number;
    update: number;
    delete: number;
};
/** @unstable */
type SidecarDone = {
    reqId: number;
    error: string | null;
};
/** @unstable */
type SidecarLine = {
    reqId: number;
    line: string;
};
/**  A log line from a plugin's sidecar. @unstable */
type SidecarLog = {
    reqId: number;
    line: string;
};
/** @unstable */
type SidecarProgress = {
    pluginId: string;
    downloaded: number;
    total: number;
};
/**  A spaced pick's answer: the picked ids plus the spacing they were picked at. @unstable */
type SpacedPickResult = {
    ids: number[];
    distanceM: number;
};
/**
 *  Open-time snapshot: the same `values` a mutation result carries, with every field
 *  present. The one full picture JS ever receives; everything after is a delta.
 *  @unstable
 */
type StoreStatus = {
    version: number;
    values: EngineValues;
};
/**  What the store has to warn the user about. The sentence is TS's to write. @unstable */
type StoreWarning = 
/**  The uncommitted delta was unreadable; the map opened from its last commit. */
{
    kind: "deltaSetAside";
};
/**  Lightweight status for polling: count, version, and whether unsaved changes exist. @unstable */
type SummaryResult = {
    locationCount: number;
    version: number;
    dirtyCount: number;
};
/**
 *  Only the fields a pull genuinely changes. A field the provider cannot represent reads as empty
 *  on the remote side and must not overwrite local data, so absent fields are left untouched.
 *  `panoId` applies only when `panoIdSet` is true, since a cleared panoId is a real change to `null`.
 *  @unstable
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
/**  Everything the reconcile settled to, for the JS side. Every array is empty on an unchanged map. @unstable */
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
 *  Generic `{id, patch}` update envelope, parameterized by the patch type. Specta
 *  has no `Partial<T>`, and a patch is a deliberate *subset* of patchable fields, so
 *  each entity names its own patch struct (e.g. `TagPatch`) rather than deriving one.
 */
type Update<P> = {
    id: number;
    patch: P;
};
/** @unstable */
type UpdateAvailable = {
    version: string;
    currentVersion: string;
    notes: string | null;
};
/**  Download progress, emitted per chunk. `total` is absent when the server sends no length. @unstable */
type UpdateProgress = {
    downloaded: number;
    total: number | null;
};
/**  How far behind one country's downloaded coverage data is. @unstable */
type ValiCountryStatus = {
    countryCode: string;
    files: number;
    bytes: number;
};
/** @unstable */
type ValiLocation_Deserialize = {
    lat: number;
    lng: number;
    heading: number;
    zoom: number | null;
    pitch: number | null;
    panoId: string | null;
    tags: string[];
};
/** @unstable */
type ValiLocation = {
    lat: number;
    lng: number;
    heading: number;
    zoom?: number | null;
    pitch?: number | null;
    panoId?: string | null;
    tags: string[];
};
/** @unstable */
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
 * optional `query`. Every entry point receives the run's `{ fields, force, config }` as its
 * last argument. Rows arrive as `Location`s and `run`/`map` answer
 * with `Update<LocationPatch>`s under the `patch` sink, or `Update<T>` of the module's
 * own answer under `collect`.
 *  @unstable
 */

interface ProcedureRequest {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | ArrayBuffer;
}
/** @unstable */
interface ProcedureResponse {
    /** 0 when the host could not issue the request at all. */
    status: number;
    body: Uint8Array;
}
/** @unstable */
export interface ProcedureNeighbor {
    id: number;
    lat: number;
    lng: number;
    distM: number;
    [field: string]: unknown;
}
/** @unstable */
interface ProcedureHost {
    fetch(req: ProcedureRequest): ProcedureResponse;
    fetchMany(reqs: ProcedureRequest[]): ProcedureResponse[];
    /** Every query resolved to its pano, aligned to `queries`: an id query over
     *  GetMetadata (deduped, batched, bisection-retried), a search query over
     *  SingleImageSearch. `skipped` is a query the host never answered: an aborted run,
     *  or an id query whose id is empty. */
    panos(queries: PanoQuery[]): PanoAnswer[];
    classify(dataset: string, lat: number, lng: number): string | null;
    /** Locations within `radiusM` metres of a coordinate, nearest first, each carrying
     *  whichever of `fields` it had. The host builds one index per (radius, fields) pair
     *  and holds it for the run, so asking once per row is the intended use; varying
     *  either argument mid-run rebuilds it. A location at the exact coordinate is
     *  included, so a caller probing its own row drops itself by id, and a radius of 0
     *  answers exactly that coordinate. Only a run has locations to search; a query that
     *  asks throws. */
    neighbors(lat: number, lng: number, radiusM: number, fields?: string[]): ProcedureNeighbor[];
    /** Run one sidecar command. `onLine` sees each output line as it arrives, so a
     *  procedure can report progress mid-run; the lines are also returned together. */
    sidecar(pluginId: string, command: string, payloadJson: string, onLine?: (line: string) => void): string[];
    /** 0 debug, 1 info, 2 warn, 3 error. `console.*` routes here. */
    log(level: number, msg: string): void;
    progress(units: number): void;
    /** IANA timezone at a coordinate, or null outside the valid range. Pure compute,
     *  available to every procedure shape. @unstable */
    tz(lat: number, lng: number): string | null;
    /** Marks a row as failed rather than skipped. */
    fail(id: number): void;
    /** Delivers one partial result to the caller while the call is still running, under
     *  an id of the procedure's choosing. Queries stream these to whoever asked; runs
     *  discard them. */
    emit(id: number, value: unknown): void;
    aborted(): boolean;
}
declare global {
    /** Reachable inside a procedure module only. `fetch`, `fetchMany`, `panos` and
     *  `sidecar` are detached outside `run` and `query`; calling one elsewhere throws. */
    const mma: ProcedureHost;
}

/** @unstable */
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
/** @unstable */
export type D = keyof Digits;
/** Lift a single-item curried transform into one that folds over an array of items. @unstable */
declare const batch: <T, S>(op: (item: T) => (state: S) => S) => (items: T[]) => (state: S) => S;
/** @unstable */
export type RequireNonNull<T> = {
    [P in keyof T]-?: NonNullable<T[P]>;
};
/** @unstable */
export type Nullable<T> = {
    [K in keyof T]: T[K] | null;
};
/** @unstable */
export type Rename<T, Map extends Record<string, string>> = {
    [K in keyof T as K extends keyof Map ? Map[K] : K]: T[K];
};
/** The member(s) of union `U` whose discriminant `D` (default `"type"`) is `V`. @unstable */
export type Variant<U, V extends U[D], D extends keyof U = "type" & keyof U> = Extract<U, Record<D, V>>;

/** A field definition with every optional attribute spelled absent. */
declare function createFieldDef(type: FieldType, over?: Partial<Omit<FieldDef, "type">>): FieldDef;
/** A tag's display identity: name, color, sidebar order, and document links. */
export interface Tag {
    id: number;
    name: string;
    color: string;
    /** True while at least one location carries the tag. */
    visible: boolean;
    order: number | null;
    doclinks: string[];
}
/** Partial update to a tag's editable display metadata; `null` clears the field. */
export type TagPatch = {
    [K in "name" | "color" | "doclinks"]?: Tag[K] | null;
};
/** Street View camera orientation (POV). @unstable */
export type LocationPOV = Pick<Location, "heading" | "pitch" | "zoom">;
/** A view on a specific panorama. @unstable */
export type PanoView = LocationPOV & RequireNonNull<Pick<Location, "panoId">>;
/** The camera fields a Location and the live Street View viewer share. @unstable */
export type PanoCapture = LocationPOV & Pick<Location, "lat" | "lng" | "panoId">;
/** A {lat, lng} coordinate pair. */
export type LatLng = google.maps.LatLngLiteral;
/** A {west, south, east, north} bounding box. */
export type Bounds = google.maps.LatLngBoundsLiteral;
/** True when bounds span the entire world. */
declare function isWorldBounds(b: Bounds): boolean;
/** Convert a [south, west, north, east] tuple to a Bounds object. @unstable */
declare function scoreTupleToBounds([s, w, n, e]: [number, number, number, number]): Bounds;
/** Convert a [west, south, east, north] bbox tuple to Bounds, or null. @unstable */
declare function bboxTupleToBounds(t: [number, number, number, number] | null): Bounds | null;
/** Convert a Bounds object to a [south, west, north, east] tuple. @unstable */
declare function boundsToScoreTuple(b: Bounds): [number, number, number, number];
/** Pinned: the location always opens this exact pano. */
declare function isPinned(loc: Location): loc is Location & {
    panoId: string;
};
/** The location pinned to the pano it carries, or unpinned to float on default coverage. */
declare function setPinned(loc: Location, on: boolean): Location;
/** The `extra` merge patch that turns `before` into `after`: changed keys carry their
 *  new value, keys `after` lacks carry null. */
declare function extraPatch(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Record<string, unknown>;
/** The same location on the same pano: what makes one row's answer another row's. @unstable */
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
/** True when the location is an import preview (not yet committed). @unstable */
declare function isImportPreview(loc: Location): boolean;
/** True when the location is a seen-history overlay preview. @unstable */
declare function isSeenPreview(loc: Location): boolean;
/** Build a Location from lat/lng plus overrides. `id` stays 0 until `addLocations`
 *  writes the real id back into the object. */
declare function createLocation(partial: Partial<Location> & LatLng): Location;
/** A new Location at the viewer's live camera, carrying `source`'s flags and the given
 *  tags. `extra` describes the pano it was fetched for, so it only survives a drop that
 *  stayed on that pano. @unstable */
declare function dropLocation(source: Location, live: PanoCapture, panoId: string | null, tags: number[]): Location;
/** Apply a LocationPatch to a location. `extra` follows JSON Merge Patch (RFC 7386):
 *  keys shallow-merge, a null value deletes its key, and a null patch clears extra. */
declare function applyLocationPatch(loc: Location, patch: LocationPatch_Deserialize): Location;
/** @unstable */
export type SortMode = "name" | "created" | "opened" | "amount";
/** @unstable */
export type TagSortMode = "default" | "name" | "amount";
/** @unstable */
export type WorkArea = "overview" | "location" | "duplicates" | "import" | "plugin" | "diff";
/** Hex like "#1098ad"; legacy stored prefs may hold an Open Props ramp name. */
export type SvColor = string;
export type MapTypeKey = "map" | "satellite" | "osm" | "vector";
export type SvCoverageType = "official" | "unofficial" | "default";
export type SvThickness = "default" | "high";
export type MarkerStyle = "pin" | "circle" | "arrow";

/** @unstable */
export type types_Bounds = Bounds;
/** @unstable */
export type types_LatLng = LatLng;
/** @unstable */
export type types_LocationPOV = LocationPOV;
/** @unstable */
export type types_MapTypeKey = MapTypeKey;
/** @unstable */
export type types_MarkerStyle = MarkerStyle;
/** @unstable */
export type types_MaybeLocation = MaybeLocation;
/** @unstable */
export type types_PanoCapture = PanoCapture;
/** @unstable */
export type types_PanoView = PanoView;
/** @unstable */
export type types_SortMode = SortMode;
/** @unstable */
export type types_SvColor = SvColor;
/** @unstable */
export type types_SvCoverageType = SvCoverageType;
/** @unstable */
export type types_SvThickness = SvThickness;
/** @unstable */
export type types_Tag = Tag;
/** @unstable */
export type types_TagPatch = TagPatch;
/** @unstable */
export type types_TagSortMode = TagSortMode;
/** @unstable */
export type types_WorkArea = WorkArea;
declare const types_applyLocationPatch: typeof applyLocationPatch;
/** @unstable */
declare const types_bboxTupleToBounds: typeof bboxTupleToBounds;
/** @unstable */
declare const types_boundsToScoreTuple: typeof boundsToScoreTuple;
declare const types_createFieldDef: typeof createFieldDef;
declare const types_createLocation: typeof createLocation;
/** @unstable */
declare const types_dropLocation: typeof dropLocation;
declare const types_extraPatch: typeof extraPatch;
/** @unstable */
declare const types_isImportPreview: typeof isImportPreview;
declare const types_isPinned: typeof isPinned;
/** @unstable */
declare const types_isSeenPreview: typeof isSeenPreview;
declare const types_isVirtualLocation: typeof isVirtualLocation;
declare const types_isWorldBounds: typeof isWorldBounds;
declare const types_locId: typeof locId;
/** @unstable */
declare const types_sameRow: typeof sameRow;
/** @unstable */
declare const types_scoreTupleToBounds: typeof scoreTupleToBounds;
declare const types_setPinned: typeof setPinned;
declare namespace types {
  export { types_applyLocationPatch as applyLocationPatch, types_bboxTupleToBounds as bboxTupleToBounds, types_boundsToScoreTuple as boundsToScoreTuple, types_createFieldDef as createFieldDef, types_createLocation as createLocation, types_dropLocation as dropLocation, types_extraPatch as extraPatch, types_isImportPreview as isImportPreview, types_isPinned as isPinned, types_isSeenPreview as isSeenPreview, types_isVirtualLocation as isVirtualLocation, types_isWorldBounds as isWorldBounds, types_locId as locId, types_sameRow as sameRow, types_scoreTupleToBounds as scoreTupleToBounds, types_setPinned as setPinned };
  export type { types_Bounds as Bounds, types_LatLng as LatLng, types_LocationPOV as LocationPOV, types_MapTypeKey as MapTypeKey, types_MarkerStyle as MarkerStyle, types_MaybeLocation as MaybeLocation, types_PanoCapture as PanoCapture, types_PanoView as PanoView, types_SortMode as SortMode, types_SvColor as SvColor, types_SvCoverageType as SvCoverageType, types_SvThickness as SvThickness, types_Tag as Tag, types_TagPatch as TagPatch, types_TagSortMode as TagSortMode, types_WorkArea as WorkArea };
}

/** An [r, g, b] byte tuple. */
export type RGB = [number, number, number];
/** An [r, g, b, a] byte tuple. @unstable */
export type RGBA = [...RGB, number];
/** Parse "#rrggbb" to an [r, g, b] byte tuple. @unstable */
declare function hexToRgb(hex: string): RGB;
/** Return "#000" or "#fff" for readable text on the given hex background. @unstable */
declare function textColorFor(bg: string): string;
/** Resolve an SV coverage color to hex. Accepts "#rrggbb" or a CSS custom-property
 *  ramp name (legacy stored format). @unstable */
declare function resolveSvColorHex(color: string): string;
/** Set the app's `--accent` and `--on-accent` CSS custom properties from a hex color. @unstable */
declare function applyAccentColor(hex: string): void;
/** Convert "#rrggbb" to {h, s, l} (degrees, percent, percent). @unstable */
declare function hexToHsl(hex: string): {
    h: number;
    s: number;
    l: number;
};
/** Convert HSL (degrees, percent, percent) to "#rrggbb". @unstable */
declare function hslToHex(h: number, s: number, l: number): string;
/** Convert HSL (h in degrees, s and l in 0-1) to an RGB byte tuple. @unstable */
declare function hslToRgb(h: number, s: number, l: number): RGB;
/**
 * Deterministic tag color from a name.
 *  @unstable
 */
declare function colorForName(name: string): string;
/** Format an RGB tuple as a CSS `rgb(r, g, b)` string. @unstable */
declare function rgbCss([r, g, b]: RGB): string;
/** Convert an RGB byte tuple to "#rrggbb". @unstable */
declare function rgbToHex([r, g, b]: RGB): string;
/** A label's color: a user override if set, else a deterministic color from its name. @unstable */
declare function labelColor(name: string, overrides: Record<string, string>): string;

/** @unstable */
export type colorUtils_RGB = RGB;
/** @unstable */
export type colorUtils_RGBA = RGBA;
/** @unstable */
declare const colorUtils_applyAccentColor: typeof applyAccentColor;
/** @unstable */
declare const colorUtils_colorForName: typeof colorForName;
/** @unstable */
declare const colorUtils_hexToHsl: typeof hexToHsl;
/** @unstable */
declare const colorUtils_hexToRgb: typeof hexToRgb;
/** @unstable */
declare const colorUtils_hslToHex: typeof hslToHex;
/** @unstable */
declare const colorUtils_hslToRgb: typeof hslToRgb;
/** @unstable */
declare const colorUtils_labelColor: typeof labelColor;
/** @unstable */
declare const colorUtils_resolveSvColorHex: typeof resolveSvColorHex;
/** @unstable */
declare const colorUtils_rgbCss: typeof rgbCss;
/** @unstable */
declare const colorUtils_rgbToHex: typeof rgbToHex;
/** @unstable */
declare const colorUtils_textColorFor: typeof textColorFor;
declare namespace colorUtils {
  export { colorUtils_applyAccentColor as applyAccentColor, colorUtils_colorForName as colorForName, colorUtils_hexToHsl as hexToHsl, colorUtils_hexToRgb as hexToRgb, colorUtils_hslToHex as hslToHex, colorUtils_hslToRgb as hslToRgb, colorUtils_labelColor as labelColor, colorUtils_resolveSvColorHex as resolveSvColorHex, colorUtils_rgbCss as rgbCss, colorUtils_rgbToHex as rgbToHex, colorUtils_textColorFor as textColorFor };
  export type { colorUtils_RGB as RGB, colorUtils_RGBA as RGBA };
}

/** Per-cell, per-selection membership: a dense bitmask or a sparse selected-index list. @unstable */
export type SelEntry = {
    kind: "mask";
    mask: Uint8Array;
} | {
    kind: "idx";
    indices: Uint32Array;
};
/** @unstable */
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

/** Pure selection transforms: build, compose, invert, rewrite, and remove selections. @unstable */

export interface SelectionState {
    selections: Selection[];
    ghosted: ReadonlySet<string>;
}
/** @unstable */
export type SelectionPatch = Partial<SelectionState>;
/** Selector variants that wrap child selections (Intersection, Union, Invert). @unstable */
export type CompositeType = Extract<Selector, {
    selections: Selection[];
}>["type"];
/** Composite variants that wrap exactly one child (e.g. Invert). @unstable */
export type UnaryType = "Invert";
/** Composite variants that are flat n-ary groups. @unstable */
export type GroupType = Exclude<CompositeType, UnaryType>;
/** @unstable */
declare const UNARY_TYPES: readonly ["Invert"];
/** @unstable */
export type FilterOpKind = FilterOp["op"];
/** Whether a predicate reads the location's clock in its own timezone. Only a range can. @unstable */
declare const filterIsLocalTime: (test: FilterOp) => boolean;
/** Display symbol/word for each filter operator. Symbols are language-neutral; only the worded
 *  operators are marked for translation. @unstable */
declare const OP_LABELS: Record<FilterOpKind, string>;
/** Locations carrying `tagId`. A tag is membership in the `tags` list field and nothing
 *  else, so there is no tag selector to build. @unstable */
declare const tagSelector: (tagId: number) => Selector;
/** Locations with no tags: `tags` resolves to nothing on an untagged row. @unstable */
declare const untaggedSelector: () => Selector;
/** Locations whose heading was never set. @unstable */
declare const unpannedSelector: () => Selector;
/** Locations pinned to one exact pano (the flag plus a pano id, mirroring Rust's
 *  `Selector::pano_ids`), or the locations not pinned. @unstable */
declare function panoIdSelector(on: boolean): Selector;
/** The tag a selector names, or null when it names something else. The single place that
 *  recognises tag membership, so nothing else has to know its shape. @unstable */
declare function tagIdOf(selector: Selector): number | null;
/** Whether a selector is the pinned composite `panoIdSelector` builds (`true`), its
 *  inversion (`false`), or something else (`null`). Display-only. @unstable */
declare function panoIdOf(selector: Selector): boolean | null;
/** Deterministic color derived from a selection key string. @unstable */
declare function colorForKey(key: string): RGB;
/** Key an id list by hashing it: the same ids in the same order give the same key.
 *  Order-sensitive, like the list it identifies. Key length is constant. @unstable */
declare function locationsKey(ids: number[]): string;
/** Ghost keys that "solo" `key`: everything except it. Returns an empty set when `key`
 *  is already the sole visible selection, so a repeat call un-isolates (clears all ghosts). @unstable */
declare function isolateGhostKeys(keys: string[], ghosted: ReadonlySet<string>, key: string): Set<string>;
/** Toggle one selection's ghosted (dimmed) state. @unstable */
declare const toggleGhost: (key: string) => (_sels: Selection[], ghosted: ReadonlySet<string>) => SelectionPatch;
/** Solo one selection by ghosting all others. Repeat to clear all ghosts. @unstable */
declare const isolateGhost: (key: string) => (sels: Selection[], ghosted: ReadonlySet<string>) => SelectionPatch;
/** Ghost all selections, or clear all ghosts if every selection is already ghosted. @unstable */
declare const toggleGhostAll: () => (sels: Selection[], ghosted: ReadonlySet<string>) => SelectionPatch;
/** Pick `n` distinct ids uniformly at random from `ids`. `n` is floored and clamped to
 *  `[0, ids.length]`, so an over-large count returns all ids. `ids` is not mutated. @unstable */
declare function sampleIds(ids: number[], n: number): number[];
/** What one selection type answers about itself; optional answers default at the lookup. @unstable */
export interface SelectionDescriptor<K extends Selector["type"]> {
    key(selector: Variant<Selector, K>, locations: number[]): string;
    label(selector: Variant<Selector, K>, tagNames?: Record<number, string>): string;
    /** Null falls through to the key hash. */
    color?(selector: Variant<Selector, K>): RGB | null;
    locations?(selector: Variant<Selector, K>): number[];
}
/** Per-type descriptor for each selector variant: key derivation, display label, and optional color/location overrides. @unstable */
declare const SELECTIONS: {
    [K in Selector["type"]]: SelectionDescriptor<K>;
};
/** Every child selection a selector wraps, whatever shape it wraps them in. @unstable */
declare function childSelections(selector: Selector): Selection[];
/** `selector` with its children replaced, keeping the shape it wraps them in. @unstable */
declare function withChildren(selector: Selector, children: Selection[]): Selector;
/** Create a Selection with a deterministic key and color from its selector. @unstable */
declare function buildSelection(selector: Selector): Selection;
/** Locations matching every one of `selectors`; with none, every location. @unstable */
declare const all: (...selectors: Selector[]) => Selector;
/** Locations matching any of `selectors`; with none, no location. @unstable */
declare const any: (...selectors: Selector[]) => Selector;
/** Locations not matching `selector`. @unstable */
declare const not: (selector: Selector) => Selector;
/** Locations holding a value for `field`. @unstable */
declare const has: (field: string) => Selector;
/** Locations holding no value for `field`. @unstable */
declare const lacks: (field: string) => Selector;
/** Append a new selection built from `selector`, deduplicating by key. @unstable */
declare const addSelection: (selector: Selector) => (current: Selection[]) => Selection[];
/** Remove a selection by key. Composites unwrap their children back into the list. @unstable */
declare const removeSelection: (key: string) => (current: Selection[]) => Selection[];
/** Merge the targeted selections (or all, when `keys` is null) into a single Intersection. @unstable */
declare const intersectSelections: (keys?: string[] | null) => (current: Selection[]) => Selection[];
/** Merge the targeted selections (or all, when `keys` is null) into a single Union. @unstable */
declare const unionSelections: (keys?: string[] | null) => (current: Selection[]) => Selection[];
/** Invert targeted selections. Single target toggles in-place at any depth; multiple are wrapped in Union then Invert. @unstable */
declare const invertSelections: (keys?: string[] | null) => (current: Selection[]) => Selection[];
/** Add or remove a location from the Manual selection, creating it if needed. @unstable */
declare const toggleManualSelection: (locationId: number) => (current: Selection[]) => Selection[];
/** Move selection `fromKey` before or after `toKey` in the list. @unstable */
declare const reorderSelections: (fromKey: string, toKey: string, position: "before" | "after") => (current: Selection[]) => Selection[];
/** Merge the dragged selection into the drop target as a composite, absorbing existing
 *  children of the same type. Handles nested cases across parent groups. @unstable */
declare const composeSelections: (dragKey: string, dropKey: string, mode: GroupType, dragParent?: string | null, dropParent?: string | null) => (current: Selection[]) => Selection[];
/** Pull a child out of a composite back into the top-level list, children and all. Parent collapses
 *  if only one child remains, and disappears if none do. @unstable */
declare const decomposeChild: (parentKey: string, childKey: string) => (current: Selection[]) => Selection[];
/** Remove a child from a composite, ungrouping any nested group's children into the parent. @unstable */
declare const removeFromComposite: (parentKey: string, childKey: string) => (current: Selection[]) => Selection[];
/** Compose two siblings inside the same parent group into a nested composite. @unstable */
declare function composeSiblings(current: Selection[], parentKey: string, dragKey: string, dropKey: string, mode: GroupType): Selection[];
/** Compose a top-level selection with a child inside a parent group. @unstable */
declare function composeWithChild(current: Selection[], dragKey: string, parentKey: string, childKey: string, mode: GroupType): Selection[];
/** Replace the selection at `oldKey` (at any depth) with one built from `selector`. If the new
 *  key collides with an existing selection, the existing one wins and the replacement is dropped. @unstable */
declare function replaceSelection(current: Selection[], oldKey: string, selector: Selector): Selection[];
/** Human-readable label for a selection. Pass `tagNames` to resolve tags by saved name
 *  rather than the open map's tags. @unstable */
declare function selectionDisplayName(sel: Selection, tagNames?: Record<number, string>): string;
/** Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
 *  the `/`-path to its shortest unique suffix; otherwise returns the name verbatim. @unstable */
declare function displayTagName(name: string): string;
/** Update the colors of selections by matching keys from `entries`. @unstable */
declare const setSelectionColors: (entries: Selection[]) => (current: Selection[]) => Selection[];
/** Rename a Polygon selection's display name. @unstable */
declare const setPolygonName: (key: string, name: string) => (current: Selection[]) => Selection[];
/** Rename or remove a field across all Filter selections. When `to` is null, filters on that field are dropped. @unstable */
declare const rewriteSelectionFields: (from: string, to: string | null) => (selections: Selection[]) => Selection[];

/** @unstable */
export type selectionOps_CompositeType = CompositeType;
/** @unstable */
export type selectionOps_FilterOpKind = FilterOpKind;
/** @unstable */
export type selectionOps_GroupType = GroupType;
/** @unstable */
declare const selectionOps_OP_LABELS: typeof OP_LABELS;
/** @unstable */
declare const selectionOps_SELECTIONS: typeof SELECTIONS;
/** @unstable */
export type selectionOps_SelectionPatch = SelectionPatch;
/** @unstable */
export type selectionOps_SelectionState = SelectionState;
/** @unstable */
declare const selectionOps_UNARY_TYPES: typeof UNARY_TYPES;
/** @unstable */
export type selectionOps_UnaryType = UnaryType;
/** @unstable */
declare const selectionOps_addSelection: typeof addSelection;
/** @unstable */
declare const selectionOps_all: typeof all;
/** @unstable */
declare const selectionOps_any: typeof any;
/** @unstable */
declare const selectionOps_batch: typeof batch;
/** @unstable */
declare const selectionOps_buildSelection: typeof buildSelection;
/** @unstable */
declare const selectionOps_childSelections: typeof childSelections;
/** @unstable */
declare const selectionOps_colorForKey: typeof colorForKey;
/** @unstable */
declare const selectionOps_composeSelections: typeof composeSelections;
/** @unstable */
declare const selectionOps_composeSiblings: typeof composeSiblings;
/** @unstable */
declare const selectionOps_composeWithChild: typeof composeWithChild;
/** @unstable */
declare const selectionOps_decomposeChild: typeof decomposeChild;
/** @unstable */
declare const selectionOps_displayTagName: typeof displayTagName;
/** @unstable */
declare const selectionOps_filterIsLocalTime: typeof filterIsLocalTime;
/** @unstable */
declare const selectionOps_has: typeof has;
/** @unstable */
declare const selectionOps_intersectSelections: typeof intersectSelections;
/** @unstable */
declare const selectionOps_invertSelections: typeof invertSelections;
/** @unstable */
declare const selectionOps_isolateGhost: typeof isolateGhost;
/** @unstable */
declare const selectionOps_isolateGhostKeys: typeof isolateGhostKeys;
/** @unstable */
declare const selectionOps_lacks: typeof lacks;
/** @unstable */
declare const selectionOps_locationsKey: typeof locationsKey;
/** @unstable */
declare const selectionOps_not: typeof not;
/** @unstable */
declare const selectionOps_panoIdOf: typeof panoIdOf;
/** @unstable */
declare const selectionOps_panoIdSelector: typeof panoIdSelector;
/** @unstable */
declare const selectionOps_removeFromComposite: typeof removeFromComposite;
/** @unstable */
declare const selectionOps_removeSelection: typeof removeSelection;
/** @unstable */
declare const selectionOps_reorderSelections: typeof reorderSelections;
/** @unstable */
declare const selectionOps_replaceSelection: typeof replaceSelection;
/** @unstable */
declare const selectionOps_rewriteSelectionFields: typeof rewriteSelectionFields;
/** @unstable */
declare const selectionOps_sampleIds: typeof sampleIds;
/** @unstable */
declare const selectionOps_selectionDisplayName: typeof selectionDisplayName;
/** @unstable */
declare const selectionOps_setPolygonName: typeof setPolygonName;
/** @unstable */
declare const selectionOps_setSelectionColors: typeof setSelectionColors;
/** @unstable */
declare const selectionOps_tagIdOf: typeof tagIdOf;
/** @unstable */
declare const selectionOps_tagSelector: typeof tagSelector;
/** @unstable */
declare const selectionOps_toggleGhost: typeof toggleGhost;
/** @unstable */
declare const selectionOps_toggleGhostAll: typeof toggleGhostAll;
/** @unstable */
declare const selectionOps_toggleManualSelection: typeof toggleManualSelection;
/** @unstable */
declare const selectionOps_unionSelections: typeof unionSelections;
/** @unstable */
declare const selectionOps_unpannedSelector: typeof unpannedSelector;
/** @unstable */
declare const selectionOps_untaggedSelector: typeof untaggedSelector;
/** @unstable */
declare const selectionOps_withChildren: typeof withChildren;
declare namespace selectionOps {
  export { selectionOps_OP_LABELS as OP_LABELS, selectionOps_SELECTIONS as SELECTIONS, selectionOps_UNARY_TYPES as UNARY_TYPES, selectionOps_addSelection as addSelection, selectionOps_all as all, selectionOps_any as any, selectionOps_batch as batch, selectionOps_buildSelection as buildSelection, selectionOps_childSelections as childSelections, selectionOps_colorForKey as colorForKey, selectionOps_composeSelections as composeSelections, selectionOps_composeSiblings as composeSiblings, selectionOps_composeWithChild as composeWithChild, selectionOps_decomposeChild as decomposeChild, selectionOps_displayTagName as displayTagName, selectionOps_filterIsLocalTime as filterIsLocalTime, selectionOps_has as has, selectionOps_intersectSelections as intersectSelections, selectionOps_invertSelections as invertSelections, selectionOps_isolateGhost as isolateGhost, selectionOps_isolateGhostKeys as isolateGhostKeys, selectionOps_lacks as lacks, selectionOps_locationsKey as locationsKey, selectionOps_not as not, selectionOps_panoIdOf as panoIdOf, selectionOps_panoIdSelector as panoIdSelector, selectionOps_removeFromComposite as removeFromComposite, selectionOps_removeSelection as removeSelection, selectionOps_reorderSelections as reorderSelections, selectionOps_replaceSelection as replaceSelection, selectionOps_rewriteSelectionFields as rewriteSelectionFields, selectionOps_sampleIds as sampleIds, selectionOps_selectionDisplayName as selectionDisplayName, selectionOps_setPolygonName as setPolygonName, selectionOps_setSelectionColors as setSelectionColors, selectionOps_tagIdOf as tagIdOf, selectionOps_tagSelector as tagSelector, selectionOps_toggleGhost as toggleGhost, selectionOps_toggleGhostAll as toggleGhostAll, selectionOps_toggleManualSelection as toggleManualSelection, selectionOps_unionSelections as unionSelections, selectionOps_unpannedSelector as unpannedSelector, selectionOps_untaggedSelector as untaggedSelector, selectionOps_withChildren as withChildren };
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
     *  The sole source for sidebar counts — refreshed wholesale from Rust on every sync. @unstable */
    selectionCounts: Record<string, number>;
    selections: Selection[];
    /** Keys of selections that are "ghosted": kept in the list but excluded from the
     *  Rust sync, so they neither render nor count toward the selected set. Ephemeral. @unstable */
    ghostedSelections: ReadonlySet<string>;
    selectedLocationIds: SelectedIds;
    /** @unstable */
    activeLocationId: number | null;
    /** The location open in the editor, or null. Virtual locations (staged
     *  imports, seen previews) live here with negative ids. */
    activeLocation: Location | null;
    /** @unstable */
    duplicateLocations: Location[];
    /** @unstable */
    workArea: WorkArea;
    /** @unstable */
    activePluginId: string | null;
}
export type MapState = UiState & EngineState;
/** Per-tag location counts: `valueCounts.tags` re-keyed by numeric id. */
declare const getTagCounts: () => Record<number, number>;
/** The tag view: `valueMeta.tags` piles dressed over the counts, recomputed only when
 *  either slice moves. A tag is visible exactly while something carries it (count > 0);
 *  a value present in data without metadata (foreign import) shows under a derived
 *  name/color; emptied metadata lingers dark until its name is reused. */
declare const getTags: () => Record<number, Tag>;
/** Reactive slice of the map state. Re-renders only when the selected value's
 *  reference changes (`Object.is`), so selectors must return state fields or
 *  memoized values, not a new value per call. */
declare function useMapState<T>(selector: (s: MapState) => T): T;
/** Imperative snapshot of the map state. */
declare function getMapState(): Readonly<MapState>;
/** Tags that exist from the user's point of view: the ones something carries. Raw
 *  `tags` also holds dark metadata ghosts (count=0, visible=false) - almost nothing
 *  should enumerate those. */
declare const getVisibleTags: () => Tag[];
/** Raw by-id tag lookup — includes dark metadata ghosts so stale references
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
declare function countBy(selector: Selector, field: string, key: KeySpec): Promise<CountBy>;
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
/** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want. @unstable */
declare function setSelectedLocationIds(ids: SelectedIds): void;
/** Patch any map's metadata by id and persist it. Updates the open map's state when it is that map. */
declare function patchMapMeta(id: string, patch: MapMetaPatch_Deserialize): Promise<void>;
/** `patchMapMeta` for the map open in this window. */
declare function updateMapMeta(patch: MapMetaPatch_Deserialize): Promise<void> | undefined;
/** Replace the map's extra-field definitions (types/labels for `Location.extra` keys). */
declare function setMapExtraFields(fields: Record<string, FieldDef>): Promise<void>;
/** Decode a selection bitmask and draw it on the map. @unstable */
declare function emitBitmask(bytes: number[]): void;
/** Run a mutation, apply its result to the map, and schedule a save. A result that wraps its
 *  mutation comes back whole; `empty` is its answer when no map is open. @unstable */
declare function mutate(fn: () => Promise<MutationResult>): Promise<MutationResult>;
/** @unstable */
declare function mutate<R extends {
    mutation: MutationResult;
}>(fn: () => Promise<R>, empty: R): Promise<R>;
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
/** Apply a field operation across all locations matching `selector`. Emits `location:invalidate`. @unstable */
declare function applyFieldOp(selector: Selector, op: FieldOp, recordUndo: boolean): Promise<FieldOpResult>;
/** Add selectors to the active selection list. */
declare function addSelections(selectors: Selector[]): Promise<void>;
/** Drop selections by key. */
declare function removeSelections(keys: string[]): Promise<void>;
/** Apply a selection transform function and re-resolve the selection.
 *  The function receives the current selections and ghosted set, and returns either
 *  a new `Selection[]` or a `SelectionPatch`. No-op when nothing changed. @unstable */
declare function applySelectionUpdate(op: (sels: Selection[], ghosted: ReadonlySet<string>) => Selection[] | SelectionPatch): Promise<void>;
/** Re-resolve all selections against the current map data and update the overlay.
 *  Use when the underlying data changed but the selections themselves did not. @unstable */
declare function syncSelections$1(): Promise<void>;
/** Clear all selections. */
declare function resetSelections(): Promise<void>;
/** Replace the current selection with up to `count` ids picked at random.
 *  With `perSelection`, picks up to `count` from each active selection separately.
 *  Returns the number of ids actually picked (0 when nothing is selected). @unstable */
declare function selectRandomFromSelection(count: number, perSelection?: boolean): Promise<number>;
/** Replace the current selection with spatially spaced ids - either `count` ids maximizing
 *  spacing, or as many as fit at `minDistanceM`. With `perSelection`, each active selection
 *  is picked from separately. Returns the count picked and the minimum distance achieved. @unstable */
declare function selectSpacedFromSelection(opts: {
    count?: number;
    minDistanceM?: number;
}, perSelection?: boolean): Promise<{
    picked: number;
    distanceM: number;
}>;
/** Replace the current selection with evenly spaced ids laid out on a honeycomb - either at
 *  most `count` ids spaced as widely as that allows, or ids about `spacingM` apart. No two
 *  picks sit closer than half the spacing. With `perSelection`, each active selection is
 *  picked from separately. Returns the count picked and the spacing used. @unstable */
declare function selectEvenlySpacedFromSelection(opts: {
    count?: number;
    spacingM?: number;
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
/** Open a staged-import location read-only, as if it were active. It is not on the map and
 *  cannot be edited. @unstable */
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
 *  leaving "location" clears the active location, leaving "plugin" clears the plugin id. @unstable */
declare function setWorkArea(area: WorkArea): void;
/** Open a plugin's sidebar (switches the editor pane to "plugin"). */
declare function setPluginMode(pluginId: string): void;
/** Close the plugin sidebar and return to the overview. */
declare function exitPluginMode(): void;
/** Get-or-create tags by name (case-insensitive; ids are allocated by the store) and
 *  return them in request order. Pass `selector` to also put the tags on those
 *  locations. Emits `tag:add`. */
declare function createTags(names: string[], selector?: Selector): Promise<Tag[]>;
/** Rename or recolor tags. A rename colliding with an existing tag name
 *  (case-insensitive) merges the two: every location is remapped to the survivor
 *  (undoable) and the emptied source's metadata goes dark. */
declare function updateTags(updates: Update<TagPatch>[]): Promise<void>;
/** Delete tags: strip them from every location in one undoable mutation. The emptied
 *  metadata goes dark (count 0 hides it); undo restores the rows and the tags with
 *  them. Emits `tag:remove`. */
declare function deleteTags(tagIds: number[]): Promise<void>;
/** Persist a new tag display order. */
declare function reorderTags(orderedIds: number[]): Promise<void>;
/** Put `add` on every location the selector resolves to and strip `remove` from them,
 *  in one undoable mutation. There is no tag-specific write path: `tags` is an ordinary
 *  list-valued field, so this is the same `listSet` any `array` field takes. Locations
 *  already in the requested state are untouched; `add` wins for a tag in both lists. */
declare function setTags(add: number[], remove: number[], selector: Selector): Promise<void> | Promise<FieldOpResult>;
/** Undo the last edit. */
declare function undo(): Promise<void>;
/** Redo the last undone edit. */
declare function redo(): Promise<void>;
/** Commit all pending changes to the map's version history. Clears the undo stack. */
declare function commitMap(message?: string): Promise<string>;
/** Restore the map to a previous commit's state and reopen it. Clears undo/redo. @unstable */
declare function checkoutCommit(commitId: string): Promise<void>;

/** @unstable */
export type store_MapState = MapState;
/** @unstable */
export type store_UiState = UiState;
declare const store_addLocations: typeof addLocations;
declare const store_addSelections: typeof addSelections;
/** @unstable */
declare const store_applyFieldOp: typeof applyFieldOp;
/** @unstable */
declare const store_applySelectionUpdate: typeof applySelectionUpdate;
/** @unstable */
declare const store_cancelAutosave: typeof cancelAutosave;
/** @unstable */
declare const store_checkoutCommit: typeof checkoutCommit;
/** @unstable */
declare const store_closeDuplicates: typeof closeDuplicates;
declare const store_commitMap: typeof commitMap;
declare const store_countBy: typeof countBy;
declare const store_countIn: typeof countIn;
declare const store_coverage: typeof coverage;
declare const store_createTags: typeof createTags;
declare const store_currentSelection: typeof currentSelection;
declare const store_deleteField: typeof deleteField;
declare const store_deleteTags: typeof deleteTags;
/** @unstable */
declare const store_discardOpenMap: typeof discardOpenMap;
declare const store_duplicateLocation: typeof duplicateLocation;
/** @unstable */
declare const store_emitBitmask: typeof emitBitmask;
declare const store_exitPluginMode: typeof exitPluginMode;
declare const store_fetchBounds: typeof fetchBounds;
declare const store_fetchColumns: typeof fetchColumns;
declare const store_fetchLocations: typeof fetchLocations;
declare const store_fieldValues: typeof fieldValues;
/** @unstable */
declare const store_flushSave: typeof flushSave;
declare const store_getActiveSelections: typeof getActiveSelections;
declare const store_getMapState: typeof getMapState;
declare const store_getTag: typeof getTag;
declare const store_getTagCounts: typeof getTagCounts;
declare const store_getTags: typeof getTags;
declare const store_getVisibleTags: typeof getVisibleTags;
/** @unstable */
declare const store_holdAutosave: typeof holdAutosave;
/** @unstable */
declare const store_initStore: typeof initStore;
/** @unstable */
declare const store_mergeDuplicates: typeof mergeDuplicates;
/** @unstable */
declare const store_mutate: typeof mutate;
/** @unstable */
declare const store_openDuplicateLocation: typeof openDuplicateLocation;
/** @unstable */
declare const store_openStagedLocation: typeof openStagedLocation;
declare const store_partition: typeof partition;
declare const store_patchMapMeta: typeof patchMapMeta;
/** @unstable */
declare const store_previewDuplicateGroups: typeof previewDuplicateGroups;
/** @unstable */
declare const store_previewVirtualLocation: typeof previewVirtualLocation;
/** @unstable */
declare const store_pruneDuplicates: typeof pruneDuplicates;
declare const store_redo: typeof redo;
/** @unstable */
declare const store_removeDuplicate: typeof removeDuplicate;
declare const store_removeLocations: typeof removeLocations;
declare const store_removeSelections: typeof removeSelections;
declare const store_renameField: typeof renameField;
declare const store_reorderTags: typeof reorderTags;
declare const store_resetSelections: typeof resetSelections;
declare const store_resolveIds: typeof resolveIds;
declare const store_resolveLocation: typeof resolveLocation;
declare const store_sampleFrom: typeof sampleFrom;
/** @unstable */
declare const store_scheduleAutoCommit: typeof scheduleAutoCommit;
/** @unstable */
declare const store_scheduleSave: typeof scheduleSave;
/** @unstable */
declare const store_selectEvenlySpacedFromSelection: typeof selectEvenlySpacedFromSelection;
/** @unstable */
declare const store_selectRandomFromSelection: typeof selectRandomFromSelection;
/** @unstable */
declare const store_selectSpacedFromSelection: typeof selectSpacedFromSelection;
declare const store_setActiveLocation: typeof setActiveLocation;
declare const store_setMapExtraFields: typeof setMapExtraFields;
declare const store_setPluginMode: typeof setPluginMode;
/** @unstable */
declare const store_setSelectedLocationIds: typeof setSelectedLocationIds;
declare const store_setTags: typeof setTags;
/** @unstable */
declare const store_setWorkArea: typeof setWorkArea;
declare const store_tagIdsToNames: typeof tagIdsToNames;
declare const store_undo: typeof undo;
declare const store_updateLocations: typeof updateLocations;
declare const store_updateMapMeta: typeof updateMapMeta;
declare const store_updateTags: typeof updateTags;
declare const store_useMapState: typeof useMapState;
/** @unstable */
declare const store_waitForInflightPersist: typeof waitForInflightPersist;
declare namespace store {
  export { store_addLocations as addLocations, store_addSelections as addSelections, store_applyFieldOp as applyFieldOp, store_applySelectionUpdate as applySelectionUpdate, store_cancelAutosave as cancelAutosave, store_checkoutCommit as checkoutCommit, store_closeDuplicates as closeDuplicates, closeMap$1 as closeMap, store_commitMap as commitMap, store_countBy as countBy, store_countIn as countIn, store_coverage as coverage, store_createTags as createTags, store_currentSelection as currentSelection, store_deleteField as deleteField, store_deleteTags as deleteTags, store_discardOpenMap as discardOpenMap, store_duplicateLocation as duplicateLocation, store_emitBitmask as emitBitmask, store_exitPluginMode as exitPluginMode, store_fetchBounds as fetchBounds, store_fetchColumns as fetchColumns, store_fetchLocations as fetchLocations, store_fieldValues as fieldValues, store_flushSave as flushSave, store_getActiveSelections as getActiveSelections, store_getMapState as getMapState, store_getTag as getTag, store_getTagCounts as getTagCounts, store_getTags as getTags, store_getVisibleTags as getVisibleTags, store_holdAutosave as holdAutosave, store_initStore as initStore, store_mergeDuplicates as mergeDuplicates, store_mutate as mutate, store_openDuplicateLocation as openDuplicateLocation, openMap$1 as openMap, store_openStagedLocation as openStagedLocation, store_partition as partition, store_patchMapMeta as patchMapMeta, store_previewDuplicateGroups as previewDuplicateGroups, store_previewVirtualLocation as previewVirtualLocation, store_pruneDuplicates as pruneDuplicates, store_redo as redo, store_removeDuplicate as removeDuplicate, store_removeLocations as removeLocations, store_removeSelections as removeSelections, store_renameField as renameField, store_reorderTags as reorderTags, store_resetSelections as resetSelections, store_resolveIds as resolveIds, store_resolveLocation as resolveLocation, store_sampleFrom as sampleFrom, store_scheduleAutoCommit as scheduleAutoCommit, store_scheduleSave as scheduleSave, store_selectEvenlySpacedFromSelection as selectEvenlySpacedFromSelection, store_selectRandomFromSelection as selectRandomFromSelection, store_selectSpacedFromSelection as selectSpacedFromSelection, store_setActiveLocation as setActiveLocation, store_setMapExtraFields as setMapExtraFields, store_setPluginMode as setPluginMode, store_setSelectedLocationIds as setSelectedLocationIds, store_setTags as setTags, store_setWorkArea as setWorkArea, syncSelections$1 as syncSelections, store_tagIdsToNames as tagIdsToNames, store_undo as undo, store_updateLocations as updateLocations, store_updateMapMeta as updateMapMeta, store_updateTags as updateTags, store_useMapState as useMapState, store_waitForInflightPersist as waitForInflightPersist };
  export type { store_MapState as MapState, store_UiState as UiState };
}

/** Edit an existing filter (or any selection) in place by key, preserving its
 *  position inside any AND/OR/Invert composite. Carries ghost state to the new key. @unstable */
declare function updateFilterSelection(oldKey: string, selector: Selector): Promise<void>;
/** Toggle tag selections on or off for the given tags. @unstable */
declare function toggleTagSelections(tagIds: number[]): void;
/** Tag ids that currently have a top-level Tag selection active. @unstable */
declare const getSelectedTagIds: () => ReadonlySet<number>;
/** Tag ids of every Tag leaf in the active selection tree, in list order.
 *  Includes composite children, excludes ghosted selections; ids may repeat. @unstable */
declare const getSelectedTagIdsDeep: () => readonly number[];

/** @unstable */
declare const selectionActions_getSelectedTagIds: typeof getSelectedTagIds;
/** @unstable */
declare const selectionActions_getSelectedTagIdsDeep: typeof getSelectedTagIdsDeep;
/** @unstable */
declare const selectionActions_toggleTagSelections: typeof toggleTagSelections;
/** @unstable */
declare const selectionActions_updateFilterSelection: typeof updateFilterSelection;
declare namespace selectionActions {
  export {
    selectionActions_getSelectedTagIds as getSelectedTagIds,
    selectionActions_getSelectedTagIdsDeep as getSelectedTagIdsDeep,
    selectionActions_toggleTagSelections as toggleTagSelections,
    selectionActions_updateFilterSelection as updateFilterSelection,
  };
}

/** Saved selection rules: portable named rules that persist across maps. A rule stores a
 *  `Selector` tree plus the tag names its `Tag` leaves carried at save time, so it can
 *  re-resolve against whatever map is open. */

/** Selection types that cannot be saved as rules because they are bound to the open map. @unstable */
declare const MAP_LOCAL_TYPES: readonly ["Locations", "Manual", "ValidationState", "Reviewed"];
/** Whether the selector tree contains only portable types (no map-local leaves). @unstable */
declare function isSaveable(selector: Selector): boolean;
/** One part of a saved rule: what its chip reads as, and what it resolves to here. The
 *  label comes from the tree as saved, so a tag this map doesn't have still reads by the
 *  name it was saved under. @unstable */
export interface SavedPart {
    label: string;
    color: RGB;
    selector: Selector;
}
/** A rule's parts: its top-level `Union` is the list it was saved from, anything else is
 *  a single part. @unstable */
declare function savedParts(saved: SavedSelection): SavedPart[];
/** The rules that exist, as identity only. Empty until the index loads: the first
 *  call starts the read and `saved-selections:changed` announces it. @unstable */
declare function getSavedSelectionIndex(): SavedSelectionInfo[];
/** React hook: the saved selection index, re-rendering on changes. @unstable */
declare function useSavedSelectionIndex(): SavedSelectionInfo[];
/** Load the full rule bodies for the given `ids`. @unstable */
declare function loadSavedSelections(ids: string[]): Promise<SavedSelection[]>;
/** Every rule with its body. @unstable */
declare function loadAllSavedSelections(): Promise<SavedSelection[]>;
/** A saved rule as a single `Selector`, resolved against the open map. Matches nothing
 *  until the body arrives; fetching it emits `saved-selections:changed`, so a caller that
 *  re-reads on that event gets the real tree. @unstable */
declare function savedSelector(id: string): Selector;
/** Persists the saveable selections as one rule. False when none of them are saveable. @unstable */
declare function saveCurrentSelections(name: string, selections: Selection[]): Promise<boolean>;
/** Permanently delete a saved selection rule. @unstable */
declare function deleteSavedSelection(id: string): Promise<void>;
/** Adds the rule's parts to the sidebar, resolved against the open map. Returns how many
 *  were added. @unstable */
declare function applySavedSelection(saved: SavedSelection): number;

/** @unstable */
declare const savedSelections_MAP_LOCAL_TYPES: typeof MAP_LOCAL_TYPES;
/** @unstable */
export type savedSelections_SavedPart = SavedPart;
/** @unstable */
declare const savedSelections_applySavedSelection: typeof applySavedSelection;
/** @unstable */
declare const savedSelections_deleteSavedSelection: typeof deleteSavedSelection;
/** @unstable */
declare const savedSelections_getSavedSelectionIndex: typeof getSavedSelectionIndex;
/** @unstable */
declare const savedSelections_isSaveable: typeof isSaveable;
/** @unstable */
declare const savedSelections_loadAllSavedSelections: typeof loadAllSavedSelections;
/** @unstable */
declare const savedSelections_loadSavedSelections: typeof loadSavedSelections;
/** @unstable */
declare const savedSelections_saveCurrentSelections: typeof saveCurrentSelections;
/** @unstable */
declare const savedSelections_savedParts: typeof savedParts;
/** @unstable */
declare const savedSelections_savedSelector: typeof savedSelector;
/** @unstable */
declare const savedSelections_useSavedSelectionIndex: typeof useSavedSelectionIndex;
declare namespace savedSelections {
  export { savedSelections_MAP_LOCAL_TYPES as MAP_LOCAL_TYPES, savedSelections_applySavedSelection as applySavedSelection, savedSelections_deleteSavedSelection as deleteSavedSelection, savedSelections_getSavedSelectionIndex as getSavedSelectionIndex, savedSelections_isSaveable as isSaveable, savedSelections_loadAllSavedSelections as loadAllSavedSelections, savedSelections_loadSavedSelections as loadSavedSelections, savedSelections_saveCurrentSelections as saveCurrentSelections, savedSelections_savedParts as savedParts, savedSelections_savedSelector as savedSelector, savedSelections_useSavedSelectionIndex as useSavedSelectionIndex };
  export type { savedSelections_SavedPart as SavedPart };
}

/** A value saved in local storage: its key and its defaults. @unstable */
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
    "select-evenly-spaced": {
        label: "Pick evenly spaced locations from selection";
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
/** @unstable */
export type CommandId = keyof typeof COMMANDS;
/** @unstable */
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
/** @unstable */
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
/** Download size of each border detail level, in bytes. @unstable */
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
/** Tag-suggestion list cap stops (slider indices); 0 = unlimited ("All"). @unstable */
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
/** @unstable */
export type Language = keyof typeof LANGUAGES;
/** @unstable */
export type MovementMode = keyof typeof MOVEMENT_MODES;
/** @unstable */
declare const MOVEMENT_CYCLE: MovementMode[];
/** @unstable */
export type ExactDateFormat = keyof typeof EXACT_DATE_FORMATS;
/** @unstable */
export type DateTimezone = keyof typeof DATE_TIMEZONES;
/** @unstable */
export type SeenResolution = keyof typeof SEEN_RESOLUTIONS;
/** @unstable */
export type MapListField = keyof typeof MAP_LIST_FIELDS;
/** @unstable */
export type DiscordPresenceMode = keyof typeof DISCORD_PRESENCE_MODES;
/** @unstable */
export type GeocodeProvider = keyof typeof GEOCODE_PROVIDERS;
/** @unstable */
export type UnitSystem = keyof typeof UNIT_SYSTEMS;
/** @unstable */
export type TagViewMode = keyof typeof TAG_VIEW_MODES;
/** @unstable */
export type TagFolderColorMode = keyof typeof TAG_FOLDER_COLOR_MODES;
/** @unstable */
export type OpacityToggleMode = keyof typeof OPACITY_TOGGLE_MODES;
/** @unstable */
export type PolygonColorMode = keyof typeof POLYGON_COLOR_MODES;
/** @unstable */
export type BorderDetail = keyof typeof BORDER_DETAILS;
/** @unstable */
export type SubdivisionDetail = keyof typeof SUBDIVISION_DETAILS;
/** @unstable */
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
    /** Smallest half-width, in degrees, the map frames around a single pasted or imported point. @unstable */
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
    svTrail: boolean;
    /** @unstable */
    svTrailColor: RGB;
    /** @unstable */
    svTrailPosition: boolean;
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
    /** Local REST transport for window.MMA (Settings > Advanced). @unstable */
    remoteApi: boolean;
    /** @unstable */
    remoteApiKey: string;
    /** @unstable */
    pinnedCommands: PinnedEntry[];
};
/** @unstable */
export type AppSettings = typeof DEFAULTS;
/** Settings holding private information that should not be exfiltrated. @unstable */
declare const PRIVATE_SETTINGS: ReadonlySet<keyof AppSettings>;
/** App settings exposed as CSS custom properties on `:root`. @unstable */
declare const CSS_VAR_SETTINGS: ReadonlyArray<readonly [cssVar: string, value: (s: AppSettings) => string]>;
/** localStorage descriptor for the persisted settings object. @unstable */
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
    /** Smallest half-width, in degrees, the map frames around a single pasted or imported point. */
    pastePadding: number;
    followActiveInReview: boolean;
    markerColor: RGB;
    activeLocationColor: RGB;
    importPreviewColor: RGB;
    svTrail: boolean;
    svTrailColor: RGB;
    svTrailPosition: boolean;
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
/** Reset all settings to defaults. @unstable */
declare function resetSettings(): void;
/** React hook: all settings, re-rendering on any change. @unstable */
declare function useSettings(): AppSettings;
/** React hook: one setting value, re-rendering only when that key changes. @unstable */
declare function useSetting<K extends keyof AppSettings>(key: K): AppSettings[K];

/** @unstable */
declare const settings_APP_SETTINGS: typeof APP_SETTINGS;
/** @unstable */
export type settings_AppSettings = AppSettings;
/** @unstable */
declare const settings_BORDER_ARCHIVE_BYTES: typeof BORDER_ARCHIVE_BYTES;
/** @unstable */
declare const settings_BORDER_DETAILS: typeof BORDER_DETAILS;
/** @unstable */
export type settings_BorderDetail = BorderDetail;
/** @unstable */
declare const settings_CSS_VAR_SETTINGS: typeof CSS_VAR_SETTINGS;
/** @unstable */
declare const settings_DATE_TIMEZONES: typeof DATE_TIMEZONES;
/** @unstable */
declare const settings_DEFAULTS: typeof DEFAULTS;
/** @unstable */
declare const settings_DISCORD_PRESENCE_MODES: typeof DISCORD_PRESENCE_MODES;
/** @unstable */
export type settings_DateTimezone = DateTimezone;
/** @unstable */
export type settings_DiscordPresenceMode = DiscordPresenceMode;
/** @unstable */
declare const settings_EXACT_DATE_FORMATS: typeof EXACT_DATE_FORMATS;
/** @unstable */
export type settings_ExactDateFormat = ExactDateFormat;
/** @unstable */
declare const settings_GEOCODE_PROVIDERS: typeof GEOCODE_PROVIDERS;
/** @unstable */
declare const settings_GEOCODE_PROVIDER_LABELS: typeof GEOCODE_PROVIDER_LABELS;
/** @unstable */
export type settings_GeocodeProvider = GeocodeProvider;
/** @unstable */
declare const settings_LANGUAGES: typeof LANGUAGES;
/** @unstable */
export type settings_Language = Language;
/** @unstable */
declare const settings_MAP_LIST_FIELDS: typeof MAP_LIST_FIELDS;
/** @unstable */
declare const settings_MOVEMENT_CYCLE: typeof MOVEMENT_CYCLE;
/** @unstable */
declare const settings_MOVEMENT_MODES: typeof MOVEMENT_MODES;
/** @unstable */
export type settings_MapListField = MapListField;
/** @unstable */
export type settings_MovementMode = MovementMode;
/** @unstable */
declare const settings_OPACITY_TOGGLE_MODES: typeof OPACITY_TOGGLE_MODES;
/** @unstable */
export type settings_OpacityToggleMode = OpacityToggleMode;
/** @unstable */
declare const settings_POLYGON_COLOR_MODES: typeof POLYGON_COLOR_MODES;
/** @unstable */
declare const settings_PREVIEW_ASPECT_RATIOS: typeof PREVIEW_ASPECT_RATIOS;
/** @unstable */
declare const settings_PRIVATE_SETTINGS: typeof PRIVATE_SETTINGS;
/** @unstable */
export type settings_PolygonColorMode = PolygonColorMode;
/** @unstable */
export type settings_PreviewAspectRatio = PreviewAspectRatio;
/** @unstable */
declare const settings_SEEN_RESOLUTIONS: typeof SEEN_RESOLUTIONS;
/** @unstable */
declare const settings_SUBDIVISION_DETAILS: typeof SUBDIVISION_DETAILS;
/** @unstable */
export type settings_SeenResolution = SeenResolution;
/** @unstable */
export type settings_SubdivisionDetail = SubdivisionDetail;
/** @unstable */
declare const settings_TAG_FOLDER_COLOR_MODES: typeof TAG_FOLDER_COLOR_MODES;
/** @unstable */
declare const settings_TAG_SUGGESTION_LIMITS: typeof TAG_SUGGESTION_LIMITS;
/** @unstable */
declare const settings_TAG_VIEW_MODES: typeof TAG_VIEW_MODES;
/** @unstable */
export type settings_TagFolderColorMode = TagFolderColorMode;
/** @unstable */
export type settings_TagViewMode = TagViewMode;
/** @unstable */
declare const settings_UNIT_SYSTEMS: typeof UNIT_SYSTEMS;
/** @unstable */
export type settings_UnitSystem = UnitSystem;
/** @unstable */
declare const settings_getSettings: typeof getSettings;
/** @unstable */
declare const settings_navHiddenWithUI: typeof navHiddenWithUI;
/** @unstable */
declare const settings_panoDisplayOptions: typeof panoDisplayOptions;
/** @unstable */
declare const settings_resetSettings: typeof resetSettings;
/** @unstable */
declare const settings_setSetting: typeof setSetting;
/** @unstable */
declare const settings_useSetting: typeof useSetting;
/** @unstable */
declare const settings_useSettings: typeof useSettings;
declare namespace settings {
  export { settings_APP_SETTINGS as APP_SETTINGS, settings_BORDER_ARCHIVE_BYTES as BORDER_ARCHIVE_BYTES, settings_BORDER_DETAILS as BORDER_DETAILS, settings_CSS_VAR_SETTINGS as CSS_VAR_SETTINGS, settings_DATE_TIMEZONES as DATE_TIMEZONES, settings_DEFAULTS as DEFAULTS, settings_DISCORD_PRESENCE_MODES as DISCORD_PRESENCE_MODES, settings_EXACT_DATE_FORMATS as EXACT_DATE_FORMATS, settings_GEOCODE_PROVIDERS as GEOCODE_PROVIDERS, settings_GEOCODE_PROVIDER_LABELS as GEOCODE_PROVIDER_LABELS, settings_LANGUAGES as LANGUAGES, settings_MAP_LIST_FIELDS as MAP_LIST_FIELDS, settings_MOVEMENT_CYCLE as MOVEMENT_CYCLE, settings_MOVEMENT_MODES as MOVEMENT_MODES, settings_OPACITY_TOGGLE_MODES as OPACITY_TOGGLE_MODES, settings_POLYGON_COLOR_MODES as POLYGON_COLOR_MODES, settings_PREVIEW_ASPECT_RATIOS as PREVIEW_ASPECT_RATIOS, settings_PRIVATE_SETTINGS as PRIVATE_SETTINGS, settings_SEEN_RESOLUTIONS as SEEN_RESOLUTIONS, settings_SUBDIVISION_DETAILS as SUBDIVISION_DETAILS, settings_TAG_FOLDER_COLOR_MODES as TAG_FOLDER_COLOR_MODES, settings_TAG_SUGGESTION_LIMITS as TAG_SUGGESTION_LIMITS, settings_TAG_VIEW_MODES as TAG_VIEW_MODES, settings_UNIT_SYSTEMS as UNIT_SYSTEMS, settings_getSettings as getSettings, settings_navHiddenWithUI as navHiddenWithUI, settings_panoDisplayOptions as panoDisplayOptions, settings_resetSettings as resetSettings, settings_setSetting as setSetting, settings_useSetting as useSetting, settings_useSettings as useSettings };
  export type { settings_AppSettings as AppSettings, settings_BorderDetail as BorderDetail, settings_DateTimezone as DateTimezone, settings_DiscordPresenceMode as DiscordPresenceMode, settings_ExactDateFormat as ExactDateFormat, settings_GeocodeProvider as GeocodeProvider, settings_Language as Language, settings_MapListField as MapListField, settings_MovementMode as MovementMode, settings_OpacityToggleMode as OpacityToggleMode, settings_PolygonColorMode as PolygonColorMode, settings_PreviewAspectRatio as PreviewAspectRatio, settings_SeenResolution as SeenResolution, settings_SubdivisionDetail as SubdivisionDetail, settings_TagFolderColorMode as TagFolderColorMode, settings_TagViewMode as TagViewMode, settings_UnitSystem as UnitSystem };
}

/** Parsed-but-not-committed import shown while `workArea === "import"`. @unstable */
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
/** Import from a file path. @unstable */
declare function beginImportFromPath(path: string): Promise<void>;
/** Stage pasted text for preview. Throws if no locations are found. @unstable */
declare function beginImportPaste(text: string): Promise<void>;
/** Commit the staged import, optionally dropping fields and applying a bulk tag. @unstable */
declare function confirmImport(droppedFields: string[], tagName?: string): Promise<EditorImportResult | null>;
/** Discard the staged import without committing. @unstable */
declare function cancelImport(): void;

/** @unstable */
export type importStaging_ImportStaging = ImportStaging;
/** @unstable */
declare const importStaging_beginImportFromPath: typeof beginImportFromPath;
/** @unstable */
declare const importStaging_beginImportPaste: typeof beginImportPaste;
/** @unstable */
declare const importStaging_cancelImport: typeof cancelImport;
/** @unstable */
declare const importStaging_confirmImport: typeof confirmImport;
/** @unstable */
declare const importStaging_getImportPreviewPositions: typeof getImportPreviewPositions;
/** @unstable */
declare const importStaging_getImportStaging: typeof getImportStaging;
/** @unstable */
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
 *  interleaved `[lng, lat]` Float32Arrays. @unstable */
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
/** Split a commit delta into added, removed, and modified locations. A location on both
 *  sides of the delta counts as modified. @unstable */
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

/** @unstable */
export type commitDiff_CommitDiffPreview = CommitDiffPreview;
/** @unstable */
declare const commitDiff_beginCommitDiffPreview: typeof beginCommitDiffPreview;
/** @unstable */
declare const commitDiff_categorizeCommitDelta: typeof categorizeCommitDelta;
/** @unstable */
declare const commitDiff_diffPositions: typeof diffPositions;
/** @unstable */
declare const commitDiff_endCommitDiffPreview: typeof endCommitDiffPreview;
/** @unstable */
declare const commitDiff_getCommitDiffPreview: typeof getCommitDiffPreview;
/** @unstable */
declare const commitDiff_hasCommitDiff: typeof hasCommitDiff;
/** @unstable */
declare const commitDiff_resetCommitDiffCounts: typeof resetCommitDiffCounts;
/** @unstable */
declare const commitDiff_resetCommitDiffState: typeof resetCommitDiffState;
/** @unstable */
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

/** @unstable */
export type picker_SelectorPick = SelectorPick;
/** @unstable */
export type picker_SelectorPickController = SelectorPickController;
/** @unstable */
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
/** Refresh the map list from disk. @unstable */
declare function reloadMapList(): Promise<void>;
/** Refresh the map list and notify other windows of the change. @unstable */
declare function invalidateMapList(): Promise<void>;
/** Set the map list directly without a disk read. @unstable */
declare function setCachedMapList(list: MapMeta[]): void;
/** Create a new empty map and return its metadata. */
declare function createMap(name: string, folder?: string | null): Promise<MapMeta>;
/** Open the scratch map, creating it on first use. */
declare function openScratchMap(): Promise<void>;
/** Whether `id` belongs to an app fixture rather than a user-created map. @unstable */
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
/** @unstable */
declare const mapList_invalidateMapList: typeof invalidateMapList;
/** @unstable */
declare const mapList_isReservedMap: typeof isReservedMap;
declare const mapList_moveMapToFolder: typeof moveMapToFolder;
declare const mapList_openScratchMap: typeof openScratchMap;
/** @unstable */
declare const mapList_reloadMapList: typeof reloadMapList;
declare const mapList_renameFolder: typeof renameFolder;
/** @unstable */
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

/** @unstable */
export interface PruneResult {
    session: ReviewSession | null;
    cursorMoved: boolean;
}
/** Position of `id` in the session's worklist, or -1. O(1) per step. @unstable */
declare function positionOf(s: ReviewSession, id: number): number;
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
/** Union of reviewed ids across sessions, de-duplicated. @unstable */
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

/** @unstable */
export type review_PruneResult = PruneResult;
/** @unstable */
declare const review_advance: typeof advance;
/** @unstable */
declare const review_beginReview: typeof beginReview;
/** @unstable */
declare const review_cancelReview: typeof cancelReview;
/** @unstable */
declare const review_deleteSession: typeof deleteSession;
/** @unstable */
declare const review_getReviewSession: typeof getReviewSession;
/** @unstable */
declare const review_isAtStart: typeof isAtStart;
/** @unstable */
declare const review_isCurrentReviewed: typeof isCurrentReviewed;
/** @unstable */
declare const review_listSessions: typeof listSessions;
/** @unstable */
declare const review_positionOf: typeof positionOf;
/** @unstable */
declare const review_pruneSession: typeof pruneSession;
/** @unstable */
declare const review_renameReview: typeof renameReview;
/** @unstable */
declare const review_resumeReview: typeof resumeReview;
/** @unstable */
declare const review_retreat: typeof retreat;
/** @unstable */
declare const review_reviewDelete: typeof reviewDelete;
/** @unstable */
declare const review_reviewIndex: typeof reviewIndex;
/** @unstable */
declare const review_reviewNext: typeof reviewNext;
/** @unstable */
declare const review_reviewPrev: typeof reviewPrev;
/** @unstable */
declare const review_reviewedHistoryIds: typeof reviewedHistoryIds;
/** @unstable */
declare const review_selectReviewSet: typeof selectReviewSet;
/** @unstable */
declare const review_selectReviewedHistory: typeof selectReviewedHistory;
/** @unstable */
declare const review_useReviewSession: typeof useReviewSession;
declare namespace review {
  export { review_advance as advance, review_beginReview as beginReview, review_cancelReview as cancelReview, review_deleteSession as deleteSession, review_getReviewSession as getReviewSession, review_isAtStart as isAtStart, review_isCurrentReviewed as isCurrentReviewed, review_listSessions as listSessions, review_positionOf as positionOf, review_pruneSession as pruneSession, review_renameReview as renameReview, review_resumeReview as resumeReview, review_retreat as retreat, review_reviewDelete as reviewDelete, review_reviewIndex as reviewIndex, review_reviewNext as reviewNext, review_reviewPrev as reviewPrev, review_reviewedHistoryIds as reviewedHistoryIds, review_selectReviewSet as selectReviewSet, review_selectReviewedHistory as selectReviewedHistory, review_useReviewSession as useReviewSession };
  export type { review_PruneResult as PruneResult };
}

/** @unstable */
export type Cmd = typeof commands$1;
/** Every Rust command, typed. Any of them can change in a release. @unstable */
declare const cmd: Cmd;

/** @unstable */
export type commands_Cmd = Cmd;
/** @unstable */
declare const commands_cmd: typeof cmd;
declare namespace commands {
  export { commands_cmd as cmd };
  export type { commands_Cmd as Cmd };
}

/** Low-level command, shell, and file dialog access. @unstable */

declare const shell: {
    /** @unstable */
    Command: typeof Command;
};
/** @unstable */
declare const dialog: {
    /** @unstable */
    open: typeof open;
    /** @unstable */
    save: typeof save;
};

/** @unstable */
declare const tauri_dialog: typeof dialog;
/** @unstable */
declare const tauri_invoke: typeof invoke;
/** @unstable */
declare const tauri_shell: typeof shell;
declare namespace tauri {
  export {
    tauri_dialog as dialog,
    tauri_invoke as invoke,
    tauri_shell as shell,
  };
}

/** The fields a plugin shows as itself, declared once by its manifest. */
export type PluginIdentity = Pick<PluginManifest, "id" | "name" | "description" | "icon" | "comingSoon" | "experimental">;
export interface Plugin extends PluginIdentity {
    core?: boolean;
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

/** @unstable */
export type registry_Plugin = Plugin;
/** @unstable */
export type registry_PluginBehavior = PluginBehavior;
/** @unstable */
export type registry_PluginIdentity = PluginIdentity;
declare const registry_getPlugin: typeof getPlugin;
declare const registry_getPlugins: typeof getPlugins;
declare const registry_isBackgroundPlugin: typeof isBackgroundPlugin;
declare const registry_registerPlugin: typeof registerPlugin;
/** @unstable */
declare const registry_setPendingManifest: typeof setPendingManifest;
/** @unstable */
declare const registry_unregisterPlugin: typeof unregisterPlugin;
declare namespace registry {
  export { registry_getPlugin as getPlugin, registry_getPlugins as getPlugins, registry_isBackgroundPlugin as isBackgroundPlugin, registry_registerPlugin as registerPlugin, registry_setPendingManifest as setPendingManifest, registry_unregisterPlugin as unregisterPlugin };
  export type { registry_Plugin as Plugin, registry_PluginBehavior as PluginBehavior, registry_PluginIdentity as PluginIdentity };
}

/** True when the plugin is enabled by the user. @unstable */
declare function isPluginEnabled(id: string): boolean;
/** Enable or disable a plugin. @unstable */
declare function setPluginEnabled(id: string, enabled: boolean): void;
/** All registered plugins the user has enabled. @unstable */
declare function getEnabledPlugins(): Plugin[];
/** Activate all enabled plugins. Called when a map opens. @unstable */
declare function activatePlugins(): void;
/** Deactivate all plugins and stop their sidecars. Called when a map closes. @unstable */
declare function deactivatePlugins(): void;
/** Activate a single plugin by id. @unstable */
declare function activatePlugin(id: string): void;
/** Deactivate a single plugin and stop its sidecar. @unstable */
declare function deactivatePlugin(id: string): void;
/** True once the MMA surface is installed and plugins are safe to call it. @unstable */
declare function isReady(): boolean;
/** Mark the plugin surface as ready. @unstable */
declare function markReady(): void;

/** @unstable */
declare const pluginHost_activatePlugin: typeof activatePlugin;
/** @unstable */
declare const pluginHost_activatePlugins: typeof activatePlugins;
/** @unstable */
declare const pluginHost_deactivatePlugin: typeof deactivatePlugin;
/** @unstable */
declare const pluginHost_deactivatePlugins: typeof deactivatePlugins;
/** @unstable */
declare const pluginHost_getEnabledPlugins: typeof getEnabledPlugins;
/** @unstable */
declare const pluginHost_isPluginEnabled: typeof isPluginEnabled;
/** @unstable */
declare const pluginHost_isReady: typeof isReady;
/** @unstable */
declare const pluginHost_markReady: typeof markReady;
/** @unstable */
declare const pluginHost_setPluginEnabled: typeof setPluginEnabled;
declare namespace pluginHost {
  export {
    pluginHost_activatePlugin as activatePlugin,
    pluginHost_activatePlugins as activatePlugins,
    pluginHost_deactivatePlugin as deactivatePlugin,
    pluginHost_deactivatePlugins as deactivatePlugins,
    pluginHost_getEnabledPlugins as getEnabledPlugins,
    pluginHost_isPluginEnabled as isPluginEnabled,
    pluginHost_isReady as isReady,
    pluginHost_markReady as markReady,
    pluginHost_setPluginEnabled as setPluginEnabled,
  };
}

/** True when `appVersion` meets the plugin's minimum version requirement. @unstable */
declare function isPluginCompatible(minAppVersion: string | null | undefined, appVersion: string): boolean;
/** True when a newer version is published and the installed version is known. @unstable */
declare function isPluginUpdatable(installedVersion: string | undefined, latestVersion: string | undefined): boolean;
/** True when either the plugin or its sidecar has a newer published version. @unstable */
declare function needsUpdate(installedVersion: string | undefined, latestVersion: string | undefined, installedSidecarVersion: string | null | undefined, latestSidecarVersion: string | undefined): boolean;
/** The build of a plugin to install. `ref` is the commit, null for the latest. @unstable */
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
/** Fetch the marketplace plugin registry. Later calls return the first result until restart. @unstable */
declare function fetchPluginRegistry(): Promise<PluginManifest[]>;
/** Auto-update a plugin to the newest compatible build before loading it. Falls back
 *  to what is on disk on failure. @unstable */
declare function autoUpdatePlugin(m: PluginManifest, latest: PluginManifest | undefined, appVersion: string): Promise<PluginManifest>;

/** @unstable */
export type marketplace_ResolvedBuild = ResolvedBuild;
/** @unstable */
declare const marketplace_autoUpdatePlugin: typeof autoUpdatePlugin;
/** @unstable */
declare const marketplace_fetchPluginRegistry: typeof fetchPluginRegistry;
/** @unstable */
declare const marketplace_isPluginCompatible: typeof isPluginCompatible;
/** @unstable */
declare const marketplace_isPluginUpdatable: typeof isPluginUpdatable;
/** @unstable */
declare const marketplace_needsBuildUpdate: typeof needsBuildUpdate;
/** @unstable */
declare const marketplace_needsUpdate: typeof needsUpdate;
/** @unstable */
declare const marketplace_resolveBuild: typeof resolveBuild;
declare namespace marketplace {
  export { marketplace_autoUpdatePlugin as autoUpdatePlugin, marketplace_fetchPluginRegistry as fetchPluginRegistry, marketplace_isPluginCompatible as isPluginCompatible, marketplace_isPluginUpdatable as isPluginUpdatable, marketplace_needsBuildUpdate as needsBuildUpdate, marketplace_needsUpdate as needsUpdate, marketplace_resolveBuild as resolveBuild };
  export type { marketplace_ResolvedBuild as ResolvedBuild };
}

export interface PluginStorage {
    get<T = unknown>(key: string, fallback?: T): T;
    set(key: string, value: unknown): void;
    remove(key: string): void;
    keys(): string[];
}
/** Persistent key-value storage namespaced to a plugin. Survives restarts. */
declare function storage(id: string): PluginStorage;
/** React state hook backed by the plugin's persistent store. Survives sidebar
 *  unmount and app restart. Values are global, not per-map. */
declare function usePluginState<T>(pluginId: string, key: string, initial: T | (() => T)): readonly [T, (action: SetStateAction<T>) => void];

/** @unstable */
export type pluginStorage_PluginStorage = PluginStorage;
declare const pluginStorage_storage: typeof storage;
declare const pluginStorage_usePluginState: typeof usePluginState;
declare namespace pluginStorage {
  export { pluginStorage_storage as storage, pluginStorage_usePluginState as usePluginState };
  export type { pluginStorage_PluginStorage as PluginStorage };
}

/** @unstable */
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

/** @unstable */
declare const scope_disposePlugin: typeof disposePlugin;
/** @unstable */
declare const scope_resolvePluginPath: typeof resolvePluginPath;
/** @unstable */
declare const scope_runAsPlugin: typeof runAsPlugin;
/** @unstable */
declare const scope_setPluginBaseDir: typeof setPluginBaseDir;
/** @unstable */
declare const scope_trackDisposable: typeof trackDisposable;
declare namespace scope {
  export {
    scope_disposePlugin as disposePlugin,
    scope_resolvePluginPath as resolvePluginPath,
    scope_runAsPlugin as runAsPlugin,
    scope_setPluginBaseDir as setPluginBaseDir,
    scope_trackDisposable as trackDisposable,
  };
}

/** @unstable */
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
    /** @unstable */
    "store:changed": void;
    /** @unstable */
    "render:delta": RenderDelta;
    /** @unstable */
    "render:selection": SelectionBitmaskPayload;
    "map-list:changed": void;
    /** @unstable */
    "saved-selections:changed": void;
    "settings:changed": void;
    /** @unstable */
    "fullscreen:changed": void;
    "plugins:changed": void;
    /** @unstable */
    "hotkeys:changed": void;
    /** @unstable */
    "toasts:changed": void;
    /** @unstable */
    "jobs:changed": void;
    /** @unstable */
    "bulkruns:changed": void;
    /** @unstable */
    "scene:changed": void;
    /** @unstable */
    "measure:changed": void;
    /** @unstable */
    "anchor:changed": void;
    /** @unstable */
    "viewport-lock:changed": void;
    /** @unstable */
    "trail:changed": void;
    "seen:changed": void;
    /** @unstable */
    "update:changed": void;
    /** @unstable */
    "review:changed": void;
    "fields:changed": void;
    /** @unstable */
    "route:changed": void;
    /** @unstable */
    "import-markers:changed": void;
    /** @unstable */
    "diff-markers:changed": void;
    /** @unstable */
    "commit-diff:changed": void;
};
export type EditorEventMap = typeof EVENT_DEFS;
export type EditorEvent = keyof EditorEventMap;
declare const pluginEventPayload: unique symbol;
/** One of a plugin's own events, named `plugin:<plugin id>:<name>` and carrying a `T` to whoever
 *  hears it. `definePluginEvent` makes one. @unstable */
export type PluginEvent<T = void> = `plugin:${string}:${string}` & {
    readonly [pluginEventPayload]: T;
};
/** What an event hands its handlers. */
export type EventPayload<E extends EditorEvent | PluginEvent<unknown>> = E extends EditorEvent ? EditorEventMap[E] : E extends PluginEvent<infer T> ? T : never;
export type EventHandler<E extends EditorEvent | PluginEvent<unknown>> = (payload: EventPayload<E>) => void;

/** Subscribe to an editor event or a plugin's own event, automatically unsubscribed on plugin
 *  deactivation. */
declare function on<E extends EditorEvent | PluginEvent<unknown>>(event: E, handler: EventHandler<E>): () => void;
/** Name one of plugin `pluginId`'s own events, carrying a `T`. Define it once and share it, so
 *  whoever raises it and whoever hears it agree on the payload. @unstable */
declare function definePluginEvent<T = void>(pluginId: string, name: string): PluginEvent<T>;
/** Raise one of a plugin's own events, with its payload when it carries one. @unstable */
declare function emitPluginEvent<T>(event: PluginEvent<T>, ...payload: T extends void ? [] : [payload: T]): void;
/** React hook: what `read` returns, read again each time `event` is raised. `read` must return
 *  the same reference while nothing it reads has changed. @unstable */
declare function usePluginEvent<V>(event: PluginEvent<unknown>, read: () => V): V;

/** @unstable */
declare const pluginEvents_definePluginEvent: typeof definePluginEvent;
/** @unstable */
declare const pluginEvents_emitPluginEvent: typeof emitPluginEvent;
declare const pluginEvents_on: typeof on;
/** @unstable */
declare const pluginEvents_usePluginEvent: typeof usePluginEvent;
declare namespace pluginEvents {
  export {
    pluginEvents_definePluginEvent as definePluginEvent,
    pluginEvents_emitPluginEvent as emitPluginEvent,
    pluginEvents_on as on,
    pluginEvents_usePluginEvent as usePluginEvent,
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

/** @unstable */
export interface SidecarOptions<T> {
    /** Fires once per JSON object the sidecar emits, in order. */
    onLine?(item: T): void;
    /** Sidecar diagnostic output, one-shot runs only. */
    onLog?(line: string): void;
    signal?: AbortSignal;
}
/** Send a command to a plugin's sidecar and resolve with its last emitted JSON
 *  object (null if it emitted none). `payload` is sent as JSON. @unstable */
declare function request$1<T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T>): Promise<T | null>;
/** The sidecar version installed for a plugin, or null when it has none yet. @unstable */
declare function installedVersion$1(pluginId: string): Promise<string | null>;
/** The nested `sidecar` namespace on the plugin surface. */
declare const sidecar: {
    /** @unstable */
    request: typeof request$1;
    /** @unstable */
    installedVersion: typeof installedVersion$1;
};

/** @unstable */
export type sidecar$1_SidecarOptions<T> = SidecarOptions<T>;
declare const sidecar$1_sidecar: typeof sidecar;
declare namespace sidecar$1 {
  export { sidecar$1_sidecar as sidecar };
  export type { sidecar$1_SidecarOptions as SidecarOptions };
}

export type BarSize = "sm" | "md" | "lg";
export type BarTone = "accent" | "complete" | "incomplete";
/** A bar filled to `value`, a share from 0 to 1. */
declare function Bar({ value, size, tone, className, }: {
    value: number;
    size?: BarSize;
    tone?: BarTone;
    className?: string;
}): react.JSX.Element;

export type ButtonVariant = "primary" | "destructive" | "ghost";
declare function Button({ variant, small, type, className, ...props }: ComponentPropsWithRef<"button"> & {
    variant?: ButtonVariant;
    small?: boolean;
}): react.JSX.Element;

export interface ChoiceLabelProps {
    /** Text shown beside the control. Clicking the text acts like clicking the control. */
    children?: ReactNode;
    /** Secondary text shown under the label. */
    hint?: ReactNode;
}

/** A checkbox, with its label and hint beside it when given. */
declare function Checkbox({ className, children, hint, ...props }: Omit<ComponentPropsWithRef<"input">, "children"> & ChoiceLabelProps): react.JSX.Element;

/** A color picker surface without a swatch. Takes and returns an `[r, g, b]` tuple, debounced. @unstable */
declare function RgbPicker({ color, onChange }: {
    color: RGB;
    onChange: (color: RGB) => void;
}): react.JSX.Element;
/** A color swatch that opens the picker in a popover on click. */
declare function ColorPicker({ color, onChange, ariaLabel, }: {
    color: RGB;
    onChange: (color: RGB) => void;
    ariaLabel?: string;
}): react.JSX.Element;

/** A button that asks "Are you sure?" on the first click and acts on the second. Moving focus
 *  away disarms it. @unstable */
declare function ConfirmButton({ onConfirm, confirmLabel, variant, children, onBlur, ...props }: Omit<ComponentPropsWithRef<typeof Button>, "onClick"> & {
    onConfirm: () => void;
    /** The label while armed. Defaults to "Are you sure?". */
    confirmLabel?: ReactNode;
}): react.JSX.Element;

/** Share of locations holding a value as a bar and a percentage, colored by whether every location is covered when `status` is set. */
declare function CoverageBar({ ratio, size, status, className, }: {
    ratio: number;
    size?: BarSize;
    status?: boolean;
    className?: string;
}): react.JSX.Element;

/** @unstable */
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
/** @unstable */
declare function DatePicker({ mode, value, onChange, anyYear, onAnyYearToggle, showAnyYear, showTime, anyTime, onAnyTimeToggle, showAnyTime, tzLocal, onTzLocalToggle, showTzLocal, onYearSelect, wallClock, }: DatePickerProps): react.JSX.Element;

/** Controlled open/close pair every dialog component takes. */
export interface DialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}
/** @unstable */
declare function useCloseDialog(): () => void;
/** @unstable */
declare function Dialog({ open, onOpenChange, children, ...props }: Omit<ComponentProps<typeof Dialog$1.Root>, "onOpenChange"> & {
    onOpenChange?: (open: boolean) => void;
}): react.JSX.Element;
/** @unstable */
declare const DialogTrigger: Dialog$1.Trigger;
/** A dialog's fixed width: small, medium, large or extra large. */
export type DialogSize = "sm" | "md" | "lg" | "xl";
/** @unstable */
declare function DialogContent({ className, title, size, initialFocus, children, ...props }: ComponentProps<typeof Dialog$1.Popup> & {
    title: string;
    size?: DialogSize;
}): react.JSX.Element;
/** One button in a dialog footer. */
export interface DialogAction {
    label: ReactNode;
    /** Runs on click. Without it the button submits the form it sits in. */
    onClick?: () => void;
    disabled?: boolean;
    /** An identifier for automated tests. */
    "data-qa"?: string;
}
/** A dialog's footer: side content on the left, then Cancel, then the main action on the right.
 *  @unstable */
declare function DialogActions({ start, destructive, cancel, primary, }: {
    /** Content held to the left: a summary, a meter, paging or secondary buttons. */
    start?: ReactNode;
    /** An action that destroys something, held to the far left. With `confirm` it asks "Are you
     *  sure?" on the first click and acts on the second. */
    destructive?: DialogAction & {
        confirm?: boolean;
    };
    /** The dismiss button, labelled Cancel and closing the dialog unless told otherwise. */
    cancel?: true | Partial<DialogAction>;
    /** The action the dialog exists for, always rightmost. */
    primary?: DialogAction & {
        tone?: "primary" | "destructive";
    };
}): react.JSX.Element;
/** A dialog body laid out as a column that runs `onSubmit` when submitted, Enter included.
 *  @unstable */
declare function DialogForm({ onSubmit, className, ...props }: Omit<ComponentPropsWithRef<"form">, "onSubmit"> & {
    onSubmit: () => void;
}): react.JSX.Element;
/** Asks the user to confirm one action, with room for extra options under the message.
 *  @unstable */
declare function ConfirmDialog({ open, onOpenChange, title, message, confirmLabel, cancelLabel, tone, busy, size, onConfirm, children, }: DialogProps & {
    title: string;
    message: ReactNode;
    confirmLabel: ReactNode;
    cancelLabel?: ReactNode;
    /** Destructive for an action that cannot be taken back. */
    tone?: "primary" | "destructive";
    /** Disables both buttons while the action runs. */
    busy?: boolean;
    size?: DialogSize;
    onConfirm: () => void;
    children?: ReactNode;
}): react.JSX.Element;
/** Asks for one line of text, submitted with Enter or the submit button.
 *  @unstable */
declare function PromptDialog({ open, onOpenChange, title, value, onChange, placeholder, submitLabel, error, canSubmit, selectOnFocus, size, onSubmit, children, }: DialogProps & {
    title: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    submitLabel: ReactNode;
    /** Shown under the field. Pass null to keep its line reserved while there is no error. */
    error?: ReactNode;
    /** Whether the value can be submitted. Defaults to the value not being blank. */
    canSubmit?: boolean;
    /** Selects the whole value when the field gains focus. */
    selectOnFocus?: boolean;
    size?: DialogSize;
    onSubmit: () => void;
    /** Extra content between the field and the buttons. */
    children?: ReactNode;
}): react.JSX.Element;

/** Country flag from the bundled SVG set. Renders nothing for a missing or malformed code. */
declare function Flag({ code, height, className, }: {
    code: string | null;
    height?: number;
    className?: string;
}): react.JSX.Element | null;

/** A line of secondary text, optionally marked as a warning or an error. */
declare function Hint({ tone, children }: {
    tone?: "warning" | "error";
    children?: ReactNode;
}): react.JSX.Element;
/** A boxed message that informs, warns, reports an error or confirms a success. */
declare function Notice({ tone, children, }: {
    tone: "info" | "warning" | "error" | "success";
    children: ReactNode;
}): react.JSX.Element;

/** Click-to-record key combo input. Backspace/Delete clears, Escape cancels. @unstable */
declare function HotkeyInput({ value, onChange, }: {
    value: string;
    onChange: (combo: string) => void;
}): react.JSX.Element;

export interface IconProps {
    path: string;
    size?: number;
    className?: string;
    style?: React.CSSProperties;
}
declare function Icon({ path, size, className, style }: IconProps): react.JSX.Element;

/** A button showing only an icon, named by its label. @unstable */
declare function IconButton({ icon, label, size, active, reveal, overlay, tooltip, tooltipSide, type, className, children, ...props }: Omit<ComponentPropsWithRef<"button">, "aria-label" | "title"> & {
    /** An icon path, or a drawn icon to show instead. */
    icon: string | ReactNode;
    /** What the button does, read aloud and shown as its tooltip. */
    label: string;
    /** The icon's size in pixels. */
    size?: number;
    /** Shows the button as pressed. */
    active?: boolean;
    /** Hides the button until its row is hovered or holds focus. */
    reveal?: boolean;
    /** Draws the button for use over map or street view imagery. */
    overlay?: boolean;
    /** The tooltip text, or false for none. Defaults to the label. */
    tooltip?: string | false;
    /** The side the tooltip opens on. */
    tooltipSide?: "top" | "bottom" | "left" | "right";
    /** Shown after the icon, such as a badge. */
    children?: ReactNode;
}): react.JSX.Element;

/** A dropdown. `compact` shrinks it to fit its value; `limited` caps the height of its option list.
 *  @unstable */
declare function NSelect({ className, compact, limited, onWheel, ...props }: ComponentPropsWithRef<"select"> & {
    compact?: boolean;
    limited?: boolean;
}): react.JSX.Element;

/** A progress bar under its label and count, with any extra detail below it. */
declare function ProgressRow({ label, count, value, size, className, children, }: {
    label: ReactNode;
    count?: ReactNode;
    value: number;
    size?: BarSize;
    className?: string;
    children?: ReactNode;
}): react.JSX.Element;

/** A radio button, with its label and hint beside it when given. */
declare function Radio({ className, children, hint, ...props }: Omit<ComponentPropsWithRef<"input">, "children"> & ChoiceLabelProps): react.JSX.Element;

declare function SelectorPicker({ ctl, className, }: {
    ctl: SelectorPickController;
    className?: string;
}): react.JSX.Element;

/** `label` stays a plain string so settings search can match on it; `badge` is the escape hatch
 *  for a marker sitting beside it, like the flask on an experimental plugin card. @unstable */
export type Base = {
    label: string;
    badge?: ReactNode;
    description?: string;
    /** Extra search terms, e.g. the option labels of a select control. */
    keywords?: string[];
    disabled?: boolean;
    sub?: boolean;
};
/** @unstable */
export type BoolRow = Base & {
    checked: boolean;
    onChange: (v: boolean) => void;
};
/** @unstable */
export type AutoBoolRow = Base & {
    setting: keyof AppSettings;
};
/** @unstable */
export type ControlRow = Base & {
    control: ReactNode;
};
/** @unstable */
declare function SettingRow(props: BoolRow | ControlRow | AutoBoolRow): react.JSX.Element | null;

/** A message for a panel or list with nothing to show, with an optional icon. `compact` fits it
 *  inline in a list. */
declare function EmptyState({ icon, compact, children, }: {
    icon?: string;
    compact?: boolean;
    children: ReactNode;
}): react.JSX.Element;

/** Standard right-hand sidebar chrome (title, back button, scrollable body). Use for plugin sidebars. */
declare function Sidebar({ title, onBack, actions, className, flush, children, }: {
    title: ReactNode;
    onBack?: () => void;
    actions?: ReactNode;
    className?: string;
    flush?: boolean;
    children: ReactNode;
}): react.JSX.Element;
/** Collapsible titled section inside a Sidebar. */
declare function Section({ title, defaultOpen, collapsible, addons, children, }: {
    title: ReactNode;
    defaultOpen?: boolean;
    collapsible?: boolean;
    addons?: ReactNode;
    children: ReactNode;
}): react.JSX.Element;
/** Labelled form row (label left, control right) for sidebar sections. */
declare function Field({ label, hint, row, children, }: {
    label: ReactNode;
    hint?: ReactNode;
    row?: boolean;
    children: ReactNode;
}): react.JSX.Element;
export interface SegmentedOption<T extends string | number> {
    value: T;
    label: ReactNode;
    disabled?: boolean;
    title?: string;
}
/** Row of mutually exclusive option buttons. `role` is `"tabs"` when the options switch between
 *  panels and `"radio"` (the default) when they pick a value; `fill` stretches the options to
 *  equal widths across the row. */
declare function SegmentedControl<T extends string | number>({ options, value, onChange, role, fill, className, }: {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    role?: "tabs" | "radio";
    fill?: boolean;
    className?: string;
}): react.JSX.Element;

/** A range input whose track fills up to its value, followed by the value itself when `format` is given. */
declare function Slider({ className, format, ...props }: ComponentPropsWithRef<"input"> & {
    format?: (value: number) => ReactNode;
}): react.JSX.Element;

/** A spinning ring shown while something loads. `size` is any length, such as `"10px"`. */
declare function Spinner({ size, label }: {
    size?: string;
    label?: string;
}): react.JSX.Element;

/** Text input with a suggestion dropdown. Enter picks the first suggestion; Escape or an
 *  outside click closes it. The dropdown shows whenever `suggestions` is non-empty, so
 *  filter or fetch them yourself. The class props restyle it. @unstable */
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
}): react.JSX.Element;

declare function Switch({ checked, onChange, disabled, label, }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    label?: string;
}): react.JSX.Element;

/** A compact row with a switch on the left. Clicking anywhere on the row toggles it. */
declare function SwitchRow({ checked, onChange, label, disabled, className, children, }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    disabled?: boolean;
    className?: string;
    children?: ReactNode;
}): react.JSX.Element;

/** @unstable */
export type TagPillButtonVariant = "add" | "delete" | "edit";
/** The leading affordance inside a TagPill: remove, apply, or open the editor. @unstable */
declare function TagPillButton({ variant, className, ...props }: ComponentPropsWithRef<"button"> & {
    variant: TagPillButtonVariant;
}): react.JSX.Element;
/** @unstable */
export type TagPillOwnProps = {
    color: string;
    label: ReactNode;
    count?: number;
    small?: boolean;
    button?: ReactNode;
    children?: ReactNode;
};
/** @unstable */
export type TagPillProps<E extends ElementType> = TagPillOwnProps & {
    as?: E;
} & Omit<ComponentPropsWithRef<E>, keyof TagPillOwnProps | "as">;
/** A tag shown as a pill in its color. @unstable */
declare function TagPill<E extends ElementType = "span">({ as, color, label, count, small, button, children, ...rest }: TagPillProps<E>): react.JSX.Element;

declare function TextInput({ className, ...props }: ComponentPropsWithRef<"input">): react.JSX.Element;

/** @unstable */
export interface ToolBlockProps {
    title: string;
    className?: string;
    addons?: ReactNode;
    children?: ReactNode;
    isCollapsed?: boolean;
    onCollapse?: (collapsed: boolean) => void;
    collapsedAddons?: ReactNode;
}
/** @unstable */
declare function ToolBlock(props: ToolBlockProps): react.JSX.Element;

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";
/** Shows `content` as a tooltip when its child is hovered. The child is not wrapped. */
declare function Tooltip({ content, side, align, children, }: {
    content: string;
    side?: Side;
    align?: Align;
    children: ReactElement;
}): ReactElement<Record<string, unknown>, string | react.JSXElementConstructor<any>>;

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

declare const primitives_Bar: typeof Bar;
declare const primitives_Button: typeof Button;
declare const primitives_Checkbox: typeof Checkbox;
declare const primitives_ColorPicker: typeof ColorPicker;
/** @unstable */
declare const primitives_ConfirmButton: typeof ConfirmButton;
/** @unstable */
declare const primitives_ConfirmDialog: typeof ConfirmDialog;
declare const primitives_CoverageBar: typeof CoverageBar;
/** @unstable */
declare const primitives_DatePicker: typeof DatePicker;
/** @unstable */
declare const primitives_Dialog: typeof Dialog;
/** @unstable */
export type primitives_DialogAction = DialogAction;
/** @unstable */
declare const primitives_DialogActions: typeof DialogActions;
/** @unstable */
declare const primitives_DialogContent: typeof DialogContent;
/** @unstable */
declare const primitives_DialogForm: typeof DialogForm;
/** @unstable */
export type primitives_DialogProps = DialogProps;
/** @unstable */
export type primitives_DialogSize = DialogSize;
declare const primitives_DialogTrigger: typeof DialogTrigger;
declare const primitives_EmptyState: typeof EmptyState;
declare const primitives_Field: typeof Field;
declare const primitives_Flag: typeof Flag;
declare const primitives_Hint: typeof Hint;
/** @unstable */
declare const primitives_HotkeyInput: typeof HotkeyInput;
declare const primitives_Icon: typeof Icon;
/** @unstable */
declare const primitives_IconButton: typeof IconButton;
/** @unstable */
declare const primitives_NSelect: typeof NSelect;
declare const primitives_Notice: typeof Notice;
declare const primitives_ProgressRow: typeof ProgressRow;
/** @unstable */
declare const primitives_PromptDialog: typeof PromptDialog;
declare const primitives_Radio: typeof Radio;
/** @unstable */
declare const primitives_RgbPicker: typeof RgbPicker;
declare const primitives_Section: typeof Section;
declare const primitives_SegmentedControl: typeof SegmentedControl;
/** @unstable */
export type primitives_SegmentedOption<T extends string | number> = SegmentedOption<T>;
declare const primitives_SelectorPicker: typeof SelectorPicker;
/** @unstable */
declare const primitives_SettingRow: typeof SettingRow;
declare const primitives_Sidebar: typeof Sidebar;
declare const primitives_Slider: typeof Slider;
declare const primitives_Spinner: typeof Spinner;
/** @unstable */
declare const primitives_SuggestInput: typeof SuggestInput;
declare const primitives_Switch: typeof Switch;
declare const primitives_SwitchRow: typeof SwitchRow;
/** @unstable */
declare const primitives_TagPill: typeof TagPill;
/** @unstable */
declare const primitives_TagPillButton: typeof TagPillButton;
declare const primitives_TextInput: typeof TextInput;
/** @unstable */
declare const primitives_ToolBlock: typeof ToolBlock;
declare const primitives_Tooltip: typeof Tooltip;
/** @unstable */
declare const primitives_useCloseDialog: typeof useCloseDialog;
declare namespace primitives {
  export { primitives_Bar as Bar, primitives_Button as Button, primitives_Checkbox as Checkbox, primitives_ColorPicker as ColorPicker, primitives_ConfirmButton as ConfirmButton, primitives_ConfirmDialog as ConfirmDialog, primitives_CoverageBar as CoverageBar, primitives_DatePicker as DatePicker, primitives_Dialog as Dialog, primitives_DialogActions as DialogActions, primitives_DialogContent as DialogContent, primitives_DialogForm as DialogForm, primitives_DialogTrigger as DialogTrigger, primitives_EmptyState as EmptyState, primitives_Field as Field, primitives_Flag as Flag, primitives_Hint as Hint, primitives_HotkeyInput as HotkeyInput, primitives_Icon as Icon, primitives_IconButton as IconButton, primitives_NSelect as NSelect, primitives_Notice as Notice, primitives_ProgressRow as ProgressRow, primitives_PromptDialog as PromptDialog, primitives_Radio as Radio, primitives_RgbPicker as RgbPicker, primitives_Section as Section, primitives_SegmentedControl as SegmentedControl, primitives_SelectorPicker as SelectorPicker, primitives_SettingRow as SettingRow, primitives_Sidebar as Sidebar, primitives_Slider as Slider, primitives_Spinner as Spinner, primitives_SuggestInput as SuggestInput, primitives_Switch as Switch, primitives_SwitchRow as SwitchRow, primitives_TagPill as TagPill, primitives_TagPillButton as TagPillButton, primitives_TextInput as TextInput, primitives_ToolBlock as ToolBlock, primitives_Tooltip as Tooltip, primitives_useCloseDialog as useCloseDialog };
  export type { primitives_DialogAction as DialogAction, primitives_DialogProps as DialogProps, primitives_DialogSize as DialogSize, primitives_SegmentedOption as SegmentedOption };
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
declare function knownFieldDefs(...keys: string[]): Record<string, FieldDef>;
/** All enrichment field options (core and plugin-registered). @unstable */
declare function getEnrichFieldOptions(): EnrichFieldOption[];
/** Offer extra fields in the enrichment UI. Unregistered when the plugin deactivates. */
declare function registerEnrichFields(fields: EnrichFieldOption[]): void;
/** All enrichment field keys (core and plugin-registered). @unstable */
declare function getAllEnrichKeys(): string[];
/** Keys enriched when enrichFields is null (the default set: all options except defaultOff ones). @unstable */
declare function getDefaultEnrichKeys(): string[];
/** The declared form of a wire struct: every field optional, absent where the wire says null. @unstable */
export type Declared<T> = {
    [K in keyof T]?: NonNullable<T[K]>;
};
/** A unit of work for the procedure engine: the procedure's own declaration (`ProcedureDecl`,
 *  what a run and a query both read) plus how a run schedules it. @unstable */
export interface ProcedureSpec<TCollected = unknown, TConfig = unknown> extends Declared<Omit<ProcedureDecl, "entry" | "config">>, Declared<Pick<ProviderDecl, "select" | "sink" | "instances">> {
    /** Phantom field carrying the `TCollected` type. Never set at runtime. */
    readonly collects?: TCollected;
    /** Module entry point: absolute path, `res://procedures/<name>.js` for built-in
     *  procedures, or a relative filename (resolved against the plugin's directory). */
    entry: string;
    batch: BatchMode;
    /** The procedure's own configuration, handed to every entry point as `config`. */
    config?: TConfig;
    /** Awaited before the provider joins a run; returning false excludes it. */
    prepare?: () => Promise<boolean>;
}
/** A named procedure with dependency-graph placement. Providers that declare
 *  `fieldDefs` are enrichment providers whose fields appear in the enrichment UI. @unstable */
export interface Provider<TCollected = unknown, TConfig = unknown> {
    /** @unstable */
    id: string;
    /** Name shown in enrichment progress and results. @unstable */
    label: string;
    /** The procedure that computes this provider's fields. @unstable */
    procedure: ProcedureSpec<TCollected, TConfig>;
    /** Extra-field keys this provider produces. @unstable */
    fieldDefs?: Record<string, FieldDef>;
    /** Core columns this provider writes (e.g. `panoId`). @unstable */
    provides?: string[];
    /** Fields this provider reads; it runs after their producers finish. @unstable */
    requires?: string[];
}
/** Register a provider (e.g. a plugin's sun position). Unregistered when the plugin
 *  deactivates. */
declare function registerProvider(provider: Provider): void;
/** All registered providers. @unstable */
declare function getProviders(): Provider[];
/** The provider that produces a given extra field, if any. @unstable */
declare function getProviderForField(field: string): Provider | undefined;
/** True when `key` is in the given enrichment set (or in the default set when null). @unstable */
declare function isFieldEnabled(enrichFields: string[] | null, key: string): boolean;
/** Every field transitively derived from the `changed` keys via the provider graph. @unstable */
declare function derivedFrom(changed: Iterable<string>): Set<string>;
/** Remove fields transitively derived from `changed` from an `extra` record. @unstable */
declare function withoutDerivedFrom(extra: Record<string, unknown> | null, changed: Iterable<string>): Record<string, unknown> | null;

/** @unstable */
export type fieldDefs_EnrichFieldOption = EnrichFieldOption;
/** @unstable */
export type fieldDefs_ProcedureSpec<TCollected = unknown, TConfig = unknown> = ProcedureSpec<TCollected, TConfig>;
/** @unstable */
export type fieldDefs_Provider<TCollected = unknown, TConfig = unknown> = Provider<TCollected, TConfig>;
/** @unstable */
declare const fieldDefs_derivedFrom: typeof derivedFrom;
/** @unstable */
declare const fieldDefs_getAllEnrichKeys: typeof getAllEnrichKeys;
/** @unstable */
declare const fieldDefs_getDefaultEnrichKeys: typeof getDefaultEnrichKeys;
/** @unstable */
declare const fieldDefs_getEnrichFieldOptions: typeof getEnrichFieldOptions;
/** @unstable */
declare const fieldDefs_getProviderForField: typeof getProviderForField;
/** @unstable */
declare const fieldDefs_getProviders: typeof getProviders;
/** @unstable */
declare const fieldDefs_isFieldEnabled: typeof isFieldEnabled;
declare const fieldDefs_knownFieldDefs: typeof knownFieldDefs;
declare const fieldDefs_registerEnrichFields: typeof registerEnrichFields;
declare const fieldDefs_registerProvider: typeof registerProvider;
/** @unstable */
declare const fieldDefs_withoutDerivedFrom: typeof withoutDerivedFrom;
declare namespace fieldDefs {
  export { fieldDefs_derivedFrom as derivedFrom, fieldDefs_getAllEnrichKeys as getAllEnrichKeys, fieldDefs_getDefaultEnrichKeys as getDefaultEnrichKeys, fieldDefs_getEnrichFieldOptions as getEnrichFieldOptions, fieldDefs_getProviderForField as getProviderForField, fieldDefs_getProviders as getProviders, fieldDefs_isFieldEnabled as isFieldEnabled, fieldDefs_knownFieldDefs as knownFieldDefs, fieldDefs_registerEnrichFields as registerEnrichFields, fieldDefs_registerProvider as registerProvider, fieldDefs_withoutDerivedFrom as withoutDerivedFrom };
  export type { fieldDefs_EnrichFieldOption as EnrichFieldOption, fieldDefs_ProcedureSpec as ProcedureSpec, fieldDefs_Provider as Provider };
}

/** True when `key` is a built-in Location field (stored top-level, not under `extra`). */
declare function isBuiltinField(key: string): boolean;
/** True when the field can be bulk-edited. @unstable */
declare function isWritableField(key: string): boolean;
/** True when the field can be bulk-cleared. @unstable */
declare function isClearableField(key: string): boolean;
/** True when the field should appear in field pickers. @unstable */
declare function isListableField(key: string): boolean;
/** All built-in field keys (excluding virtual). @unstable */
declare function getBuiltinKeys(): string[];
/** Register field definitions from an enrichment provider (called at activation). */
declare function registerPluginFieldDefs(defs: Record<string, FieldDef>): void;
/** Remove plugin field definitions by key (called when a plugin is deactivated). */
declare function unregisterPluginFieldDefs(keys: string[]): void;
/** Keys some location on this map carries. Same reference until the user layer moves. */
declare const getKnownFieldKeys: () => ReadonlySet<string>;
/** Look up metadata for a field key. Returns `undefined` if no layer declares it. */
declare function getFieldDef(key: string): FieldDef | undefined;
/** Translated display label for a field key, falling back to a sentence-cased version of the key. */
declare function fieldLabel(key: string): string;
/** Display label for a field value. Enum values use their translated display name. */
declare function fieldValueLabel(def: FieldDef | undefined, value: unknown): string;
/** The value space a field declares, as bare strings. Distinct from the store's
 *  `fieldValues`, which reports the values actually present in the data. */
declare function declaredValues(def: FieldDef | undefined): string[] | null;
/** Merged view of all field definitions across all layers. */
declare function getAllFieldDefs(): Record<string, FieldDef>;

declare const fieldDefRegistry_declaredValues: typeof declaredValues;
declare const fieldDefRegistry_fieldLabel: typeof fieldLabel;
declare const fieldDefRegistry_fieldValueLabel: typeof fieldValueLabel;
declare const fieldDefRegistry_getAllFieldDefs: typeof getAllFieldDefs;
/** @unstable */
declare const fieldDefRegistry_getBuiltinKeys: typeof getBuiltinKeys;
declare const fieldDefRegistry_getFieldDef: typeof getFieldDef;
declare const fieldDefRegistry_getKnownFieldKeys: typeof getKnownFieldKeys;
declare const fieldDefRegistry_isBuiltinField: typeof isBuiltinField;
/** @unstable */
declare const fieldDefRegistry_isClearableField: typeof isClearableField;
/** @unstable */
declare const fieldDefRegistry_isListableField: typeof isListableField;
/** @unstable */
declare const fieldDefRegistry_isWritableField: typeof isWritableField;
declare const fieldDefRegistry_registerPluginFieldDefs: typeof registerPluginFieldDefs;
declare const fieldDefRegistry_unregisterPluginFieldDefs: typeof unregisterPluginFieldDefs;
declare namespace fieldDefRegistry {
  export {
    fieldDefRegistry_declaredValues as declaredValues,
    fieldDefRegistry_fieldLabel as fieldLabel,
    fieldDefRegistry_fieldValueLabel as fieldValueLabel,
    fieldDefRegistry_getAllFieldDefs as getAllFieldDefs,
    fieldDefRegistry_getBuiltinKeys as getBuiltinKeys,
    fieldDefRegistry_getFieldDef as getFieldDef,
    fieldDefRegistry_getKnownFieldKeys as getKnownFieldKeys,
    fieldDefRegistry_isBuiltinField as isBuiltinField,
    fieldDefRegistry_isClearableField as isClearableField,
    fieldDefRegistry_isListableField as isListableField,
    fieldDefRegistry_isWritableField as isWritableField,
    fieldDefRegistry_registerPluginFieldDefs as registerPluginFieldDefs,
    fieldDefRegistry_unregisterPluginFieldDefs as unregisterPluginFieldDefs,
  };
}

/** @unstable */
export interface FieldProjection {
    id: string;
    label: string;
    /** True when this projection uses the location's timezone. */
    needsTz: boolean;
}
/** Projections valid for a field type, in display order (first = dialog default). @unstable */
declare function projectionsForType(type: FieldType): FieldProjection[];
/** The "Range" partition option (numeric binning). @unstable */
declare const RANGE_ID = "range";
/** Partition-key dropdown options for a field type. @unstable */
declare function partitionKeyOptions(type: FieldType, rangeForDates: boolean): {
    id: string;
    label: string;
}[];

/** @unstable */
export type fieldProjections_FieldProjection = FieldProjection;
/** @unstable */
declare const fieldProjections_RANGE_ID: typeof RANGE_ID;
/** @unstable */
declare const fieldProjections_partitionKeyOptions: typeof partitionKeyOptions;
/** @unstable */
declare const fieldProjections_projectionsForType: typeof projectionsForType;
declare namespace fieldProjections {
  export { fieldProjections_RANGE_ID as RANGE_ID, fieldProjections_partitionKeyOptions as partitionKeyOptions, fieldProjections_projectionsForType as projectionsForType };
  export type { fieldProjections_FieldProjection as FieldProjection };
}

/** Entry point of a procedure this app bundles. Plugins ship their own paths. @unstable */
declare const procedureEntry: (name: string) => string;
/** The readable name behind an entry point, for surfaces that show one. @unstable */
declare const procedureName: (entry: string) => string;
/** Ask a procedure a read-only question under its declared network limits. Rejects when it
 *  exports no `query`, when the call fails, or when `signal` aborts. `onPartial` receives
 *  pages of answers as they resolve, ahead of the full result; each entry carries the id
 *  the emitting side chose for it. @unstable */
declare function queryProcedure<T = unknown, P = unknown>(spec: ProcedureSpec, input: unknown, signal?: AbortSignal, onPartial?: (entries: {
    id: number;
    value: P;
}[]) => void): Promise<T>;
/** Display labels for a field's partition keys. Month-of-year keys are numeric tokens and
 *  become locale month names; otherwise falls back to the keys themselves when the field's
 *  procedure has no `label` query or returns a non-matching array. @unstable */
declare function resolveFieldLabels(field: string, keys: string[], key?: KeySpec): Promise<string[]>;
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
/** Every declaration a run scheduled, by provider id. @unstable */
export type ProviderOutcomes = Record<string, ProcedureOutcome>;
/** @unstable */
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
/** A provider to run, optionally overriding the config its procedure declares. @unstable */
export interface ProviderRun<TConfig = unknown> {
    provider: Provider<unknown, TConfig>;
    config?: Partial<NoInfer<TConfig>>;
    /** Re-derive this provider's fields even on an unforced run. For an operation whose
     *  point is to recompute one provider rather than fill in what is missing. */
    force?: boolean;
    /** The `fieldDefs` keys to produce; omitted, every key it declares. */
    fields?: string[];
}
/** Run a set of providers over `rows`. When `rows` is a Selector, matching locations
 *  are processed in place and results are written back. When `rows` is a Location array,
 *  locations are processed independently and returned as modified copies. Resolves once
 *  every provider finishes, or on abort. @unstable */
declare function runProviders<C extends readonly unknown[]>(items: {
    [K in keyof C]: ProviderRun<C[K]>;
}, rows: Selector, opts?: RunOpts): Promise<ProviderOutcomes>;
/** @unstable */
declare function runProviders<C extends readonly unknown[]>(items: {
    [K in keyof C]: ProviderRun<C[K]>;
}, rows: Location[], opts?: RunOpts): Promise<RowsRun>;
/** What a run may set on top of what the spec declares. @unstable */
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
declare function runProcedure<T, C>(spec: ProcedureSpec<T, C>, selector: Selector, opts: Omit<RunOpts, "force"> & Omit<DeclOpts, "fields" | "requires" | "config"> & {
    id: string;
    config?: Partial<NoInfer<C>>;
}): Promise<ProcedureOutcome<T>>;

/** @unstable */
export type procedures_BatchOutcome = BatchOutcome;
/** @unstable */
export type procedures_BulkOpts = BulkOpts;
/** @unstable */
export type procedures_CollectedEntry<T = unknown> = CollectedEntry<T>;
/** @unstable */
export type procedures_ProcedureOutcome<TCollected = unknown> = ProcedureOutcome<TCollected>;
/** @unstable */
export type procedures_ProviderOutcomes = ProviderOutcomes;
/** @unstable */
export type procedures_ProviderPart = ProviderPart;
/** @unstable */
export type procedures_ProviderRun<TConfig = unknown> = ProviderRun<TConfig>;
/** @unstable */
export type procedures_RunOpts = RunOpts;
/** @unstable */
declare const procedures_noWork: typeof noWork;
/** @unstable */
declare const procedures_procedureEntry: typeof procedureEntry;
/** @unstable */
declare const procedures_procedureName: typeof procedureName;
/** @unstable */
declare const procedures_queryProcedure: typeof queryProcedure;
/** @unstable */
declare const procedures_resolveFieldLabels: typeof resolveFieldLabels;
/** @unstable */
declare const procedures_runProcedure: typeof runProcedure;
/** @unstable */
declare const procedures_runProviders: typeof runProviders;
declare namespace procedures {
  export { procedures_noWork as noWork, procedures_procedureEntry as procedureEntry, procedures_procedureName as procedureName, procedures_queryProcedure as queryProcedure, procedures_resolveFieldLabels as resolveFieldLabels, procedures_runProcedure as runProcedure, procedures_runProviders as runProviders };
  export type { procedures_BatchOutcome as BatchOutcome, procedures_BulkOpts as BulkOpts, procedures_CollectedEntry as CollectedEntry, procedures_ProcedureOutcome as ProcedureOutcome, procedures_ProviderOutcomes as ProviderOutcomes, procedures_ProviderPart as ProviderPart, procedures_ProviderRun as ProviderRun, procedures_RunOpts as RunOpts };
}

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
declare namespace seen {
  export {
    seen_clearSeen as clearSeen,
    seen_getSeenCount as getSeenCount,
    seen_getSeenCountries as getSeenCountries,
    seen_getSeenEntries as getSeenEntries,
    seen_getSeenMaps as getSeenMaps,
  };
}

/** @unstable */
export type PanoDestination = string | google.maps.LatLngLiteral;
/** @unstable */
export type PanoFrame = CameraFrame & {
    zoom?: number;
};
/** @unstable */
export type ShowResult = {
    status: "shown";
    pano: Pano | null;
} | {
    status: "superseded";
};
/** @unstable */
export type PanoEvent = "pov_changed" | "zoom_changed" | "links_changed" | "status_changed" | "pano_changed";
/** @unstable */
export type PanoViewer = ReturnType<typeof createPano>;
/** Create an independent pano viewer with its own camera, requests, listeners and mounts. @unstable */
declare function createPano(): {
    /** Resolve and show a location's pano, optionally hidden until it loads; "superseded" when overtaken. */
    show: (loc: Location, { concealUntilReady }?: {
        concealUntilReady?: boolean;
    }) => Promise<ShowResult>;
    /** Move to a pano id or position now, optionally setting the camera, overtaking pending requests. */
    jump: (to: PanoDestination, frame?: PanoFrame) => void;
    /** Step to the linked pano nearest the camera heading, or its reverse. */
    step: (direction: "forward" | "backward") => boolean;
    /** Jump to the nearest official pano ahead of the camera, turned by `headingOffset` degrees. */
    jumpAhead: (headingOffset: number) => Promise<boolean>;
    /** Stage a location's pano while nothing newer is pending, so a later show is instant. */
    preload: (loc: Location) => Promise<void>;
    /** Rebuild a stuck viewer in place, keeping its pano and camera. */
    reload: (fallback: google.maps.LatLngLiteral) => void;
    /** Whether the viewer has been created. */
    exists: () => boolean;
    /** Whether the viewer has finished loading its current pano. */
    isLoaded: () => boolean;
    /** The current pano id, or null before one loads. */
    panoId: () => string | null;
    /** The current pano's position, or null before one loads. */
    position: () => google.maps.LatLngLiteral | null;
    /** The camera heading and pitch. */
    pov: () => CameraFrame;
    /** The viewer's display zoom. */
    zoom: () => number;
    /** The current pano's navigable links. */
    links: () => google.maps.StreetViewLink[];
    /** The camera in the stored zoom domain, zeroed without a viewer. */
    captureView: () => LocationPOV;
    /** The viewer read back into Location fields, or null until it has a position. */
    capture: () => PanoCapture | null;
    /** Freeze the live camera for an offscreen render; throws until a pano is ready. */
    snapshot: () => PanoView;
    /** The live WebGL scene canvas, or null before the first render. */
    canvas: () => HTMLCanvasElement | null;
    /** Cover-crop the live frame into an exact image, or null until real imagery renders. */
    captureImage: (width: number, height: number) => HTMLCanvasElement | null;
    /** Point the camera now. */
    look: (frame: PanoFrame) => void;
    /** Reserve a camera move across an async wait; it lands only if nothing moved the pano since. */
    reserveLook: () => (frame: PanoFrame) => boolean;
    /** Nudge heading and pitch by a delta, keeping pitch in range. */
    nudge: (dHeading: number, dPitch: number) => void;
    /** Animate the camera to a frame, replacing any turn in progress. */
    turnTo: (target: CameraFrame) => void;
    /** Face north level, or look straight down zoomed out when already facing north. */
    pointNorth: () => void;
    /** Face the linked road nearest the camera heading. */
    faceRoad: () => void;
    /** Turn to face the opposite direction. */
    turnAround: () => void;
    /** Turn to the next linked road clockwise from the camera. */
    turnToNextLink: () => void;
    /** Step the zoom in. */
    zoomIn: () => void;
    /** Step the zoom out. */
    zoomOut: () => void;
    /** Zoom fully out. */
    resetZoom: () => void;
    /** Listen to a viewer event, across viewer rebuilds; returns an unsubscribe. */
    on: (event: PanoEvent, fn: () => void) => () => void;
    /** Apply display options to the viewer. */
    configure: (options: google.maps.StreetViewPanoramaOptions) => void;
    /** Hide the viewer. */
    hide: () => void;
    /** Parent the viewer into a container; the newest mount wins until released. */
    mount: (target: HTMLElement) => () => void;
    /** Draw the crosshair over the viewer; returns a remove. */
    showCrosshair: () => () => void;
    /** Show a toast anchored over the viewer. */
    toast: (message: string, durationMs: number) => void;
    /** Release the viewer, its container and every listener; the instance is unusable afterwards. */
    dispose: () => void;
};
/** The app's default pano viewer. @unstable */
declare const pano: {
    /** Resolve and show a location's pano, optionally hidden until it loads; "superseded" when overtaken. @unstable */
    show: (loc: Location, { concealUntilReady }?: {
        concealUntilReady?: boolean;
    }) => Promise<ShowResult>;
    /** Move to a pano id or position now, optionally setting the camera, overtaking pending requests. @unstable */
    jump: (to: PanoDestination, frame?: PanoFrame) => void;
    /** Step to the linked pano nearest the camera heading, or its reverse. @unstable */
    step: (direction: "forward" | "backward") => boolean;
    /** Jump to the nearest official pano ahead of the camera, turned by `headingOffset` degrees. @unstable */
    jumpAhead: (headingOffset: number) => Promise<boolean>;
    /** Stage a location's pano while nothing newer is pending, so a later show is instant. @unstable */
    preload: (loc: Location) => Promise<void>;
    /** Rebuild a stuck viewer in place, keeping its pano and camera. @unstable */
    reload: (fallback: google.maps.LatLngLiteral) => void;
    /** Whether the viewer has been created. @unstable */
    exists: () => boolean;
    /** Whether the viewer has finished loading its current pano. @unstable */
    isLoaded: () => boolean;
    /** The current pano id, or null before one loads. @unstable */
    panoId: () => string | null;
    /** The current pano's position, or null before one loads. @unstable */
    position: () => google.maps.LatLngLiteral | null;
    /** The camera heading and pitch. @unstable */
    pov: () => CameraFrame;
    /** The viewer's display zoom. @unstable */
    zoom: () => number;
    /** The current pano's navigable links. @unstable */
    links: () => google.maps.StreetViewLink[];
    /** The camera in the stored zoom domain, zeroed without a viewer. @unstable */
    captureView: () => LocationPOV;
    /** The viewer read back into Location fields, or null until it has a position. @unstable */
    capture: () => PanoCapture | null;
    /** Freeze the live camera for an offscreen render; throws until a pano is ready. @unstable */
    snapshot: () => PanoView;
    /** The live WebGL scene canvas, or null before the first render. @unstable */
    canvas: () => HTMLCanvasElement | null;
    /** Cover-crop the live frame into an exact image, or null until real imagery renders. @unstable */
    captureImage: (width: number, height: number) => HTMLCanvasElement | null;
    /** Point the camera now. @unstable */
    look: (frame: PanoFrame) => void;
    /** Reserve a camera move across an async wait; it lands only if nothing moved the pano since. @unstable */
    reserveLook: () => (frame: PanoFrame) => boolean;
    /** Nudge heading and pitch by a delta, keeping pitch in range. @unstable */
    nudge: (dHeading: number, dPitch: number) => void;
    /** Animate the camera to a frame, replacing any turn in progress. @unstable */
    turnTo: (target: CameraFrame) => void;
    /** Face north level, or look straight down zoomed out when already facing north. @unstable */
    pointNorth: () => void;
    /** Face the linked road nearest the camera heading. @unstable */
    faceRoad: () => void;
    /** Turn to face the opposite direction. @unstable */
    turnAround: () => void;
    /** Turn to the next linked road clockwise from the camera. @unstable */
    turnToNextLink: () => void;
    /** Step the zoom in. @unstable */
    zoomIn: () => void;
    /** Step the zoom out. @unstable */
    zoomOut: () => void;
    /** Zoom fully out. @unstable */
    resetZoom: () => void;
    /** Listen to a viewer event, across viewer rebuilds; returns an unsubscribe. @unstable */
    on: (event: PanoEvent, fn: () => void) => () => void;
    /** Apply display options to the viewer. @unstable */
    configure: (options: google.maps.StreetViewPanoramaOptions) => void;
    /** Hide the viewer. @unstable */
    hide: () => void;
    /** Parent the viewer into a container; the newest mount wins until released. @unstable */
    mount: (target: HTMLElement) => () => void;
    /** Draw the crosshair over the viewer; returns a remove. @unstable */
    showCrosshair: () => () => void;
    /** Show a toast anchored over the viewer. @unstable */
    toast: (message: string, durationMs: number) => void;
    /** Release the viewer, its container and every listener; the instance is unusable afterwards. @unstable */
    dispose: () => void;
};

/** @unstable */
export type panoSurface_PanoDestination = PanoDestination;
/** @unstable */
export type panoSurface_PanoEvent = PanoEvent;
/** @unstable */
export type panoSurface_PanoFrame = PanoFrame;
/** @unstable */
export type panoSurface_PanoViewer = PanoViewer;
/** @unstable */
export type panoSurface_ShowResult = ShowResult;
/** @unstable */
declare const panoSurface_createPano: typeof createPano;
/** @unstable */
declare const panoSurface_pano: typeof pano;
declare namespace panoSurface {
  export { panoSurface_createPano as createPano, panoSurface_pano as pano };
  export type { panoSurface_PanoDestination as PanoDestination, panoSurface_PanoEvent as PanoEvent, panoSurface_PanoFrame as PanoFrame, panoSurface_PanoViewer as PanoViewer, panoSurface_ShowResult as ShowResult };
}

/** @unstable */
export interface GeoDisplay {
    address: string;
    countryCode: string | null;
}

/** @unstable */
export type PendingEntryLocation = RequireNonNull<Pick<Location, "lat" | "lng" | "panoId">> & Nullable<Rename<Pick<Location, "id">, {
    id: "locationId";
}>>;
/** @unstable */
export type SeenPano = Pick<SeenEntry, "locationId" | "lat" | "lng" | "heading" | "pitch" | "zoom" | "countryCode"> & Pick<Location, "panoId">;
/** Suppress the next seen-history entry for `panoId`. @unstable */
declare function seenSkipNext(panoId: string): void;
/** Update the pending seen entry's geocode info (country, address). @unstable */
declare function seenUpdateGeo(geo: GeoDisplay): void;
/** Record a panorama change for the seen history. Flushes the previous entry and stages the new one. @unstable */
declare function seenPanoChanged(location: PendingEntryLocation, geo: GeoDisplay | null, viewer: PanoViewer): void;
/** Write the pending seen entry to disk, if any. @unstable */
declare function seenFlush(viewer: PanoViewer): void;
/** Record a pano visit now at its starting view, with a thumbnail if that view is still on screen once imagery arrives. @unstable */
declare function seenRecord(location: PendingEntryLocation & LocationPOV, viewer: PanoViewer): Promise<void>;
/** Open a seen entry's panorama in the Street View viewer. @unstable */
declare function loadSeenPano(entry: SeenPano, viewer: PanoViewer): Promise<void>;

/** @unstable */
declare const seenRecorder_loadSeenPano: typeof loadSeenPano;
/** @unstable */
declare const seenRecorder_seenFlush: typeof seenFlush;
/** @unstable */
declare const seenRecorder_seenPanoChanged: typeof seenPanoChanged;
/** @unstable */
declare const seenRecorder_seenRecord: typeof seenRecord;
/** @unstable */
declare const seenRecorder_seenSkipNext: typeof seenSkipNext;
/** @unstable */
declare const seenRecorder_seenUpdateGeo: typeof seenUpdateGeo;
declare namespace seenRecorder {
  export {
    seenRecorder_loadSeenPano as loadSeenPano,
    seenRecorder_seenFlush as seenFlush,
    seenRecorder_seenPanoChanged as seenPanoChanged,
    seenRecorder_seenRecord as seenRecord,
    seenRecorder_seenSkipNext as seenSkipNext,
    seenRecorder_seenUpdateGeo as seenUpdateGeo,
  };
}

/** Enrich a single location with the map's enabled metadata fields. Existing fields are
 *  kept unless `force` re-derives all of them. Returns the enriched location without
 *  writing it. Returns the location unchanged when enrichment is disabled. */
declare function enrich(loc: Location, opts?: Omit<RunOpts, "onProgress">): Promise<Location>;
/** One summary row per pass that did work: the core metadata pass, then every
 *  provider that updated or failed at least one location. */
export interface EnrichOutcome extends ProcedureOutcome {
    id: string;
    label: string;
}
/** Bulk-enrich a selector: resolve missing pano ids, then run every field-producing
 *  provider (metadata, exact date, timezone, subdivision). */
declare function enrichAll(selector: Selector, opts?: RunOpts): Promise<EnrichOutcome[]>;

/** @unstable */
export type enrich$1_EnrichOutcome = EnrichOutcome;
declare const enrich$1_enrich: typeof enrich;
declare const enrich$1_enrichAll: typeof enrichAll;
declare namespace enrich$1 {
  export { enrich$1_enrich as enrich, enrich$1_enrichAll as enrichAll };
  export type { enrich$1_EnrichOutcome as EnrichOutcome };
}

/** Build the provider run list for enrichment, narrowed to `enrichFields`. Fields not
 *  offered in the enrichment settings are always included. @unstable */
declare function enrichRuns(enrichFields: string[] | null, exclude?: string[]): ProviderRun[];
/** Where to search when resolving a pano from coordinates, and which capture of its
 *  timeline to settle on. @unstable */
export interface PanoResolveConfig {
    radius: number;
    sources?: PanoType[];
    capture?: CapturePick;
}
/** Pano-resolve provider for enrichment. Writes the `panoId` field and runs before any
 *  provider that depends on it. Rows that already have a pano id are skipped unless the
 *  run is forced. @unstable */
declare const panoResolveProvider: Provider<{
    panoId: string;
}, PanoResolveConfig>;
/** Exact capture timestamp, narrowed from the `imageDate` month via binary search. @unstable */
declare const exactDateProvider: Provider;
/** Timezone at the location's coordinates. Requires `datetime` to be present. @unstable */
declare const timezoneProvider: Provider;
/** Subdivision (adm1) via offline point-in-polygon against the local border dataset.
 *  No Google dependency; downloads the adm1 archive on first use. @unstable */
declare const subdivisionProvider: Provider;
/** Core panorama metadata via Google's GetMetadata RPC. @unstable */
declare const svMetaProvider: Provider;

/** @unstable */
export type providers_PanoResolveConfig = PanoResolveConfig;
/** @unstable */
declare const providers_enrichRuns: typeof enrichRuns;
/** @unstable */
declare const providers_exactDateProvider: typeof exactDateProvider;
/** @unstable */
declare const providers_panoResolveProvider: typeof panoResolveProvider;
/** @unstable */
declare const providers_subdivisionProvider: typeof subdivisionProvider;
/** @unstable */
declare const providers_svMetaProvider: typeof svMetaProvider;
/** @unstable */
declare const providers_timezoneProvider: typeof timezoneProvider;
declare namespace providers {
  export { providers_enrichRuns as enrichRuns, providers_exactDateProvider as exactDateProvider, providers_panoResolveProvider as panoResolveProvider, providers_subdivisionProvider as subdivisionProvider, providers_svMetaProvider as svMetaProvider, providers_timezoneProvider as timezoneProvider };
  export type { providers_PanoResolveConfig as PanoResolveConfig };
}

/** How a bulk pin settles each location's pano before pinning it. */
export interface PinOpts extends BulkOpts {
    /** Resolve pano ids first; off, only locations that already carry one are pinned. */
    resolve?: boolean;
    /** Move each resolved pano to this capture of its timeline. */
    capture?: CapturePick | null;
    /** Re-resolve already pinned locations too. */
    force?: boolean;
}
/** What a bulk pin did: the locations newly pinned, the ones whose pano could not be
 *  resolved, and how many pano ids the resolve wrote. */
export interface PinOutcome extends BatchOutcome {
    resolved: number;
}
/** Pin every location in the selector to its pano id, resolving pano ids first when asked. */
declare function bulkPinToPano(selector: Selector, opts?: PinOpts): Promise<PinOutcome>;

/** @unstable */
export type pinPano_PinOpts = PinOpts;
/** @unstable */
export type pinPano_PinOutcome = PinOutcome;
declare const pinPano_bulkPinToPano: typeof bulkPinToPano;
declare namespace pinPano {
  export { pinPano_bulkPinToPano as bulkPinToPano };
  export type { pinPano_PinOpts as PinOpts, pinPano_PinOutcome as PinOutcome };
}

/** Configuration for Street View validation: search radius, and whether pinned rows are
 *  also compared against the coordinate lookup (off = a pin means the row is deliberate,
 *  its stored pano's own timeline is the only update signal). */
export interface ValidateConfig {
    radius: number;
    checkPinned: boolean;
}
/** What a validation run answered: the ids grouped by the state they validated to, over
 *  the outcome every run reports. */
export interface ValidationOutcome extends BatchOutcome {
    states: Map<ValidationState, number[]>;
}
/** Check that each location's Street View coverage still exists. */
declare function validateLocations(selector: Selector, opts?: BulkOpts & {
    config?: Partial<ValidateConfig>;
}): Promise<ValidationOutcome>;

/** @unstable */
export type validate_ValidateConfig = ValidateConfig;
/** @unstable */
export type validate_ValidationOutcome = ValidationOutcome;
declare const validate_validateLocations: typeof validateLocations;
declare namespace validate {
  export { validate_validateLocations as validateLocations };
  export type { validate_ValidateConfig as ValidateConfig, validate_ValidationOutcome as ValidationOutcome };
}

export interface SearchOpts {
    sources?: PanoType[];
    preference?: RankingStrategy;
}
/** Full pano metadata for one or more panos, aligned to `panoIds`. Duplicates are
 *  deduped and large batches are split automatically. */
declare function svMetadata(panoIds: string[], signal?: AbortSignal): Promise<(Pano | null)[]>;
/** The nearest pano to each point, aligned to `points`, null where there is no coverage.
 *  `opts.sources` narrows which collections are searched and `opts.preference` picks
 *  nearest or best. `onPano` sees each point's answer the moment its search resolves,
 *  ahead of the full array. */
declare function panosAt(points: LatLng[], radius?: number, opts?: SearchOpts, signal?: AbortSignal, onPano?: (index: number, pano: Pano | null) => void): Promise<(Pano | null)[]>;

/** @unstable */
export type query_SearchOpts = SearchOpts;
declare const query_panosAt: typeof panosAt;
declare const query_svMetadata: typeof svMetadata;
declare namespace query {
  export { query_panosAt as panosAt, query_svMetadata as svMetadata };
  export type { query_SearchOpts as SearchOpts };
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

/** Set or clear the main editor map host. @unstable */
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
/** Run registered click interceptors (newest first). True if one consumed the click. @unstable */
declare function tryInterceptClick(lat: number, lng: number, shiftKey?: boolean): boolean;
export type DrawInterceptor = (rings: number[][][]) => boolean;
/** Set the callback for completed polygon draws. Null clears it. */
declare function setDrawInterceptor(fn: DrawInterceptor | null): void;
/** Pass completed polygon rings to the draw interceptor. True if it consumed them. @unstable */
declare function tryInterceptDraw(rings: number[][][]): boolean;

declare const mapState_addClickInterceptor: typeof addClickInterceptor;
declare const mapState_fitMapToBounds: typeof fitMapToBounds;
declare const mapState_getMapHost: typeof getMapHost;
declare const mapState_setDrawInterceptor: typeof setDrawInterceptor;
/** @unstable */
declare const mapState_setMapHost: typeof setMapHost;
/** @unstable */
declare const mapState_tryInterceptClick: typeof tryInterceptClick;
/** @unstable */
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

/** The shared scene that all map surfaces render from. @unstable */
declare function getScene(): CellManager;
/** Set the default marker color (RGB bytes). @unstable */
declare function setMarkerDefaultColor(r: number, g: number, b: number): void;
/** Change the default marker color and repaint. @unstable */
declare function recolorScene(mc: RGB): void;
/** Current default marker color as RGBA. @unstable */
declare function getMarkerDefaultColor(): RGBA;
/** Resolves when the most recently started full scene load has finished (or immediately if none is in flight). @unstable */
declare function whenSceneSettled(): Promise<void>;
/** Rebuild the full scene for all locations. @unstable */
declare function loadScene(markerStyle: MarkerStyle, mc?: RGB): Promise<void>;
/** Clear all marker data from the scene. @unstable */
declare function clearScene(): void;
/** Start listening for deltas, selections, and active-location changes. Returns a stop function. @unstable */
declare function startSceneEngine(): () => void;

/** @unstable */
declare const sceneStore_clearScene: typeof clearScene;
/** @unstable */
declare const sceneStore_getMarkerDefaultColor: typeof getMarkerDefaultColor;
/** @unstable */
declare const sceneStore_getScene: typeof getScene;
/** @unstable */
declare const sceneStore_loadScene: typeof loadScene;
/** @unstable */
declare const sceneStore_recolorScene: typeof recolorScene;
/** @unstable */
declare const sceneStore_setMarkerDefaultColor: typeof setMarkerDefaultColor;
/** @unstable */
declare const sceneStore_startSceneEngine: typeof startSceneEngine;
/** @unstable */
declare const sceneStore_whenSceneSettled: typeof whenSceneSettled;
declare namespace sceneStore {
  export {
    sceneStore_clearScene as clearScene,
    sceneStore_getMarkerDefaultColor as getMarkerDefaultColor,
    sceneStore_getScene as getScene,
    sceneStore_loadScene as loadScene,
    sceneStore_recolorScene as recolorScene,
    sceneStore_setMarkerDefaultColor as setMarkerDefaultColor,
    sceneStore_startSceneEngine as startSceneEngine,
    sceneStore_whenSceneSettled as whenSceneSettled,
  };
}

/** Snapshot of every rendered location's id and position (`[lng, lat, ...]`). */
declare function getScenePositions(): {
    ids: Uint32Array;
    positions: Float32Array;
};

declare const scenePositions_getScenePositions: typeof getScenePositions;
declare namespace scenePositions {
  export {
    scenePositions_getScenePositions as getScenePositions,
  };
}

/** @unstable */
export interface ToastEntry {
    id: number;
    message: string;
}
/** Show a brief toast notification. Optionally scoped to a `container` element. */
declare function toast(message: string, duration?: number, container?: HTMLElement): void;
/** Current list of visible toasts. @unstable */
declare function getToasts(): ToastEntry[];

/** @unstable */
declare const toast$1_getToasts: typeof getToasts;
declare const toast$1_toast: typeof toast;
declare namespace toast$1 {
  export {
    toast$1_getToasts as getToasts,
    toast$1_toast as toast,
  };
}

/** `map` jobs mutate the open map and are cancelled when it closes; `app` jobs survive. @unstable */
export type JobScope = "map" | "app";
/** @unstable */
export interface JobOpts {
    scope?: JobScope;
    /** Abort the underlying work. Omitted = the tray offers no cancel button. */
    cancel?: () => void;
    /** Reopen the owning UI. Omitted = the tray entry is not clickable. */
    reveal?: () => void;
}
/** @unstable */
export interface JobEntry {
    id: number;
    label: string;
    scope: JobScope;
    fraction: number;
    detail?: string;
    /** The owning UI is showing its own progress; the tray skips this entry. */
    hidden: boolean;
    cancel?: () => void;
    reveal?: () => void;
}
/** Handle for driving a registered job. All methods are no-ops once the job ended. @unstable */
export interface JobHandle {
    /** Set the progress bar fraction (0-1) and optional detail text. */
    update(fraction: number, detail?: string): void;
    setHidden(hidden: boolean): void;
    /** Remove the job, optionally leaving a brief toast. */
    finish(message?: string, duration?: number): void;
    /** Remove the job and leave an error toast. */
    fail(message: string): void;
}
/** Live jobs, for the tray. Reference changes on every update. @unstable */
declare function getJobs(): JobEntry[];
/** Register a long-running operation with the global job tray. The caller owns the
 *  work; the registry owns only its presentation and the cancel/reveal controls. @unstable */
declare function registerJob(label: string, opts?: JobOpts): JobHandle;
/** @unstable */
export interface JobRunContext {
    signal: AbortSignal;
    report: (fraction: number, detail?: string) => void;
}
/** Sugar for promise-shaped work: registers a job wired to an AbortController, reports
 *  through the handle, and ends the job however `fn` settles. Cancelling resolves null;
 *  a real failure toasts and rethrows. @unstable */
declare function runJob<R>(label: string, fn: (ctx: JobRunContext) => Promise<R>, opts?: Omit<JobOpts, "cancel">): Promise<R | null>;
/** Cancel every live job of `scope` that can be cancelled. Owners observe their own
 *  abort and end their jobs; entries without a cancel are removed outright. @unstable */
declare function cancelJobs(scope: JobScope): void;
/** @unstable */
export type MapExitKind = "leave" | "quit";
/** The pending map-exit confirmation, for the dialog. @unstable */
declare function getExitRequest(): {
    kind: MapExitKind;
} | null;
/** Gate a user action that would end every map-scoped job. Resolves true immediately when
 *  none are live; otherwise raises the confirm dialog, and true means the jobs were
 *  cancelled and the action should proceed. @unstable */
declare function confirmMapExit(kind: MapExitKind): Promise<boolean>;
/** Answer the pending map-exit confirmation. @unstable */
declare function resolveMapExit(ok: boolean): void;

/** @unstable */
export type jobs_JobEntry = JobEntry;
/** @unstable */
export type jobs_JobHandle = JobHandle;
/** @unstable */
export type jobs_JobOpts = JobOpts;
/** @unstable */
export type jobs_JobRunContext = JobRunContext;
/** @unstable */
export type jobs_JobScope = JobScope;
/** @unstable */
export type jobs_MapExitKind = MapExitKind;
/** @unstable */
declare const jobs_cancelJobs: typeof cancelJobs;
/** @unstable */
declare const jobs_confirmMapExit: typeof confirmMapExit;
/** @unstable */
declare const jobs_getExitRequest: typeof getExitRequest;
/** @unstable */
declare const jobs_getJobs: typeof getJobs;
/** @unstable */
declare const jobs_registerJob: typeof registerJob;
/** @unstable */
declare const jobs_resolveMapExit: typeof resolveMapExit;
/** @unstable */
declare const jobs_runJob: typeof runJob;
declare namespace jobs {
  export { jobs_cancelJobs as cancelJobs, jobs_confirmMapExit as confirmMapExit, jobs_getExitRequest as getExitRequest, jobs_getJobs as getJobs, jobs_registerJob as registerJob, jobs_resolveMapExit as resolveMapExit, jobs_runJob as runJob };
  export type { jobs_JobEntry as JobEntry, jobs_JobHandle as JobHandle, jobs_JobOpts as JobOpts, jobs_JobRunContext as JobRunContext, jobs_JobScope as JobScope, jobs_MapExitKind as MapExitKind };
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
 *  so a double-clicked button cannot start two. */
declare function useJob<R = void, P = string>(fn: (ctx: JobContext<P>) => Promise<R>): Job<R, P>;

/** @unstable */
export type useJob$1_Job<R, P> = Job<R, P>;
/** @unstable */
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
declare function setUserFieldDefs(defs: Record<string, FieldDef>): Promise<void>;
/** @deprecated v0.11.0. Use `MMA.storage()`. @unstable */
declare function createPluginStorage(id: string): PluginStorage;
/** @deprecated v0.11.0. Use `MMA.sidecar.request()`. @unstable */
declare function request<T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T>): Promise<T | null>;
/** @deprecated v0.11.0. Use `MMA.sidecar.installedVersion()`. @unstable */
declare function installedVersion(pluginId: string): Promise<string | null>;
/** @deprecated v0.10.5. Use `MMA.setTags([tagId], [], { type: "Locations", locations: ids, name: null })`. @unstable */
declare function addTagToLocations(tagId: number, locationIds: number[]): Promise<void> | Promise<FieldOpResult>;
/** @deprecated v0.10.5. Use `MMA.setTags([], [tagId], { type: "Locations", locations: ids, name: null })`. @unstable */
declare function removeTagFromLocations(tagId: number, locationIds: number[]): Promise<void> | Promise<FieldOpResult>;
/** @deprecated v0.10.5. Use `MMA.setTags([], [tagId], MMA.tagSelector(tagId))`. @unstable */
declare function removeTagFromAllLocations(tagId: number): Promise<void> | Promise<FieldOpResult>;

/** @unstable */
declare const legacy_addTagToLocations: typeof addTagToLocations;
/** @unstable */
declare const legacy_createPluginStorage: typeof createPluginStorage;
/** @unstable */
declare const legacy_fetchAllLocations: typeof fetchAllLocations;
/** @unstable */
declare const legacy_fetchLocation: typeof fetchLocation;
/** @unstable */
declare const legacy_fetchLocationsByIds: typeof fetchLocationsByIds;
/** @unstable */
declare const legacy_fieldCoverage: typeof fieldCoverage;
/** @unstable */
declare const legacy_getActiveLocation: typeof getActiveLocation;
/** @unstable */
declare const legacy_getAllSelections: typeof getAllSelections;
/** @unstable */
declare const legacy_getCurrentMap: typeof getCurrentMap;
/** @unstable */
declare const legacy_getCurrentMapId: typeof getCurrentMapId;
/** @unstable */
declare const legacy_getDirtyCount: typeof getDirtyCount;
/** @unstable */
declare const legacy_getGhostedSelections: typeof getGhostedSelections;
/** @unstable */
declare const legacy_getGoogleMap: typeof getGoogleMap;
/** @unstable */
declare const legacy_getSelectedLocationIds: typeof getSelectedLocationIds;
/** @unstable */
declare const legacy_getSelections: typeof getSelections;
/** @unstable */
declare const legacy_getWorkArea: typeof getWorkArea;
/** @unstable */
declare const legacy_installedVersion: typeof installedVersion;
/** @unstable */
declare const legacy_registerEnrichmentProvider: typeof registerEnrichmentProvider;
/** @unstable */
declare const legacy_removeTagFromAllLocations: typeof removeTagFromAllLocations;
/** @unstable */
declare const legacy_removeTagFromLocations: typeof removeTagFromLocations;
/** @unstable */
declare const legacy_request: typeof request;
/** @unstable */
declare const legacy_setUserFieldDefs: typeof setUserFieldDefs;
/** @unstable */
declare const legacy_waitForGoogleMap: typeof waitForGoogleMap;
declare namespace legacy {
  export {
    legacy_addTagToLocations as addTagToLocations,
    legacy_createPluginStorage as createPluginStorage,
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
    legacy_getWorkArea as getWorkArea,
    legacy_installedVersion as installedVersion,
    legacy_registerEnrichmentProvider as registerEnrichmentProvider,
    legacy_removeTagFromAllLocations as removeTagFromAllLocations,
    legacy_removeTagFromLocations as removeTagFromLocations,
    legacy_request as request,
    legacy_setUserFieldDefs as setUserFieldDefs,
    legacy_waitForGoogleMap as waitForGoogleMap,
  };
}

/** Cross-module stopwatch for map-open latency. @unstable */
declare const mapOpen: {
    start: number;
    seen: Set<string>;
    begin(): void;
    mark(phase: string): void;
};

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

/** @unstable */
declare const testApi_closeMap: typeof closeMap;
/** @unstable */
declare const testApi_deleteMap: typeof deleteMap;
/** @unstable */
declare const testApi_importFile: typeof importFile;
/** @unstable */
declare const testApi_importPaste: typeof importPaste;
/** @unstable */
declare const testApi_mapOpen: typeof mapOpen;
/** @unstable */
declare const testApi_openMap: typeof openMap;
/** @unstable */
declare const testApi_procedureEntry: typeof procedureEntry;
/** @unstable */
declare const testApi_runProcedure: typeof runProcedure;
/** @unstable */
declare const testApi_syncSelections: typeof syncSelections;
declare namespace testApi {
  export {
    testApi_closeMap as closeMap,
    testApi_deleteMap as deleteMap,
    testApi_importFile as importFile,
    testApi_importPaste as importPaste,
    testApi_mapOpen as mapOpen,
    testApi_openMap as openMap,
    testApi_procedureEntry as procedureEntry,
    testApi_runProcedure as runProcedure,
    testApi_syncSelections as syncSelections,
  };
}

/** The nested `_test` namespace on the plugin surface. @unstable */
declare const _test: typeof testApi;

/** @unstable */
declare const testSurface__test: typeof _test;
declare namespace testSurface {
  export {
    testSurface__test as _test,
  };
}

/** Base URL for a custom URI scheme, platform-adjusted. @unstable */
declare function schemeBase(scheme: string): string;
/** URL that serves a local file over the `mma-buf://` protocol. @unstable */
declare function mmaBufUrl(path: string): string;
/** Copy of `set` with `value` toggled, or forced on/off by `on`. @unstable */
declare function toggleInSet<T>(set: ReadonlySet<T>, value: T, on?: boolean): Set<T>;
/** The item `isBetter` prefers over every other, or null when there are none. @unstable */
declare function bestBy<T>(items: Iterable<T>, isBetter: (a: T, b: T) => boolean): T | null;
/** Shuffle `items` in place (Fisher-Yates) and return them. @unstable */
declare function shuffle<T>(items: T[]): T[];
/** Split `arr` into sub-arrays of at most `n` elements. @unstable */
declare function chunk<T>(arr: readonly T[], n: number): T[][];
/** Compare two semver strings (e.g. "0.6.1", "0.7.0-rc.2"). Returns >0 if a > b.
 *  Build metadata is ignored; a pre-release sorts below the release it precedes. @unstable */
declare function cmpVersion(a: string, b: string): number;
/** `["0.7.0", "rc.2"]` for `"v0.7.0-rc.2+build"`; the pre-release part is `""` when absent. @unstable */
declare function splitVersion(v: string): [core: string, pre: string];
/** True when `v` carries a semver pre-release tag, e.g. "1.0.0-beta.1". @unstable */
declare function isPrereleaseVersion(v: string): boolean;
/** True when the app runs in a browser instead of the desktop app. @unstable */
declare function isWeb(): boolean;
/** Trigger a browser download from an in-memory Blob. @unstable */
declare function downloadBlob(blob: Blob, fileName: string): void;
/** Copy an image Blob to the clipboard. False when the platform refuses it. @unstable */
declare function copyImageToClipboard(blob: Blob): Promise<boolean>;
/** Compare strings with natural (numeric-aware) ordering. @unstable */
declare function compareNatural(a: string, b: string): number;
/** Sort tags by the chosen mode: name, location count, or manual order. @unstable */
declare function sortTagsByMode(tags: Tag[], mode: TagSortMode, counts: Record<number, number>): Tag[];
/** Color for a tag named `name`. An existing tag uses its stored color. @unstable */
declare function tagColorFor(name: string, tags: Tag[]): string;
/** Add a name to a staged list: dedup case-insensitively, normalizing to an existing tag's
 *  canonical casing. Returns the original array unchanged if already present. @unstable */
declare function appendTagName(pending: string[], name: string, tags: Tag[]): string[];
/** Current time as Unix seconds, the form Location timestamps use. @unstable */
declare function nowUnix(): number;
/** Rolling anchor for a phase-relative locations/second average. @unstable */
export interface PhaseRate {
    t0: number;
    done0: number;
    done: number;
    total: number;
}
/** Compute a locations/second rate for the current progress phase. Re-anchors when a
 *  new phase is detected (done went backward or total grew). Null until a quarter second
 *  of work has elapsed. @unstable */
declare function phaseRate(prev: PhaseRate | null, done: number, total: number, now: number): {
    state: PhaseRate;
    rate: number | null;
};

/** @unstable */
export type util_PhaseRate = PhaseRate;
/** @unstable */
declare const util_appendTagName: typeof appendTagName;
/** @unstable */
declare const util_bestBy: typeof bestBy;
/** @unstable */
declare const util_chunk: typeof chunk;
/** @unstable */
declare const util_cmpVersion: typeof cmpVersion;
/** @unstable */
declare const util_compareNatural: typeof compareNatural;
/** @unstable */
declare const util_copyImageToClipboard: typeof copyImageToClipboard;
/** @unstable */
declare const util_downloadBlob: typeof downloadBlob;
/** @unstable */
declare const util_isPrereleaseVersion: typeof isPrereleaseVersion;
/** @unstable */
declare const util_isWeb: typeof isWeb;
/** @unstable */
declare const util_mmaBufUrl: typeof mmaBufUrl;
/** @unstable */
declare const util_nowUnix: typeof nowUnix;
/** @unstable */
declare const util_phaseRate: typeof phaseRate;
/** @unstable */
declare const util_schemeBase: typeof schemeBase;
/** @unstable */
declare const util_shuffle: typeof shuffle;
/** @unstable */
declare const util_sortTagsByMode: typeof sortTagsByMode;
/** @unstable */
declare const util_splitVersion: typeof splitVersion;
/** @unstable */
declare const util_tagColorFor: typeof tagColorFor;
/** @unstable */
declare const util_toggleInSet: typeof toggleInSet;
declare namespace util {
  export { util_appendTagName as appendTagName, util_bestBy as bestBy, util_chunk as chunk, util_cmpVersion as cmpVersion, util_compareNatural as compareNatural, util_copyImageToClipboard as copyImageToClipboard, util_downloadBlob as downloadBlob, util_isPrereleaseVersion as isPrereleaseVersion, util_isWeb as isWeb, util_mmaBufUrl as mmaBufUrl, util_nowUnix as nowUnix, util_phaseRate as phaseRate, util_schemeBase as schemeBase, util_shuffle as shuffle, util_sortTagsByMode as sortTagsByMode, util_splitVersion as splitVersion, util_tagColorFor as tagColorFor, util_toggleInSet as toggleInSet };
  export type { util_PhaseRate as PhaseRate };
}

export type ConstsApi = typeof consts;
export type StoreApi = typeof store;
/** Pure transforms over the selection list behind the sidebar. @unstable */
export type SelectionOpsApi = typeof selectionOps;
/** Editing the selection list the way the sidebar does. @unstable */
export type SelectionActionsApi = typeof selectionActions;
/** Saved selection rules. @unstable */
export type SavedSelectionsApi = typeof savedSelections;
/** App settings and their option tables; the shape moves with every setting added. @unstable */
export type SettingsApi = typeof settings;
/** Stage, preview, and confirm an import into the open map. @unstable */
export type ImportStagingApi = typeof importStaging;
/** Uncommitted changes and their preview on the map. @unstable */
export type CommitDiffApi = typeof commitDiff;
export type SelectorPickApi = typeof picker;
export type MapListApi = typeof mapList;
/** Review sessions and their history. @unstable */
export type ReviewApi = typeof review;
/** The raw command layer under the app-level API; any of them can change in a release. @unstable */
export type CommandsApi = typeof commands;
/** Raw command, shell, and file dialog access. @unstable */
export type TauriApi = typeof tauri;
export type RegistryApi = typeof registry;
/** Enabling plugins and their activation lifecycle. @unstable */
export type PluginHostApi = typeof pluginHost;
/** The plugin marketplace and its update checks. @unstable */
export type MarketplaceApi = typeof marketplace;
export type PluginStorageApi = typeof pluginStorage;
/** Which plugin owns a registration, and its teardown. @unstable */
export type ScopeApi = typeof scope;
export type PluginEventsApi = typeof pluginEvents;
export type ExternalsApi = typeof externals;
export type SidecarApi = typeof sidecar$1;
export type UiApi = typeof uiSurface;
export type FieldDefsApi = typeof fieldDefs;
export type FieldDefRegistryApi = typeof fieldDefRegistry;
/** The keys a field can be grouped by. @unstable */
export type FieldProjectionsApi = typeof fieldProjections;
/** Running procedures directly, outside a registered provider. @unstable */
export type ProceduresApi = typeof procedures;
export type SeenApi = typeof seen;
/** How the app records panorama visits into the seen history. @unstable */
export type SeenRecorderApi = typeof seenRecorder;
/** The shared panorama viewer. @unstable */
export type PanoApi = typeof panoSurface;
export type EnrichApi = typeof enrich$1;
/** The providers the app registers for enrichment. @unstable */
export type ProvidersApi = typeof providers;
export type PinPanoApi = typeof pinPano;
export type ValidateApi = typeof validate;
export type QueryApi = typeof query;
export type MapStateApi = typeof mapState;
/** The marker scene the map surfaces render from, and its load lifecycle. @unstable */
export type SceneStoreApi = typeof sceneStore;
export type ScenePositionsApi = typeof scenePositions;
/** Color conversion helpers. @unstable */
export type ColorApi = typeof colorUtils;
export type ToastApi = typeof toast$1;
/** The global job tray. @unstable */
export type JobsApi = typeof jobs;
export type UseJobApi = typeof useJob$1;
/** Shims for removed APIs. @unstable */
export type LegacyApi = typeof legacy;
/** @unstable */
export type TestApi = typeof testSurface;
export type TypesApi = typeof types;
/** General-purpose helpers. @unstable */
export type UtilApi = typeof util;
/** The global `MMA` object (also `window.MMA`). */
interface MMA extends ConstsApi, StoreApi, SelectionOpsApi, SelectionActionsApi, SavedSelectionsApi, SettingsApi, ImportStagingApi, CommitDiffApi, SelectorPickApi, MapListApi, ReviewApi, CommandsApi, TauriApi, RegistryApi, PluginHostApi, MarketplaceApi, PluginStorageApi, ScopeApi, PluginEventsApi, ExternalsApi, SidecarApi, UiApi, FieldDefsApi, FieldDefRegistryApi, FieldProjectionsApi, ProceduresApi, SeenApi, SeenRecorderApi, PanoApi, EnrichApi, ProvidersApi, PinPanoApi, ValidateApi, QueryApi, MapStateApi, SceneStoreApi, ScenePositionsApi, ColorApi, ToastApi, JobsApi, UseJobApi, TestApi, TypesApi, UtilApi, LegacyApi {
}

declare global {
    interface Window {
        MMA: MMA;
    }
    const MMA: MMA;
}

export type { BUILTIN_FIELDS, CLEARABLE_BUILTINS, CameraType, CapturePick, DEFAULT_DUPLICATE_SCORE, DatePart, EFFECT_CALLS, ERROR_CODES, FieldType, FirstSyncMode, IssueState, KNOWN_FIELDS, LocationFlag, MMA, MMA as MMAApi, MergeWinner, OFFICIAL_ID_PATTERN, PLAIN_CALLS, PROJECTIONS, PanoType, RankingStrategy, RateCost, ResolutionSide, SCRATCH_MAP_ID, Sink, VIRTUAL_FLAGS, ValidationState, commands$1 as commands, events };
export type { AnonIssueRef, AttachmentRef, BatchMode, CameraFrame, CellRemoval, Columns, CommitDelta, CommitDiff, CommitInfo, CommitResult, ComparisonType, Conflict, ConflictKind, CopyToMapResult, CountBy, DataLocation, DbStats, DeviceCodeInfo, EditorImportPreview, EditorImportResult, EngineValues, ExportOpts, ExportProgress, ExprError, ExternalMutation, FieldCount, FieldDef, FieldOp, FieldOpResult, FieldValue, FieldValuesPatch, FieldValuesResult, FilterOp, GeoResult, GgUser, GhUser, HoneycombRun, IdQuery, ImageSize, ImportPreviewEntry, ImportProgress, ImportedMapInfo, IssueComment, IssueRef, IssueThread, KeySpec, Location, LocationPatch, LocationPatch_Deserialize, MapExtra, MapKeyAction, MapKeyBinding, MapMeta, MapMetaPatch, MapMetaPatch_Deserialize, MapSettings, MmMapSummary, MmUser, MutationResult, NormalizedSyncLocation, NumericBinning, Pano, PanoAnswer, PanoDate, PanoLink, PanoQuery, PanoTime, ParsedLocation, PartitionBucket, PluginBuild, PluginBuild_Deserialize, PluginManifest, PluginManifest_Deserialize, PluginSidecar, PluginSidecar_Deserialize, PolygonGeometry, Pov, PresenceActivity, ProcedureActivity, ProcedureConfig, ProcedureDecl, ProcedureHost, ProcedureProgress, ProcedureRequest, ProcedureResponse, ProcedureResult, ProviderActivity, ProviderDecl, PullCreate, PullUpdate, QueryActivity, RateSpec, RemoteMappingRow, RenderDelta, RenderEntry, RenderPatchEntry, RenderRequest, ResultEntry, RetrySpec, ReviewCreate, ReviewSession, ReviewUpdate, Rows, RowsRun, SaveResult, SavedSelection, SavedSelectionInfo, ScoreBounds, SearchQuery, SeenEntry, SeenFilter, SeenMapInfo, SeenWriteEntry, SelPaint, Selection, SelectionInput, SelectionSync, Selector, SideCounts, SidecarDone, SidecarLine, SidecarLog, SidecarProgress, SpacedPickResult, StoreStatus, StoreWarning, SummaryResult, SyncPatch, SyncReconcileResult, Update, UpdateAvailable, UpdateProgress, ValiCountryStatus, ValiLocation, ValiLocation_Deserialize, ValiProgress, VirtualTag };
