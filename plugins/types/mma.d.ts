/// <reference types="google.maps" />

import * as _tauri_apps_api_window from '@tauri-apps/api/window';
import * as _tauri_apps_api_webview from '@tauri-apps/api/webview';
import { Channel, invoke } from '@tauri-apps/api/core';
import * as __TAURI_EVENT from '@tauri-apps/api/event';
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
    /** Both maps keep everything; nothing is deleted. @unstable */
    readonly Merge: "merge";
    /** Locations only on this map are deleted so it matches the remote map. @unstable */
    readonly MirrorFromRemote: "mirrorFromRemote";
    /** Locations only on the remote map are deleted so it matches this map. @unstable */
    readonly MirrorFromLocal: "mirrorFromLocal";
};
/** @unstable */
type FirstSyncMode = (typeof FirstSyncMode)[keyof typeof FirstSyncMode];
/** @unstable */
declare const IssueState: {
    /** The issue is still open. @unstable */
    readonly Open: "open";
    /** The issue has been closed. @unstable */
    readonly Closed: "closed";
};
/** @unstable */
type IssueState = (typeof IssueState)[keyof typeof IssueState];
/** How much of a map a destination keeps. Each shape keeps everything the one before it does. */
declare const MapShape: {
    /** Coordinates, camera and pinned panoramas: what GeoGuessr stores. */
    readonly GeoGuessr: "geoguessr";
    /** Adds tags, unpinned panoramas, capture months and location flags: what map-making.app stores. */
    readonly MapMaking: "mapMaking";
    /** Everything this app stores, including custom fields. */
    readonly Local: "local";
};
type MapShape = (typeof MapShape)[keyof typeof MapShape];
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
    /** This map's version won the conflict. @unstable */
    readonly Local: "local";
    /** The remote map's version won the conflict. @unstable */
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
/** Which edit history stack to step through. */
declare const Stack: {
    /** The edits that can be undone. */
    readonly Undo: "undo";
    /** The undone edits that can be redone. */
    readonly Redo: "redo";
};
type Stack = (typeof Stack)[keyof typeof Stack];
/** What started a sync pass. @unstable */
declare const SyncTrigger: {
    /** Sync now was pressed. @unstable */
    readonly Manual: "manual";
    /** Live sync ran it, after an edit or on its schedule. @unstable */
    readonly Live: "live";
    /** Linking the map ran its first sync. @unstable */
    readonly Link: "link";
    /** Resolving held conflicts ran it. @unstable */
    readonly Resolve: "resolve";
};
/** @unstable */
type SyncTrigger = (typeof SyncTrigger)[keyof typeof SyncTrigger];
/** Per-location bitfield, serialized as a plain `u32` over IPC and Arrow. */
declare const LocationFlag: {
    /** No flags set. */
    readonly None: 0;
    /** When the location has a stored pano, it opens exactly that pano instead of the nearest coverage. */
    readonly LoadAsPanoId: 1;
    /** Legacy marker (web). Kept as imported, with no effect in the app. */
    readonly Informational: 2;
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
/**
 * One finding of a Street View coverage check. `validate` answers each row with the
 * findings that apply, combined into one number.
 */
declare const ValidationFlag: {
    /** No findings: the location's coverage checked out. */
    readonly None: 0;
    /** Official coverage newer than the location's stored pano exists. */
    readonly Newer: 1;
    /** The location is pinned to a pano other than the one its coordinates load. */
    readonly OffDefault: 2;
    /** The pano the location's coordinates load is not the newest capture there. */
    readonly DefaultStale: 4;
    /** The location's pinned pano no longer loads, though coverage still exists at its coordinates. */
    readonly PanoIdBroke: 8;
    /** The coverage the location shows is unofficial. */
    readonly Unofficial: 16;
    /** The location shows bad-camera coverage, but its timeline holds a better camera capture. */
    readonly GoodcamAvailable: 32;
    /** No coverage was found, neither the stored pano nor any within the search radius. */
    readonly NotFound: 64;
};
type ValidationFlag = (typeof ValidationFlag)[keyof typeof ValidationFlag];
/** Which way a link carries changes. @unstable */
declare const SyncDirection: {
    /** Changes travel both ways, and conflicts wait for review. @unstable */
    readonly Bidirectional: "bidirectional";
    /** Changes only come in from the remote, which wins every conflict. @unstable */
    readonly PullOnly: "pullOnly";
};
/** @unstable */
type SyncDirection = (typeof SyncDirection)[keyof typeof SyncDirection];
declare const BUILTIN_FIELDS: {
    readonly id: {
        readonly type: "number";
        readonly label: "ID";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: "identity";
        readonly clearable: false;
    };
    readonly lat: {
        readonly type: "number";
        readonly label: "Latitude";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: "identity";
        readonly clearable: false;
    };
    readonly lng: {
        readonly type: "number";
        readonly label: "Longitude";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: "identity";
        readonly clearable: false;
    };
    readonly heading: {
        readonly type: "number";
        readonly label: "Heading";
        readonly values: null;
        readonly comparison: {
            readonly type: "circular";
            readonly period: 360;
        };
        readonly interned: false;
        readonly kind: "writable";
        readonly clearable: false;
    };
    readonly pitch: {
        readonly type: "number";
        readonly label: "Pitch";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: "writable";
        readonly clearable: false;
    };
    readonly zoom: {
        readonly type: "number";
        readonly label: "Zoom";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: "writable";
        readonly clearable: false;
    };
    readonly panoId: {
        readonly type: "string";
        readonly label: "Pano ID";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: null;
        readonly clearable: true;
    };
    readonly tags: {
        readonly type: "array";
        readonly label: "Tags";
        readonly values: null;
        readonly comparison: null;
        readonly interned: true;
        readonly kind: "writable";
        readonly clearable: false;
    };
    readonly createdAt: {
        readonly type: "date";
        readonly label: "Created";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: null;
        readonly clearable: false;
    };
    readonly modifiedAt: {
        readonly type: "date";
        readonly label: "Modified";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: null;
        readonly clearable: false;
    };
    readonly tagCount: {
        readonly type: "number";
        readonly label: "Tag count";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: "virtual";
        readonly clearable: false;
    };
    readonly loadAsPanoId: {
        readonly type: "boolean";
        readonly label: "Load as pano ID";
        readonly values: null;
        readonly comparison: null;
        readonly interned: false;
        readonly kind: "writable";
        readonly clearable: false;
    };
};
/** What a render frame does to the scene. @unstable */
declare const FrameKind: {
    /** Clears the scene, then adds every row the frame carries. @unstable */
    readonly Replace: 0;
    /** Changes the scene in place. @unstable */
    readonly Patch: 1;
};
/** @unstable */
type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];
/** @unstable */
declare const NO_SEL: 4294967295;
declare const OFFICIAL_ID_PATTERN: "^[-_A-Za-z0-9]{21}[AQgw]$";
/** @unstable */
declare const EFFECT_CALLS: readonly ["fetch", "panos", "sidecar"];
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
declare const LOCATION_MERGED: readonly ["extra"];
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
/** Every sync provider: which way it carries changes, and what it keeps of a map. @unstable */
declare const SYNC_PROVIDERS: {
    /** @unstable */
    readonly file: {
        readonly direction: "pullOnly";
        readonly shape: "local";
    };
    /** @unstable */
    readonly geoguessr: {
        readonly direction: "bidirectional";
        readonly shape: "geoguessr";
    };
    /** @unstable */
    readonly "map-making.app": {
        readonly direction: "bidirectional";
        readonly shape: "mapMaking";
    };
};
/** @unstable */
declare const SCRATCH_MAP_ID: "scratch";
/** @unstable */
declare const ERROR_CODES: readonly ["auth", "attachment-not-staged", "attachment-too-large", "attachment-not-image", "upload-rejected", "report-rejected", "report-unreadable", "sign-in-timed-out", "sign-in-token-rejected", "issue-rejected", "geoguessr-polygonal", "geoguessr-draft-too-large"];

declare const consts_BUILTIN_FIELDS: typeof BUILTIN_FIELDS;
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
/** @unstable */
declare const consts_FirstSyncMode: typeof FirstSyncMode;
/** @unstable */
export type consts_FirstSyncMode = FirstSyncMode;
/** @unstable */
declare const consts_FrameKind: typeof FrameKind;
/** @unstable */
export type consts_FrameKind = FrameKind;
/** @unstable */
declare const consts_IssueState: typeof IssueState;
/** @unstable */
export type consts_IssueState = IssueState;
declare const consts_KNOWN_FIELDS: typeof KNOWN_FIELDS;
declare const consts_LOCATION_MERGED: typeof LOCATION_MERGED;
declare const consts_LocationFlag: typeof LocationFlag;
/** @unstable */
export type consts_LocationFlag = LocationFlag;
declare const consts_MapShape: typeof MapShape;
/** @unstable */
export type consts_MapShape = MapShape;
declare const consts_MergeWinner: typeof MergeWinner;
/** @unstable */
export type consts_MergeWinner = MergeWinner;
declare const consts_NO_SEL: typeof NO_SEL;
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
/** @unstable */
declare const consts_ResolutionSide: typeof ResolutionSide;
/** @unstable */
export type consts_ResolutionSide = ResolutionSide;
declare const consts_SCRATCH_MAP_ID: typeof SCRATCH_MAP_ID;
/** @unstable */
declare const consts_SYNC_PROVIDERS: typeof SYNC_PROVIDERS;
declare const consts_Sink: typeof Sink;
/** @unstable */
export type consts_Sink = Sink;
declare const consts_Stack: typeof Stack;
/** @unstable */
export type consts_Stack = Stack;
/** @unstable */
declare const consts_SyncDirection: typeof SyncDirection;
/** @unstable */
export type consts_SyncDirection = SyncDirection;
/** @unstable */
declare const consts_SyncTrigger: typeof SyncTrigger;
/** @unstable */
export type consts_SyncTrigger = SyncTrigger;
declare const consts_ValidationFlag: typeof ValidationFlag;
/** @unstable */
export type consts_ValidationFlag = ValidationFlag;
declare namespace consts {
  export { consts_BUILTIN_FIELDS as BUILTIN_FIELDS, consts_DEFAULT_DUPLICATE_SCORE as DEFAULT_DUPLICATE_SCORE, consts_EFFECT_CALLS as EFFECT_CALLS, consts_ERROR_CODES as ERROR_CODES, consts_KNOWN_FIELDS as KNOWN_FIELDS, consts_LOCATION_MERGED as LOCATION_MERGED, consts_NO_SEL as NO_SEL, consts_OFFICIAL_ID_PATTERN as OFFICIAL_ID_PATTERN, consts_PLAIN_CALLS as PLAIN_CALLS, consts_PROJECTIONS as PROJECTIONS, consts_SCRATCH_MAP_ID as SCRATCH_MAP_ID, consts_SYNC_PROVIDERS as SYNC_PROVIDERS };
  export { consts_CameraType as CameraType, consts_CapturePick as CapturePick, consts_DatePart as DatePart, consts_FieldType as FieldType, consts_FirstSyncMode as FirstSyncMode, consts_FrameKind as FrameKind, consts_IssueState as IssueState, consts_LocationFlag as LocationFlag, consts_MapShape as MapShape, consts_MergeWinner as MergeWinner, consts_PanoType as PanoType, consts_RankingStrategy as RankingStrategy, consts_RateCost as RateCost, consts_ResolutionSide as ResolutionSide, consts_Sink as Sink, consts_Stack as Stack, consts_SyncDirection as SyncDirection, consts_SyncTrigger as SyncTrigger, consts_ValidationFlag as ValidationFlag };
}

/** Commands @unstable */
declare const commands$1: {
    /** Edit rows where target says; a pending layer holds edits until land. @unstable */
    storeEdit: (target: Target, edits: (Op<Location, Partial<Location> & Pick<Location, "id">, number>)[], opts: EditOpts | null) => Promise<MutationResult<Location>>;
    /** Drop a named pending layer and everything it holds. @unstable */
    storeDrop: (name: string) => Promise<null>;
    /** Run work over every location matched by selector. @unstable */
    storeWork: (selector: Selector$1<SelectionInput>, work: Work) => Promise<WorkResult>;
    /** Edit an interned field's value records; membership uses ordinary row edits. @unstable */
    storeEditValues: (field: string, edits: (Op<ValueRecord, Partial<ValueRecord> & Pick<ValueRecord, "id">, number>)[]) => Promise<MutationResult<ValueRecord>>;
    /** Return the uncommitted location change counts. @unstable */
    storeCommitDiff: () => Promise<Counts>;
    /** Edit the selection tree. @unstable */
    storeEditSelections: (op: SelectionOp) => Promise<MutationResult<Location>>;
    /** Answer one question about the target's rows matched by selector. @unstable */
    storeRead: (target: Target, selector: Selector$1<SelectionInput>, ask: Ask) => Promise<Answer>;
    /** Apply a saved rule with its value names resolved against the open map. @unstable */
    storeApplySavedSelection: (id: string) => Promise<MutationResult<Location>>;
    /** Return the open store's location count, version and dirty count. @unstable */
    storeSummary: () => Promise<Summary>;
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
    storeSaveDirty: () => Promise<null>;
    /**  Copy locations already stored in this map into another map. @unstable */
    storeCopyLocationsToMap: (targetMapId: string, selector: Selector$1<SelectionInput>) => Promise<CopyToMapResult>;
    /**
     *  Add caller-supplied locations to another map. Tags are matched by name against this
     *  map's tag table.
     *  @unstable
     */
    storeAddLocationsToMap: (targetMapId: string, locations: Location[]) => Promise<CopyToMapResult>;
    /**  Add locations from an upload session (see `storeUploadBegin`) as one undoable change. @unstable */
    storeAddLocationsUploaded: (sessionDir: string) => Promise<MutationResult<Location>>;
    /**  Register field dependencies. Changing an input clears fields derived from it. @unstable */
    storeSetDerived: (edges: { [key in string]: string[]; }) => Promise<null>;
    /**  Set the default marker color for new render updates. @unstable */
    storeSetMarkerColor: (color: RGB) => Promise<null>;
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
    /**  The area a polygon selects, as polygons whose edges never cross, for drawing its fill. @unstable */
    polygonFill: (polygon: PolygonGeometry) => Promise<[number, number][][][]>;
    /**  The parse error for `src`, or `null` when it parses. @unstable */
    fieldExprError: (src: string) => Promise<ExprError | null>;
    /**
     *  Count locations by country using offline point-in-polygon. Returns (ISO-A2, count) pairs.
     *  `level` selects border precision, falling back to "light" if unavailable.
     *  @unstable
     */
    storeCountryDistribution: (selector: Selector$1<SelectionInput>, level: string) => Promise<[string, number][]>;
    /**  Undo the newest edit, or redo the newest undone one. @unstable */
    storeStep: (stack: Stack, key: EntryKey | null) => Promise<MutationResult<Location>>;
    /**  Compile unaddressed selections into keyed store inputs. @unstable */
    selectionBuild: (selections: SelectionInput[]) => Promise<Selection[]>;
    /**  Draw the open map's markers: `frames` receives the whole scene, then every change to it. @unstable */
    storeSubscribeFrames: (frames: Channel<ArrayBuffer>, req: RenderRequest) => Promise<null>;
    /**  Subscribe to map changes, including the ids of added, removed, and updated rows. @unstable */
    storeSubscribeChanges: (changes: Channel<ChangeEvent>) => Promise<null>;
    /**  Resolve a marker pick (cell key + index within cell) to a location ID. @unstable */
    storeResolvePick: (cell: string, cellIndex: number) => Promise<number | null>;
    /**  Return metadata for every map in the database. @unstable */
    storeListMaps: () => Promise<MapMeta[]>;
    /**  Fetch a single map's metadata by ID. Returns `null` if not found. @unstable */
    storeGetMap: (id: string) => Promise<MapMeta | null>;
    /**  Create a new empty map with the preferences new maps start from. Returns the full metadata. @unstable */
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
     *  Copy a map, uncommitted edits included, into a new map named `name`. Version history,
     *  edit history, sync links, and review sessions stay with the original.
     *  @unstable
     */
    storeDuplicateMap: (id: string, name: string) => Promise<MapMeta>;
    /**
     *  Patch map metadata, leaving omitted fields unchanged.
     *  Open maps save through their store; tag records are edited separately.
     *  @unstable
     */
    storeUpdateMapMeta: (patch: Partial<Omit<MapMeta, "locationCount" | "pending" | "createdAt" | "updatedAt" | "lastOpenedAt">> & Pick<MapMeta, "id">) => Promise<null>;
    /**  Mark a map as opened now, for sorting the map list by recency. @unstable */
    storeTouchMapOpened: (mapId: string) => Promise<null>;
    /**  Rename a folder across all maps that reference it. @unstable */
    storeRenameFolder: (from: string, to: string) => Promise<null>;
    /**  Delete a folder, moving its maps to the root level. @unstable */
    storeDeleteFolder: (name: string) => Promise<null>;
    /**  Return aggregate database statistics: counts, file size, and configuration. @unstable */
    storeDbStats: () => Promise<DbStats>;
    /**  The preferences new maps start from, or `null` when they start from the factory defaults. @unstable */
    storeGetMapDefaults: () => Promise<MapPreferences | null>;
    /**
     *  Set the preferences new maps start from; `null` restores the factory defaults. Maps
     *  that already exist keep their own.
     *  @unstable
     */
    storeSetMapDefaults: (preferences: MapPreferences | null) => Promise<null>;
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
     *  Commit a previously previewed editor import into the open map, optionally
     *  dropping fields in `droppedFields` (e.g. `"heading"`, `"extra.countryCode"`)
     *  and/or applying each of `tagNames` to every imported location.
     *  @unstable
     */
    storeImportFile: (droppedFields: string[], tagNames: string[]) => Promise<EditorImportResult>;
    /**  Discard the staged import without importing it. @unstable */
    storeImportCancel: () => Promise<null>;
    /**  The location a pasted Maps URL names, short links resolved. @unstable */
    parseMapsUrl: (input: string) => Promise<ParsedLocation | null>;
    /**  Export locations as a `{name, customCoordinates}` JSON file, including tags and field defs. @unstable */
    storeExportJson: (opts: ExportOpts) => Promise<string>;
    /**  Export locations as a minimal lat/lng CSV file. @unstable */
    storeExportCsv: (selector: Selector$1<SelectionInput>) => Promise<string>;
    /**
     *  Export locations as a GeoJSON FeatureCollection of Point features.
     *  Each feature carries its tag names in `properties.tags`.
     *  @unstable
     */
    storeExportGeojson: (selector: Selector$1<SelectionInput>, tagsJson: string) => Promise<string>;
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
    /**  Commit the map's uncommitted changes. Returns the new commit ID. Clears undo/redo. @unstable */
    storeCommit: (mapId: string, message: string | null) => Promise<CommitResult>;
    /**  List all commits for a map, newest first. @unstable */
    storeListCommits: (mapId: string) => Promise<CommitInfo[]>;
    /**  Restore a map to a previous commit. An open map changes through its normal write path. @unstable */
    storeCheckoutCommit: (mapId: string, commitId: string) => Promise<MutationResult<Location>>;
    /**  Read a single commit's change: the locations it added, removed and updated. @unstable */
    storeGetCommitDelta: (mapId: string, commitId: string) => Promise<Change<Location>>;
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
    storeReviewUpdate: (update: Partial<Omit<ReviewSession, "mapId" | "sourceKey" | "sourceProps" | "createdAt" | "updatedAt">> & Pick<ReviewSession, "id">) => Promise<null>;
    /**  Delete a review session. @unstable */
    storeReviewDelete: (id: string) => Promise<null>;
    /**  List every saved selection rule (name, color, date), without their selector trees. @unstable */
    storeListSavedSelections: () => Promise<SavedSelectionInfo[]>;
    /**  Fetch the full saved selection rules for the given `ids`, including their selector trees. @unstable */
    storeGetSavedSelections: (ids: string[]) => Promise<SavedSelection[]>;
    /**  Save a new selection rule. @unstable */
    storeSaveSelection: (name: string, selector: Selector$1<SelectionInput>, color: RGB) => Promise<SavedSelection>;
    /**  Delete a saved selection rule by `id`. @unstable */
    storeDeleteSavedSelection: (id: string) => Promise<null>;
    /**
     *  Import saved selections kept in local storage by older versions. No-op when
     *  rules already exist. Returns the number of rules imported.
     *  @unstable
     */
    storeImportLegacySavedSelections: (json: string) => Promise<number>;
    /**  Drop all mapping rows for a linked map (unlink). @unstable */
    remoteMappingClear: (provider: string, mapId: string) => Promise<null>;
    /**
     *  Reconcile a linked map against its remote, pushing local changes and pulling
     *  remote ones. Returns the creates, updates, and deletes for each side to apply.
     *  @unstable
     */
    syncReconcile: (provider: string, mapId: string, remoteMapId: string, firstSync: FirstSyncMode | null, resolutions: ([string, ResolutionSide])[] | null) => Promise<SyncReconcileResult>;
    /**  Record a settled sync pass for a map. Only the most recent passes per provider are kept. @unstable */
    syncLogAppend: (provider: string, mapId: string, entry: SyncLogEntry) => Promise<null>;
    /**  A map's recorded sync passes with a provider, newest first. @unstable */
    syncLogList: (provider: string, mapId: string) => Promise<SyncLogEntry[]>;
    /**  The account behind the stored key, or null when no key is stored. @unstable */
    mapMakingMe: () => Promise<MmUser | null>;
    /**  Check `key` against the remote without storing it. @unstable */
    mapMakingValidate: (key: string) => Promise<MmUser>;
    /**  Linkable maps for the stored key. @unstable */
    mapMakingMaps: () => Promise<MmMapSummary[]>;
    /**  Create an empty map named `name` for the stored key. @unstable */
    mapMakingCreateMap: (name: string) => Promise<MmMapSummary>;
    /**  Store the API key, or clear it with null. @unstable */
    mapMakingSetKey: (key: string | null) => Promise<null>;
    /**  Local-only check: is a key stored? Says nothing about its validity. @unstable */
    mapMakingHasKey: () => Promise<boolean>;
    /**  Read the map file at a path or http(s) URL, to link a map to it. @unstable */
    fileSourceProbe: (address: string) => Promise<FileSource>;
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
    procedureRun: (providers: ProviderDecl[], force: boolean, target: Target | null) => Promise<number>;
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
/**  The answer to a question about the selected locations. */
type Answer = {
    kind: "ids";
    ids: number[];
} | {
    kind: "spacing";
    ids: number[];
    spacingM: number;
} | {
    kind: "count";
    count: number;
} | {
    kind: "locations";
    locations: LocationList;
} | {
    kind: "columns";
    columns: unknown[][];
} | {
    kind: "values";
    values: string[];
} | {
    kind: "groupBy";
    groups: PartitionBucket[];
} | {
    kind: "countBy";
    counts: CountBy[];
} | {
    kind: "coverage";
    coverage: ([string, number])[];
} | {
    kind: "bounds";
    bounds: [number, number, number, number] | null;
} | {
    kind: "duplicateGroups";
    groups: number[][];
} | {
    kind: "nearAny";
    values: boolean[];
};
/**  A question about the selected locations. */
type Ask = 
/**  Their ids: ascending, or a ranked selector's order. */
{
    kind: "ids";
} | 
/**  The ids a spaced pick at the root kept, with the spacing it settled on. */
{
    kind: "spacing";
} | 
/**  How many there are. */
{
    kind: "count";
} | 
/**  Every location in full. */
{
    kind: "locations";
} | 
/**
 *  One column per field, `null` where a row lacks it; `tags` is a column of tag-id
 *  arrays.
 */
{
    kind: "columns";
    fields: string[];
} | 
/**  Distinct values of `field`, sorted. */
{
    kind: "values";
    field: string;
} | 
/**  Groups by a derived key of `field`: `{ key, ids, bin }` per group. */
{
    kind: "groupBy";
    field: string;
    key: KeySpec;
} | 
/**
 *  Counts by a derived key of each field, with how many distinct rows the groups
 *  cover, one result per field.
 */
{
    kind: "countBy";
    fields: string[];
    key: KeySpec;
} | 
/**  How many rows hold a value for each field, key-sorted. */
{
    kind: "coverage";
} | 
/**  Bounding box `[west, south, east, north]`, or `null` when nothing matches. */
{
    kind: "bounds";
} | 
/**  Groups of rows within `distance` metres of each other, two or more per group. */
{
    kind: "duplicateGroups";
    distance: number;
} | 
/**  Per input coordinate, whether any selected row lies within `radiusM` metres. */
{
    kind: "nearAny";
    lats: number[];
    lngs: number[];
    radiusM: number;
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
/**  Added, removed, and updated rows, with enough information to undo or combine changes. @unstable */
type Change<T> = {
    /**  The rows it created. */
    added: T[];
    /**  Removed rows, including their old values. */
    removed: T[];
    /**  Updated rows as before/after pairs. */
    updated: ([T, T])[];
};
/**  A map change broadcast to subscribers, with affected ids and derived state. */
type ChangeEvent = {
    /**  The map version this change brought the map to. */
    version: number;
    /**  Changed derived state. Null fields are unchanged. */
    derived: Derived;
} & Keys<number>;
/**  Metadata for a single commit. @unstable */
type CommitInfo = {
    id: string;
    mapId: string;
    parentId: string | null;
    message: string | null;
    treeHash: string | null;
    locationCount: number;
    createdAt: string;
} & Counts;
/**  The new commit's ID and the resulting state update. @unstable */
type CommitResult = {
    id: string;
    status: Mutation;
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
type Composition = "intersection" | "union" | "invert";
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
/**  Counts of added, removed, and updated rows. */
type Counts = {
    /**  Rows the change created. */
    added: number;
    /**  Rows the change deleted. */
    removed: number;
    /**  Rows the change rewrote. */
    updated: number;
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
/**  Map state a change affected. Each field is `null` when it did not change. */
type Derived = {
    locationCount: number | null;
    meta: (Partial<Omit<MapMeta, "locationCount" | "pending" | "createdAt" | "updatedAt" | "lastOpenedAt">> & Pick<MapMeta, "id">) | null;
    history: Partial<{
        [key in EntryKey]: History;
    }> | null;
    /**  Changed values, keyed by field and value. Null removes a value with no record or rows. */
    fieldValues: {
        [key in string]: {
            [key in string]: HeldValue | null;
        };
    } | null;
    /**  The whole extra-field registry, when the map's row changed. */
    fieldDefs: {
        [key in string]: FieldDef;
    } | null;
    /**  Resolved count per selection node, keyed by `Selection.key` (top-level and nested). */
    selectionCounts: {
        [key in string]: number;
    } | null;
    /**  The listed selections, when the list changed. */
    selectionList: ListedSelection[] | null;
};
/**  What the user needs in order to authorize: the code to type and where to type it. @unstable */
type DeviceCodeInfo = {
    userCode: string;
    verificationUri: string;
    /**  Seconds until `userCode` stops working. */
    expiresIn: number;
};
/**  Options for applying an edit. @unstable */
type EditOpts = {
    /**  Apply the pending layer to the map after these edits. */
    land?: boolean;
};
/**
 *  Preview data for importing a file into the currently open map.
 *  Unlike bulk import, this shows per-field counts so the user can
 *  selectively drop fields (heading, panoId, etc.) before importing.
 *  @unstable
 */
type EditorImportPreview = {
    locationCount: number;
    /**  Tag records from the file, shown in the preview before map-local ids are assigned. */
    tags: {
        [key in string]: unknown;
    }[];
    fields: FieldCount[];
    warnings: string[];
    /**  Temp-file path to preview positions: interleaved LE f32 `[lng, lat]` pairs. */
    previewPositionsPath: string;
    /**  `[west, south, east, north]` bounding box of the import, for map auto-focus. */
    bounds: [number, number, number, number] | null;
    /**  True when this import is too large to undo and will be committed automatically. */
    willAutoCommit: boolean;
    /**  The id the first staged row was given; the rest follow it in order. */
    firstId: number | null;
    /**  Map settings carried by the import (`extra.settings`). */
    settings: {
        [key in string]: any;
    };
};
/**
 *  Combined result of an editor import: the mutation it made
 *  plus import-specific metadata.
 *  @unstable
 */
type EditorImportResult = {
    mutation: Mutation;
    importedCount: number;
    /**  True when the import was large enough to autocommit; the caller commits it. */
    autoCommit: boolean;
};
type EntryKey = 
/** Changes to locations. */
"locations" | 
/** Changes to piles. */
"piles" | 
/** Changes to defs. */
"defs" | 
/** Changes to meta. */
"meta" | 
/** Changes to selections. */
"selections";
/**
 *  Configuration for JSON export. Controls which fields are included and
 *  whether the export covers all locations or a specific selection.
 *  @unstable
 */
type ExportOpts = {
    exportZoom: boolean;
    exportUnpanned: boolean;
    /**  How much of the map the file keeps. */
    shape: MapShape;
    /**  Which locations to export. */
    selector: Selector$1<SelectionInput>;
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
 *  What a field is: its type, display name and declared values. A map's own fields are
 *  stored in its `extra.fields` JSON; the built-ins come from the location itself. For
 *  enumerable types, `values` declares the value space in display order, each member
 *  carrying its own display name.
 */
type FieldDef = {
    type: FieldType;
    label: string | null;
    /**  The declared value space, in display order. */
    values: FieldValue[] | null;
    /**  How this field is compared during disambiguation. `null` infers it from the field type. */
    comparison: ComparisonType | null;
    /**  The field's values are ids the map allocates, each wearing its own display record. */
    interned?: boolean;
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
/**  A map file as the link picker shows it. @unstable */
type FileSource = {
    /**  The name the file gives its map; empty when it names none. */
    name: string;
    locationCount: number;
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
/**  One value of a field as the map holds it. */
type HeldValue = {
    /**  Optional metadata for an interned value. */
    record: {
        [key in string]: unknown;
    } | null;
    /**  How many rows hold the value. */
    count: number;
};
/**  Whether undo and redo are available. */
type History = {
    /**  An edit can be undone. */
    undo: boolean;
    /**  An undone edit can be redone. */
    redo: boolean;
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
/**  Keys of added, removed, and updated rows. */
type Keys<K> = {
    /**  The rows the change created. */
    added: K[];
    /**  The rows the change deleted. */
    removed: K[];
    /**  The rows the change rewrote. */
    updated: K[];
};
/**  A selection as the sidebar lists it, plus whether it is ghosted. */
type ListedSelection = {
    selection: Selection;
    /**  Counted, but kept out of the overlay and the selected set. */
    ghosted: boolean;
};
/**
 *  A single Street View location on a map.
 *
 *  This is the atomic unit of data in the system. Locations are stored columnar
 *  in Arrow IPC on disk and addressed by `id` everywhere. The `id` is unique
 *  within a map and assigned by the store's monotonic allocator.
 */
type Location = {
    /**  Monotonically increasing within a map. Zero until the store numbers the row. */
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
/**  Matched locations: returned inline, or as a file path to read them from. */
type LocationList = {
    kind: "inline";
    locations: Location[];
} | {
    kind: "file";
    path: string;
};
/**  Operations computed independently for each selected location. @unstable */
type LocationOp = 
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
 *  Assign a value to a writable field on each row. Builtins update their stored
 *  fields; other keys update `extra`.
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
 *  Add and remove list members. `add` wins if a value appears in both lists.
 *  Rows already in the requested state keep their member order.
 */
{
    kind: "listSet";
    key: string;
    add: unknown[];
    remove: unknown[];
};
/**
 *  Top-level `extra` JSON blob on a map row. Currently only holds field definitions,
 *  but structured as an object to allow future extensions.
 */
type MapExtra = {
    fields?: {
        [key in string]: FieldDef;
    };
};
/**
 *  Action performed by a per-map key binding on the open location.
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
/**  Full metadata for a map. @unstable */
type MapMeta_Deserialize = {
    id: string;
    name: string;
    description: string;
    folder: string | null;
    settings: MapSettings;
    scoreBounds: ScoreBounds;
    extra: MapExtra;
    /**  Tag records keyed by id, loaded from `maps.tags` when opening the map. */
    tags: {
        [key in string]: ValueRecord;
    };
    labels: string[];
    locationCount: number;
    /**  Location changes since the last commit. */
    pending: Counts;
    createdAt: string;
    updatedAt: string;
    lastOpenedAt: string | null;
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
    /**  Tag records keyed by id, loaded from `maps.tags` when opening the map. */
    tags: {
        [key in string]: ValueRecord;
    };
    labels: string[];
    locationCount: number;
    /**  Location changes since the last commit. */
    pending: Counts;
    createdAt: string;
    updatedAt: string;
    lastOpenedAt: string | null;
};
/**  Street View lookup, export, and enrichment preferences that can start any map. */
type MapPreferences = {
    pointAlongRoad?: boolean;
    preferDirection?: string | null;
    preferOfficial?: boolean;
    preferHigherQuality?: boolean;
    onlyOfficial?: boolean;
    cameraTypes?: string[] | null;
    defaultPanoId?: boolean;
    exportZoom?: boolean;
    exportUnpanned?: boolean;
    /**  How much of the map a JSON export keeps. */
    exportShape?: MapShape;
    searchRadius?: number | null;
    enrichMetadata?: boolean;
    enrichFields?: string[] | null;
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
/**  A map's settings: its preferences plus what refers to its own tags and data. */
type MapSettings = {
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
    /**  What each plugin keeps with this map, by plugin id and then key. */
    pluginData?: {
        [key in string]: {
            [key in string]: unknown;
        };
    };
} & MapPreferences;
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
/**  The version a write reached and the keys it assigned. Other updates arrive on the change feed. */
type Mutation<_T = Location> = {
    /**  The map version this change brought the map to. */
    version: number;
    /**  The key the store gave each keyless set, in the order they were written. */
    keys: number[];
};
type MutationResult<T = Location> = {
    mutation: Mutation<T>;
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
    /**  Custom fields, for a remote that keeps them; `null` for one that does not, or when empty. */
    extra: {
        [key in string]: unknown;
    } | null;
};
/**  Equal-width bin sizing. `count` derives the width from the data range; `width` fixes it. */
type NumericBinning = {
    by: "count";
    n: number;
} | {
    by: "width";
    w: number;
};
/**  An edit to one keyed row: replace it, patch it, or remove it. @unstable */
type Op<T, P, K> = 
/**  The row exactly as given. */
(({
    set: T;
}) & {
    put?: never;
    remove?: never;
}) | (
/**  A patch written over the row it names. */
({
    put: P;
}) & {
    remove?: never;
    set?: never;
}) | (
/**  The row at this key removed. */
({
    remove: K;
}) & {
    put?: never;
    set?: never;
});
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
 *  What one query resolved to. `skipped` is a query that was never answered: a cancelled
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
    /**  The sidecar this build ships, so a half-installed one can be repaired. */
    sidecar?: PluginSidecar_Deserialize | null;
};
/**  A published build of a plugin. */
type PluginBuild = {
    version: string;
    ref: string;
    minAppVersion?: string | null;
    /**  The sidecar this build ships, so a half-installed one can be repaired. */
    sidecar?: PluginSidecar | null;
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
/**  How hard one caller may push an endpoint. @unstable */
type Policy = {
    rate?: RateSpec | null;
    retry?: RetrySpec | null;
    /**
     *  Requests one run or one query may have in flight at once. A run's instances share
     *  the budget; a separate run or query gets its own.
     */
    inflight?: number | null;
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
    /**
     *  Procedure-specific configuration, a JSON value as text. Passed through verbatim
     *  inside the config object every entry point receives.
     */
    config?: string | null;
} & Policy;
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
    select: Selector$1<SelectionInput>;
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
/**  A colour as red, green and blue bytes, serialized as `[r, g, b]`. */
type RGB = [number, number, number];
/**  Rate limit: `units` calls per `perMs` milliseconds, refilled continuously. @unstable */
type RateSpec = {
    units: number;
    perMs: number;
    cost?: RateCost;
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
    markerColor?: RGB | null;
};
/**  One location's answer from a procedure, as the JSON its module emitted. @unstable */
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
/** @unstable */
type SavedSelection = {
    selector: Selector$1;
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
    color: RGB;
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
/**  A panorama visit record. @unstable */
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
 *  @unstable
 */
type SeenFilter = {
    country?: string | null;
    mapId?: string | null;
    search?: string | null;
    locationIds?: number[] | null;
    since?: number | null;
};
/**  Map ID and display name for seen-history filtering. @unstable */
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
type Selection = {
    key: string;
    color: RGB;
    selector: Selector$1;
};
/** @unstable */
type SelectionInput = {
    selector: Selector$1<SelectionInput>;
    color?: RGB | null;
};
/** @unstable */
type SelectionOp = {
    /** @unstable */
    kind: "add";
    selections: SelectionInput[];
} | {
    /** @unstable */
    kind: "set";
    selections: SelectionInput[];
} | {
    /** @unstable */
    kind: "remove";
    keys: string[];
} | {
    /** @unstable */
    kind: "toggle";
    selections: SelectionInput[];
} | {
    /** @unstable */
    kind: "manual";
    id: number;
} | {
    /** @unstable */
    kind: "active";
    op: SelectionOp;
} | {
    /** @unstable */
    kind: "combine";
    mode: Composition;
    keys: string[] | null;
} | {
    /** @unstable */
    kind: "ghost";
    index: number;
} | {
    /** @unstable */
    kind: "isolate";
    index: number;
} | {
    /** @unstable */
    kind: "ghostAll";
} | {
    /** @unstable */
    kind: "invert";
    path: number[];
} | {
    /** @unstable */
    kind: "compose";
    drag: number[];
    drop: number[];
    mode: Composition;
} | {
    /** @unstable */
    kind: "move";
    from: number[];
    to: number[];
    after: boolean;
} | {
    /** @unstable */
    kind: "removeAt";
    path: number[];
} | {
    /** @unstable */
    kind: "replace";
    path: number[];
    selection: SelectionInput;
} | {
    /** @unstable */
    kind: "color";
    path: number[];
    color: RGB;
} | {
    /** @unstable */
    kind: "polygonName";
    path: number[];
    name: string;
};
/**  Selection predicates and composites, serialized with a `type` discriminator. */
type Selector$1<S = Selection> = {
    type: "Locations";
    locations: number[];
    name: string | null;
} | {
    type: "Everything";
} | 
/**  The locations currently selected in the editor. */
{
    type: "Selected";
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
    type: "Validation";
    locations: number[];
    category: string;
} | {
    type: "Reviewed";
    locations: number[];
    sessionId: string;
    mode: string;
} | {
    type: "Intersection";
    selections: S[];
} | {
    type: "Union";
    selections: S[];
} | {
    type: "Invert";
    selections: S[];
} | {
    type: "Filter";
    field: string;
    test: FilterOp;
} | 
/**
 *  Rank by a field expression, optionally keeping only the first `k`.
 *  Unscorable rows rank last; without `k`, all child rows are kept.
 */
{
    type: "Ranked";
    /**  What to rank; `null` ranks the whole map. */
    selection: S | null;
    expr: string;
    k: number | null;
    ascending: boolean;
} | 
/**  `n` rows of a selection drawn uniformly at random, without replacement. */
{
    type: "Sample";
    /**  What to draw from; `null` draws from the whole map. */
    selection: S | null;
    n: number;
} | 
/**  A selection thinned to a spread-out subset. */
{
    type: "Spaced";
    /**  What to thin; `null` thins the whole map. */
    selection: S | null;
    thin: Thinning;
} | 
/**  A selection thinned on a honeycomb, never two picks closer than half the spacing. */
{
    type: "EvenlySpaced";
    /**  What to thin; `null` thins the whole map. */
    selection: S | null;
    thin: Thinning;
} | 
/**  The rows of a selection within `radiusM` metres of a coordinate. */
{
    type: "Nearby";
    /**  Where to look; `null` looks over the whole map. */
    selection: S | null;
    lat: number;
    lng: number;
    radiusM: number;
} | 
/**  The row of a selection closest to a coordinate. */
{
    type: "Nearest";
    /**  Where to look; `null` looks over the whole map. */
    selection: S | null;
    lat: number;
    lng: number;
};
/**  Operations computed over the selected rows as a group. @unstable */
type SetOp = {
    kind: "merge";
    groups: number[][];
    score: string | null;
} | 
/**
 *  Remove duplicates within `distance` metres of each other, keeping the best-scored
 *  survivor per cluster.
 */
{
    kind: "pruneDuplicates";
    distance: number;
    score: string | null;
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
/** @unstable */
type StoreStatus = {
    version: number;
    derived: Derived;
};
/**  What the store has to warn the user about. The sentence is TS's to write. @unstable */
type StoreWarning = 
/**  The uncommitted delta was unreadable; the map opened from its last commit. */
{
    kind: "deltaSetAside";
};
/** @unstable */
type Summary = {
    locationCount: number;
    version: number;
    dirtyCount: number;
};
/**  One settled sync pass. @unstable */
type SyncLogEntry = {
    trigger: SyncTrigger;
    /**  When the pass started, in milliseconds since 1970. */
    startedAt: number;
    durationMs: number;
    result: SyncLogResult;
};
/**  How a sync pass ended. @unstable */
type SyncLogResult = 
/**  The pass finished, with what it changed on each side. */
{
    kind: "ok";
    pushed: SideCounts;
    pulled: SideCounts;
    adopted: number;
    conflicts: number;
} | 
/**  The pass stopped with this error. */
{
    kind: "error";
    message: string;
};
/**  Sync counts, unresolved conflicts, and the locally applied pull mutation. @unstable */
type SyncReconcileResult = {
    /**  Remote-applied counts; mirror-from-local deletes fold into `delete`. */
    pushed: SideCounts;
    /**  Local-applied counts; mirror-from-remote deletes fold into `delete`. */
    pulled: SideCounts;
    adopted: number;
    conflicts: Conflict[];
    /**  The change the pull half made locally, or `null` when nothing was pulled. */
    mutation: Mutation | null;
    /**  The rows the pull removed. */
    removedIds: number[];
};
/**  Read or edit map rows directly, or through a named pending layer. */
type Target = 
/**  The map's rows. */
{
    kind: "map";
} | 
/**
 *  A pending layer, created on first use. Reads include current underlying map data;
 *  edits reach the map when the layer is applied.
 */
{
    kind: "pending";
    name: string;
};
/**  Limit a spaced pick by count or minimum spacing. */
type Thinning = 
/**  At most `n` rows. */
{
    by: "count";
    n: number;
} | 
/**  Rows about `m` metres apart. */
{
    by: "metres";
    m: number;
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
/**  Metadata for one interned value. */
type ValueRecord = {
    id: number;
    /**  The value's display name, unique within its field regardless of case. */
    name?: string | null;
    /**  The value's place in its field's list. */
    order?: number | null;
} & {
    [key in string]: unknown;
};
/**
 *  Per-map config for a virtual tag-tree node - a folder node with no underlying
 *  tag (e.g. "a" when only "a/b" and "a/c" exist). Keyed by the node's full slash
 *  path in `MapSettings::virtual_tags`. Tree-view only; never creates a real tag.
 */
type VirtualTag = {
    color?: string | null;
    /**  Where the folder sorts while it holds no tags, on the same scale as tag order. */
    order?: number | null;
};
/**  Operations over the selected locations. @unstable */
type Work = LocationOp | SetOp;
/**  The mutation and operation-specific results. */
type WorkResult = {
    mutation: Mutation;
    /**  Rows the work edited. */
    changed: number;
    /**  Rows an expression could not evaluate. */
    failed: number[];
};

/**
 * The global `mma` API available inside procedure modules. Calls are synchronous;
 * pass request lists for concurrency. `map` and `run` receive locations;
 * `query` handles read-only requests. Each entry point receives `{ fields, force, config }`.
 * Results are location patches under `patch`, or module-defined answers under `collect`.
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
    /** One request, or every request of a list at once, answered in order. A single
     *  request that cannot be issued throws; inside a list it answers `status: 0`, so the
     *  rest survive. */
    fetch(req: ProcedureRequest): ProcedureResponse;
    fetch(reqs: ProcedureRequest[]): ProcedureResponse[];
    /** Resolve pano ids or coordinate searches, returning answers in input order.
     *  `skipped` means the run was aborted or the requested id was empty. */
    panos(queries: PanoQuery[]): PanoAnswer[];
    classify(dataset: string, lat: number, lng: number): string | null;
    /** Nearby run locations, nearest first, with the requested fields when present.
     *  Includes the queried location itself; radius 0 matches exact coordinates.
     *  Keep radius and fields constant to reuse the index. Unavailable in queries. */
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
    /** Marks a location as failed rather than skipped. */
    fail(id: number): void;
    /** Delivers one partial result to the caller while the call is still running, under
     *  an id of the procedure's choosing. Queries stream these to whoever asked; runs
     *  discard them. */
    emit(id: number, value: unknown): void;
    aborted(): boolean;
}
declare global {
    /** Reachable inside a procedure module only. `fetch`, `panos` and `sidecar` are
     *  detached outside `run` and `query`; calling one elsewhere throws. */
    const mma: ProcedureHost;
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
     *  colour fact is whether a selection or the open-location highlight is covering it. */
    visible: Uint8Array;
    angles: Float32Array;
    count: number;
    capacity: number;
    positionVersion: number;
    colorVersion: number;
    constructor(capacity?: number);
    /** A cell holding `rows` as they are, viewing the frame's arrays rather than copying
     *  them. Every row starts hidden until the caller paints it. */
    static of(rows: FrameRows): CellBuffer;
    /** Append a marker, growing the buffer if needed. Visibility is set by the caller once
     *  the overlay knows about the row. */
    append(id: number, lng: number, lat: number, angle: number): void;
    /** O(1) removal by swapping with the last element. Mirrors Rust's cell_remove_render. */
    swapRemove(index: number): void;
    patchPosition(index: number, lng: number, lat: number, angle: number): void;
    /** Show (255) or hide (0) one marker in the base layer. */
    patchVisible(index: number, visible: number): void;
    private ensureCapacity;
}
/** One cell's rows in a frame, viewed in place: ids for adds, slots for patches. @unstable */
export interface FrameRows {
    key: Uint32Array<ArrayBuffer>;
    pos: Float32Array<ArrayBuffer>;
    angle: Float32Array<ArrayBuffer>;
    sel: Uint32Array<ArrayBuffer>;
}
/** What applying one frame did: the map version the scene reached, whether it started the
 *  scene over, and the ids it added and removed, ascending. A row that moved between cells
 *  is in neither; a replace lists nothing. @unstable */
export interface FrameSummary {
    version: number;
    replace: boolean;
    added: Uint32Array;
    removed: Uint32Array;
}
/**
 * Owns all marker render data as 32 geohash-cell CellBuffers plus a selection overlay,
 * kept in step with the map by applying its render frames in order (`apply`).
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
    /** The location the open-location layer draws, hidden in its base cell. */
    private openId;
    /** Scratch for `restateSelections`: per-row winning selection index, reused across
     *  cells so a full restate does not allocate one array per cell. */
    private selWinner;
    /**
     * Apply one render frame. Every cell's removals swap-remove their slots first; then per
     * cell the adds append and the patches restate rows by their slot. Every added or patched row
     * states the selection painting it, so the base cells and the overlay are written from
     * one fact. A selection section, when present, then restates every cell's membership.
     */
    apply(buf: ArrayBuffer): FrameSummary;
    /** Put the row at `cb[i]` in or out of the selection overlay and set its base visibility.
     *  Idempotent, so restating a row's current state costs nothing but is always safe.
     *  The caller bumps the cell's colour version once for the whole frame. */
    private paint;
    /** Set the open location, whose marker the open-location layer draws instead of the base cell.
     *  Returns whether the open location actually moved. */
    setOpen(id: number | null): boolean;
    /**
     * A base row is hidden exactly when something else is drawing it: the selection overlay
     * or the open-location layer. The only place `visible` is decided for a single row, so
     * "selected" and "open" never have to negotiate over the byte.
     */
    private syncVisible;
    /** Visit every rendered location's position. The cells hold all alive rows (a `visible`
     *  0 only means the overlay or open-location layer draws that row instead), so this is the
     *  maintained full-map position set. */
    forEachPosition(f: (id: number, lng: number, lat: number) => void): void;
    /** Map a deck.gl pick (cell + index) back to a location ID. */
    resolvePickFromCell(cellKey: string, cellIndex: number): number | null;
    /** Selected-id set, snapshotted from the overlay. */
    selectedIds(): SelectedIds;
    /**
     * Restate the selection overlay from a frame's selection section. Selected rows are
     * drawn by the overlay in their selection's color and hidden in their base cell.
     *
     * Partial updates are supported: only the cells named in `cellEntries` are restated,
     * and overlay entries for every other cell survive untouched.
     */
    private restateSelections;
    clear(): void;
}

export type Cmd = typeof commands$1;
/** Every backend command, typed. Any of them can change in a release. @unstable */
declare const cmd: Cmd;

/** @unstable */
export type commands_Cmd = Cmd;
/** @unstable */
declare const commands_cmd: typeof cmd;
declare namespace commands {
  export { commands_cmd as cmd };
  export type { commands_Cmd as Cmd };
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

type Selector = Parameters<Cmd["storeRead"]>[1];

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
/** A change to some fields of row `id`. */
/** A change to some of row `id`'s fields. */
export type Patch<T extends {
    id: unknown;
}> = Partial<T> & Pick<T, "id">;
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
/** A full location or just its id (to be fetched on demand). */
export type MaybeLocation = Location | number;
/** Extract the id from a MaybeLocation. */
declare function locId(m: MaybeLocation): number;
/** Build a new Location from lat/lng plus overrides. Its `id` is 0, whatever the
 *  overrides hold, until `addLocations` writes the real id back into the object. */
declare function createLocation(partial: Partial<Location> & LatLng): Location;
/** A new Location at the viewer's live camera, carrying `source`'s flags and the given
 *  tags. `extra` describes the pano it was fetched for, so it only survives a drop that
 *  stayed on that pano. @unstable */
declare function dropLocation(source: Location, live: PanoCapture, panoId: string | null, tags: number[]): Location;
/** @unstable */
export type SortMode = "name" | "created" | "opened" | "amount";
export type TagSortMode = "default" | "name" | "amount";
/** @unstable */
export type WorkArea = "overview" | "location" | "duplicates" | "import" | "plugin" | "diff";
/** Hex like "#1098ad"; legacy stored prefs may hold an Open Props ramp name. @unstable */
export type SvColor = string;
/** @unstable */
export type MapTypeKey = "map" | "satellite" | "osm" | "vector";
/** @unstable */
export type SvCoverageType = "official" | "unofficial" | "default";
/** @unstable */
export type SvThickness = "default" | "high";
/** @unstable */
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
export type types_Patch<T extends {
    id: unknown;
}> = Patch<T>;
/** @unstable */
export type types_Selector = Selector;
/** @unstable */
export type types_SortMode = SortMode;
/** @unstable */
export type types_SvColor = SvColor;
/** @unstable */
export type types_SvCoverageType = SvCoverageType;
/** @unstable */
export type types_SvThickness = SvThickness;
/** @unstable */
export type types_TagSortMode = TagSortMode;
/** @unstable */
export type types_WorkArea = WorkArea;
/** @unstable */
declare const types_bboxTupleToBounds: typeof bboxTupleToBounds;
/** @unstable */
declare const types_boundsToScoreTuple: typeof boundsToScoreTuple;
declare const types_createFieldDef: typeof createFieldDef;
declare const types_createLocation: typeof createLocation;
/** @unstable */
declare const types_dropLocation: typeof dropLocation;
declare const types_isPinned: typeof isPinned;
declare const types_isWorldBounds: typeof isWorldBounds;
declare const types_locId: typeof locId;
/** @unstable */
declare const types_scoreTupleToBounds: typeof scoreTupleToBounds;
declare const types_setPinned: typeof setPinned;
declare namespace types {
  export { types_bboxTupleToBounds as bboxTupleToBounds, types_boundsToScoreTuple as boundsToScoreTuple, types_createFieldDef as createFieldDef, types_createLocation as createLocation, types_dropLocation as dropLocation, types_isPinned as isPinned, types_isWorldBounds as isWorldBounds, types_locId as locId, types_scoreTupleToBounds as scoreTupleToBounds, types_setPinned as setPinned };
  export type { types_Bounds as Bounds, types_LatLng as LatLng, types_LocationPOV as LocationPOV, types_MapTypeKey as MapTypeKey, types_MarkerStyle as MarkerStyle, types_MaybeLocation as MaybeLocation, types_PanoCapture as PanoCapture, types_PanoView as PanoView, types_Patch as Patch, types_Selector as Selector, types_SortMode as SortMode, types_SvColor as SvColor, types_SvCoverageType as SvCoverageType, types_SvThickness as SvThickness, Tag as Tag, types_TagSortMode as TagSortMode, types_WorkArea as WorkArea };
}

/** The full local mirror of the store's derived state. */
export type EngineState = {
    [K in Exclude<keyof Derived, "meta">]: NonNullable<Derived[K]>;
};
export interface UiState {
    mapId: string | null;
    /** Persisted identity slice (metadata + settings). Changes rarely. */
    map: MapMeta | null;
    selectedLocationIds: SelectedIds;
    /** The location open in the editor, or null. */
    open: Open | null;
    /** @unstable */
    duplicateLocations: Location[];
    /** @unstable */
    workArea: WorkArea;
    /** @unstable */
    activePluginId: string | null;
}
/** Where an open location came from: the map, the seen history, or a pending import. */
export type OpenOrigin = "map" | "seen" | "import";
/** A location open in the editor. A preview's id is its viewer-layer id. */
export interface Open {
    id: number;
    origin: OpenOrigin;
    /** Identifies this editor session, even when reopening the same location. */
    session: number;
    /** The location as last read from the viewer's layer, or null while loading. */
    location: Location | null;
}
export type MapState = UiState & EngineState;
declare const Store: {
    /** Replace state fields and notify subscribers. @unstable */
    patch: (patch: Partial<MapState>) => void;
    /** Merge derived updates, preserving null fields and removing null field values. @unstable */
    merge: (v: Derived) => void;
    /** Reactive slice of the map state. Re-renders only when the selected value's
     *  reference changes (`Object.is`), so selectors must return state fields or
     *  memoized values, not a new value per call. */
    use: <T>(selector: (s: MapState) => T) => T;
    /** Imperative snapshot of the map state. */
    get: () => Readonly<MapState>;
    /** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want. @unstable */
    setSelected: (ids: SelectedIds) => void;
    /** Replace the open map's row in state; persisting it is the caller's. @unstable */
    setMeta: (map: MapMeta) => void;
    /** Clear derived state when the map closes. @unstable */
    resetDerived: () => void;
};

declare const EVENT_DEFS: {
    /** Map changes with affected location ids. Consumers re-read derived location data on this event. */
    "store:change": ChangeEvent;
    "selection:change": Selection[];
    "open:change": number | null;
    /** @deprecated v0.12.0. Listen for `open:change`. @unstable */
    "active:change": number | null;
    "map:open": MapMeta;
    "map:close": void;
    /** @unstable */
    "store:changed": void;
    "map-list:changed": void;
    /** @unstable */
    "saved-selections:changed": void;
    "settings:changed": void;
    /** @unstable */
    "fullscreen:changed": void;
    "plugins:changed": void;
    /** @unstable */
    "sync-links:changed": void;
    /** @unstable */
    "map-badges:changed": void;
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

/** A mark drawn after a map's name in the map list: an icon, or a count of changes. @unstable */
export type MapBadge = {
    key: string;
    title: string;
} & ({
    icon: string;
} | {
    diff: Counts;
});
/** A feature that marks map rows, shown or hidden as a unit in settings. @unstable */
export interface BadgeSource {
    /** Stable id, remembered by the setting that hides it. */
    id: string;
    /** Name shown next to its checkbox in settings. */
    label: string;
    /** Events after which the badges are collected again. */
    events: readonly EditorEvent[];
    /** Yields the badges to show, each paired with its map id. */
    collect(): Iterable<[mapId: string, badge: MapBadge]>;
}
declare const Maps: {
    /** One-time store startup. The app calls this; plugins never need to. @unstable */
    init: () => Promise<void>;
    /** Open a map in this window, closing any currently open map first. */
    open: (id: string) => Promise<void>;
    /** Close the open map, saving unsaved changes first. */
    close: () => Promise<void>;
    /** Drop the open map without persisting anything @unstable */
    discard: () => void;
    /** Reactive list of all maps (metadata only). */
    useList: () => MapMeta[];
    /** The list of all maps (metadata only). */
    list: () => MapMeta[];
    /** Refresh the map list from disk. @unstable */
    reload: () => Promise<void>;
    /** Refresh the map list and notify other windows of the change. @unstable */
    invalidate: () => Promise<void>;
    /** Set the map list directly without a disk read. @unstable */
    setList: (list: MapMeta[]) => void;
    /** Create a new empty map and return its metadata. */
    create: (name: string, folder?: string | null) => Promise<MapMeta>;
    /** Copy a map, uncommitted edits included, into a new map named `name` and return its metadata. */
    duplicate: (id: string, name: string) => Promise<MapMeta>;
    /** Permanently delete a map and all its data. Not undoable. */
    remove: (id: string) => Promise<void>;
    /** Open the scratch map, creating it on first use. */
    openScratch: () => Promise<void>;
    /** Whether `id` belongs to an app fixture rather than a user-created map. @unstable */
    isReserved: (id: string | null) => boolean;
    /** The name a copy of the map named `name` starts with. @unstable */
    copyName: (name: string) => string;
    /** Rename a folder, moving all its maps to the new name. */
    renameFolder: (from: string, to: string) => Promise<void>;
    /** Move a map into a folder, or to the root when `folder` is null. */
    moveToFolder: (mapId: string, folder: string | null) => Promise<void>;
    /** Delete a folder. Maps in it become unfoldered. */
    removeFolder: (name: string) => Promise<void>;
    /** Add a source of map-row badges. @unstable */
    registerBadges: (source: BadgeSource) => void;
    /** Every registered badge source, in registration order. @unstable */
    badgeSources: () => readonly BadgeSource[];
    /** Badges per map id, from every registered source. @unstable */
    badges: () => Map<string, MapBadge[]>;
    /** Reactive {@link Maps.badges}. @unstable */
    useBadges: () => Map<string, MapBadge[]>;
};

export type AnswerOf<K extends Answer["kind"]> = Extract<Answer, {
    kind: K;
}>;
export type Payload<T> = {
    [K in keyof T]: Exclude<keyof T, K> extends never ? T[K] : T;
}[keyof T];
export type Materialized<T> = T extends LocationList ? Location[] : T;
export type ReadResult<A extends Answer> = A extends Answer ? Materialized<Payload<Omit<A, "kind">>> : never;
declare const Query: {
    /** Ask one question about the locations `selector` matches. A full-location answer loads any
     *  backing file automatically; ask for ids or columns when full locations are unnecessary. */
    read: <A extends Ask>(selector: Selector, ask: A, target?: Target) => Promise<ReadResult<AnswerOf<A["kind"]>>>;
    /** The locations an answer carries, fetched from its temp file when it was too large to send inline. */
    locationsOf: (list: LocationList) => Promise<Location[]>;
};

declare const Mutation: {
    settle: (m: Mutation) => Promise<void>;
    run: <R extends MutationResult = MutationResult>(fn: () => Promise<R>, ...fallback: MutationResult extends R ? [empty?: R] : [empty: R]) => Promise<R>;
};

/** @unstable */
declare const SelectionList: {
    /** Tag ids with a top-level listed tag selection, including ghosted selections. @unstable */
    tagIds: () => ReadonlySet<number>;
    /** Tag ids from active selection leaves, including repeated ids and composite children. @unstable */
    tagIdsDeep: () => readonly number[];
    /** Listed selections that are not ghosted. @unstable */
    active: () => Selection[];
    /** Update and resolve the listed selections. Use `onActive` to affect only active selections. @unstable */
    update: (op: SelectionOp) => Promise<void>;
    /** Undo the last selection change without undoing data edits. @unstable */
    undo: () => Promise<void>;
    /** Redo the last undone selection change without redoing data edits. @unstable */
    redo: () => Promise<void>;
    /** @unstable */
    select: <R extends number[] | {
        ids: number[];
    }>(pick: (selector: Selector) => Promise<R>, perSelection?: boolean) => Promise<{
        picked: number;
        results: R[];
    }>;
};

declare const Autosave: {
    /** Defer autosave until the returned release function runs. Useful for batches that land many mutations. @unstable */
    hold: () => (() => void);
    /** Schedule a debounced autosave. Mutations call this automatically. @unstable */
    schedule: () => void;
    /** Cancel any pending autosave timer. @unstable */
    cancel: () => void;
    /** Wait for any in-progress save to finish. @unstable */
    waitForInflight: () => Promise<void> | null;
    /** Background auto-commit after an import with autoCommit set. @unstable */
    scheduleAutoCommit: (mapId: string, importedCount: number) => void;
    /** Save any unsaved changes now instead of waiting for the timer. @unstable */
    flush: () => Promise<void>;
};

declare const Edit: {
    /** Edit locations on the map or in a pending layer. Map changes are undoable. @unstable */
    locations: (...[target, edits, opts]: Parameters<typeof cmd.storeEdit>) => Promise<MutationResult<Location>>;
    /** Patch a map's metadata and persist it: the open map's unless the patch names an `id`. */
    meta: (patch: Omit<Parameters<typeof cmd.storeUpdateMapMeta>[0], "id"> & {
        id?: string;
    }) => Promise<void>;
    /** Edit an interned field's value records in one undoable step. */
    values: (...[field, edits]: Parameters<typeof cmd.storeEditValues>) => Promise<MutationResult<ValueRecord>>;
    /** Run `op` across every location `selector` matches, in one undoable step. @unstable */
    work: (selector: Selector, op: Work) => Promise<WorkResult>;
};

declare const Tag: {
    /** Per-tag location counts, keyed by numeric id. */
    counts: () => Record<number, number>;
    /** Tag records, including unreferenced records and generated display defaults. */
    all: () => Record<number, Tag>;
    /** Tag records referenced by at least one location. */
    visible: () => Tag[];
    /** Look up a tag record, including unreferenced tags. */
    get: (id: number) => Tag | undefined;
    /** Tag names for the given ids, skipping any that no longer resolve. */
    names: (ids: number[]) => string[];
    /** Remove tags from every location in one undoable step.
     * Unreferenced tags are hidden; undo restores them. */
    remove: (tagIds: number[]) => Promise<WorkResult>;
    /** Update tag display records in one undoable edit. */
    update: (updates: (Partial<ValueRecord> & Pick<ValueRecord, "id">)[]) => Promise<MutationResult<ValueRecord>>;
    /** Get or create tag records by name and return their ids. */
    create: (records: Omit<ValueRecord, "id">[]) => Promise<number[]>;
    /** Set tag display order from an ordered list of ids. */
    reorder: (ids: number[]) => Promise<MutationResult<ValueRecord>>;
    /** Move matching locations to a tag with the given name, optionally within a selector. */
    rename: (ids: number[], name: string, scope?: Selector | null) => Promise<void>;
    /** Get or create tag records and assign them to matching locations. */
    assign: (selector: Selector, records: Omit<ValueRecord, "id">[]) => Promise<WorkResult>;
};

declare const Location: {
    /** Add locations to the map. Real ids are assigned and written back into the passed
     *  objects - build with `createLocation` (id 0) and read `loc.id` after. Undoable. */
    add: (locs: Location[]) => Promise<void>;
    /** Clone a location in place and return the new id, or null if it doesn't exist. Undoable. */
    duplicate: (id: number) => Promise<number | null>;
    /** Remove locations by id. Undoable. */
    remove: (ids: ReadonlyIdSet) => Promise<void>;
    /** Patch locations by id. Only include the fields you're changing; `extra` merges
     *  per-key (null deletes a key). Undoable by default. */
    update: (updates: Patch<Location>[]) => Promise<void>;
    /** Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres. @unstable */
    duplicateGroups: (distance: number) => Promise<number[][]>;
};

declare const Editor: {
    VIEWER: {
        readonly kind: "pending";
        readonly name: "viewer";
    };
    /** Set the open location if `session` is still current. */
    setLocation: (location: Location | null, session: number) => void;
    /** Preview a copy of a staged-import location. The import row stays staged until Confirm. @unstable */
    openImport: (index: number) => Promise<void>;
    /** Open an arbitrary location read-only as a seen-preview: loads its pano without
     *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. @unstable */
    preview: (loc: Location) => void;
    /** Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found. */
    resolve: (m: MaybeLocation) => Promise<Location | null>;
    /** Open a location in the editor. With `checkDuplicates`, opening a spot with 2+ locations
     *  within 2m opens the duplicate-resolution panel instead. A later opening or closing
     *  supersedes one still loading. */
    open: (target: MaybeLocation, checkDuplicates?: boolean) => Promise<void>;
    /** Close the open location and return to the pane it was opened from. */
    close: () => void;
    /** Open one location from the duplicate-resolution panel in the editor. @unstable */
    openDuplicate: (loc: Location) => void;
    /** Drop a location from the duplicate-resolution panel (does not delete it). @unstable */
    removeDuplicate: (id: number) => void;
    /** Close the duplicate-resolution panel and return to the overview. @unstable */
    closeDuplicates: () => void;
    /** Transition the editor pane, enforcing state invariants:
     *  leaving "location" closes the open location, leaving "plugin" clears the plugin id. @unstable */
    setArea: (area: WorkArea) => void;
    /** Open a plugin's sidebar (switches the editor pane to "plugin"). */
    openPlugin: (pluginId: string) => void;
    /** Close the plugin sidebar and return to the overview. */
    closePlugin: () => void;
};

declare const History: {
    /** Whether a history action is available for one part or for the data edit as a whole. @unstable */
    available: (history: MapState["history"], stack: Stack, key?: EntryKey) => boolean;
    /** Undo the last edit. */
    undo: () => Promise<void>;
    /** Redo the last undone edit. */
    redo: () => Promise<void>;
};

declare const Commit: {
    /** Commit all pending changes to the map's version history. Clears the undo stack. */
    create: (message?: string) => Promise<string>;
    /** Restore a previous commit as a new revert commit and refresh the view. Clears undo/redo. @unstable */
    checkout: (commitId: string) => Promise<void>;
};

declare const Field$1: {
    /** Rename extra-field `from` to `to` across all locations, its definition, and the listed
     *  selections, in one undoable step. When a location already holds `to`, `winner` decides
     *  which value survives. Saved selections are map-independent rules and keep their names. */
    rename: (from: string, to: string, winner?: MergeWinner) => Promise<void>;
    /** Delete extra-field `key` from every location, its definition, and the listed selections,
     *  in one undoable step. */
    remove: (key: string) => Promise<void>;
};

/** Commit-diff preview state shown while `workArea === "diff"`. Position arrays are
 *  interleaved `[lng, lat]` Float32Arrays. @unstable */
export interface CommitDiffPreview {
    hash: string;
    counts: Counts;
    added: Float32Array;
    removed: Float32Array;
    updated: Float32Array;
}
/** @unstable */
declare const CommitDiff: {
    /** Whether there are uncommitted changes (adds, removes, or updates). @unstable */
    has: () => boolean;
    /** Reset the uncommitted-change counts to zero. @unstable */
    resetCounts: () => void;
    /** React hook: the uncommitted add/remove/modify counts, kept in sync with the store. @unstable */
    use: () => Counts;
    /** The current commit-diff preview, or null when not previewing. @unstable */
    preview: () => CommitDiffPreview | null;
    /** Clear commit-diff preview state. @unstable */
    reset: () => void;
    /** Pack `[lng, lat]` pairs into an interleaved Float32Array. @unstable */
    positions: (locs: LatLng[]) => Float32Array;
    /** Fetch a commit's change and overlay its added/removed/updated locations on the map,
     *  temporarily replacing the regular markers. @unstable */
    begin: (commit: CommitInfo) => Promise<void>;
    /** Leave commit-diff preview and restore the regular markers. @unstable */
    end: () => void;
};

/** Parsed-but-not-committed import shown while `workArea === "import"`. @unstable */
export interface ImportStaging {
    preview: EditorImportPreview;
}
/** @unstable */
declare const Import: {
    /** The preview marker positions for the staged import. @unstable */
    previewPositions: () => Float32Array<ArrayBufferLike>;
    /** The current staged import, or null if none. @unstable */
    staging: () => ImportStaging | null;
    /** The pending layer holding this window's staged import locations. @unstable */
    target: () => Target;
    /** Discard the staged import and its pending layer. @unstable */
    reset: () => void;
    /** Import from a file path. @unstable */
    fromPath: (path: string) => Promise<void>;
    /** Stage pasted text for preview. Throws if no locations are found. @unstable */
    paste: (text: string) => Promise<void>;
    /** Commit the staged import, optionally dropping fields and applying bulk tags. @unstable */
    confirm: (droppedFields: string[], tagNames?: string[]) => Promise<EditorImportResult | null>;
    /** Discard the staged import without committing. @unstable */
    cancel: () => void;
};

/** Pure selection transforms: build, compose, invert, rewrite, and remove selections. */

/** Selector variants with child selections. @unstable */
export type CompositeType = Extract<Selector, {
    selections: SelectionInput[];
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
/** Locations with no tags: `tags` resolves to nothing on an untagged location. @unstable */
declare const untaggedSelector: () => Selector;
/** Locations whose heading was never set. @unstable */
declare const unpannedSelector: () => Selector;
/** Locations pinned to one exact pano (the flag plus a pano id, mirroring Rust's
 *  `Selector::pano_ids`), or the locations not pinned. @unstable */
declare function panoIdSelector(on: boolean): Selector;
/** Locations holding a value for `field`. @unstable */
declare const has: (field: string) => Selector;
/** Locations holding no value for `field`. @unstable */
declare const lacks: (field: string) => Selector;
/** Locations matching every one of `selectors`; with none, every location. @unstable */
declare const all: (...selectors: Selector[]) => Selector;
/** Locations matching any of `selectors`; with none, no location. @unstable */
declare const any: (...selectors: Selector[]) => Selector;
/** Locations not matching `selector`. @unstable */
declare const not: (selector: Selector) => Selector;
/** The tag a selector names, or null when it names something else. The single place that
 *  recognises tag membership, so nothing else has to know its shape. @unstable */
declare function tagIdOf(selector: Selector): number | null;
/** What one selection type answers about itself; optional answers default at the lookup. @unstable */
export interface SelectionDescriptor<K extends Selector["type"]> {
    label(selector: Variant<Selector, K>, tagNames?: Record<number, string>): string;
}
/** Per-type descriptor for each selector variant: key derivation, display label, and optional color/location overrides. @unstable */
declare const SELECTIONS: {
    [K in Selector["type"]]: SelectionDescriptor<K>;
};
/** Every child selection a selector wraps, whatever shape it wraps them in. @unstable */
declare function childSelections<S>(selector: Selector$1<S>): S[];
/** `selector` with its children replaced, keeping the shape it wraps them in. @unstable */
declare function withChildren<S>(selector: Selector$1<S>, children: S[]): Selector$1<S>;
/** An unaddressed selection input; Rust supplies its key and default color. @unstable */
declare function selection(selector: Selector, color?: RGB): SelectionInput;
/** @unstable */
declare function buildSelection(selector: Selector): Promise<Selection>;
/** @unstable */
export type SelectionPath = readonly number[];
/** @unstable */
declare function selectionAt(rows: ListedSelection[], path: SelectionPath): Selection | undefined;
/** @unstable */
declare const addSelection: (...selectors: Selector[]) => SelectionOp;
/** @unstable */
declare const setSelections: (selections: SelectionInput[]) => SelectionOp;
/** @unstable */
declare const removeSelection: (...keys: string[]) => SelectionOp;
/** @unstable */
declare const toggleSelection: (...selectors: Selector[]) => SelectionOp;
/** @unstable */
declare const toggleManualSelection: (id: number) => SelectionOp;
/** @unstable */
declare const onActive: (op: SelectionOp) => SelectionOp;
/** @unstable */
declare const intersectSelections: (keys?: string[] | null) => SelectionOp;
/** @unstable */
declare const unionSelections: (keys?: string[] | null) => SelectionOp;
/** @unstable */
declare const invertSelections: (keys?: string[] | null) => SelectionOp;
/** @unstable */
declare const toggleGhost: (index: number) => SelectionOp;
/** @unstable */
declare const isolateGhost: (index: number) => SelectionOp;
/** @unstable */
declare const toggleGhostAll: SelectionOp;
/** @unstable */
declare const toggleInvert: (path: SelectionPath) => SelectionOp;
/** @unstable */
declare const composeSelections: (drag: SelectionPath, drop: SelectionPath, mode: GroupType) => SelectionOp;
/** @unstable */
declare const moveSelection: (from: SelectionPath, to: SelectionPath, position: "before" | "after") => SelectionOp;
/** @unstable */
declare const removeSelectionAt: (path: SelectionPath) => SelectionOp;
/** @unstable */
declare const replaceSelection: (path: SelectionPath, selector: Selector) => SelectionOp;
/** @unstable */
declare const setSelectionColor: (path: SelectionPath, color: RGB) => SelectionOp;
/** @unstable */
declare const setPolygonName: (path: SelectionPath, name: string) => SelectionOp;
/** Human-readable label for a selection. Pass `tagNames` to resolve tags by saved name
 *  rather than the open map's tags. @unstable */
declare function selectionDisplayName(sel: SelectionInput, tagNames?: Record<number, string>): string;

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
export type selectionOps_SelectionPath = SelectionPath;
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
declare const selectionOps_buildSelection: typeof buildSelection;
/** @unstable */
declare const selectionOps_childSelections: typeof childSelections;
/** @unstable */
declare const selectionOps_composeSelections: typeof composeSelections;
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
declare const selectionOps_lacks: typeof lacks;
/** @unstable */
declare const selectionOps_moveSelection: typeof moveSelection;
/** @unstable */
declare const selectionOps_not: typeof not;
/** @unstable */
declare const selectionOps_onActive: typeof onActive;
/** @unstable */
declare const selectionOps_panoIdSelector: typeof panoIdSelector;
/** @unstable */
declare const selectionOps_removeSelection: typeof removeSelection;
/** @unstable */
declare const selectionOps_removeSelectionAt: typeof removeSelectionAt;
/** @unstable */
declare const selectionOps_replaceSelection: typeof replaceSelection;
/** @unstable */
declare const selectionOps_selection: typeof selection;
/** @unstable */
declare const selectionOps_selectionAt: typeof selectionAt;
/** @unstable */
declare const selectionOps_selectionDisplayName: typeof selectionDisplayName;
/** @unstable */
declare const selectionOps_setPolygonName: typeof setPolygonName;
/** @unstable */
declare const selectionOps_setSelectionColor: typeof setSelectionColor;
/** @unstable */
declare const selectionOps_setSelections: typeof setSelections;
/** @unstable */
declare const selectionOps_tagIdOf: typeof tagIdOf;
/** @unstable */
declare const selectionOps_tagSelector: typeof tagSelector;
/** @unstable */
declare const selectionOps_toggleGhost: typeof toggleGhost;
/** @unstable */
declare const selectionOps_toggleGhostAll: typeof toggleGhostAll;
/** @unstable */
declare const selectionOps_toggleInvert: typeof toggleInvert;
/** @unstable */
declare const selectionOps_toggleManualSelection: typeof toggleManualSelection;
/** @unstable */
declare const selectionOps_toggleSelection: typeof toggleSelection;
/** @unstable */
declare const selectionOps_unionSelections: typeof unionSelections;
/** @unstable */
declare const selectionOps_unpannedSelector: typeof unpannedSelector;
/** @unstable */
declare const selectionOps_untaggedSelector: typeof untaggedSelector;
/** @unstable */
declare const selectionOps_withChildren: typeof withChildren;
declare namespace selectionOps {
  export { selectionOps_OP_LABELS as OP_LABELS, selectionOps_SELECTIONS as SELECTIONS, selectionOps_UNARY_TYPES as UNARY_TYPES, selectionOps_addSelection as addSelection, selectionOps_all as all, selectionOps_any as any, selectionOps_buildSelection as buildSelection, selectionOps_childSelections as childSelections, selectionOps_composeSelections as composeSelections, selectionOps_filterIsLocalTime as filterIsLocalTime, selectionOps_has as has, selectionOps_intersectSelections as intersectSelections, selectionOps_invertSelections as invertSelections, selectionOps_isolateGhost as isolateGhost, selectionOps_lacks as lacks, selectionOps_moveSelection as moveSelection, selectionOps_not as not, selectionOps_onActive as onActive, selectionOps_panoIdSelector as panoIdSelector, selectionOps_removeSelection as removeSelection, selectionOps_removeSelectionAt as removeSelectionAt, selectionOps_replaceSelection as replaceSelection, selectionOps_selection as selection, selectionOps_selectionAt as selectionAt, selectionOps_selectionDisplayName as selectionDisplayName, selectionOps_setPolygonName as setPolygonName, selectionOps_setSelectionColor as setSelectionColor, selectionOps_setSelections as setSelections, selectionOps_tagIdOf as tagIdOf, selectionOps_tagSelector as tagSelector, selectionOps_toggleGhost as toggleGhost, selectionOps_toggleGhostAll as toggleGhostAll, selectionOps_toggleInvert as toggleInvert, selectionOps_toggleManualSelection as toggleManualSelection, selectionOps_toggleSelection as toggleSelection, selectionOps_unionSelections as unionSelections, selectionOps_unpannedSelector as unpannedSelector, selectionOps_untaggedSelector as untaggedSelector, selectionOps_withChildren as withChildren };
  export type { selectionOps_CompositeType as CompositeType, selectionOps_FilterOpKind as FilterOpKind, selectionOps_GroupType as GroupType, selectionOps_SelectionPath as SelectionPath, selectionOps_UnaryType as UnaryType };
}

/** Selection types that cannot be saved as rules because they are bound to the open map. @unstable */
declare const MAP_LOCAL_TYPES: readonly ["Locations", "Manual", "Validation", "Reviewed", "Selected"];
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
/** Load the full rule bodies for the given `ids`. @unstable */
declare function loadSavedSelections(ids: string[]): Promise<SavedSelection[]>;
/** Every rule with its body. @unstable */
declare function loadAllSavedSelections(): Promise<SavedSelection[]>;
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
declare namespace savedSelections {
  export { savedSelections_MAP_LOCAL_TYPES as MAP_LOCAL_TYPES, savedSelections_applySavedSelection as applySavedSelection, savedSelections_deleteSavedSelection as deleteSavedSelection, savedSelections_getSavedSelectionIndex as getSavedSelectionIndex, savedSelections_isSaveable as isSaveable, savedSelections_loadAllSavedSelections as loadAllSavedSelections, savedSelections_loadSavedSelections as loadSavedSelections, savedSelections_saveCurrentSelections as saveCurrentSelections, savedSelections_savedParts as savedParts };
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
declare const hasOpenLocation: () => boolean;
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
    saveAs: {
        label: "Save as...";
        icon: string;
        group: "Map";
        aliases: string[];
        execute: () => void;
        enabled: typeof requiresMap;
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
        enabled: typeof hasOpenLocation;
    };
    undo: {
        label: "Undo";
        icon: string;
        group: "Map";
        defaultBinding: string;
        execute: () => Promise<void>;
        enabled: () => boolean;
    };
    redo: {
        label: "Redo";
        icon: string;
        group: "Map";
        defaultBinding: string;
        execute: () => Promise<void>;
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
        execute: () => Promise<void>;
        enabled: typeof hasAnySelections;
    };
    reselect: {
        label: "Undo selection change";
        aliases: string[];
        icon: string;
        group: "Selections";
        defaultBinding: string;
        execute: () => Promise<void>;
        enabled: () => boolean;
    };
    "redo-selection": {
        label: "Redo selection change";
        icon: string;
        group: "Selections";
        defaultBinding: string;
        execute: () => Promise<void>;
        enabled: () => boolean;
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
    /** Ids of map-row badge sources that are hidden. @unstable */
    hiddenMapBadges: string[];
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
    /** Ids of map-row badge sources that are hidden. */
    hiddenMapBadges: string[];
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

/** What the selector picker offers. Not a location set -- `selectorForPick` turns it
 *  into a `Selector`. */
export type SelectorPick = {
    pick: "all";
} | {
    pick: "selection";
};
export interface SelectorPickController {
    /** The picked locations. Hand it straight to any `Selector` consumer. */
    selector: Selector;
    /** The picker's own state. Persist this, not `selector`: it tracks the live selection. */
    choice: SelectorPick;
    setChoice(c: SelectorPick): void;
    allCount: number;
    selectionCount: number;
}
/** Convert a picker choice into the corresponding `Selector`. @unstable */
declare function selectorForPick(choice: SelectorPick): Selector;
/** React hook: selector state with live counts. Defaults to the current selection when one
 *  exists, else all locations. Use `createSelectorPick` when non-React code also reads the selector. @unstable */
declare function useSelectorPick(initial?: SelectorPick): SelectorPickController;
/** A standalone selector store that can be read from both React and non-React code.
 *  Each `createSelectorPick` call returns an isolated instance. @unstable */
export interface SelectorPickHandle {
    get(): Selector;
    getChoice(): SelectorPick;
    set(choice: SelectorPick): void;
    subscribe(listener: () => void): () => void;
    /** React view of this handle: re-renders on change, with live counts. */
    use(): SelectorPickController;
}
/** A standalone "all locations vs current selection" switch, for features that operate on a subset. @unstable */
declare function createSelectorPick(initial?: SelectorPick): SelectorPickHandle;

/** @unstable */
export type picker_SelectorPick = SelectorPick;
/** @unstable */
export type picker_SelectorPickController = SelectorPickController;
/** @unstable */
export type picker_SelectorPickHandle = SelectorPickHandle;
/** @unstable */
declare const picker_createSelectorPick: typeof createSelectorPick;
/** @unstable */
declare const picker_selectorForPick: typeof selectorForPick;
/** @unstable */
declare const picker_useSelectorPick: typeof useSelectorPick;
declare namespace picker {
  export { picker_createSelectorPick as createSelectorPick, picker_selectorForPick as selectorForPick, picker_useSelectorPick as useSelectorPick };
  export type { picker_SelectorPick as SelectorPick, picker_SelectorPickController as SelectorPickController, picker_SelectorPickHandle as SelectorPickHandle };
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
/** @unstable */
export type ReviewMode = "reviewed" | "unreviewed";
/** The session's locations in `mode`: those reviewed, or those still to review. @unstable */
declare function reviewSet(s: ReviewSession, mode: ReviewMode): number[];
/** Union of reviewed ids across sessions, de-duplicated. @unstable */
declare function reviewedHistoryIds(sessions: ReviewSession[]): number[];
/** True when the cursor is on the session's first location. @unstable */
declare function isAtStart(s: ReviewSession): boolean;
/** True when the cursor is on the session's last location. @unstable */
declare function isAtEnd(s: ReviewSession): boolean;
/** Current cursor location is in the reviewed set. @unstable */
declare function isCurrentReviewed(s: ReviewSession): boolean;
/** Reactive active review session, or null. @unstable */
declare function useReviewSession(): ReviewSession | null;
/** The active review session, or null. @unstable */
declare function getReviewSession(): ReviewSession | null;
/** Start or resume a review over `ids`. When `source` is a selection, re-reviewing
 *  that selection resumes any in-progress session for it. @unstable */
declare function beginReview(ids: number[], source?: Selection): Promise<void>;
/** Review the selected locations. With one active selection, the review belongs to it and
 *  resumes with it. @unstable */
declare function reviewSelected(): Promise<void>;
/** Resume a session picked from the resume modal. @unstable */
declare function resumeReview(s: ReviewSession): Promise<void>;
/** Mark the current location reviewed and step to the next one. @unstable */
declare function reviewNext(): Promise<void>;
/** Step back to the previous location in the session. @unstable */
declare function reviewPrev(): Promise<void>;
/** Delete the current location and advance to the next one. Exits the pass if it
 *  was the last item. @unstable */
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
/** The locations of review session `s` that are reviewed, or still to review. @unstable */
declare function reviewSetSelector(s: ReviewSession, mode: ReviewMode): Selector;

/** @unstable */
export type review_PruneResult = PruneResult;
/** @unstable */
export type review_ReviewMode = ReviewMode;
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
declare const review_isAtEnd: typeof isAtEnd;
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
declare const review_reviewSelected: typeof reviewSelected;
/** @unstable */
declare const review_reviewSet: typeof reviewSet;
/** @unstable */
declare const review_reviewSetSelector: typeof reviewSetSelector;
/** @unstable */
declare const review_reviewedHistoryIds: typeof reviewedHistoryIds;
/** @unstable */
declare const review_selectReviewedHistory: typeof selectReviewedHistory;
/** @unstable */
declare const review_useReviewSession: typeof useReviewSession;
declare namespace review {
  export { review_advance as advance, review_beginReview as beginReview, review_cancelReview as cancelReview, review_deleteSession as deleteSession, review_getReviewSession as getReviewSession, review_isAtEnd as isAtEnd, review_isAtStart as isAtStart, review_isCurrentReviewed as isCurrentReviewed, review_listSessions as listSessions, review_positionOf as positionOf, review_pruneSession as pruneSession, review_renameReview as renameReview, review_resumeReview as resumeReview, review_retreat as retreat, review_reviewDelete as reviewDelete, review_reviewIndex as reviewIndex, review_reviewNext as reviewNext, review_reviewPrev as reviewPrev, review_reviewSelected as reviewSelected, review_reviewSet as reviewSet, review_reviewSetSelector as reviewSetSelector, review_reviewedHistoryIds as reviewedHistoryIds, review_selectReviewedHistory as selectReviewedHistory, review_useReviewSession as useReviewSession };
  export type { review_PruneResult as PruneResult, review_ReviewMode as ReviewMode };
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
    sidecarVersion: string | null;
}
/** The newest build of a plugin this app version can run. Falls back through older
 *  pinned builds when the latest is incompatible. Null when none fit. @unstable */
declare function resolveBuild(entry: PluginManifest, appVersion: string): ResolvedBuild | null;
/** True when the installed plugin or its sidecar should be refreshed to `target`. @unstable */
declare function needsBuildUpdate(installedVersion: string | undefined, target: ResolvedBuild, installedSidecarVersion: string | null | undefined): boolean;
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
/** A plugin's store in the open map. Writes resolve once they are saved. */
export interface MapPluginStorage {
    get<T = unknown>(key: string, fallback?: T): T;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    keys(): string[];
}
/** Persistent key-value storage namespaced to a plugin. Survives restarts. */
declare function storage(id: string): PluginStorage;
/** Persistent key-value storage a plugin keeps with the open map, so every map has its own.
 *  Throws when no map is open. */
declare function mapStorage(id: string): MapPluginStorage;
/** Re-read a plugin's store after another window wrote it. @unstable */
declare function reloadStorage(id: string): void;
/** React state hook backed by the plugin's persistent store. Survives sidebar
 *  unmount and app restart. Values are global, not per-map. */
declare function usePluginState<T>(pluginId: string, key: string, initial: T | (() => T)): readonly [T, (action: SetStateAction<T>) => void];

/** @unstable */
export type pluginStorage_MapPluginStorage = MapPluginStorage;
/** @unstable */
export type pluginStorage_PluginStorage = PluginStorage;
declare const pluginStorage_mapStorage: typeof mapStorage;
/** @unstable */
declare const pluginStorage_reloadStorage: typeof reloadStorage;
declare const pluginStorage_storage: typeof storage;
declare const pluginStorage_usePluginState: typeof usePluginState;
declare namespace pluginStorage {
  export { pluginStorage_mapStorage as mapStorage, pluginStorage_reloadStorage as reloadStorage, pluginStorage_storage as storage, pluginStorage_usePluginState as usePluginState };
  export type { pluginStorage_MapPluginStorage as MapPluginStorage, pluginStorage_PluginStorage as PluginStorage };
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

export interface SidecarOptions<T> {
    /** Fires once per JSON object the sidecar emits, in order. */
    onLine?(item: T): void;
    /** Sidecar diagnostic output, one-shot runs only. */
    onLog?(line: string): void;
    signal?: AbortSignal;
}
/** Send a command to a plugin's sidecar and resolve with its last emitted JSON
 *  object (null if it emitted none). `payload` is sent as JSON. */
declare function request$1<T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T>): Promise<T | null>;
/** The sidecar version installed for a plugin, or null when it has none yet. */
declare function installedVersion$1(pluginId: string): Promise<string | null>;
/** The nested `sidecar` namespace on the plugin surface. */
declare const sidecar: {
    request: typeof request$1;
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

/** Standard right-hand sidebar chrome (title, back button, scrollable body, pinned footer). Use for plugin sidebars. */
declare function Sidebar({ title, onBack, actions, className, flush, footer, children, }: {
    title: ReactNode;
    onBack?: () => void;
    actions?: ReactNode;
    className?: string;
    flush?: boolean;
    /** Stays pinned below the body while it scrolls, for the sidebar's main actions. */
    footer?: ReactNode;
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
    /** Render the dropdown in a body portal, anchored to the input and following it as it
     *  moves, so it floats over clipping ancestors like `.modal__content`. Clicks on it are
     *  exempted from dialog outside-dismissal via the `suggest-portal` class (see DialogContent). */
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

/** @unstable */
export interface EnrichFieldOption {
    key: string;
    label: string;
    /** Excluded from the default field set (null enrichFields); user must opt in. */
    defaultOff?: boolean;
}
/** Build field definitions for well-known keys (e.g. `"altitude"`, `"countryCode"`). */
declare function knownFieldDefs(...keys: string[]): Record<string, FieldDef>;
/** All enrichment field options: the core fields, then every registered provider's own fields. @unstable */
declare function getEnrichFieldOptions(): EnrichFieldOption[];
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
    /** Extra-field keys this provider produces. Each is offered as an enrichment option. @unstable */
    fieldDefs?: Record<string, FieldDef>;
    /** Leaves this provider's fields out of the default enrichment set, so users opt in. @unstable */
    defaultOff?: boolean;
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

/** @unstable */
export type fieldDefs_EnrichFieldOption = EnrichFieldOption;
/** @unstable */
export type fieldDefs_ProcedureSpec<TCollected = unknown, TConfig = unknown> = ProcedureSpec<TCollected, TConfig>;
/** @unstable */
export type fieldDefs_Provider<TCollected = unknown, TConfig = unknown> = Provider<TCollected, TConfig>;
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
declare const fieldDefs_registerProvider: typeof registerProvider;
declare namespace fieldDefs {
  export { fieldDefs_getAllEnrichKeys as getAllEnrichKeys, fieldDefs_getDefaultEnrichKeys as getDefaultEnrichKeys, fieldDefs_getEnrichFieldOptions as getEnrichFieldOptions, fieldDefs_getProviderForField as getProviderForField, fieldDefs_getProviders as getProviders, fieldDefs_isFieldEnabled as isFieldEnabled, fieldDefs_knownFieldDefs as knownFieldDefs, fieldDefs_registerProvider as registerProvider };
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
/** Every listable built-in, and every field this map defines. @unstable */
declare function getFieldKeys(): string[];
/** Keys this map defines a field for. Same reference until the user layer moves. */
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
/** @unstable */
declare const fieldDefRegistry_getFieldKeys: typeof getFieldKeys;
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
    fieldDefRegistry_getFieldKeys as getFieldKeys,
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
/** One location's answer from a `collect` run. @unstable */
export interface CollectedEntry<T = unknown> {
    id: number;
    value: T;
}
/** @unstable */
export interface BatchOutcome {
    /** Count of locations the procedure processed successfully. */
    succeeded: number;
    /** IDs of locations the procedure failed on. */
    failed: number[];
}
/** @unstable */
export interface ProcedureOutcome<TCollected = unknown> extends BatchOutcome {
    /** Answers from a `collect` run, in page order. Absent when results were written as patches. */
    collected?: CollectedEntry<TCollected>[];
}
/** Every declaration a run scheduled, by provider id. @unstable */
export type ProviderOutcomes = Record<string, ProcedureOutcome>;
/** @unstable */
declare const noWork: () => BatchOutcome;
/** One provider's own progress. Counts are net of skipped locations. @unstable */
export interface ProviderPart {
    label: string;
    done: number;
    total: number;
    failed: number;
    finished: boolean;
}
/** @unstable */
export interface RunOpts {
    signal?: AbortSignal;
    force?: boolean;
    /** Read locations and write results at this target instead of the map. */
    on?: Target;
    /** `done`/`total` reflect the slowest provider. `parts` carries each labeled
     *  provider's own counts, ordered as declared. */
    onProgress?: (done: number, total: number, parts: ProviderPart[]) => void;
    /** Each location as a provider finishes with it (locations-only runs). The same location arrives
     *  again from each subsequent provider. */
    onPartial?: (rows: Location[]) => void;
}
/** @unstable */
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
/** Run a set of providers over the locations `selector` matches and write their results back.
 *  Resolves once every provider finishes, or on abort. @unstable */
declare function runProviders<C extends readonly unknown[]>(items: {
    [K in keyof C]: ProviderRun<C[K]>;
}, selector: Selector, opts?: RunOpts): Promise<ProviderOutcomes>;
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

/** Fetch a page of the seen (visited-panorama) history. @unstable */
declare function getSeenEntries(limit?: number, offset?: number, filter?: SeenFilter, thumbnails?: boolean): Promise<SeenEntry[]>;
/** Number of seen entries matching the filter (all when omitted). @unstable */
declare function getSeenCount(filter?: SeenFilter): Promise<number>;
/** Distinct country codes that appear in the seen history. @unstable */
declare function getSeenCountries(): Promise<string[]>;
/** Maps that have seen-history entries. @unstable */
declare function getSeenMaps(): Promise<SeenMapInfo[]>;
/** Delete the entire seen history. Not undoable. @unstable */
declare function clearSeen(): Promise<void>;

/** @unstable */
declare const seen_clearSeen: typeof clearSeen;
/** @unstable */
declare const seen_getSeenCount: typeof getSeenCount;
/** @unstable */
declare const seen_getSeenCountries: typeof getSeenCountries;
/** @unstable */
declare const seen_getSeenEntries: typeof getSeenEntries;
/** @unstable */
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

/** @unstable */
declare function enrich(selector: Selector, { resolve, ...opts }?: RunOpts & {
    resolve?: boolean;
}): Promise<ProviderOutcomes>;

/** @unstable */
declare const enrich$1_enrich: typeof enrich;
declare namespace enrich$1 {
  export {
    enrich$1_enrich as enrich,
  };
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

/** How a bulk pin settles each location's pano before pinning it. @unstable */
export interface PinOpts extends BulkOpts {
    /** Resolve pano ids first; off, only locations that already carry one are pinned. */
    resolve?: boolean;
    /** Move each resolved pano to this capture of its timeline. */
    capture?: CapturePick | null;
    /** Re-resolve already pinned locations too. */
    force?: boolean;
}
/** What a bulk pin did: the locations newly pinned, the ones whose pano could not be
 *  resolved, and how many pano ids the resolve wrote. @unstable */
export interface PinOutcome extends BatchOutcome {
    resolved: number;
}
/** Pin every location in the selector to its pano id, resolving pano ids first when asked. @unstable */
declare function bulkPinToPano(selector: Selector, opts?: PinOpts): Promise<PinOutcome>;

/** @unstable */
export type pinPano_PinOpts = PinOpts;
/** @unstable */
export type pinPano_PinOutcome = PinOutcome;
/** @unstable */
declare const pinPano_bulkPinToPano: typeof bulkPinToPano;
declare namespace pinPano {
  export { pinPano_bulkPinToPano as bulkPinToPano };
  export type { pinPano_PinOpts as PinOpts, pinPano_PinOutcome as PinOutcome };
}

/** Configuration for Street View validation: the radius of the coordinate lookup. @unstable */
export interface ValidateConfig {
    radius: number;
}
/** What a validation run answered: the ids in each asked-for category that any location
 *  fell into, keyed by category in table order, over the outcome every run reports. @unstable */
export interface ValidationOutcome extends BatchOutcome {
    categories: Map<string, number[]>;
}
/** Check that each location's Street View coverage still exists, grouping the locations
 *  into `categories` (keys of `VALIDATION_CATEGORIES`; the standard ones when omitted). @unstable */
declare function validateLocations(selector: Selector, opts?: BulkOpts & {
    config?: Partial<ValidateConfig>;
    categories?: readonly string[];
}): Promise<ValidationOutcome>;

/** @unstable */
export type validate_ValidateConfig = ValidateConfig;
/** @unstable */
export type validate_ValidationOutcome = ValidationOutcome;
/** @unstable */
declare const validate_validateLocations: typeof validateLocations;
declare namespace validate {
  export { validate_validateLocations as validateLocations };
  export type { validate_ValidateConfig as ValidateConfig, validate_ValidationOutcome as ValidationOutcome };
}

/** What validation answers for one location: its `ValidationFlag`s, and whether it was
 *  pinned when checked. @unstable */
export interface ValidationAnswer {
    flags: number;
    pinned: boolean;
}
/** A group of validated locations a user can ask for: a single flag, or a combination of
 *  flags and pinned state. @unstable */
export interface ValidationCategory {
    key: string;
    label: string;
    /** Asked for unless the user says otherwise. */
    standard: boolean;
    test: (answer: ValidationAnswer) => boolean;
}
/** @unstable */
declare const VALIDATION_CATEGORIES: readonly ValidationCategory[];
/** @unstable */
declare const STANDARD_VALIDATION_CATEGORIES: string[];
/** The category a key names, or null for one this version does not know. @unstable */
declare function validationCategory(key: string): ValidationCategory | null;

/** @unstable */
declare const validationCategories_STANDARD_VALIDATION_CATEGORIES: typeof STANDARD_VALIDATION_CATEGORIES;
/** @unstable */
declare const validationCategories_VALIDATION_CATEGORIES: typeof VALIDATION_CATEGORIES;
/** @unstable */
export type validationCategories_ValidationAnswer = ValidationAnswer;
/** @unstable */
export type validationCategories_ValidationCategory = ValidationCategory;
/** @unstable */
declare const validationCategories_validationCategory: typeof validationCategory;
declare namespace validationCategories {
  export { validationCategories_STANDARD_VALIDATION_CATEGORIES as STANDARD_VALIDATION_CATEGORIES, validationCategories_VALIDATION_CATEGORIES as VALIDATION_CATEGORIES, validationCategories_validationCategory as validationCategory };
  export type { validationCategories_ValidationAnswer as ValidationAnswer, validationCategories_ValidationCategory as ValidationCategory };
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
export type query$1_SearchOpts = SearchOpts;
declare const query$1_panosAt: typeof panosAt;
declare const query$1_svMetadata: typeof svMetadata;
declare namespace query$1 {
  export { query$1_panosAt as panosAt, query$1_svMetadata as svMetadata };
  export type { query$1_SearchOpts as SearchOpts };
}

/** @unstable */
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
    selectedOpacity: number;
    selectedVisible: boolean;
    markerSize: number;
    showPerfectScoreCircle: boolean;
    showSearchRadiusCursor: boolean;
    showPreviews: boolean;
    clickMode: ClickMode;
}
/** What clicking empty map does: create a location, nothing, or snap to the nearest one. @unstable */
export type ClickMode = "default" | "selectOnly" | "nearest";

/** @unstable */
export interface MapStyle {
    featureType?: string;
    elementType?: string;
    stylers: Record<string, any>[];
}

/** @unstable */
export interface CustomStyle {
    name: string;
    style: MapStyle[];
}

/** @unstable */
export interface HostInstances {
    google: google.maps.Map;
    maplibre: maplibregl.Map;
}
/** @unstable */
export type MapHostKind = keyof HostInstances;
/** @unstable */
export interface DeckOverlayProps {
    layers: Layer[];
    onClick?: (info: PickingInfo, domEvent?: Event) => void;
    onHover?: (info: PickingInfo, domEvent?: Event) => void;
    onError?: (e: unknown) => void;
}
/** @unstable */
export interface DeckOverlayHandle {
    setProps(props: Partial<DeckOverlayProps>): void;
    finalize(): void;
}
/** @unstable */
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
/** @unstable */
export interface BasemapOpts {
    customStyles: CustomStyle[];
}
/** @unstable */
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
/** @unstable */
export type MapHost = {
    [K in MapHostKind]: MapHostContract<K>;
}[MapHostKind];

/** Set or clear the main editor map host. @unstable */
declare function setMapHost(host: MapHost | null): void;
/** Return the main editor map host, or null if not mounted. @unstable */
declare function getMapHost(): MapHost | null;
/** Wait for the main editor map to be ready. @unstable */
declare function waitForMapHost(): Promise<MapHost>;
/** Fit the editor map's viewport to `bounds`. A `minExtent` prevents over-zoom on tiny areas. @unstable */
declare function fitMapToBounds(bounds: Bounds | null, padding?: number, minExtent?: number): void;
/** @unstable */
export type ClickInterceptor = (lat: number, lng: number, shiftKey: boolean) => boolean;
/** Register a map-click interceptor. Returns a removal function. The most recently
 *  added interceptor that returns true consumes the click. @unstable */
declare function addClickInterceptor(fn: ClickInterceptor): () => void;
/** Run registered click interceptors (newest first). True if one consumed the click. @unstable */
declare function tryInterceptClick(lat: number, lng: number, shiftKey?: boolean): boolean;
/** @unstable */
export type DrawInterceptor = (rings: number[][][]) => boolean;
/** Set the callback for completed polygon draws. Null clears it. @unstable */
declare function setDrawInterceptor(fn: DrawInterceptor | null): void;
/** Pass completed polygon rings to the draw interceptor. True if it consumed them. @unstable */
declare function tryInterceptDraw(rings: number[][][]): boolean;

/** @unstable */
declare const mapState_addClickInterceptor: typeof addClickInterceptor;
/** @unstable */
declare const mapState_fitMapToBounds: typeof fitMapToBounds;
/** @unstable */
declare const mapState_getMapHost: typeof getMapHost;
/** @unstable */
declare const mapState_setDrawInterceptor: typeof setDrawInterceptor;
/** @unstable */
declare const mapState_setMapHost: typeof setMapHost;
/** @unstable */
declare const mapState_tryInterceptClick: typeof tryInterceptClick;
/** @unstable */
declare const mapState_tryInterceptDraw: typeof tryInterceptDraw;
/** @unstable */
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

/** An [r, g, b, a] byte tuple. @unstable */
export type RGBA = [...RGB, number];
/** Hue in degrees, saturation and lightness in percent. @unstable */
export type HSL = {
    h: number;
    s: number;
    l: number;
};
/** Parse "#rrggbb" or "#rgb" to an [r, g, b] byte tuple; black when it is not hex. @unstable */
declare function hexToRgb(hex: string): RGB;
/** Return "#000" or "#fff" for readable text on the given hex background. @unstable */
declare function textColorFor(bg: string): string;
/** Resolve an SV coverage color to hex. Accepts "#rrggbb" or a CSS custom-property
 *  ramp name (legacy stored format). @unstable */
declare function resolveSvColorHex(color: string): string;
/** Set the app's `--accent` and `--on-accent` CSS custom properties from a hex color. @unstable */
declare function applyAccentColor(hex: string): void;
/** Convert "#rrggbb" to HSL. @unstable */
declare function hexToHsl(hex: string): HSL;
/** Convert HSL to "#rrggbb". @unstable */
declare function hslToHex({ h, s, l }: HSL): string;
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
declare function rgbToHex(rgb: RGB): string;
/** A label's color: a user override if set, else a deterministic color from its name. @unstable */
declare function labelColor(name: string, overrides: Record<string, string>): string;

/** @unstable */
export type colorUtils_HSL = HSL;
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
  export type { colorUtils_HSL as HSL, colorUtils_RGBA as RGBA };
}

/** The shared scene that all map surfaces render from. @unstable */
declare function getScene(): CellManager;
/** Set the default marker color (RGB bytes). @unstable */
declare function setMarkerDefaultColor(r: number, g: number, b: number): void;
/** Change the default marker color and repaint. @unstable */
declare function recolorScene(mc: RGB): void;
/** Current default marker color as RGBA. @unstable */
declare function getMarkerDefaultColor(): RGBA;
/**
 * Resolves once the scene has applied the frame for map version `version`, with what that
 * frame did. Resolves at once, with nothing applied, when the scene follows no map.
 * @unstable
 */
declare function sceneReached(version: number): Promise<FrameSummary>;
/** Resolves when the most recently started full scene load has finished (or immediately if none is in flight). @unstable */
declare function whenSceneSettled(): Promise<void>;
/** Load the whole scene again and follow every change to it from there. @unstable */
declare function loadScene(markerStyle?: MarkerStyle, mc?: RGB): Promise<void>;
/** Clear all marker data from the scene and stop following the map. @unstable */
declare function clearScene(): void;
/** Start following open-location changes. Returns a stop function. @unstable */
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
declare const sceneStore_sceneReached: typeof sceneReached;
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
    sceneStore_sceneReached as sceneReached,
    sceneStore_setMarkerDefaultColor as setMarkerDefaultColor,
    sceneStore_startSceneEngine as startSceneEngine,
    sceneStore_whenSceneSettled as whenSceneSettled,
  };
}

/** Snapshot of every rendered location's id and position (`[lng, lat, ...]`). @unstable */
declare function getScenePositions(): {
    ids: Uint32Array;
    positions: Float32Array;
};

/** @unstable */
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
/** @deprecated v0.8.2. Read `MMA.Store.get().map`. @unstable */
declare function getCurrentMap(): MapMeta | null;
/** @deprecated v0.8.2. Read `MMA.Store.get().mapId`. @unstable */
declare function getCurrentMapId(): string | null;
/** @deprecated v0.8.2. Read `MMA.Store.get().open?.location`. @unstable */
declare function getActiveLocation(): Location | null;
/** @deprecated v0.8.2. Read `MMA.Store.get().selectedLocationIds`. @unstable */
declare function getSelectedLocationIds(): SelectedIds;
/** @deprecated v0.8.2. Read `MMA.Store.get().workArea`. @unstable */
declare function getWorkArea(): WorkArea;
/** @deprecated v0.8.2. Read `MMA.Store.get().selectionList`. @unstable */
declare function getAllSelections(): Selection[];
/** @deprecated v0.8.2. Read `MMA.Store.get().selectionList`. @unstable */
declare function getGhostedSelections(): Set<string>;
/** @deprecated v0.8.2. Use `MMA.SelectionList.active()`. @unstable */
declare function getSelections(): Selection[];
/** @deprecated v0.8.2. Ask `MMA.Query.read` for the summary and take `dirtyCount`. @unstable */
declare function getDirtyCount(): Promise<number>;
/** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Locations", locations: [id], name: null }, { kind: "locations" })`. @unstable */
declare function fetchLocation(id: number): Promise<Location>;
/** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Locations", locations: ids, name: null }, { kind: "locations" })`. @unstable */
declare function fetchLocationsByIds(ids: number[]): Promise<Location[]>;
/** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Everything" }, { kind: "locations" })`. @unstable */
declare function fetchAllLocations(): Promise<Location[]>;
/** @deprecated v0.10.2. Use `MMA.Query.read(selector, { kind: "coverage" })`. @unstable */
declare function fieldCoverage(selector: Selector): Promise<[string, number][]>;
/** @deprecated v0.10.2. Use `MMA.registerProvider()`. @unstable */
declare function registerEnrichmentProvider(provider: Provider): void;
/** @deprecated v0.10.5. The user layer is Rust-owned state (`MMA.Store.get().fieldDefs`);
 *  use `MMA.Edit.meta({ extra: { fields } })` to change it, or `MMA.registerPluginFieldDefs()`
 *  for plugin-owned defs. @unstable */
declare function setUserFieldDefs(fields: Record<string, FieldDef>): Promise<void>;
/** @deprecated v0.10.5. Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [tagId], remove: [] })`. @unstable */
declare function addTagToLocations(tagId: number, locationIds: number[]): Promise<WorkResult>;
/** @deprecated v0.10.5. Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. @unstable */
declare function removeTagFromLocations(tagId: number, locationIds: number[]): Promise<WorkResult>;
/** @deprecated v0.10.5. Use `MMA.Edit.work(MMA.tagSelector(tagId), { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. @unstable */
declare function removeTagFromAllLocations(tagId: number): Promise<WorkResult>;
/** @deprecated v0.11.0. Use `MMA.storage()`. @unstable */
declare function createPluginStorage(id: string): PluginStorage;
/** @deprecated v0.11.0. Use `MMA.sidecar.request()`. @unstable */
declare function request<T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T>): Promise<T | null>;
/** @deprecated v0.11.0. Use `MMA.sidecar.installedVersion()`. @unstable */
declare function installedVersion(pluginId: string): Promise<string | null>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "ids" })`. @unstable */
declare function resolveIds(selector: Selector): Promise<number[]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "count" })`. @unstable */
declare function countIn(selector: Selector): Promise<number>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "bounds" })`. @unstable */
declare function fetchBounds(selector: Selector): Promise<[number, number, number, number] | null>;
/** @deprecated v0.11.3. Use `MMA.Query.read({ type: "Sample", selection: MMA.selection(selector), n }, { kind: "ids" })`. @unstable */
declare function sampleFrom(selector: Selector, n: number): Promise<number[]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "values", field })`. @unstable */
declare function fieldValues(selector: Selector, field: string): Promise<string[]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "countBy", fields: [field], key })`. @unstable */
declare function countBy(selector: Selector, field: string, key: KeySpec): Promise<CountBy>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "coverage" })`. @unstable */
declare function coverage(selector: Selector): Promise<[string, number][]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "columns", fields })`. @unstable */
declare function fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "groupBy", field, key })`. @unstable */
declare function partition(field: string, key: KeySpec, selector: Selector): Promise<PartitionBucket[]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "locations" })`. @unstable */
declare function fetchLocations(selector: Selector): Promise<Location[]>;
/** @deprecated v0.11.3. A provider's `fieldDefs` are offered as enrichment options on their
 *  own; set `defaultOff` on the provider to make them opt-in. @unstable */
declare function registerEnrichFields(_fields: EnrichFieldOption[]): void;
/** @deprecated v0.11.3. Use `MMA.SelectionList.update(MMA.addSelection(...selectors))`. @unstable */
declare function addSelections(selectors: Selector[]): Promise<void>;
/** @deprecated v0.11.3. Use `MMA.SelectionList.update(MMA.removeSelection(...keys))`. @unstable */
declare function removeSelections(keys: string[]): Promise<void>;
/** @deprecated v0.11.3. Use `MMA.SelectionList.update({ kind: "set", selections: [] })`. @unstable */
declare function resetSelections(): Promise<void>;
/** @deprecated v0.11.7. Use the `{ type: "Selected" }` selector. @unstable */
declare function currentSelection(): Selector;
/** @deprecated v0.12.0. Use MMA.Query.read(selector, ask) instead. @unstable */
declare function query(selector: Selector, target?: Target): {
    /** Resolved ids in ascending order, or in ranked-selector order. */
    ids: () => Promise<number[]>;
    /** Number of locations the selector resolves to. */
    count: () => Promise<number>;
    /** Bounding box [west, south, east, north], or null when nothing resolves. */
    bounds: () => Promise<[number, number, number, number] | null>;
    /** n ids drawn uniformly at random, without replacement. */
    sample: (n: number) => Promise<number[]>;
    /** Distinct values of field, sorted. */
    values: (field: string) => Promise<string[]>;
    /** Group each field by a derived key and count, one result per field. */
    countBy: (fields: string[], key: KeySpec) => Promise<CountBy[]>;
    /** How many locations hold a value for each field, key-sorted. */
    coverage: () => Promise<[string, number][]>;
    /** One column per field: null for missing values and tag-id arrays for tags. */
    columns: (fields: string[]) => Promise<unknown[][]>;
    /** Group by a derived key; bins use bound order and other keys sort naturally. */
    partition: (field: string, key: KeySpec) => Promise<PartitionBucket[]>;
    /** Full matching locations, loading any large result from its temporary file. */
    locations: () => Promise<Location[]>;
};
/** @deprecated v0.12.0. Use `MMA.Editor.open(target)`, or `MMA.Editor.close()` in place of null. @unstable */
declare function setActiveLocation(target: MaybeLocation | null, checkDuplicates?: boolean): Promise<void>;
/** @deprecated v0.12.1. Use `MMA.Store.get`. */
declare const getMapState: typeof Store.get;
/** @deprecated v0.12.1. Use `MMA.Store.use`. */
declare const useMapState: typeof Store.use;
/** @deprecated v0.12.1. Use `MMA.Store.setMeta`. @unstable */
declare const setMap: typeof Store.setMeta;
/** @deprecated v0.12.1. Use `MMA.Store.setSelected`. @unstable */
declare const setSelectedLocationIds: typeof Store.setSelected;
/** @deprecated v0.12.1. Use `MMA.Tag.counts`. */
declare const getTagCounts: typeof Tag.counts;
/** @deprecated v0.12.1. Use `MMA.Tag.all`. */
declare const getTags: typeof Tag.all;
/** @deprecated v0.12.1. Use `MMA.Tag.visible`. */
declare const getVisibleTags: typeof Tag.visible;
/** @deprecated v0.12.1. Use `MMA.Tag.get`. */
declare const getTag: typeof Tag.get;
/** @deprecated v0.12.1. Use `MMA.Tag.names`. */
declare const tagIdsToNames: typeof Tag.names;
/** @deprecated v0.12.1. Use `MMA.Tag.remove`. */
declare const deleteTags: typeof Tag.remove;
/** @deprecated v0.12.1. Use `MMA.Mutation.run`. */
declare const mutate: typeof Mutation.run;
/** @deprecated v0.12.1. Use `MMA.Mutation.settle`. */
declare const settled: typeof Mutation.settle;
/** @deprecated v0.12.1. Use `MMA.Query.read`. */
declare const read: typeof Query.read;
/** @deprecated v0.12.1. Use `MMA.Query.locationsOf`. */
declare const locationsOf: typeof Query.locationsOf;
/** @deprecated v0.12.1. Use `MMA.Location.add`. */
declare const addLocations: typeof Location.add;
/** @deprecated v0.12.1. Use `MMA.Location.duplicate`. */
declare const duplicateLocation: typeof Location.duplicate;
/** @deprecated v0.12.1. Use `MMA.Location.remove`. */
declare const removeLocations: typeof Location.remove;
/** @deprecated v0.12.1. Use `MMA.Location.update`. */
declare const updateLocations: typeof Location.update;
/** @deprecated v0.12.1. Use `MMA.Location.duplicateGroups`. @unstable */
declare const previewDuplicateGroups: typeof Location.duplicateGroups;
/** @deprecated v0.12.1. Use `MMA.Editor.setLocation`. */
declare const setOpenLocation: typeof Editor.setLocation;
/** @deprecated v0.12.1. Use `MMA.Editor.openImport`. @unstable */
declare const openStagedLocation: typeof Editor.openImport;
/** @deprecated v0.12.1. Use `MMA.Editor.preview`. @unstable */
declare const previewLocation: typeof Editor.preview;
/** @deprecated v0.12.1. Use `MMA.Editor.resolve`. */
declare const resolveLocation: typeof Editor.resolve;
/** @deprecated v0.12.1. Use `MMA.Editor.open`. */
declare const openLocation: typeof Editor.open;
/** @deprecated v0.12.1. Use `MMA.Editor.close`. */
declare const closeLocation: typeof Editor.close;
/** @deprecated v0.12.1. Use `MMA.Editor.openDuplicate`. @unstable */
declare const openDuplicateLocation: typeof Editor.openDuplicate;
/** @deprecated v0.12.1. Use `MMA.Editor.removeDuplicate`. @unstable */
declare const removeDuplicate: typeof Editor.removeDuplicate;
/** @deprecated v0.12.1. Use `MMA.Editor.closeDuplicates`. @unstable */
declare const closeDuplicates: typeof Editor.closeDuplicates;
/** @deprecated v0.12.1. Use `MMA.Editor.setArea`. @unstable */
declare const setWorkArea: typeof Editor.setArea;
/** @deprecated v0.12.1. Use `MMA.Editor.openPlugin`. */
declare const setPluginMode: typeof Editor.openPlugin;
/** @deprecated v0.12.1. Use `MMA.Editor.closePlugin`. */
declare const exitPluginMode: typeof Editor.closePlugin;
/** @deprecated v0.12.1. Use `MMA.Field.rename`. */
declare const renameField: typeof Field$1.rename;
/** @deprecated v0.12.1. Use `MMA.Field.remove`. */
declare const deleteField: typeof Field$1.remove;
/** @deprecated v0.12.1. Use `MMA.SelectionList.active`. */
declare const getActiveSelections: typeof SelectionList.active;
/** @deprecated v0.12.1. Use `MMA.SelectionList.update`. @unstable */
declare const applySelectionUpdate: typeof SelectionList.update;
/** @deprecated v0.12.1. Use `MMA.SelectionList.undo`. @unstable */
declare const restoreSelections: typeof SelectionList.undo;
/** @deprecated v0.12.1. Use `MMA.SelectionList.redo`. @unstable */
declare const redoSelections: typeof SelectionList.redo;
/** @deprecated v0.12.1. Use `MMA.SelectionList.select`. */
declare const select: typeof SelectionList.select;
/** @deprecated v0.12.1. Use `MMA.History.available`. @unstable */
declare const historyAvailable: typeof History.available;
/** @deprecated v0.12.1. Use `MMA.History.undo`. */
declare const undo: typeof History.undo;
/** @deprecated v0.12.1. Use `MMA.History.redo`. */
declare const redo: typeof History.redo;
/** @deprecated v0.12.1. Use `MMA.Commit.create`. */
declare const commitMap: typeof Commit.create;
/** @deprecated v0.12.1. Use `MMA.Commit.checkout`. @unstable */
declare const checkoutCommit: typeof Commit.checkout;
/** @deprecated v0.12.1. Use `MMA.Maps.init`. @unstable */
declare const initStore: typeof Maps.init;
/** @deprecated v0.12.1. Use `MMA.Maps.open`. */
declare const openMap$1: typeof Maps.open;
/** @deprecated v0.12.1. Use `MMA.Maps.close`. */
declare const closeMap$1: typeof Maps.close;
/** @deprecated v0.12.1. Use `MMA.Maps.discard`. @unstable */
declare const discardOpenMap: typeof Maps.discard;
/** @deprecated v0.12.1. Use `MMA.SelectionList.tagIds`. @unstable */
declare const getSelectedTagIds: typeof SelectionList.tagIds;
/** @deprecated v0.12.1. Use `MMA.SelectionList.tagIdsDeep`. @unstable */
declare const getSelectedTagIdsDeep: typeof SelectionList.tagIdsDeep;
/** @deprecated v0.12.1. Use `MMA.Editor.VIEWER`. */
declare const VIEWER: typeof Editor.VIEWER;
/** @deprecated v0.12.1. Use `MMA.Maps.useList`. */
declare const useMapList: typeof Maps.useList;
/** @deprecated v0.12.1. Use `MMA.Maps.list`. */
declare const getMapList: typeof Maps.list;
/** @deprecated v0.12.1. Use `MMA.Maps.reload`. @unstable */
declare const reloadMapList: typeof Maps.reload;
/** @deprecated v0.12.1. Use `MMA.Maps.invalidate`. @unstable */
declare const invalidateMapList: typeof Maps.invalidate;
/** @deprecated v0.12.1. Use `MMA.Maps.setList`. @unstable */
declare const setCachedMapList: typeof Maps.setList;
/** @deprecated v0.12.1. Use `MMA.Maps.create`. */
declare const createMap: typeof Maps.create;
/** @deprecated v0.12.1. Use `MMA.Maps.duplicate`. */
declare const duplicateMap: typeof Maps.duplicate;
/** @deprecated v0.12.1. Use `MMA.Maps.remove`. */
declare const deleteMap$1: typeof Maps.remove;
/** @deprecated v0.12.1. Use `MMA.Maps.openScratch`. */
declare const openScratchMap: typeof Maps.openScratch;
/** @deprecated v0.12.1. Use `MMA.Maps.isReserved`. @unstable */
declare const isReservedMap: typeof Maps.isReserved;
/** @deprecated v0.12.1. Use `MMA.Maps.copyName`. @unstable */
declare const copyName: typeof Maps.copyName;
/** @deprecated v0.12.1. Use `MMA.Maps.renameFolder`. */
declare const renameFolder: typeof Maps.renameFolder;
/** @deprecated v0.12.1. Use `MMA.Maps.moveToFolder`. */
declare const moveMapToFolder: typeof Maps.moveToFolder;
/** @deprecated v0.12.1. Use `MMA.Maps.removeFolder`. */
declare const deleteFolder: typeof Maps.removeFolder;
/** @deprecated v0.12.1. Use `MMA.Maps.registerBadges`. @unstable */
declare const registerMapBadges: typeof Maps.registerBadges;
/** @deprecated v0.12.1. Use `MMA.Maps.badgeSources`. @unstable */
declare const getMapBadgeSources: typeof Maps.badgeSources;
/** @deprecated v0.12.1. Use `MMA.Maps.badges`. @unstable */
declare const getMapBadges: typeof Maps.badges;
/** @deprecated v0.12.1. Use `MMA.Maps.useBadges`. @unstable */
declare const useMapBadges: typeof Maps.useBadges;
/** @deprecated v0.12.1. Use `MMA.Edit`. */
declare const edit: typeof Edit;
/** @deprecated v0.12.1. Use `MMA.Autosave`. */
declare const autosave: typeof Autosave;

declare const legacy_VIEWER: typeof VIEWER;
declare const legacy_addLocations: typeof addLocations;
/** @unstable */
declare const legacy_addSelections: typeof addSelections;
/** @unstable */
declare const legacy_addTagToLocations: typeof addTagToLocations;
declare const legacy_applySelectionUpdate: typeof applySelectionUpdate;
declare const legacy_autosave: typeof autosave;
declare const legacy_checkoutCommit: typeof checkoutCommit;
declare const legacy_closeDuplicates: typeof closeDuplicates;
declare const legacy_closeLocation: typeof closeLocation;
declare const legacy_commitMap: typeof commitMap;
declare const legacy_copyName: typeof copyName;
/** @unstable */
declare const legacy_countBy: typeof countBy;
/** @unstable */
declare const legacy_countIn: typeof countIn;
/** @unstable */
declare const legacy_coverage: typeof coverage;
declare const legacy_createMap: typeof createMap;
/** @unstable */
declare const legacy_createPluginStorage: typeof createPluginStorage;
/** @unstable */
declare const legacy_currentSelection: typeof currentSelection;
declare const legacy_deleteField: typeof deleteField;
declare const legacy_deleteFolder: typeof deleteFolder;
declare const legacy_deleteTags: typeof deleteTags;
declare const legacy_discardOpenMap: typeof discardOpenMap;
declare const legacy_duplicateLocation: typeof duplicateLocation;
declare const legacy_duplicateMap: typeof duplicateMap;
declare const legacy_edit: typeof edit;
declare const legacy_exitPluginMode: typeof exitPluginMode;
/** @unstable */
declare const legacy_fetchAllLocations: typeof fetchAllLocations;
/** @unstable */
declare const legacy_fetchBounds: typeof fetchBounds;
/** @unstable */
declare const legacy_fetchColumns: typeof fetchColumns;
/** @unstable */
declare const legacy_fetchLocation: typeof fetchLocation;
/** @unstable */
declare const legacy_fetchLocations: typeof fetchLocations;
/** @unstable */
declare const legacy_fetchLocationsByIds: typeof fetchLocationsByIds;
/** @unstable */
declare const legacy_fieldCoverage: typeof fieldCoverage;
/** @unstable */
declare const legacy_fieldValues: typeof fieldValues;
/** @unstable */
declare const legacy_getActiveLocation: typeof getActiveLocation;
declare const legacy_getActiveSelections: typeof getActiveSelections;
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
declare const legacy_getMapBadgeSources: typeof getMapBadgeSources;
declare const legacy_getMapBadges: typeof getMapBadges;
declare const legacy_getMapList: typeof getMapList;
declare const legacy_getMapState: typeof getMapState;
/** @unstable */
declare const legacy_getSelectedLocationIds: typeof getSelectedLocationIds;
declare const legacy_getSelectedTagIds: typeof getSelectedTagIds;
declare const legacy_getSelectedTagIdsDeep: typeof getSelectedTagIdsDeep;
/** @unstable */
declare const legacy_getSelections: typeof getSelections;
declare const legacy_getTag: typeof getTag;
declare const legacy_getTagCounts: typeof getTagCounts;
declare const legacy_getTags: typeof getTags;
declare const legacy_getVisibleTags: typeof getVisibleTags;
/** @unstable */
declare const legacy_getWorkArea: typeof getWorkArea;
declare const legacy_historyAvailable: typeof historyAvailable;
declare const legacy_initStore: typeof initStore;
/** @unstable */
declare const legacy_installedVersion: typeof installedVersion;
declare const legacy_invalidateMapList: typeof invalidateMapList;
declare const legacy_isReservedMap: typeof isReservedMap;
declare const legacy_locationsOf: typeof locationsOf;
declare const legacy_moveMapToFolder: typeof moveMapToFolder;
declare const legacy_mutate: typeof mutate;
declare const legacy_openDuplicateLocation: typeof openDuplicateLocation;
declare const legacy_openLocation: typeof openLocation;
declare const legacy_openScratchMap: typeof openScratchMap;
declare const legacy_openStagedLocation: typeof openStagedLocation;
/** @unstable */
declare const legacy_partition: typeof partition;
declare const legacy_previewDuplicateGroups: typeof previewDuplicateGroups;
declare const legacy_previewLocation: typeof previewLocation;
/** @unstable */
declare const legacy_query: typeof query;
declare const legacy_read: typeof read;
declare const legacy_redo: typeof redo;
declare const legacy_redoSelections: typeof redoSelections;
/** @unstable */
declare const legacy_registerEnrichFields: typeof registerEnrichFields;
/** @unstable */
declare const legacy_registerEnrichmentProvider: typeof registerEnrichmentProvider;
declare const legacy_registerMapBadges: typeof registerMapBadges;
declare const legacy_reloadMapList: typeof reloadMapList;
declare const legacy_removeDuplicate: typeof removeDuplicate;
declare const legacy_removeLocations: typeof removeLocations;
/** @unstable */
declare const legacy_removeSelections: typeof removeSelections;
/** @unstable */
declare const legacy_removeTagFromAllLocations: typeof removeTagFromAllLocations;
/** @unstable */
declare const legacy_removeTagFromLocations: typeof removeTagFromLocations;
declare const legacy_renameField: typeof renameField;
declare const legacy_renameFolder: typeof renameFolder;
/** @unstable */
declare const legacy_request: typeof request;
/** @unstable */
declare const legacy_resetSelections: typeof resetSelections;
/** @unstable */
declare const legacy_resolveIds: typeof resolveIds;
declare const legacy_resolveLocation: typeof resolveLocation;
declare const legacy_restoreSelections: typeof restoreSelections;
/** @unstable */
declare const legacy_sampleFrom: typeof sampleFrom;
declare const legacy_select: typeof select;
/** @unstable */
declare const legacy_setActiveLocation: typeof setActiveLocation;
declare const legacy_setCachedMapList: typeof setCachedMapList;
declare const legacy_setMap: typeof setMap;
declare const legacy_setOpenLocation: typeof setOpenLocation;
declare const legacy_setPluginMode: typeof setPluginMode;
declare const legacy_setSelectedLocationIds: typeof setSelectedLocationIds;
/** @unstable */
declare const legacy_setUserFieldDefs: typeof setUserFieldDefs;
declare const legacy_setWorkArea: typeof setWorkArea;
declare const legacy_settled: typeof settled;
declare const legacy_tagIdsToNames: typeof tagIdsToNames;
declare const legacy_undo: typeof undo;
declare const legacy_updateLocations: typeof updateLocations;
declare const legacy_useMapBadges: typeof useMapBadges;
declare const legacy_useMapList: typeof useMapList;
declare const legacy_useMapState: typeof useMapState;
/** @unstable */
declare const legacy_waitForGoogleMap: typeof waitForGoogleMap;
declare namespace legacy {
  export {
    legacy_VIEWER as VIEWER,
    legacy_addLocations as addLocations,
    legacy_addSelections as addSelections,
    legacy_addTagToLocations as addTagToLocations,
    legacy_applySelectionUpdate as applySelectionUpdate,
    legacy_autosave as autosave,
    legacy_checkoutCommit as checkoutCommit,
    legacy_closeDuplicates as closeDuplicates,
    legacy_closeLocation as closeLocation,
    closeMap$1 as closeMap,
    legacy_commitMap as commitMap,
    legacy_copyName as copyName,
    legacy_countBy as countBy,
    legacy_countIn as countIn,
    legacy_coverage as coverage,
    legacy_createMap as createMap,
    legacy_createPluginStorage as createPluginStorage,
    legacy_currentSelection as currentSelection,
    legacy_deleteField as deleteField,
    legacy_deleteFolder as deleteFolder,
    deleteMap$1 as deleteMap,
    legacy_deleteTags as deleteTags,
    legacy_discardOpenMap as discardOpenMap,
    legacy_duplicateLocation as duplicateLocation,
    legacy_duplicateMap as duplicateMap,
    legacy_edit as edit,
    legacy_exitPluginMode as exitPluginMode,
    legacy_fetchAllLocations as fetchAllLocations,
    legacy_fetchBounds as fetchBounds,
    legacy_fetchColumns as fetchColumns,
    legacy_fetchLocation as fetchLocation,
    legacy_fetchLocations as fetchLocations,
    legacy_fetchLocationsByIds as fetchLocationsByIds,
    legacy_fieldCoverage as fieldCoverage,
    legacy_fieldValues as fieldValues,
    legacy_getActiveLocation as getActiveLocation,
    legacy_getActiveSelections as getActiveSelections,
    legacy_getAllSelections as getAllSelections,
    legacy_getCurrentMap as getCurrentMap,
    legacy_getCurrentMapId as getCurrentMapId,
    legacy_getDirtyCount as getDirtyCount,
    legacy_getGhostedSelections as getGhostedSelections,
    legacy_getGoogleMap as getGoogleMap,
    legacy_getMapBadgeSources as getMapBadgeSources,
    legacy_getMapBadges as getMapBadges,
    legacy_getMapList as getMapList,
    legacy_getMapState as getMapState,
    legacy_getSelectedLocationIds as getSelectedLocationIds,
    legacy_getSelectedTagIds as getSelectedTagIds,
    legacy_getSelectedTagIdsDeep as getSelectedTagIdsDeep,
    legacy_getSelections as getSelections,
    legacy_getTag as getTag,
    legacy_getTagCounts as getTagCounts,
    legacy_getTags as getTags,
    legacy_getVisibleTags as getVisibleTags,
    legacy_getWorkArea as getWorkArea,
    legacy_historyAvailable as historyAvailable,
    legacy_initStore as initStore,
    legacy_installedVersion as installedVersion,
    legacy_invalidateMapList as invalidateMapList,
    legacy_isReservedMap as isReservedMap,
    legacy_locationsOf as locationsOf,
    legacy_moveMapToFolder as moveMapToFolder,
    legacy_mutate as mutate,
    legacy_openDuplicateLocation as openDuplicateLocation,
    legacy_openLocation as openLocation,
    openMap$1 as openMap,
    legacy_openScratchMap as openScratchMap,
    legacy_openStagedLocation as openStagedLocation,
    legacy_partition as partition,
    legacy_previewDuplicateGroups as previewDuplicateGroups,
    legacy_previewLocation as previewLocation,
    legacy_query as query,
    legacy_read as read,
    legacy_redo as redo,
    legacy_redoSelections as redoSelections,
    legacy_registerEnrichFields as registerEnrichFields,
    legacy_registerEnrichmentProvider as registerEnrichmentProvider,
    legacy_registerMapBadges as registerMapBadges,
    legacy_reloadMapList as reloadMapList,
    legacy_removeDuplicate as removeDuplicate,
    legacy_removeLocations as removeLocations,
    legacy_removeSelections as removeSelections,
    legacy_removeTagFromAllLocations as removeTagFromAllLocations,
    legacy_removeTagFromLocations as removeTagFromLocations,
    legacy_renameField as renameField,
    legacy_renameFolder as renameFolder,
    legacy_request as request,
    legacy_resetSelections as resetSelections,
    legacy_resolveIds as resolveIds,
    legacy_resolveLocation as resolveLocation,
    legacy_restoreSelections as restoreSelections,
    legacy_sampleFrom as sampleFrom,
    legacy_select as select,
    legacy_setActiveLocation as setActiveLocation,
    legacy_setCachedMapList as setCachedMapList,
    legacy_setMap as setMap,
    legacy_setOpenLocation as setOpenLocation,
    legacy_setPluginMode as setPluginMode,
    legacy_setSelectedLocationIds as setSelectedLocationIds,
    legacy_setUserFieldDefs as setUserFieldDefs,
    legacy_setWorkArea as setWorkArea,
    legacy_settled as settled,
    legacy_tagIdsToNames as tagIdsToNames,
    legacy_undo as undo,
    legacy_updateLocations as updateLocations,
    legacy_useMapBadges as useMapBadges,
    legacy_useMapList as useMapList,
    legacy_useMapState as useMapState,
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
/** Import a previewed file, optionally assigning tags. @unstable */
declare function importFile(droppedFields: string[], tagNames?: string[]): Promise<EditorImportResult>;

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
/** Prompt for files; resolves empty when the picker is dismissed. @unstable */
declare function pickFiles(accept: string, opts?: {
    multiple?: boolean;
}): Promise<File[]>;
/** Trigger a browser download from an in-memory Blob. @unstable */
declare function downloadBlob(blob: Blob, fileName: string): void;
/** Copy an image Blob to the clipboard. False when the platform refuses it. @unstable */
declare function copyImageToClipboard(blob: Blob): Promise<boolean>;
/** Compare strings with natural (numeric-aware) ordering. @unstable */
declare function compareNatural(a: string, b: string): number;
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
declare const util_pickFiles: typeof pickFiles;
/** @unstable */
declare const util_schemeBase: typeof schemeBase;
/** @unstable */
declare const util_shuffle: typeof shuffle;
/** @unstable */
declare const util_splitVersion: typeof splitVersion;
/** @unstable */
declare const util_toggleInSet: typeof toggleInSet;
declare namespace util {
  export { util_bestBy as bestBy, util_chunk as chunk, util_cmpVersion as cmpVersion, util_compareNatural as compareNatural, util_copyImageToClipboard as copyImageToClipboard, util_downloadBlob as downloadBlob, util_isPrereleaseVersion as isPrereleaseVersion, util_isWeb as isWeb, util_mmaBufUrl as mmaBufUrl, util_nowUnix as nowUnix, util_phaseRate as phaseRate, util_pickFiles as pickFiles, util_schemeBase as schemeBase, util_shuffle as shuffle, util_splitVersion as splitVersion, util_toggleInSet as toggleInSet };
  export type { util_PhaseRate as PhaseRate };
}

/** Sort tags by the chosen mode: name, location count, or manual order. */
declare function sortTagsByMode(tags: Tag[], mode: TagSortMode, counts: Record<number, number>): Tag[];
/** Color for a tag named `name`. An existing tag uses its stored color. */
declare function tagColorFor(name: string, tags: Tag[]): string;
/** Add a name to a staged list: dedup case-insensitively, normalizing to an existing tag's
 *  canonical casing. Returns the original array unchanged if already present. */
declare function appendTagName(pending: string[], name: string, tags: Tag[]): string[];
/** Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
 *  the `/`-path to its shortest unique suffix; otherwise returns the name verbatim. */
declare function displayTagName(name: string): string;

declare const tags_appendTagName: typeof appendTagName;
declare const tags_displayTagName: typeof displayTagName;
declare const tags_sortTagsByMode: typeof sortTagsByMode;
declare const tags_tagColorFor: typeof tagColorFor;
declare namespace tags {
  export {
    tags_appendTagName as appendTagName,
    tags_displayTagName as displayTagName,
    tags_sortTagsByMode as sortTagsByMode,
    tags_tagColorFor as tagColorFor,
  };
}

export type ConstsApi = typeof consts;
/** Pure transforms over the selection list behind the sidebar. @unstable */
export type SelectionOpsApi = typeof selectionOps;
/** Saved selection rules. @unstable */
export type SavedSelectionsApi = typeof savedSelections;
/** App settings and their option tables; the shape moves with every setting added. @unstable */
export type SettingsApi = typeof settings;
/** The selector picker the pick dialogs share; its choices move with the UI. @unstable */
export type SelectorPickApi = typeof picker;
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
export type FieldDefsApi = typeof fieldDefs;
export type FieldDefRegistryApi = typeof fieldDefRegistry;
/** The keys a field can be grouped by. @unstable */
export type FieldProjectionsApi = typeof fieldProjections;
/** Running procedures directly, outside a registered provider. @unstable */
export type ProceduresApi = typeof procedures;
/** The seen-location history. @unstable */
export type SeenApi = typeof seen;
/** How the app records panorama visits into the seen history. @unstable */
export type SeenRecorderApi = typeof seenRecorder;
/** The shared panorama viewer. @unstable */
export type PanoApi = typeof panoSurface;
/** Enrichment passes over the open map. @unstable */
export type EnrichApi = typeof enrich$1;
/** The providers the app registers for enrichment. @unstable */
export type ProvidersApi = typeof providers;
/** Bulk pinning locations to their panoramas. @unstable */
export type PinPanoApi = typeof pinPano;
/** Coverage validation passes. @unstable */
export type ValidateApi = typeof validate;
/** The validation categories users pick from, over the flags a check answers. @unstable */
export type ValidationCategoriesApi = typeof validationCategories;
export type QueryApi = typeof query$1;
/** The embedded map host, its preferences, and click interceptors. @unstable */
export type MapStateApi = typeof mapState;
/** The marker scene the map surfaces render from, and its load lifecycle. @unstable */
export type SceneStoreApi = typeof sceneStore;
/** Screen positions of the rendered markers. @unstable */
export type ScenePositionsApi = typeof scenePositions;
/** Color conversion helpers. @unstable */
export type ColorApi = typeof colorUtils;
export type ToastApi = typeof toast$1;
/** The global job tray. @unstable */
export type JobsApi = typeof jobs;
export type UseJobApi = typeof useJob$1;
/** Compatibility bindings for flat plugin calls. */
export type LegacyApi = typeof legacy;
/** @unstable */
export type TestApi = typeof testSurface;
export type TypesApi = typeof types;
/** General-purpose helpers. @unstable */
export type UtilApi = typeof util;
export type TagsApi = typeof tags;
/** The global `MMA` object (also `window.MMA`). */
interface MMA extends ConstsApi, SelectionOpsApi, SavedSelectionsApi, SettingsApi, SelectorPickApi, ReviewApi, CommandsApi, TauriApi, RegistryApi, PluginHostApi, MarketplaceApi, PluginStorageApi, ScopeApi, PluginEventsApi, ExternalsApi, SidecarApi, FieldDefsApi, FieldDefRegistryApi, FieldProjectionsApi, ProceduresApi, SeenApi, SeenRecorderApi, PanoApi, EnrichApi, ProvidersApi, PinPanoApi, ValidateApi, ValidationCategoriesApi, QueryApi, MapStateApi, SceneStoreApi, ScenePositionsApi, ColorApi, ToastApi, JobsApi, UseJobApi, TestApi, TypesApi, UtilApi, TagsApi, LegacyApi {
    /** Shared UI primitives for plugin sidebars and dialogs. */
    ui: typeof primitives;
    /** Debounced persistence of the open map: schedule, hold, cancel, or flush it. */
    Autosave: typeof Autosave;
    /** Edit map locations, metadata, value records, and selections. */
    Edit: typeof Edit;
    /** Add, update, remove, and inspect map locations. */
    Location: typeof Location;
    /** Manage tag records and their assignment to locations. */
    Tag: typeof Tag;
    /** Open locations and change the editor pane. */
    Editor: typeof Editor;
    /** Navigate undo and redo history. */
    History: typeof History;
    /** Save and restore map versions. */
    Commit: typeof Commit;
    /** Rename or remove metadata fields across the map. */
    Field: typeof Field$1;
    /** Read the open map state and update its selection and metadata. */
    Store: Omit<typeof Store, "patch" | "merge" | "resetDerived">;
    /** Create, list, open, close, and organize maps. */
    Maps: typeof Maps;
    /** Read locations and summaries for a selector. */
    Query: typeof Query;
    /** Run mutations and wait for their state and display updates. */
    Mutation: typeof Mutation;
    /** Change the listed selections and inspect their active members. @unstable */
    SelectionList: typeof SelectionList;
    /** Uncommitted changes and their preview on the map. @unstable */
    CommitDiff: typeof CommitDiff;
    /** Stage, preview, and confirm an import into the open map. @unstable */
    Import: typeof Import;
}

declare global {
    interface Window {
        MMA: MMA;
    }
    const MMA: MMA;
}

export type { BUILTIN_FIELDS, CameraType, CapturePick, DEFAULT_DUPLICATE_SCORE, DatePart, EFFECT_CALLS, ERROR_CODES, FieldType, FirstSyncMode, FrameKind, IssueState, KNOWN_FIELDS, LOCATION_MERGED, LocationFlag, MMA, MMA as MMAApi, MapShape, MergeWinner, NO_SEL, OFFICIAL_ID_PATTERN, PLAIN_CALLS, PROJECTIONS, PanoType, RankingStrategy, RateCost, ResolutionSide, SCRATCH_MAP_ID, SYNC_PROVIDERS, Sink, Stack, SyncDirection, SyncTrigger, ValidationFlag, commands$1 as commands, events };
export type { AnonIssueRef, Answer, Ask, AttachmentRef, BatchMode, CameraFrame, Change, ChangeEvent, CommitInfo, CommitResult, ComparisonType, Composition, Conflict, ConflictKind, CopyToMapResult, CountBy, Counts, DataLocation, DbStats, Derived, DeviceCodeInfo, EditOpts, EditorImportPreview, EditorImportResult, EntryKey, ExportOpts, ExportProgress, ExprError, FieldCount, FieldDef, FieldValue, FileSource, FilterOp, GeoResult, GgUser, GhUser, HeldValue, History as History, HoneycombRun, IdQuery, ImageSize, ImportPreviewEntry, ImportProgress, ImportedMapInfo, IssueComment, IssueRef, IssueThread, KeySpec, Keys, ListedSelection, Location as Location, LocationList, LocationOp, MapExtra, MapKeyAction, MapKeyBinding, MapMeta, MapMeta_Deserialize, MapPreferences, MapSettings, MmMapSummary, MmUser, Mutation as Mutation, MutationResult, NormalizedSyncLocation, NumericBinning, Op, Pano, PanoAnswer, PanoDate, PanoLink, PanoQuery, PanoTime, ParsedLocation, PartitionBucket, PluginBuild, PluginBuild_Deserialize, PluginManifest, PluginManifest_Deserialize, PluginSidecar, PluginSidecar_Deserialize, Policy, PolygonGeometry, Pov, PresenceActivity, ProcedureActivity, ProcedureConfig, ProcedureDecl, ProcedureHost, ProcedureProgress, ProcedureRequest, ProcedureResponse, ProcedureResult, ProviderActivity, ProviderDecl, QueryActivity, RGB, RateSpec, RenderRequest, ResultEntry, RetrySpec, ReviewCreate, ReviewSession, SavedSelection, SavedSelectionInfo, ScoreBounds, SearchQuery, SeenEntry, SeenFilter, SeenMapInfo, SeenWriteEntry, Selection, SelectionInput, SelectionOp, Selector$1 as Selector, SetOp, SideCounts, SidecarDone, SidecarLine, SidecarLog, SidecarProgress, StoreStatus, StoreWarning, Summary, SyncLogEntry, SyncLogResult, SyncReconcileResult, Target, Thinning, UpdateAvailable, UpdateProgress, ValiCountryStatus, ValiLocation, ValiLocation_Deserialize, ValiProgress, ValueRecord, VirtualTag, Work, WorkResult };
