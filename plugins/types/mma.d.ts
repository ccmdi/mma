/// <reference types="google.maps" />

import * as react from 'react';
import { SetStateAction, ComponentType, ComponentPropsWithRef, ReactNode, ComponentProps, CSSProperties, ElementType, ReactElement } from 'react';
import * as _tauri_apps_api_window from '@tauri-apps/api/window';
import * as _tauri_apps_api_webview from '@tauri-apps/api/webview';
import { Channel } from '@tauri-apps/api/core';
import * as __TAURI_EVENT from '@tauri-apps/api/event';
import { Layer as Layer$1, PickingInfo } from '@deck.gl/core';
import * as maplibregl from 'maplibre-gl';
import { Command } from '@tauri-apps/plugin-shell';
import { open, save } from '@tauri-apps/plugin-dialog';
import * as _base_ui_components_react_dialog from '@base-ui-components/react/dialog';
import { Dialog as Dialog$1 } from '@base-ui-components/react/dialog';

/** @api */
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
export type CameraType = (typeof CameraType)[keyof typeof CameraType];
/** A capture of a pano's timeline to settle on. @api */
declare const CapturePick: {
    /** The newest official capture. */
    readonly Newest: "newest";
    /** The oldest official capture. */
    readonly Oldest: "oldest";
};
export type CapturePick = (typeof CapturePick)[keyof typeof CapturePick];
/** A calendar component to group dates by. @api */
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
export type DatePart = (typeof DatePart)[keyof typeof DatePart];
/**
 * Type discriminant for `Location.extra` field definitions.
 * Determines how the field is displayed and filtered in the UI.
 * @api
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
export type FieldType = (typeof FieldType)[keyof typeof FieldType];
/** How a group of selections joins its members. @api */
declare const Group: {
    /** The locations any member selects. */
    readonly Union: "Union";
    /** The locations every member selects. */
    readonly Intersection: "Intersection";
};
export type Group = (typeof Group)[keyof typeof Group];
/**
 * First-sync seeding when both sides already have pins. Only meaningful on the first sync
 * (empty mapping); afterwards it's plain three-way. `Merge` never deletes.
 * @api @unstable
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
export type FirstSyncMode = (typeof FirstSyncMode)[keyof typeof FirstSyncMode];
/** @api @unstable */
declare const IssueState: {
    /** The issue is still open. @unstable */
    readonly Open: "open";
    /** The issue has been closed. @unstable */
    readonly Closed: "closed";
};
/** @unstable */
export type IssueState = (typeof IssueState)[keyof typeof IssueState];
/** How much of a map a destination keeps. Each shape keeps everything the one before it does. @api */
declare const MapShape: {
    /** Coordinates, camera and pinned panoramas: what GeoGuessr stores. */
    readonly GeoGuessr: "geoguessr";
    /** Adds tags, unpinned panoramas, capture months and location flags: what map-making.app stores. */
    readonly MapMaking: "mapMaking";
    /** Everything this app stores, including custom fields. */
    readonly Local: "local";
};
export type MapShape = (typeof MapShape)[keyof typeof MapShape];
/** When a move target already holds a value, which side survives. @api */
declare const MergeWinner: {
    /** The moved value replaces what the target already holds. */
    readonly From: "from";
    /** The target keeps its own value and the moved value is dropped. */
    readonly To: "to";
};
export type MergeWinner = (typeof MergeWinner)[keyof typeof MergeWinner];
/** Where a moved selection lands beside its target. @api */
declare const Place: {
    /** In front of the target. */
    readonly Before: "before";
    /** Behind the target. */
    readonly After: "after";
};
export type Place = (typeof Place)[keyof typeof Place];
/**
 * What one attempt charges the bucket: the call itself, or one per row in its batch
 * (for APIs that bill multi-row requests per row).
 * @api
 */
declare const RateCost: {
    /** Each attempt charges the rate limit once, however many rows it carries. */
    readonly Request: "request";
    /** Each attempt charges the rate limit once per row it carries; a query carries no rows and charges once. */
    readonly Row: "row";
};
export type RateCost = (typeof RateCost)[keyof typeof RateCost];
/** Which locations of a review session a selection holds. @api */
declare const ReviewMode: {
    /** The locations already reviewed. */
    readonly Reviewed: "reviewed";
    /** The locations still to review. */
    readonly Unreviewed: "unreviewed";
};
export type ReviewMode = (typeof ReviewMode)[keyof typeof ReviewMode];
/** Which side won a resolved conflict. @api @unstable */
declare const ResolutionSide: {
    /** This map's version won the conflict. @unstable */
    readonly Local: "local";
    /** The remote map's version won the conflict. @unstable */
    readonly Remote: "remote";
};
/** @unstable */
export type ResolutionSide = (typeof ResolutionSide)[keyof typeof ResolutionSide];
/**
 * Where a provider's results go. `Patch` applies them to the locations they name;
 * `Collect` delivers them to the caller and writes nothing. The declaration decides
 * this, never the contents of a result.
 * @api
 */
declare const Sink: {
    /** Results are written to the locations they name. */
    readonly Patch: "patch";
    /** Results are handed back and nothing is written. */
    readonly Collect: "collect";
};
export type Sink = (typeof Sink)[keyof typeof Sink];
/** Which edit history stack to step through. @api */
declare const Stack: {
    /** The steps that can be undone. */
    readonly Undo: "undo";
    /** The undone steps that can be redone. */
    readonly Redo: "redo";
};
export type Stack = (typeof Stack)[keyof typeof Stack];
/** Which edit history to step through. Each part of the map that undoes on its own has one. @api */
declare const Timeline: {
    /** Edits to locations, value records, and field definitions. */
    readonly Edits: "edits";
    /** Changes to the listed selections. */
    readonly Selections: "selections";
};
export type Timeline = (typeof Timeline)[keyof typeof Timeline];
/** What started a sync pass. @api @unstable */
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
export type SyncTrigger = (typeof SyncTrigger)[keyof typeof SyncTrigger];
/** Per-location bitfield, sent and stored as a plain `u32`. @api */
declare const LocationFlag: {
    /** No flags set. */
    readonly None: 0;
    /** When the location has a stored pano, it opens exactly that pano instead of the nearest coverage. */
    readonly LoadAsPanoId: 1;
    /** Legacy marker (web). Kept as imported, with no effect in the app. */
    readonly Informational: 2;
};
export type LocationFlag = (typeof LocationFlag)[keyof typeof LocationFlag];
/** Which imagery collection a pano id belongs to. @api */
declare const PanoType: {
    /** Official Street View coverage. */
    readonly Official: 2;
    /** Unofficial imagery from outside the user-uploaded collection. */
    readonly Unknown: 3;
    /** Imagery uploaded by users. */
    readonly UserUploaded: 10;
};
export type PanoType = (typeof PanoType)[keyof typeof PanoType];
/**
 * Which pano the search picks; omitted means closest. BEST at a small radius can return a
 * neighbouring pano from the same capture run, so probe a pano's own coordinate with CLOSEST.
 * @api
 */
declare const RankingStrategy: {
    /** The pano the search ranks best within the radius, which may not be the nearest. */
    readonly Best: 1;
    /** The pano nearest the searched point, and the choice when none is given. */
    readonly Closest: 2;
};
export type RankingStrategy = (typeof RankingStrategy)[keyof typeof RankingStrategy];
/**
 * One finding of a Street View coverage check. `validate` answers each row with the
 * findings that apply, combined into one number.
 * @api
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
export type ValidationFlag = (typeof ValidationFlag)[keyof typeof ValidationFlag];
/** Which way a link carries changes. @api @unstable */
declare const SyncDirection: {
    /** Changes travel both ways, and conflicts wait for review. @unstable */
    readonly Bidirectional: "bidirectional";
    /** Changes only come in from the remote, which wins every conflict. @unstable */
    readonly PullOnly: "pullOnly";
};
/** @unstable */
export type SyncDirection = (typeof SyncDirection)[keyof typeof SyncDirection];
/** @api */
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
/** @api */
declare const OFFICIAL_ID_PATTERN: "^[-_A-Za-z0-9]{21}[AQgw]$";
/** @api @unstable */
declare const DEFAULT_DUPLICATE_SCORE: "tagCount + has(panoId) + loadAsPanoId + (heading != 0)";
/** @api */
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
/** @api */
declare const DEFAULT_MARKER_COLOR: readonly [42, 42, 42];
/** @api @unstable */
declare const PROJECTIONS: readonly [{
    readonly id: "value";
    readonly appliesTo: readonly ["string", "enum", "boolean", "number", "month", "array"];
    readonly needsTz: false;
}, {
    readonly id: "day";
    readonly appliesTo: readonly ["date"];
    readonly needsTz: true;
}, {
    readonly id: "yearMonth";
    readonly appliesTo: readonly ["date"];
    readonly needsTz: true;
}, {
    readonly id: "year";
    readonly appliesTo: readonly ["date", "month"];
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
/** Every sync provider: which way it carries changes, and what it keeps of a map. @api @unstable */
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
/** @api @unstable */
declare const SCRATCH_MAP_ID: "scratch";
/** @api @unstable */
declare const ERROR_CODES: readonly ["auth", "attachment-not-staged", "attachment-too-large", "attachment-not-image", "upload-rejected", "report-rejected", "report-unreadable", "reply-rejected", "sign-in-timed-out", "sign-in-token-rejected", "issue-rejected", "geoguessr-polygonal", "geoguessr-draft-too-large", "data-folder-unavailable", "database-unreadable", "database-newer", "migration-failed", "map-missing", "map-unreadable"];
/** Country codes Vali has coverage data for. @api @unstable */
declare const VALI_COUNTRIES: readonly ["AE", "AF", "AL", "AM", "AR", "AT", "AU", "AZ", "BA", "BD", "BE", "BG", "BH", "BN", "BO", "BR", "BT", "BW", "BY", "BZ", "CA", "CD", "CH", "CI", "CL", "CM", "CN", "CO", "CR", "CU", "CZ", "DE", "DK", "DO", "DZ", "EC", "EE", "EG", "ER", "ES", "ET", "FI", "FO", "FR", "GB", "GE", "GL", "GR", "GT", "HK", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IN", "IQ", "IR", "IS", "IT", "JM", "JO", "JP", "KE", "KG", "KH", "KR", "KW", "KZ", "LA", "LB", "LI", "LK", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MK", "ML", "MM", "MN", "MO", "MT", "MV", "MX", "MY", "NG", "NI", "NL", "NO", "NP", "NZ", "OM", "PA", "PE", "PH", "PK", "PL", "PR", "PT", "PY", "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SE", "SG", "SI", "SK", "SN", "SO", "SV", "SY", "TH", "TJ", "TM", "TN", "TR", "TT", "TW", "UA", "US", "UY", "UZ", "VE", "VN", "XK", "YE", "ZA", "ZW", "CW", "AD", "AG", "AI", "AO", "AQ", "AS", "AW", "AX", "BB", "BF", "BI", "BJ", "BL", "BM", "BQ", "BS", "BV", "CC", "CF", "CG", "CK", "CV", "CX", "CY", "DJ", "DM", "EH", "FJ", "FK", "FM", "GA", "GD", "GF", "GG", "GH", "GI", "GM", "GN", "GP", "GQ", "GS", "GU", "GW", "GY", "HM", "IM", "IO", "JE", "KI", "KM", "KN", "KP", "KY", "LC", "LR", "LS", "MF", "MG", "MH", "MP", "MQ", "MR", "MS", "MU", "MW", "MZ", "NA", "NC", "NE", "NF", "NR", "NU", "PF", "PG", "PM", "PN", "PS", "PW", "SB", "SC", "SD", "SH", "SJ", "SL", "SM", "SR", "SS", "ST", "SX", "SZ", "TC", "TD", "TF", "TG", "TK", "TL", "TO", "TV", "TZ", "UG", "UM", "VA", "VC", "VG", "VI", "VU", "WF", "WS", "YT", "ZM"];

/** Commands @unstable */
declare const commands: {
    /**  Reports the window ready and returns the app's startup time and uptime. @unstable */
    appReady: () => Promise<AppReady>;
    /**  Fails with the reason the app could not start, and succeeds when it started normally. @unstable */
    startupCheck: () => Promise<null>;
    /**
     *  Write text to a temp file and return its path. `name` is a leaf filename
     *  (cannot contain path separators).
     *  @unstable
     */
    writeTempFile: (name: string, content: string) => Promise<string>;
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
     *  Install a plugin from the marketplace: its manifest, main script, procedure module and sidecar.
     *  `gitRef` pins an older build; `null` installs the latest.
     *  @unstable
     */
    installPlugin: (id: string, gitRef: string | null) => Promise<PluginManifest>;
    /**  Delete a plugin's directory. @unstable */
    uninstallPlugin: (id: string) => Promise<null>;
    /**  Installed sidecar version for a plugin, or `null` if not installed. @unstable */
    sidecarInstalledVersion: (pluginId: string) => Promise<string | null>;
    /**
     *  Run one unit of work on a plugin's sidecar under a `runId` from `runReserve`. Commands the
     *  manifest lists under `serve` go to the plugin's resident process; the rest get a one-shot
     *  child, which `runCancel` kills. Streams `sidecar-line` (one JSON object per unit) and
     *  `sidecar-log` (stderr), then exactly one `sidecar-done`, all keyed by the run id.
     *  @unstable
     */
    sidecarRequest: (pluginId: string, command: string, payload: string | null, runId: number) => Promise<null>;
    /**  Stop all sidecar processes for a plugin, or for every plugin when the id is null. @unstable */
    sidecarStop: (pluginId: string | null) => Promise<null>;
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
     *  Return the nearest city, administrative region, and country for a coordinate.
     *  Never `null`: every landmass is covered.
     *  @unstable
     */
    reverseGeocode: (lat: number, lng: number) => Promise<GeoResult | null>;
    /**  IANA timezone at a coordinate, or `null` outside the valid range. @unstable */
    timezoneAt: (lat: number, lng: number) => Promise<string | null>;
    /**  Show the window with the system open animation, maximized if `maximized` is set. @unstable */
    revealWindow: (maximized: boolean) => Promise<void>;
    /**  Set the Discord Rich Presence activity, or clear it when null. No-op when Discord is not running. @unstable */
    discordPresenceSet: (activity: PresenceActivity | null) => Promise<null>;
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
    /**  Every collab session this app is in, and every map it copied from another app's. @unstable */
    collabSessions: () => Promise<CollabSessions>;
    /**  The maps the signed-in user shares, and the maps others share with them. @unstable */
    collabShares: () => Promise<Shares>;
    /**
     *  Share map `map` with exactly `logins`, or stop sharing it when there are none. Anyone left
     *  out is turned away from the map's session.
     *  @unstable
     */
    collabShare: (map: string, logins: string[]) => Promise<null>;
    /**  Host map `map` for everyone it is shared with, until it is left. @unstable */
    collabHost: (map: string) => Promise<null>;
    /**
     *  Join the map `via` reaches, as an account it is shared with or as a guest with an invite
     *  code, following it into this app's copy of it. A copy edited since its last session is
     *  reported instead, unless `replace` says to replace those edits.
     *  @unstable
     */
    collabJoin: (via: Via, replace: boolean) => Promise<JoinOutcome>;
    /**
     *  Leave the session on this app's map `map`: a host ends it for everyone, a peer keeps its
     *  copy. An ended session is dismissed.
     *  @unstable
     */
    collabLeave: (map: string) => Promise<null>;
    /**  Show `data` to everyone else in the session on this app's map `map`. @unstable */
    collabPresent: (map: string, data: Shown) => Promise<null>;
    /**
     *  Turn on the code that lets guests without a GitHub account join this app's shared map
     *  `map`, returning it, or turn it off, which turns away every guest in its session.
     *  @unstable
     */
    collabInvite: (map: string, on: boolean) => Promise<string | null>;
    /**  The tail of `mma.log`, scrubbed. Empty string when there is no log yet. @unstable */
    feedbackLogTail: () => Promise<string>;
    /**  File a report anonymously under this install id, or as the signed-in GitHub user when it is null. @unstable */
    feedbackSubmit: (title: string, body: string, installId: string | null) => Promise<ReportRef>;
    /**  Upload an image attachment for a bug report and return its URL. @unstable */
    feedbackUploadAttachment: (path: string, name: string) => Promise<AttachmentRef>;
    /**  Fetch a report's state and replies, with its reply token when it was filed anonymously or null when filed as the signed-in GitHub user. @unstable */
    feedbackThread: (number: number, token: string | null) => Promise<IssueThread>;
    /**  Reply on a report, with its reply token when it was filed anonymously or null when filed as the signed-in GitHub user. @unstable */
    feedbackReply: (number: number, token: string | null, body: string) => Promise<IssueComment>;
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
    /**  Start the remote API server with this key, re-keying it when already running, or stop it when the key is null. @unstable */
    remoteApiSet: (key: string | null) => Promise<null>;
    /**  Deliver the result for remote API request `id`. `payload` is JSON text. @unstable */
    remoteApiRespond: (id: number, ok: boolean, payload: string) => Promise<void>;
    /**
     *  Open a map, deliver its later changes on `changes`, and return its initial state
     *  (per-value counts, metadata, undo/redo availability). The scratch map is created on its
     *  first open. Must be called before any other store commands.
     *  @unstable
     */
    storeOpenMap: (mapId: string, changes: Channel<ChangeEvent>) => Promise<StoreStatus>;
    /**  Close the open map, saving unsaved changes first. @unstable */
    storeCloseMap: () => Promise<null>;
    /**  Save uncommitted changes to disk. No-op when nothing has changed. @unstable */
    storeSaveDirty: () => Promise<null>;
    /**  Edit the map; an open pending layer holds location edits until it lands. @unstable */
    storeEdit: <V extends Edits>(edits: V) => Promise<ReplyTo<Edited, V>>;
    /**
     *  Run work over the target's locations matched by selector; an open pending layer holds the
     *  edits until it lands.
     *  @unstable
     */
    storeWork: (target: Target, selector: Selector$1<SelectionInput>, work: Work) => Promise<WorkResult>;
    /**
     *  Land a pending layer's edits on the map as one undoable step; later edits to it join that
     *  step.
     *  @unstable
     */
    storeLandLayer: (name: string) => Promise<Mutation<Location>>;
    /**  Close a pending layer. Edits not yet landed are discarded; work still writing to a landed layer finishes first. @unstable */
    storeCloseLayer: (name: string, mapId: string | null) => Promise<null>;
    /**  Answer one question about the target's locations matched by selector. @unstable */
    storeRead: (target: Target, selector: Selector$1<SelectionInput>, ask: Ask) => Promise<Answer>;
    /**
     *  Copy the locations that `selector` matches into another map, skipping ones it already has.
     *  Extra fields carry over, and interned values such as tags are matched to the target's by name.
     *  @unstable
     */
    storeCopyLocationsToMap: (targetMapId: string, selector: Selector$1<SelectionInput>) => Promise<CopyToMapResult>;
    /**
     *  The points of a honeycomb about `spacingM` metres apart that fall inside the polygon,
     *  one entry per row of points.
     *  @unstable
     */
    honeycombPoints: (polygon: PolygonGeometry, spacingM: number) => Promise<HoneycombRun[]>;
    /**  Points inside the polygon as `[lng, lat]` pairs, drawn as `sampling` says. @unstable */
    polygonPoints: (polygon: PolygonGeometry, sampling: PointSampling) => Promise<[number, number][]>;
    /**  Whether each of the points sits inside the polygon. @unstable */
    polygonContainsPoints: (polygon: PolygonGeometry, lats: number[], lngs: number[]) => Promise<boolean[]>;
    /**
     *  Bounding box `[west, south, east, north]` of the polygon itself, or `null` when it
     *  has no vertices. `west > east` means the box crosses the antimeridian.
     *  @unstable
     */
    polygonBounds: (polygon: PolygonGeometry) => Promise<[number, number, number, number] | null>;
    /**  The parse error for `src`, or `null` when it parses. @unstable */
    fieldExprError: (src: string) => Promise<ExprError | null>;
    /**
     *  Count locations by country using offline point-in-polygon. Returns (ISO-A2, count) pairs.
     *  `level` selects border precision, falling back to "light" if unavailable.
     *  @unstable
     */
    storeCountryDistribution: (selector: Selector$1<SelectionInput>, level: string) => Promise<[string, number][]>;
    /**  Undo the newest edit, or redo the newest undone one. @unstable */
    storeStep: (stack: Stack, timeline: Timeline) => Promise<Mutation<Location>>;
    /**  Compile unaddressed selections into keyed store inputs. @unstable */
    selectionBuild: (selections: SelectionInput[]) => Promise<Selection[]>;
    /**  Draw the open map's markers: `frames` receives the whole scene, then every change to it. @unstable */
    storeSubscribeFrames: (frames: Channel<ArrayBuffer>, req: RenderRequest) => Promise<null>;
    /**  Return metadata for every map in the database. @unstable */
    storeListMaps: () => Promise<MapMeta[]>;
    /**  Create a new empty map with the preferences new maps start from. Returns the full metadata. @unstable */
    storeCreateMap: (name: string, folder: string | null) => Promise<MapMeta>;
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
     *  Open maps save through their store; value records are edited separately.
     *  A closed map writes straight to disk and returns null.
     *  @unstable
     */
    storeUpdateMapMeta: (patch: Partial<Omit<MapMeta, "locationCount" | "pending" | "createdAt" | "updatedAt" | "lastOpenedAt" | "settings" | "localPluginData">> & Pick<MapMeta, "id"> & {
        settings?: Partial<Omit<MapSettings, keyof MapPreferences | "pluginData">> & (Partial<MapPreferences>) & {
            pluginData?: { [key in string]: Op<{ [key_1 in string]: unknown; }, { [key_1 in string]: Op<unknown, unknown, null>; }, null>; };
        };
    } & {
        localPluginData?: { [key in string]: Op<{ [key_1 in string]: unknown; }, { [key_1 in string]: Op<unknown, unknown, null>; }, null>; };
    }) => Promise<Mutation<Location> | null>;
    /**  Move every map in folder `from` to folder `to`, or to the root when `to` is null. @unstable */
    storeMoveFolder: (from: string, to: string | null) => Promise<null>;
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
     *  Parse a file or pasted text, stage it, and return field-level statistics and preview
     *  positions for the editor import dialog. Call `storeImportFile` to commit the import.
     *  @unstable
     */
    storeImportPreview: (source: ImportSource) => Promise<EditorImportPreview>;
    /**  Import the staged file, dropping chosen fields and tags and applying each supplied tag to every location. @unstable */
    storeImportFile: (droppedFields: string[], tagNames: string[], droppedTags: string[]) => Promise<EditorImportResult>;
    /**  Discard the staged import without importing it. @unstable */
    storeImportCancel: () => Promise<null>;
    /**  The location a pasted Maps URL names, short links resolved. @unstable */
    parseMapsUrl: (input: string) => Promise<ParsedLocation | null>;
    /**  Write the selected locations to a temporary file in `format` and return its path. @unstable */
    storeExport: (selector: Selector$1<SelectionInput>, format: ExportFormat) => Promise<string>;
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
    /**
     *  Restore a map to a previous commit. An open map changes through its normal write path;
     *  a closed one is rewritten on disk and returns null.
     *  @unstable
     */
    storeCheckoutCommit: (mapId: string, commitId: string) => Promise<Mutation<Location> | null>;
    /**  Read a single commit's change: the locations it added, removed and updated. @unstable */
    storeGetCommitDelta: (mapId: string, commitId: string) => Promise<Change<Location>>;
    /**  Record a panorama visit. The history is capped; oldest entries are evicted when full. @unstable */
    storeSeenWrite: (entry: SeenWriteEntry) => Promise<null>;
    /**  Returns a page of seen entries, newest first, and the number of entries matching the filter. @unstable */
    storeSeenList: (limit: number, offset: number, filter: SeenFilter | null, thumbnails: boolean) => Promise<SeenPage>;
    /**  Return all distinct country codes in the seen history, sorted alphabetically. @unstable */
    storeSeenCountries: () => Promise<string[]>;
    /**  Returns all distinct maps that have seen entries, with resolved display names. @unstable */
    storeSeenMaps: () => Promise<SeenMapInfo[]>;
    /**  Deletes all seen history entries. @unstable */
    storeSeenClear: () => Promise<null>;
    /**  List review sessions for a map, newest first, optionally only those with `status` and `sourceKey`. @unstable */
    storeReviewList: (mapId: string, status: string | null, sourceKey: string | null) => Promise<ReviewSession[]>;
    /**
     *  Add, replace, patch or remove review sessions together. Returns each added session as
     *  stored, in order.
     *  @unstable
     */
    storeReviewEdit: (edits: (Op<ReviewSession, Partial<Omit<ReviewSession, "mapId" | "sourceKey" | "sourceProps" | "createdAt" | "updatedAt">> & Pick<ReviewSession, "id">, string>)[]) => Promise<ReviewSession[]>;
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
    /**
     *  Generate locations from a Vali map definition (JSON text). Missing country data is
     *  auto-downloaded like the Vali CLI. A `runId` from `runReserve` lets `runCancel` stop it.
     *  @unstable
     */
    valiGenerate: (definition: string, runId: number | null) => Promise<ValiLocation[]>;
    /**
     *  Download Vali coverage data for a country code or continent alias, or for every country
     *  when `country` is null. A `runId` from `runReserve` lets `runCancel` stop it.
     *  @unstable
     */
    valiDownload: (country: string | null, full: boolean, updates: boolean, runId: number | null) => Promise<null>;
    /**
     *  Countries whose downloaded coverage data is older than the published copy. Fails while
     *  offline; treat that as unknown, not up to date.
     *  @unstable
     */
    valiDataStatus: () => Promise<ValiCountryStatus[]>;
    /**
     *  Download exactly the countries `valiDataStatus` reports as out of date. No-op when nothing
     *  is stale, so the caller can fire it without checking first. A `runId` from `runReserve`
     *  lets `runCancel` stop it.
     *  @unstable
     */
    valiDownloadStale: (runId: number | null) => Promise<null>;
    /**
     *  Start a procedure run under a reserved id over an open map's locations, this window's unless
     *  the target names another. Returns at once, then emits `procedure-progress` and
     *  `procedure-result` as work completes.
     *  @unstable
     */
    procedureRun: (items: RunItem[], target: Target | null, runId: number) => Promise<null>;
    /**  Register a provider, replacing one with the same id. @unstable */
    providerRegister: (provider: ProviderDef) => Promise<null>;
    /**  Remove a registered provider. @unstable */
    providerUnregister: (id: string) => Promise<null>;
    /**
     *  Run a procedure's read-only `query` export. `input` and the result are defined
     *  by the procedure module. A `runId` from `runReserve` streams partial results
     *  under it and lets `runCancel` stop the query.
     *  @unstable
     */
    procedureQuery: (procedure: ProcedureDecl, input: string, runId: number | null) => Promise<string>;
    /**
     *  Reserve an id for a job before starting it, so the results it streams carry the id and
     *  `runCancel` can stop it.
     *  @unstable
     */
    runReserve: () => Promise<number>;
    /**  Stop a run. Work it already finished stays done, and a run that has ended ignores this. @unstable */
    runCancel: (runId: number) => Promise<null>;
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
    collabPresence: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<CollabPresence>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<CollabPresence>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: CollabPresence) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<CollabPresence>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<CollabPresence>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: CollabPresence) => Promise<void>;
    };
    collabSessions: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<CollabSessions>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<CollabSessions>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: CollabSessions) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<CollabSessions>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<CollabSessions>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: CollabSessions) => Promise<void>;
    };
    mapDeleted: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<string>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<string>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: string) => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<string>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<string>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: (payload: string) => Promise<void>;
    };
    mapListChanged: ((target: _tauri_apps_api_webview.Webview | _tauri_apps_api_window.Window) => {
        listen: (cb: __TAURI_EVENT.EventCallback<null>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<null>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: () => Promise<void>;
    }) & {
        listen: (cb: __TAURI_EVENT.EventCallback<null>) => Promise<__TAURI_EVENT.UnlistenFn>;
        once: (cb: __TAURI_EVENT.EventCallback<null>) => Promise<__TAURI_EVENT.UnlistenFn>;
        emit: () => Promise<void>;
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
/**  The answer to a question about the selected locations. */
type Answer = 
/**  The matched ids. */
{
    kind: "ids";
    ids: number[];
} | 
/**  The ids a spaced pick kept, and the spacing in metres it settled on. */
{
    kind: "spacing";
    ids: number[];
    spacingM: number;
} | 
/**  How many locations matched. */
{
    kind: "count";
    count: number;
} | 
/**  The matched locations in full. */
{
    kind: "locations";
    locations: LocationList;
} | 
/**  One column per asked field. */
{
    kind: "columns";
    columns: unknown[][];
} | 
/**  The field's distinct values, sorted. */
{
    kind: "values";
    values: string[];
} | 
/**  The groups, each with its key and ids. */
{
    kind: "groupBy";
    groups: PartitionBucket[];
} | 
/**  The counts, one result per asked field. */
{
    kind: "countBy";
    counts: CountBy[];
} | 
/**  Each field and how many locations hold a value for it. */
{
    kind: "coverage";
    coverage: ([string, number])[];
} | 
/**  The bounding box, or null when nothing matched. */
{
    kind: "bounds";
    bounds: [number, number, number, number] | null;
} | 
/**  The ids of each group of nearby locations. */
{
    kind: "duplicateGroups";
    groups: number[][];
} | 
/**  Per input coordinate, whether a matched location lies near it. */
{
    kind: "nearAny";
    values: boolean[];
} | 
/**  Per given location, whether the map already holds it. */
{
    kind: "held";
    held: boolean[];
};
/**  How long the app took to start and how long it has been running. @unstable */
type AppReady = {
    /**  Milliseconds from app launch until the first window was ready. */
    startupMs: number;
    /**  Seconds since app launch rather than since a window last loaded its page. */
    uptimeSecs: number;
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
 *  One column per field, `null` where a location lacks it; an interned field's column holds
 *  lists of value ids.
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
 *  Counts by a derived key of each field, with how many distinct locations the groups
 *  cover, one result per field.
 */
{
    kind: "countBy";
    fields: string[];
    key: KeySpec;
} | 
/**  How many locations hold a value for each field, key-sorted. */
{
    kind: "coverage";
} | 
/**  Bounding box `[west, south, east, north]`, or `null` when nothing matches. */
{
    kind: "bounds";
} | 
/**  Groups of locations within `distance` metres of each other, two or more per group. */
{
    kind: "duplicateGroups";
    distance: number;
} | 
/**  Per input coordinate, whether any selected location lies within `radiusM` metres. */
{
    kind: "nearAny";
    lats: number[];
    lngs: number[];
    radiusM: number;
} | 
/**  Per given location, whether a selected one is it: same pano, else same exact coordinates. */
{
    kind: "held";
    locations: Location[];
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
/**  How a page of locations is cut into procedure calls. @unstable */
type BatchMode = {
    mode: "chunk";
    size: number;
} | {
    mode: "perRow";
} | 
/**
 *  Group locations by a location field; the procedure sees one representative per distinct
 *  value and its patch fans back out to every location sharing it. v1 key: `panoId`.
 */
{
    mode: "dedupeBy";
    key: string;
};
/**  Where the camera looks: the heading it faces and its pitch off level, in degrees. @unstable */
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
/**  A map change broadcast to subscribers, with the keys it changed and derived state. */
type ChangeEvent = {
    /**  The map version this change brought the map to. */
    version: number;
    /**  How the derived state moved, as a JSON Patch over what the window holds. */
    patch: PatchOp[];
} & Keys<number>;
/**  A map in this app copied from another app's, and where it came from. @unstable */
type CollabCopy = {
    /**  This app's map. */
    map: string;
    /**  Where it came from. */
    origin: Origin;
};
/**
 *  What someone else in the session on this app's map `map` shows everyone, sent each time
 *  they show something new.
 *  @unstable
 */
type CollabPresence = {
    /**  This app's map the session edits. */
    map: string;
    /**  Who shows it. */
    login: string;
    /**  What they show. */
    data: Shown;
};
/**  A map this app hosts or follows, as the people in it see it. @unstable */
type CollabSession = {
    /**  This app's map the session edits. */
    map: string;
    /**  The login hosting the map. */
    host: string;
    /**  The login this app is in the session as. */
    you: string;
    /**  Whether this app is the host. */
    hosting: boolean;
    /**  Everyone in the session, the host first. */
    roster: Member[];
    /**  How this app's connection to the session stands. */
    link: SessionLink;
};
/**
 *  Every collab session this app is in and every map it copied from another app's, sent
 *  whenever a session changes.
 *  @unstable
 */
type CollabSessions = {
    /**  The sessions, each on one of this app's maps. */
    sessions: CollabSession[];
    /**  The copies of other apps' maps. */
    copies: CollabCopy[];
};
/**  Metadata for a single commit. @unstable */
type CommitInfo = {
    id: string;
    mapId: string;
    parentId: string | null;
    message: string | null;
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
/**  How a location renders into a map-making JSON coordinate object. @unstable */
type CoordOpts = {
    exportZoom: boolean;
    exportUnpanned: boolean;
    /**  How much of the map the file keeps. */
    shape: MapShape;
};
/**  Result of copying locations to another map. @unstable */
type CopyToMapResult = {
    copied: number;
    skipped: number;
};
/**
 *  Group counts. A list field puts one location in several groups, so the counts do not sum to
 *  the locations grouped.
 */
type CountBy = {
    counts: ([string, number])[];
    /**  Locations held by at least one group. */
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
    /**  Value records across every map and field. */
    values: number;
    commits: number;
    /**  Bytes the metadata database occupies, its write-ahead log included. */
    dbSizeBytes: number;
    /**  Bytes every map's location data occupies, saved commits included. */
    locationSizeBytes: number;
    journalMode: string;
    foreignKeys: boolean;
};
/**
 *  The derived state a window holds: everything about the open map besides its rows. Opening a
 *  map sends it whole; every change after sends a JSON Patch over it.
 */
type Derived = {
    locationCount: number;
    /**  Location changes since the last commit. */
    pending: Counts;
    /**  The map's own details. */
    map: Omit<MapMeta, "extra" | "locationCount" | "pending">;
    history: Partial<{
        [key in Timeline]: History;
    }>;
    /**  Every held value, keyed by field and value. */
    fieldValues: {
        [key in string]: {
            [key in string]: HeldValue;
        };
    };
    /**  The extra-field registry. */
    fieldDefs: {
        [key in string]: FieldDef;
    };
    /**  Resolved count per selection node, keyed by `Selection.key` (top-level and nested). */
    selectionCounts: {
        [key in string]: number;
    };
    /**  The listed selections, keyed by `Selection.key`. */
    selectionRows: {
        [key in string]: ListedSelection;
    };
    /**  The keys of the listed selections, in list order. */
    selectionOrder: string[];
    /**  Pending layers that procedure work is currently writing to. */
    writingLayers: string[];
    /**  Whether the map has changes not yet saved to disk. */
    unsaved: boolean;
};
/**  What the user needs in order to authorize: the code to type and where to type it. */
type DeviceCodeInfo = {
    userCode: string;
    verificationUri: string;
    /**  Seconds until `userCode` stops working. */
    expiresIn: number;
};
/**  What a location edit did. @unstable */
type EditResult = {
    /**  The version the edit reached and the keys it assigned. */
    mutation: Mutation;
    /**  Derived fields the edit cleared because a field they are computed from changed. */
    invalidated: string[];
};
/**  What an edit did, answering the `Edits` variant it was. @unstable */
type Edited = 
/**  What the location edit did. */
(({
    locations: EditResult;
}) & {
    selections?: never;
    values?: never;
}) | (
/**  The version the value edit reached and the keys its new records took. */
({
    values: Mutation<ValueRecord>;
}) & {
    locations?: never;
    selections?: never;
}) | (
/**  The version the selection edit reached. */
({
    selections: Mutation<ListedSelection>;
}) & {
    locations?: never;
    values?: never;
});
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
    /**  The pending layer the staged locations are read through until the import lands. */
    target: Target;
    /**  The ids the staged locations were given, in the order the file lists them. */
    keys: IdRange<Location>;
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
};
/**  A change to the map: its locations, an interned field's values, or the selection list. */
type Edits = 
/**
 *  Locations where `target` says. Rows refer to interned values such as tags by their ids
 *  in `records`; each is matched to the map's value of the same name, created when missing.
 */
(({
    locations: {
        target: Target;
        edits: Rows;
        records: {
            [key in string]: {
                [key in number]: ValueRecord;
            };
        };
    };
}) & {
    selections?: never;
    values?: never;
}) | (
/**  One interned field's value records; membership uses location edits. */
({
    values: {
        field: string;
        edits: (Op<ValueRecord, Partial<ValueRecord> & Pick<ValueRecord, "id">, number>)[];
    };
}) & {
    locations?: never;
    selections?: never;
}) | (
/**  The selection list. */
({
    selections: SelectionEdit;
}) & {
    locations?: never;
    values?: never;
});
/**  The kind of file an export writes, with what that kind needs. @unstable */
type ExportFormat = 
/**  A `{name, customCoordinates}` map file with its interned values' records and field definitions. */
({
    format: "json";
} & JsonExport) | 
/**  A minimal lat/lng CSV file. */
{
    format: "csv";
} | 
/**  A GeoJSON FeatureCollection of points, each carrying its tag names in `properties.tags`. */
{
    format: "geojson";
};
/**  Progress of a bulk export, emitted once per map. @unstable */
type ExportProgress = {
    current: number;
    total: number;
    mapName: string;
};
/**  Why an expression failed to parse. @unstable */
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
 *  One member of an enumerable field's value space: the stored value plus its display
 *  name. The value is the identity, so a rename is a label change and membership is
 *  untouched.
 */
type FieldChoice = {
    value: string;
    label: string | null;
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
    values: FieldChoice[] | null;
    /**  How this field is compared during disambiguation. `null` infers it from the field type. */
    comparison: ComparisonType | null;
    /**  The field's values are ids the map allocates, each wearing its own display record. */
    interned?: boolean;
};
/**  A map file as the link picker shows it. @unstable */
type FileSource = {
    /**  The name the file gives its map; empty when it names none. */
    name: string;
    locationCount: number;
};
/**
 *  A filter's predicate: the operator with its operands.
 *  The range operators can read a date in the location's own timezone (`tzLocal`); the
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
    /**  How many locations hold the value. */
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
/**  Ids handed out together, one after another. @unstable */
type IdRange<_T> = {
    /**  The first id in the run. */
    first: number;
    /**  How many ids the run holds. */
    len: number;
};
/** @unstable */
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
/**  Progress of a bulk import, emitted once per map. @unstable */
type ImportProgress = {
    current: number;
    total: number;
    mapName: string;
};
/**  Where an editor import reads its locations from. @unstable */
type ImportSource = 
/**  A JSON or CSV file at this path. */
(({
    path: string;
}) & {
    text?: never;
}) | (
/**  Pasted JSON or CSV text, refused when it holds no locations. */
({
    text: string;
}) & {
    path?: never;
});
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
    avatarUrl?: string | null;
    body: string;
    /**  ISO-8601, as GitHub returns it. */
    createdAt: string;
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
    /**  Who filed it. A comment by the same author is the reporter's own. */
    author?: string;
    /**  Whether maintainers have closed it to new comments. */
    locked?: boolean;
    /**  The report as it was filed. */
    body?: string;
    /**  Oldest first. */
    comments: IssueComment[];
};
/**  What happened when this app tried to join a map. @unstable */
type JoinOutcome = 
/**  Joined, following the host into this app's map `map`. */
{
    outcome: "following";
    map: string;
} | 
/**
 *  This app's copy `map` was edited since its last session, so joining would replace those
 *  edits; join again with `replace` to go ahead.
 */
{
    outcome: "edited";
    map: string;
};
/**  A map-making JSON export: how its coordinates render, and the map they belong to. @unstable */
type JsonExport = {
    mapName: string;
    extraFieldsJson: string | null;
} & CoordOpts;
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
 *  This is the atomic unit of data in the system. Locations are stored in columns
 *  on disk and addressed by `id` everywhere. The `id` is unique
 *  within a map and assigned by the store's monotonic allocator.
 */
type Location = {
    /**  Unique within a map, and given by the map when the location is added. */
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
type LocationList = 
/**  The locations themselves. */
{
    kind: "inline";
    locations: Location[];
} | 
/**  A file holding the locations as a JSON array. */
{
    kind: "file";
    path: string;
};
/**  Operations computed independently for each selected location. @unstable */
type LocationOp = 
/**
 *  Rename `from` into `to`. Merge is the same operation -- rename is just the case
 *  where nothing holds `to` -- so `winner` decides only where a location holds both.
 */
{
    kind: "move";
    from: string;
    to: string;
    winner: MergeWinner;
} | 
/**  Drop `keys` from every location that has them. */
{
    kind: "delete";
    keys: string[];
} | 
/**
 *  Assign a value to a writable field on each location. Builtins update their stored
 *  fields; other keys update `extra`.
 */
{
    kind: "set";
    key: string;
    value: unknown;
} | 
/**
 *  Assign `key = expr(location)` per location. A location where the expression cannot evaluate (a
 *  missing or non-numeric field, a non-finite result) is reported back by id.
 */
{
    kind: "expr";
    key: string;
    expr: string;
} | 
/**
 *  Add and remove list members. `add` wins if a value appears in both lists.
 *  Locations already in the requested state keep their member order.
 */
{
    kind: "listSet";
    key: string;
    add: unknown[];
    remove: unknown[];
};
/**  A map was deleted, so anything holding it open lets it go. @unstable */
type MapDeleted = string;
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
/**  The list of maps changed, so it should be read again. @unstable */
type MapListChanged = null;
/**  Full metadata for a map. */
type MapMeta = {
    id: string;
    name: string;
    description: string;
    folder: string | null;
    settings: MapSettings;
    scoreBounds: ScoreBounds;
    extra: MapExtra;
    labels: string[];
    /**  What each plugin keeps with this map on this device alone, by plugin id and then key. */
    localPluginData: {
        [key in string]: {
            [key in string]: unknown;
        };
    };
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
/**
 *  Someone in a session: the login their room vouched for, and whether they joined as a guest
 *  with an invite code rather than an account.
 *  @unstable
 */
type Member = {
    /**  Their login. */
    login: string;
    /**  Whether they joined with an invite code. */
    guest: boolean;
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
/**  The version a write reached and the keys it assigned. Other updates arrive on the change feed. */
type Mutation<_T = Location> = {
    /**  The map version this change brought the map to. */
    version: number;
    /**  The key the store gave each keyless set, in the order they were written. */
    keys: number[];
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
/**  An edit to one keyed row: add it, replace it, patch it, or remove it. */
type Op<T, P, K> = 
/**  A new row, given the next free key in place of the one it carries. */
(({
    add: T;
}) & {
    put?: never;
    remove?: never;
    set?: never;
}) | (
/**  The row exactly as given. */
({
    set: T;
}) & {
    add?: never;
    put?: never;
    remove?: never;
}) | (
/**  A patch written over the row it names. */
({
    put: P;
}) & {
    add?: never;
    remove?: never;
    set?: never;
}) | (
/**  The row at this key removed. */
({
    remove: K;
}) & {
    add?: never;
    put?: never;
    set?: never;
});
/**  Where a copy of another app's map came from. @unstable */
type Origin = {
    /**  The login of the app that hosts the map. */
    host: string;
    /**  The map's id on its host. */
    map: string;
    /**  The login this app followed it as. */
    login: string;
    /**  What the copy held when its last session ended. */
    parted: string | null;
    /**  How this app joins the map again. */
    via: Via;
};
/**  A decoded Street View panorama: flat data with no live objects. @unstable */
type Pano = {
    /**  This image's own pano id, "" when the response carries no key. */
    id: string;
    /**  Which imagery collection the id belongs to; also what `extra.panoType` stores. */
    panoFrontend: number;
    lat: number;
    lng: number;
    altitude: number;
    /**  The camera's orientation. Google Maps builds its whole tile frame out of this. */
    pov: Pov | null;
    worldSize: ImageSize;
    tileSize: ImageSize;
    copyright: string;
    /**  `description.description[].text`, joined with ", ". */
    description: string;
    /**  The first of those parts alone, which is what Google Maps calls the short description. */
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
/** @unstable */
type PanoDate = {
    year: number;
    month: number;
    day: number;
};
/** @unstable */
type PanoLink = {
    panoId: string;
    heading: number;
};
/**  One pano lookup: a pano id resolves over GetMetadata, a search over SingleImageSearch. @unstable */
type PanoQuery = IdQuery | SearchQuery;
/** @unstable */
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
 *  `[lo, hi]` bounds, so a live Filter can be rebuilt for whole-map gradients.
 */
type PartitionBucket = {
    key: string;
    ids: number[];
    bin: [number, number] | null;
};
/**  One operation of a JSON Patch (RFC 6902). Paths are JSON Pointers (RFC 6901). */
type PatchOp = 
/**  Put `value` at `path`, replacing a member already there or inserting into an array. */
{
    op: "add";
    path: string;
    value: unknown;
} | 
/**  Remove the value at `path`. */
{
    op: "remove";
    path: string;
} | 
/**  Replace the value at `path`, which must exist. */
{
    op: "replace";
    path: string;
    value: unknown;
} | 
/**  Remove the value at `from` and add it at `path`. */
{
    op: "move";
    from: string;
    path: string;
} | 
/**  Add a copy of the value at `from` at `path`. */
{
    op: "copy";
    from: string;
    path: string;
} | 
/**  Fail the patch unless the value at `path` equals `value`. */
{
    op: "test";
    path: string;
    value: unknown;
};
/**  A published build of a plugin. @unstable */
type PluginBuild_Deserialize = {
    version: string;
    ref: string;
    minAppVersion: string | null;
    /**  The sidecar this build ships, so a half-installed one can be repaired. */
    sidecar?: PluginSidecar | null;
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
    sidecar?: PluginSidecar | null;
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
/**  A plugin's declared sidecar binary (downloaded from GitHub Releases on install). */
type PluginSidecar = {
    name: string;
    version: string;
};
/**  How points are drawn inside a polygon. @unstable */
type PointSampling = 
/**  Up to `count` points uniformly at random, fewer when the polygon fills little of its bounding box. */
{
    kind: "random";
    count: number;
} | 
/**  Points no two closer than `spacingM` metres and no gap wider than about twice that, in random order. */
{
    kind: "poisson";
    spacingM: number;
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
/** @unstable */
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
    /**
     *  The fields the run wants written, extra-field keys and core columns alike. Empty means
     *  every field the procedure produces.
     */
    fields: string[];
    /**  Recompute locations that already hold every wanted field. */
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
     *  Locations counted as done without being worked, because they already held every field
     *  the provider produces. Callers subtract these to report what a run actually did.
     */
    skipped: number;
    finished: boolean;
};
/**
 *  What one page hands back to the caller: a `Collect` provider's answers, delivered
 *  instead of being written, and for every sink the locations that failed. Emitted only when
 *  there is something in it.
 *  @unstable
 */
type ProcedureResult = {
    runId: number;
    providerId: string;
    entries: ResultEntry[];
    /**  Locations the procedure failed, or every location of a batch whose call failed. */
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
 *  One provider as the app declares it. `fields` are the fields it writes and `requires`
 *  the fields it reads; together they gate who waits for whom.
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
    /**  Recompute locations that already hold every field this provider writes. */
    force?: boolean;
    /**
     *  Instances this provider may run at once. Declared only when the procedure
     *  cannot run beside itself; throughput comes from `inflight`.
     */
    instances?: number | null;
} & ProcedureDecl;
/**  A provider as registered: the procedure it runs, the fields it writes and the fields it reads. @unstable */
type ProviderDef = {
    id: string;
    /**  Name shown while it runs. */
    label?: string | null;
    /**  Extra-field keys it produces. */
    fields?: string[];
    /**  Core columns it writes, such as `panoId`. */
    provides?: string[];
    /**  Fields it reads. Changing one clears what this provider wrote. */
    requires?: string[];
    batch: BatchMode;
    /**  Instances it may run at once, when it cannot run beside itself. */
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
    markerStyle?: string;
};
/** @unstable */
type ReportRef = {
    number: number;
    url: string;
    /**
     *  Grants read access to an anonymous report's relayed comments. Not a credential for anything
     *  else, which is why it is safe to keep in local storage. Null for a signed-in report.
     */
    token: string | null;
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
/**  A location edit's rows: sent with it, or uploaded beforehand in chunks. */
type Rows = 
/**  The rows themselves. */
(Op<Location, Partial<Location> & Pick<Location, "id">, number>)[] | 
/**  The rows uploaded to the session `storeUploadBegin` opened. */
{
    session: string;
};
/**  One item of a run: a registered provider, or a procedure that is not one. @unstable */
type RunItem = 
/**  A registered provider, with what this run sets on it. */
{
    kind: "provider";
    id: string;
    /**  The extra-field keys to produce, from those the provider declares. */
    fields: string[];
    select: Selector$1<SelectionInput>;
    /**  Replaces the registered configuration, as JSON text. */
    config?: string | null;
    /**  Recompute locations that already hold every field it writes. */
    force?: boolean;
} | (
/**  A procedure declared in full by the caller. */
{
    kind: "procedure";
} & ProviderDecl);
/** @unstable */
type SavedSelection = {
    selector: Selector$1;
    /**
     *  Each interned field's value ids and the names they carried when saved, which carry a
     *  rule's value tests from one map to another.
     */
    valueNames: ValueNames;
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
 *  The full SingleImageSearch request surface. Every optional field defaults to what
 *  Google Maps sends for `getPanorama({location, radius})`.
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
/**  A page of seen entries, newest first, and how many entries match the filter in all. @unstable */
type SeenPage = {
    entries: SeenEntry[];
    total: number;
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
/**  An edit of the selection tree as asked for: a saved selection to add, or a plain edit. */
type SelectionEdit = 
/**  Add a saved selection's parts, with its value names resolved against the open map. */
{
    kind: "addSaved";
    id: string;
} | 
/**  Any other edit of the selection tree. */
SelectionOp;
type SelectionInput = {
    selector: Selector$1<SelectionInput>;
    color?: RGB | null;
};
type SelectionOp = {
    kind: "add";
    selections: SelectionInput[];
} | {
    kind: "set";
    selections: SelectionInput[];
} | {
    kind: "remove";
    keys: string[];
} | {
    kind: "toggle";
    selections: SelectionInput[];
} | {
    kind: "manual";
    id: number;
} | {
    kind: "active";
    op: SelectionOp;
} | 
/**  Join the listed selections named by `keys`, or every one when null, into one group. */
{
    kind: "combine";
    group: Group;
    keys: string[] | null;
} | 
/**
 *  Replace the listed selections named by `keys`, or every one when null, with the
 *  locations none of them selects.
 */
{
    kind: "complement";
    keys: string[] | null;
} | {
    kind: "ghost";
    index: number;
} | {
    kind: "isolate";
    index: number;
} | {
    kind: "ghostAll";
} | {
    kind: "invert";
    path: number[];
} | {
    kind: "compose";
    drag: number[];
    drop: number[];
    group: Group;
} | {
    kind: "move";
    from: number[];
    to: number[];
    place: Place;
} | {
    kind: "removeAt";
    path: number[];
} | {
    kind: "replace";
    path: number[];
    selection: SelectionInput;
} | {
    kind: "color";
    path: number[];
    color: RGB;
} | {
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
    mode: ReviewMode;
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
 *  Unscorable locations rank last; without `k`, all child locations are kept.
 */
{
    type: "Ranked";
    /**  What to rank; `null` ranks the whole map. */
    selection: S | null;
    expr: string;
    k: number | null;
    ascending: boolean;
} | 
/**  `n` locations of a selection drawn uniformly at random, without replacement. */
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
/**  The locations of a selection within `radiusM` metres of a coordinate. */
{
    type: "Nearby";
    /**  Where to look; `null` looks over the whole map. */
    selection: S | null;
    lat: number;
    lng: number;
    radiusM: number;
} | 
/**  The location of a selection closest to a coordinate. */
{
    type: "Nearest";
    /**  Where to look; `null` looks over the whole map. */
    selection: S | null;
    lat: number;
    lng: number;
};
/**  How a session's connection stands. @unstable */
type SessionLink = 
/**  Waiting for the host to come online. */
{
    state: "waiting";
} | 
/**  Connecting to the host. */
{
    state: "connecting";
} | 
/**  Connected, and receiving the map from the host. */
{
    state: "syncing";
} | 
/**  Connected. */
{
    state: "live";
} | 
/**  The connection dropped and is being made again. */
{
    state: "reconnecting";
} | 
/**  The session is over, and why. */
{
    state: "ended";
    reason: string;
};
/**  Operations computed over the selected locations as a group. @unstable */
type SetOp = 
/**
 *  Merge each group into its best-scored location, which keeps its id and takes in the
 *  others' list values and extra fields.
 */
{
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
/**  A map the signed-in user shares, and with whom. @unstable */
type Share = {
    /**  The shared map. */
    map: string;
    /**  The map's name as it was shared. */
    name: string;
    /**  The GitHub logins it is shared with. */
    logins: string[];
    /**  The code that lets guests without a GitHub account join, while it is on. */
    invite?: string | null;
};
/**  A map someone shares with the signed-in user, and whether they host it now. @unstable */
type Shared = {
    /**  The GitHub login sharing the map. */
    host: string;
    /**  The shared map, as its host knows it. */
    map: string;
    /**  The map's name as it was shared. */
    name: string;
    /**  Whether the host is online with the map now. */
    live: boolean;
};
/**  The maps the signed-in user shares, and the maps shared with them. @unstable */
type Shares = {
    /**  The maps the signed-in user shares. */
    mine: Share[];
    /**  The maps others share with the signed-in user. */
    withMe: Shared[];
};
/**  What someone shows everyone else in a session, which only the plugin reads. @unstable */
type Shown = unknown;
/** @unstable */
type SideCounts = {
    create: number;
    update: number;
    delete: number;
};
/** @unstable */
type SidecarDone = {
    runId: number;
    error: string | null;
};
/** @unstable */
type SidecarLine = {
    runId: number;
    line: string;
};
/**  A log line from a plugin's sidecar. @unstable */
type SidecarLog = {
    runId: number;
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
/**  What the store has to warn the user about. @unstable */
type StoreWarning = 
/**  The uncommitted delta was unreadable; the map opened from its last commit. */
{
    kind: "deltaSetAside";
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
};
/**  Read or edit map rows directly, or through a named pending layer. */
type Target = 
/**  A map's rows. */
{
    kind: "map";
    /**  The map, or this window's map when null. */
    id?: string | null;
} | 
/**
 *  A pending layer, created on first use. Reads include current underlying map data;
 *  edits reach the map when the layer lands.
 */
{
    kind: "pending";
    name: string;
};
/**  Limit a spaced pick by count or minimum spacing. */
type Thinning = 
/**  At most `n` locations. */
{
    by: "count";
    n: number;
} | 
/**  Locations about `m` metres apart. */
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
/**  The names interned values carried, by field and then id. @unstable */
type ValueNames = {
    [key in string]: {
        [key in number]: string;
    };
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
/**  How this app reaches a map another app hosts. @unstable */
type Via = 
/**  By its host and its id there, as an account the map is shared with. */
(({
    host: string;
    map: string;
}) & {
    code?: never;
}) | (
/**  By the invite code its host gave, as a guest. */
({
    code: string;
}) & {
    host?: never;
    map?: never;
});
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
    /**  Locations the work edited. */
    changed: number;
    /**  Locations an expression could not evaluate. */
    failed: number[];
};
/** @unstable */
export type __TAURI_VARIANT<V> = {
    [K in keyof V]-?: [V[K]] extends [undefined] ? never : K;
}[keyof V];
/** The member of `R` answering the variant `V` was sent as. @unstable */
type ReplyTo<R, V> = Extract<R, Record<__TAURI_VARIANT<V>, unknown>>[__TAURI_VARIANT<V> & keyof Extract<R, Record<__TAURI_VARIANT<V>, unknown>>];

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
/** Persistent key-value storage namespaced to a plugin. Survives restarts. @api */
declare function storage(id: string): PluginStorage;
/** Persistent key-value storage a plugin keeps with the open map, so every map has its own.
 *  Each write changes only one key, patched onto the current map settings. @api */
declare function mapStorage(id: string): MapPluginStorage;
/** One typed value in a plugin's persistent store, read anywhere and live in React. @api */
interface PluginSetting<T> {
    /** The stored value, or the fallback while nothing of its type is stored. */
    get(): T;
    set(value: T): void;
    /** React hook: the value and its setter, re-rendering on every write. */
    use(): readonly [T, (value: T) => void];
    /** Call `listener` with each new value; returns the unsubscribe. */
    on(listener: (value: T) => void): () => void;
}
/** A typed value under `key` in the plugin's persistent store. A stored value of another
 *  type than `fallback` reads as `fallback`. @api */
declare function pluginSetting<T>(pluginId: string, key: string, fallback: T): PluginSetting<T>;
/** React state hook backed by the plugin's persistent store. Survives sidebar
 *  unmount and app restart. Values are global, not per-map. @api */
declare function usePluginState<T>(pluginId: string, key: string, initial: T | (() => T)): readonly [T, (action: SetStateAction<T>) => void];

/**
 * The global `mma` API available inside procedure modules. Calls are synchronous;
 * pass request lists for concurrency. `map` and `run` receive locations;
 * `query` handles read-only requests. Each entry point receives `{ fields, force, config }`.
 * Results are location patches under `patch`, or module-defined answers under `collect`.
 */

/** @api @unstable */
interface ProcedureRequest {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | ArrayBuffer;
}
/** @api @unstable */
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
/** @api @unstable */
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

/** The GitHub account the user is signed in with, and signing in or out of it. @api */
declare const Account: {
    /** The signed-in GitHub account, or null when signed out or unreachable. */
    me: () => Promise<GhUser | null>;
    /** React hook: the signed-in GitHub account, null when signed out, and undefined until first known. */
    use: () => GhUser | null | undefined;
    /** Sign in with GitHub: `onCode` receives the code the user enters in the browser page this opens, which is also copied to the clipboard. */
    signIn: (onCode: (code: DeviceCodeInfo) => void) => Promise<GhUser>;
    /** Sign out of GitHub and forget the stored session. */
    signOut: () => Promise<void>;
};

/** Debounced persistence of the open map: schedule, hold, cancel, or flush it. @api */
declare const Autosave: {
    /** What defers autosave while held. Useful for batches that land many mutations. @unstable */
    paused: {
        hold: () => (() => void);
        held: () => boolean;
    };
    /** Schedule a debounced autosave. Mutations call this automatically. @unstable */
    schedule: () => void;
    /** Cancel any pending autosave timer. @unstable */
    cancel: () => void;
    /** Wait until every save and background commit started so far has finished. @unstable */
    waitForInflight: () => Promise<void>;
    /** Run `write` once every save started so far has finished, and hold later saves until it does.
     *  Writes to the map's files that must not interleave with a save go through here. @unstable */
    exclusive: <T>(write: () => Promise<T>) => Promise<T>;
    /** Save any unsaved changes now instead of waiting for the timer. @unstable */
    flush: () => Promise<void>;
};

/** An [r, g, b, a] byte tuple. @unstable */
export type RGBA = [...RGB, number];
/** Hue in degrees, saturation and lightness in percent. @unstable */
export type HSL = {
    h: number;
    s: number;
    l: number;
};
/** Parse "#rrggbb" or "#rgb" to an [r, g, b] byte tuple; black when it is not hex. @api @unstable */
declare function hexToRgb(hex: string): RGB;
/** Return "#000" or "#fff" for readable text on the given hex background. @api @unstable */
declare function textColorFor(bg: string): string;
/** WCAG relative luminance of a color, from 0 for black to 1 for white. @api @unstable */
declare function luminance(rgb: RGB): number;
/** `color` moved toward white on a dark `background`, or black on a light one, until the two
 *  reach WCAG AA contrast. @api @unstable */
declare function legible(color: RGB, background: RGB): RGB;
/** Resolve an SV coverage color to hex. Accepts "#rrggbb" or a CSS custom-property
 *  ramp name (legacy stored format). @api @unstable */
declare function resolveSvColorHex(color: string): string;
/** Convert "#rrggbb" to HSL. @api @unstable */
declare function hexToHsl(hex: string): HSL;
/** Convert HSL to "#rrggbb". @api @unstable */
declare function hslToHex({ h, s, l }: HSL): string;
/** Convert HSL (h in degrees, s and l in 0-1) to an RGB byte tuple. @api @unstable */
declare function hslToRgb(h: number, s: number, l: number): RGB;
/**
 * Deterministic tag color from a name.
 * @api @unstable
 */
declare function colorForName(name: string): string;
/** Format an RGB tuple as a CSS `rgb(r, g, b)` string. @api @unstable */
declare function rgbCss([r, g, b]: RGB): string;
/** Convert an RGB byte tuple to "#rrggbb". @api @unstable */
declare function rgbToHex(rgb: RGB): string;
/** A label's color: a user override if set, else a deterministic color from its name. @api @unstable */
declare function labelColor(name: string, overrides: Record<string, string>): string;

export type Cmd = typeof commands;
/** Every backend command, typed. Any of them can change in a release. @api @unstable */
declare const cmd: Cmd;

/** Save and restore map versions. @api */
declare const Commit: {
    /** Commit all pending changes to the map's version history. Clears the undo stack. */
    create: (message?: string) => Promise<string>;
    /** Commit `mapId` in the background once pending saves finish. @unstable */
    background: (mapId: string, message: string) => void;
    /** Restore a previous commit as a new revert commit and refresh the view. Clears undo/redo. @unstable */
    checkout: (commitId: string) => Promise<void>;
};

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
/** A value that was produced. */
declare class Ok<T> {
    readonly status = "ok";
    readonly value: T;
    constructor(value: T);
    /** The value, or null when there is none. */
    ok(): T;
    /** The same state with its value transformed by `f`. */
    map<U>(f: (value: T) => U): Ok<U>;
}
/** The error that kept a value from being produced. */
declare class Err<E = Error> {
    readonly status = "error";
    readonly error: E;
    constructor(error: E);
    ok(): null;
    map(_f: (value: never) => unknown): this;
}
/** A value still being produced. */
declare class Loading {
    readonly status = "loading";
    ok(): null;
    map(_f: (value: never) => unknown): this;
}
/** Work stopped before it produced anything, by a newer run or on request. */
declare class Cancelled {
    readonly status = "cancelled";
    ok(): null;
    map(_f: (value: never) => unknown): this;
}
/** Work that has not started. */
declare class Idle {
    readonly status = "idle";
    ok(): null;
    map(_f: (value: never) => unknown): this;
}
/** Work under way, with the last progress it reported. */
declare class Running<P> extends Loading {
    readonly progress: P | null;
    constructor(progress?: P | null);
}
/** A value, or the error that kept it from being produced. */
export type Result<T, E = Error> = Ok<T> | Err<E>;
/** How a run ended: its result, or cancelled. */
export type Settled<T, E = Error> = Result<T, E> | Cancelled;
/** Work someone starts: not yet, under way, or how it ended. */
export type JobState<T, P = never, E = Error> = Idle | Running<P> | Settled<T, E>;

type Selector = Parameters<Cmd["storeRead"]>[1];

/** A field definition with every optional attribute spelled absent. @api */
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
/** True when bounds span the entire world. @api */
declare function isWorldBounds(b: Bounds): boolean;
/** Convert a [south, west, north, east] tuple to a Bounds object. @api @unstable */
declare function scoreTupleToBounds([s, w, n, e]: [number, number, number, number]): Bounds;
/** Convert a [west, south, east, north] bbox tuple to Bounds, or null. @api @unstable */
declare function bboxTupleToBounds(t: [number, number, number, number] | null): Bounds | null;
/** Convert a Bounds object to a [south, west, north, east] tuple. @api @unstable */
declare function boundsToScoreTuple(b: Bounds): [number, number, number, number];
/** Pinned: the location always opens this exact pano. @api */
declare function isPinned(loc: Location): loc is Location & {
    panoId: string;
};
/** The location pinned to the pano it carries, or unpinned to float on default coverage. @api */
declare function setPinned(loc: Location, on: boolean): Location;
/** A full location or just its id (to be fetched on demand). */
export type MaybeLocation = Location | number;
/** Extract the id from a MaybeLocation. @api */
declare function locId(m: MaybeLocation): number;
/** Build a new Location from lat/lng plus overrides. Its `id` is 0, whatever the
 *  overrides hold; adding it to the map returns its real id. @api */
declare function createLocation(partial: Partial<Location> & LatLng): Location;
/** A new Location at the viewer's live camera, carrying `source`'s flags, tagged `tagNames`
 *  through `records`, which the map it lands in matches to its own tags by name. `extra`
 *  describes the pano it was fetched for, so it only survives a drop that stayed on that
 *  pano. @api @unstable */
declare function dropLocation(source: Location, live: PanoCapture, panoId: string | null, tagNames: string[]): {
    location: Location;
    records: {
        tags: Record<number, ValueRecord>;
    };
};
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

/** Commit-diff preview state shown while `workArea === "diff"`. Position arrays are
 *  interleaved `[lng, lat]` Float32Arrays. @unstable */
export interface CommitDiffPreview {
    hash: string;
    counts: Counts;
    added: Float32Array;
    removed: Float32Array;
    updated: Float32Array;
}
/** Uncommitted changes and their preview on the map. @api @unstable */
declare const CommitDiff: {
    /** Whether there are uncommitted changes (adds, removes, or updates). @unstable */
    has: () => boolean;
    /** React hook: the uncommitted add/remove/modify counts. @unstable */
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

export type Of<K extends string> = Extract<Edits, Record<K, unknown>>[K];
/** Edit map locations, metadata, value records, and selections. @api */
declare const Edit: {
    /** Edit locations on a map or in a pending layer, with the rows themselves or the session
     *  they were uploaded to (see `storeUploadBegin`). Rows refer to interned values such as tags
     *  by their ids in `records`, matched to the map's by name. Map changes are undoable in that
     *  map. @unstable */
    locations: (target: Target, edits: Of<"locations">["edits"], records?: Of<"locations">["records"]) => Promise<EditResult>;
    /** Patch a map's metadata and persist it: the open map's unless the patch names an `id`.
     *  Settings merge key by key, so send only the keys that change. */
    meta: (patch: Omit<Parameters<typeof cmd.storeUpdateMapMeta>[0], "id"> & {
        id?: string;
    }) => Promise<void>;
    /** Edit an interned field's value records in one undoable step. */
    values: (field: string, edits: Of<"values">["edits"]) => Promise<Mutation<ValueRecord>>;
    /** Edit the selection list. Wrap an op in `{ kind: "active", op }` to affect only active
     *  selections. @unstable */
    selections: (op: Of<"selections">) => Promise<Mutation<ListedSelection>>;
    /** Run `op` across every location `selector` matches on a map or in a pending layer. Map
     *  changes are one undoable step. @unstable */
    work: (selector: Selector, op: Work, target?: Target) => Promise<WorkResult>;
};

/** Run mutations and wait for their state and display updates. @api */
declare const Mutation: {
    /** The result of a mutation that reached no map. */
    none: () => Mutation;
    /** Resolves once the open map's state and its markers both show `m`. A mutation that reached
     *  no map (version 0) settles at once. */
    settle: (m: Mutation) => Promise<void>;
    /** Send a store write, then wait until the open map shows it. */
    write: <R extends Mutation | {
        mutation: Mutation;
    } | null>(fn: () => Promise<R>) => Promise<R>;
    run: <R extends Mutation | {
        mutation: Mutation;
    } = Mutation>(fn: () => Promise<R>, ...fallback: Mutation extends R ? [empty?: R] : [empty: R]) => Promise<R>;
};

export type AnswerOf<K extends Answer["kind"]> = Extract<Answer, {
    kind: K;
}>;
export type Payload<T> = {
    [K in keyof T]: Exclude<keyof T, K> extends never ? T[K] : T;
}[keyof T];
export type Materialized<T> = T extends LocationList ? Location[] : T;
export type ReadResult<A extends Answer> = A extends Answer ? Materialized<Payload<Omit<A, "kind">>> : never;
/** Read locations and summaries for a selector. @api */
declare const Query: {
    /** Ask one question about the locations `selector` matches. A full-location answer loads any
     *  backing file automatically; ask for ids or columns when full locations are unnecessary. */
    read: <A extends Ask>(selector: Selector, ask: A, target?: Target) => Promise<ReadResult<AnswerOf<A["kind"]>>>;
    /** The locations an answer carries, fetched from its temp file when it was too large to send inline. */
    locationsOf: (list: LocationList) => Promise<Location[]>;
};

/** @unstable */
export type LocationEdits = Parameters<typeof Edit.locations>[1];
/** @unstable */
export type LayerRead = <A extends Ask>(selector: Selector, ask: A) => Promise<ReadResult<AnswerOf<A["kind"]>>>;
/** A pending layer. Operations run in order; work still writing to a landed layer outlives close. @api @unstable */
declare class Layer {
    readonly target: Extract<Target, {
        kind: "pending";
    }>;
    private readonly queue;
    private closed;
    private readonly mapId;
    private constructor();
    /** Create a layer and stage its first edits. */
    static open(edits?: LocationEdits): Promise<Layer>;
    private enqueue;
    /** Read through the layer after its earlier operations finish. */
    read<A extends Ask>(selector: Selector, ask: A): Promise<ReadResult<Extract<{
        kind: "ids";
        ids: number[];
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "spacing";
        ids: number[];
        spacingM: number;
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "count";
        count: number;
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "locations";
        locations: LocationList;
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "columns";
        columns: unknown[][];
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "values";
        values: string[];
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "groupBy";
        groups: PartitionBucket[];
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "countBy";
        counts: CountBy[];
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "coverage";
        coverage: ([string, number])[];
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "bounds";
        bounds: [number, number, number, number] | null;
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "duplicateGroups";
        groups: number[][];
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "nearAny";
        values: boolean[];
    }, {
        kind: A["kind"];
    }>> | ReadResult<Extract<{
        kind: "held";
        held: boolean[];
    }, {
        kind: A["kind"];
    }>>>;
    /** Stage location edits using the shared mutation path. */
    edit(edits: LocationEdits | ((read: LayerRead) => Promise<LocationEdits>)): Promise<EditResult>;
    /** Land the layer's edits as one undo step, resolving once the map accepts them; later writes to the layer join that step. A layer lands once. */
    land(): Promise<Mutation<Location>>;
    /** Close after queued operations finish. Edits not yet landed are discarded. */
    close(): Promise<void>;
}

/** Where an open location came from: the map, the seen history, or a pending import. */
export type OpeningOrigin = "map" | "seen" | "import";
/** A location open in the editor. A preview's id is its viewer-layer id. */
export interface Opening {
    id: number;
    origin: OpeningOrigin;
    /** The pending layer holding this opening's draft. */
    layer: Layer;
    /** The draft as last read from its layer. */
    location: Location;
    /** The location as this opening began. */
    readonly spawn: Location;
}
/** What the editor shows: the open location, the pane, and the panels that lead to them. */
export interface EditorState {
    /** The location open in the editor, or null. */
    open: Opening | null;
    /** @unstable */
    duplicateLocations: Location[];
    /** @unstable */
    workArea: WorkArea;
    /** @unstable */
    activePluginId: string | null;
}
/** @unstable */
export type DraftPatch = Omit<Patch<Location>, "id">;
/** Edits and saves bound to one opening. Once another opening or none is current, they do
 *  nothing and resolve null. A failed edit or save is logged and resolves null. @unstable */
export interface Draft {
    /** Patch the draft, or derive the patch from the draft as it stands; resolves once the open
     *  location shows it. */
    edit: (patch: DraftPatch | ((location: Location) => DraftPatch)) => Promise<void | null>;
    /** Land the draft with `patch` applied, resolving its id. */
    save: (patch: DraftPatch) => Promise<number | null>;
}
/** Open locations and change the editor pane. @api */
declare const Editor: {
    /** Imperative snapshot of the editor state. */
    get: () => Readonly<EditorState>;
    /** The positions the viewer has walked through since the location opened, [lng, lat]. @unstable */
    trail: {
        get: () => [number, number][];
        reset: (lng: number, lat: number) => void;
        push: (lng: number, lat: number) => void;
        clear: () => void;
    };
    /** Reactive slice of the editor state. Select fields or memoized values, as with `Store.use`. */
    use: <T>(selector: (s: EditorState) => T) => T;
    /** Reread the current draft. Superseded reads and errors cannot update the next opening. @unstable */
    refresh: () => Promise<void>;
    /** The open draft's edit and save, the same pair for as long as this opening lasts. @unstable */
    draft: () => Draft;
    /** Where the open location stands, or 0,0 while nothing is open. @unstable */
    usePosition: () => LatLng;
    /** Whether procedure work is still writing to the open draft. @unstable */
    useWriting: () => boolean;
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
    openDuplicate: (loc: Location) => Promise<void>;
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

/** Rename or remove metadata fields across the map. @api */
declare const Field$1: {
    /** Rename extra-field `from` to `to` across all locations, its definition, and the listed
     *  selections, in one undoable step. When a location already holds `to`, `winner` decides
     *  which value survives. Saved selections are map-independent rules and keep their names. */
    rename: (from: string, to: string, winner?: MergeWinner) => Promise<void>;
    /** Delete extra-field `key` from every location, its definition, and the listed selections,
     *  in one undoable step. */
    remove: (key: string) => Promise<void>;
};

/** True when `key` is a built-in Location field (stored top-level, not under `extra`). @api */
declare function isBuiltinField(key: string): boolean;
/** True when the field can be bulk-edited. @api @unstable */
declare function isWritableField(key: string): boolean;
/** True when the field can be bulk-cleared. @api @unstable */
declare function isClearableField(key: string): boolean;
/** True when the field should appear in field pickers. @api @unstable */
declare function isListableField(key: string): boolean;
/** All built-in field keys (excluding virtual). @api @unstable */
declare function getBuiltinKeys(): string[];
/** Register field definitions from an enrichment provider (called at activation). @api */
declare function registerPluginFieldDefs(defs: Record<string, FieldDef>): void;
/** Remove plugin field definitions by key (called when a plugin is deactivated). @api */
declare function unregisterPluginFieldDefs(keys: string[]): void;
/** Every listable built-in, and every field this map defines. @api @unstable */
declare function getFieldKeys(): string[];
/** Keys this map defines a field for. Same reference until the user layer moves. @api */
declare const getKnownFieldKeys: () => ReadonlySet<string>;
/** Look up metadata for a field key. Returns `undefined` if no layer declares it. @api */
declare function getFieldDef(key: string): FieldDef | undefined;
/** Translated display label for a field key, falling back to a sentence-cased version of the key. @api */
declare function fieldLabel(key: string): string;
/** Display label for a field value. Enum values use their translated display name. @api */
declare function fieldValueLabel(def: FieldDef | undefined, value: unknown): string;
/** The value space a field declares, as bare strings. Distinct from the store's
 *  `fieldValues`, which reports the values actually present in the data. @api */
declare function declaredValues(def: FieldDef | undefined): string[] | null;
/** Merged view of all field definitions across all layers. @api */
declare function getAllFieldDefs(): Record<string, FieldDef>;
/** @unstable */
export interface FieldProjection {
    id: string;
    label: string;
    /** True when this projection uses the location's timezone. */
    needsTz: boolean;
}
/** Projections valid for a field type, in display order (first = dialog default). @api @unstable */
declare function projectionsForType(type: FieldType): FieldProjection[];
/** The "Range" partition option (numeric binning). @api @unstable */
declare const RANGE_ID = "range";
/** Partition-key dropdown options for a field type. @api @unstable */
declare function partitionKeyOptions(type: FieldType, rangeForDates: boolean): {
    id: string;
    label: string;
}[];

/** @unstable */
export interface EnrichFieldOption {
    key: string;
    label: string;
    /** Excluded from the default field set (null enrichFields); user must opt in. */
    defaultOff?: boolean;
}
/** Build field definitions for well-known keys (e.g. `"altitude"`, `"countryCode"`). @api */
declare function knownFieldDefs(...keys: string[]): Record<string, FieldDef>;
/** All enrichment field options: the core fields, then every registered provider's own fields. @api @unstable */
declare function getEnrichFieldOptions(): EnrichFieldOption[];
/** All enrichment field keys (core and plugin-registered). @api @unstable */
declare function getAllEnrichKeys(): string[];
/** Keys enriched when enrichFields is null (the default set: all options except defaultOff ones). @api @unstable */
declare function getDefaultEnrichKeys(): string[];
/** The enrichment fields `key`'s provider reads. @api @unstable */
declare function enrichInputs(key: string): string[];
/** The fields enrichment fetches for `enrichFields` (the default set when null): the chosen
 *  ones and every field they read, so no field runs without its inputs. @api @unstable */
declare function enabledEnrichKeys(enrichFields?: string[] | null): string[];
/** True when enrichment fetches `key` for the given enrichment set. @api @unstable */
declare function isFieldEnabled(enrichFields: string[] | null, key: string): boolean;

/** The full local mirror of the store's derived state, as of the map version it reflects. */
export type EngineState = Omit<Derived, "map"> & {
    version: number;
};
/** The open map's own details. Its value records, field definitions, and counts live in their
 *  own slices. */
export type MapDetails = Derived["map"];
export interface UiState {
    mapId: string | null;
    /** Persisted identity slice (metadata + settings). Changes rarely. */
    map: MapDetails | null;
    /** Why the map in `mapId` could not be opened, or null. */
    openError: string | null;
}
export type MapState = UiState & EngineState;
/** Read and update the open map state. @api */
declare const Store: {
    /** Reactive slice of the map state. Re-renders only when the selected value's
     *  reference changes (`Object.is`), so selectors must return state fields or
     *  memoized values, not a new value per call. */
    use: <T>(selector: (s: MapState) => T) => T;
    /** Imperative snapshot of the map state. */
    get: () => Readonly<MapState>;
};

/** Navigate undo and redo history. @api */
declare const History: {
    /** Whether `timeline` can step back (undo) or forward (redo). @unstable */
    available: (history: MapState["history"], stack: Stack, timeline: Timeline) => boolean;
    /** Undo the newest edit on `timeline`, or redo the newest undone one. */
    step: (stack: Stack, timeline: Timeline) => Promise<void>;
};

/** Parsed-but-not-committed import shown while `workArea === "import"`. @unstable */
export interface ImportStaging {
    preview: EditorImportPreview;
}
/** Stage, preview, and confirm an import into the open map. @api @unstable */
declare const Import: {
    /** The preview marker positions for the staged import. @unstable */
    previewPositions: () => Float32Array<ArrayBufferLike>;
    /** The current staged import, or null if none. @unstable */
    staging: () => ImportStaging | null;
    /** Discard the staged import and its pending layer. @unstable */
    reset: () => void;
    /** Import from a file path. @unstable */
    fromPath: (path: string) => Promise<void>;
    /** Stage pasted text for preview. Throws if no locations are found. @unstable */
    paste: (text: string) => Promise<void>;
    /** Import the staged file, dropping chosen fields and tags and applying bulk tags. @unstable */
    confirm: (droppedFields: string[], tagNames?: string[], droppedTags?: string[]) => Promise<EditorImportResult | null>;
    /** Discard the staged import without committing. @unstable */
    cancel: () => void;
};

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
/** Live jobs, for the tray. Reference changes on every update. @api @unstable */
declare function getJobs(): JobEntry[];
/** Register a long-running operation with the global job tray. The caller owns the
 *  work; the registry owns only its presentation and the cancel/reveal controls. @api @unstable */
declare function registerJob(label: string, opts?: JobOpts): JobHandle;
/** @unstable */
export interface JobRunContext {
    signal: AbortSignal;
    report: (fraction: number, detail?: string) => void;
}
/** Sugar for promise-shaped work: registers a job wired to an AbortController, reports
 *  through the handle, ends the job however `fn` settles, and resolves to how it settled.
 *  A failure also toasts. @api @unstable */
declare function runJob<R>(label: string, fn: (ctx: JobRunContext) => Promise<R>, opts?: Omit<JobOpts, "cancel">): Promise<Settled<R>>;
/** Cancel every live job of `scope` that can be cancelled. Owners observe their own
 *  abort and end their jobs; entries without a cancel are removed outright. @api @unstable */
declare function cancelJobs(scope: JobScope): void;

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
    /** O(1) removal by swapping with the last element. */
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
    /** Set the open location, whose marker the open-location layer draws instead of the base cell. */
    setOpen(id: number | null): void;
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

/** Every app event and what it hands its listeners. A `<noun>:change` event carries the change
 *  itself; a `<noun>:changed` event carries nothing and means the state its noun names moved,
 *  so listeners re-read it. A noun takes one of the two forms, never both. */
declare const EVENT_DEFS: {
    /** A change to the open map: the version it reached, the locations it added, removed and
     *  updated, and the derived state that moved. */
    "store:change": ChangeEvent;
    "selection:change": Selection[];
    "open:change": number | null;
    /** @deprecated v0.12.0. Listen for `open:change`. @unstable */
    "active:change": number | null;
    "map:open": Omit<MapMeta, "extra" | "locationCount" | "pending">;
    "map:close": void;
    /** @unstable */
    "map:saved": void;
    /** The open map's state, as `Store.get` and `Store.use` read it, moved. @unstable */
    "snapshot:changed": void;
    /** @unstable */
    "editor:changed": void;
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
    "account:changed": void;
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
    events: readonly (EditorEvent | PluginEvent<unknown>)[];
    /** Yields the badges to show, each paired with its map id. */
    collect(): Iterable<[mapId: string, badge: MapBadge]>;
}
/** Create, list, open, close, and organize maps. @api */
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

export type TagCreate = Pick<Tag, "name"> & Partial<Omit<Tag, "id" | "name" | "visible">>;
/** Manage tag records and their assignment to locations. @api */
declare const Tag: {
    /** Per-tag location counts, keyed by numeric id. */
    counts: () => Record<number, number>;
    /** Tag records, including unreferenced records. */
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
    update: (updates: Patch<Tag>[]) => Promise<Mutation<ValueRecord>>;
    /** Get or create tag records by name and return their ids. */
    create: (records: TagCreate[]) => Promise<number[]>;
    /** Set tag display order from an ordered list of ids. */
    reorder: (ids: number[]) => Promise<Mutation<ValueRecord>>;
    /** Move matching locations to a tag with the given name, optionally within a selector. */
    rename: (ids: number[], name: string, scope?: Selector | null) => Promise<void>;
    /** Get or create tag records and assign them to matching locations. */
    assign: (selector: Selector, records: TagCreate[]) => Promise<WorkResult>;
};

/** Add, update, remove, and inspect map locations. @api */
declare const Location: {
    /** Add locations to the map and return their new ids, in order. Undoable. */
    add: (locs: Location[]) => Promise<number[]>;
    /** Add `location` to another map unless that map already holds it, its interned values
     *  named by `records`. Resolves to whether it was added. Undoable in that map. @unstable */
    addTo: (mapId: string, location: Location, records: Parameters<typeof Edit.locations>[2]) => Promise<boolean>;
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

/** Change the listed selections and inspect their active members. @api @unstable */
declare const SelectionList: {
    /** The listed selections, in list order. @unstable */
    listed: () => ListedSelection[];
    /** Tag ids with a top-level listed tag selection, including ghosted selections. @unstable */
    tagIds: () => ReadonlySet<number>;
    /** Tag ids from active selection leaves, including repeated ids and composite children. @unstable */
    tagIdsDeep: () => readonly number[];
    /** Listed selections that are not ghosted. @unstable */
    active: () => Selection[];
    /** @unstable */
    select: <R extends number[] | {
        ids: number[];
    }>(pick: (selector: Selector) => Promise<R>, perSelection?: boolean) => Promise<{
        picked: number;
        results: R[];
    }>;
};

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
        enabled: () => boolean;
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
    "open-enrichment": {
        label: "Open enrichment";
        icon: string;
        group: "Map";
        aliases: string[];
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
        execute: () => Promise<Mutation<ListedSelection>>;
    };
    "select-untagged": {
        label: "Select untagged locations";
        icon: string;
        group: "Selections";
        aliases: string[];
        execute: () => Promise<Mutation<ListedSelection>>;
    };
    "select-unpanned": {
        label: "Select unpanned locations";
        icon: string;
        group: "Selections";
        execute: () => Promise<Mutation<ListedSelection>>;
    };
    "select-panoid": {
        label: "Select Pano ID locations";
        icon: string;
        group: "Selections";
        execute: () => Promise<Mutation<ListedSelection>>;
    };
    "select-no-panoid": {
        label: "Select non-Pano ID locations";
        icon: string;
        group: "Selections";
        execute: () => Promise<Mutation<ListedSelection>>;
    };
    "select-uncommitted": {
        label: "Select uncommitted locations";
        icon: string;
        group: "Selections";
        execute: () => Promise<Mutation<ListedSelection>>;
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
        execute: () => Promise<Mutation<ListedSelection>>;
    };
    "intersect-selections": {
        label: "Intersect (AND) selections";
        icon: string;
        group: "Selections";
        execute: () => Promise<Mutation<ListedSelection>>;
    };
    "union-selections": {
        label: "Union (OR) selections";
        icon: string;
        group: "Selections";
        execute: () => Promise<Mutation<ListedSelection>>;
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
        execute: () => Promise<Mutation<ListedSelection>>;
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
        execute: () => Promise<Mutation<ListedSelection>>;
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

/** Supported languages, labeled in their own script. `en-XA` is a dev-only pseudolocale. @api @unstable */
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
/** @api @unstable */
declare const MOVEMENT_MODES: {
    /** @unstable */
    readonly moving: "Moving";
    /** @unstable */
    readonly "no-move": "No Move";
    /** @unstable */
    readonly nmpz: "NMPZ";
};
/** @api @unstable */
declare const SEEN_RESOLUTIONS: {
    /** @unstable */
    readonly low: "Low (160x90)";
    /** @unstable */
    readonly medium: "Medium (320x180)";
    /** @unstable */
    readonly high: "High (640x360)";
};
/** @api @unstable */
declare const EXACT_DATE_FORMATS: {
    /** @unstable */
    readonly date: "Date only";
    /** @unstable */
    readonly datetime: "Date + time";
};
/** @api @unstable */
declare const DATE_TIMEZONES: {
    /** @unstable */
    readonly location: "Location timezone";
    /** @unstable */
    readonly utc: "UTC";
};
/** @api @unstable */
declare const MAP_LIST_FIELDS: {
    /** @unstable */
    readonly locationCount: "Location count";
    /** @unstable */
    readonly lastOpened: "Last opened";
    /** @unstable */
    readonly created: "Date created";
};
/** @api @unstable */
declare const DISCORD_PRESENCE_MODES: {
    /** @unstable */
    readonly off: "Off";
    /** @unstable */
    readonly generic: "Generic (no map name)";
    /** @unstable */
    readonly full: "Full (map name + count)";
};
/** @api @unstable */
declare const GEOCODE_PROVIDERS: {
    /** @unstable */
    readonly local: "Local (offline)";
    /** @unstable */
    readonly nominatim: "Nominatim";
    /** @unstable */
    readonly google: "Google (from panorama)";
};
/** @api @unstable */
declare const GEOCODE_PROVIDER_LABELS: Record<keyof typeof GEOCODE_PROVIDERS, string>;
/** Distance units. `auto` reads the system locale's region, so a US/UK machine gets miles. @api @unstable */
declare const UNIT_SYSTEMS: {
    /** @unstable */
    readonly auto: "Automatic";
    /** @unstable */
    readonly metric: "Metric (m / km)";
    /** @unstable */
    readonly imperial: "Imperial (ft / mi)";
};
/** @api @unstable */
declare const TAG_VIEW_MODES: {
    /** @unstable */
    readonly flat: "Flat";
    /** @unstable */
    readonly tree: "Tree";
};
/** @api @unstable */
declare const TAG_FOLDER_COLOR_MODES: {
    /** @unstable */
    readonly direct: "Fixed color";
    /** @unstable */
    readonly firstChild: "Inherit first child";
};
/** @api @unstable */
declare const OPACITY_TOGGLE_MODES: {
    /** @unstable */
    readonly previous: "Last used opacity";
    /** @unstable */
    readonly full: "Full opacity";
};
/** @api @unstable */
declare const POLYGON_COLOR_MODES: {
    /** @unstable */
    readonly random: "Random";
    /** @unstable */
    readonly fixed: "Fixed color";
};
/** @api @unstable */
declare const BORDER_DETAILS: {
    /** @unstable */
    readonly light: "Standard (bundled)";
    /** @unstable */
    readonly medium: "High ({size})";
    /** @unstable */
    readonly heavy: "Ultra ({size})";
};
/** Download size of each border detail level, in bytes. @api @unstable */
declare const BORDER_ARCHIVE_BYTES: {
    /** @unstable */
    readonly medium: 7460312;
    /** @unstable */
    readonly heavy: 21514464;
    /** @unstable */
    readonly adm1: 56891952;
};
/** @api @unstable */
declare const SUBDIVISION_DETAILS: {
    /** @unstable */
    readonly off: "Off";
    /** @unstable */
    readonly adm1: "States / provinces";
};
/** Tag-suggestion list cap stops (slider indices); 0 = unlimited ("All"). @api @unstable */
declare const TAG_SUGGESTION_LIMITS: readonly [5, 10, 25, 50, 0];
/** @api @unstable */
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
/** @api @unstable */
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
/** Default values for every app setting. @api @unstable */
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
    /** Zoom factor of every window's UI, set by the app zoom hotkeys. @unstable */
    appZoom: number;
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
    followOpenInReview: boolean;
    /** @unstable */
    markerColor: RGB;
    /** @unstable */
    openLocationColor: RGB;
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
/** localStorage descriptor for the persisted settings object. @api @unstable */
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
    /** Zoom factor of every window's UI, set by the app zoom hotkeys. */
    appZoom: number;
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
    followOpenInReview: boolean;
    markerColor: RGB;
    openLocationColor: RGB;
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
    borderDetail: BorderDetail;
    subdivisionDetail: SubdivisionDetail;
    previewAspectRatio: PreviewAspectRatio;
    tagSuggestionLimit: number;
    /** Local REST transport for window.MMA (Settings > Advanced). */
    remoteApi: boolean;
    remoteApiKey: string;
    pinnedCommands: PinnedEntry[];
}>;
/** The current app settings snapshot. @api @unstable */
declare function getSettings(): AppSettings;
/** True while the pano-UI toggle covers the navigation visuals too. @api @unstable */
declare function navHiddenWithUI(s: AppSettings): boolean;
/** Effective StreetViewPanorama display options derived from the current settings. @api @unstable */
declare function panoDisplayOptions(s: AppSettings): {
    linksControl: boolean;
    clickToGo: boolean;
    showRoadLabels: boolean;
    scrollwheel: boolean;
};
/** Update one setting and persist. Emits `settings:changed`. @api @unstable */
declare function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
/** Reset all settings to defaults. @api @unstable */
declare function resetSettings(): void;
/** React hook: all settings, re-rendering on any change. @api @unstable */
declare function useSettings(): AppSettings;
/** React hook: one setting value, re-rendering only when that key changes. @api @unstable */
declare function useSetting<K extends keyof AppSettings>(key: K): AppSettings[K];

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
    layers: Layer$1[];
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
    /** A click on the map that did not drag it. */
    click: LatLng;
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
export interface CreateHostOpts extends BasemapOpts {
    camera?: {
        center: LatLng;
        zoom: number;
    };
    scaleControl?: boolean;
}
/** @unstable */
export type ClickInterceptor = (lat: number, lng: number, shiftKey: boolean) => boolean;
/** @unstable */
export type DrawInterceptor = (rings: number[][][]) => boolean;
/** @unstable */
export type MapHost = {
    [K in MapHostKind]: MapHostContract<K>;
}[MapHostKind];
/** The embedded map host, its preferences, and click interceptors. @api @unstable */
declare const MapHost: {
    /** Set or clear the main editor map host. @unstable */
    set: (host: MapHost | null) => void;
    /** Return the main editor map host, or null if not mounted. @unstable */
    get: () => MapHost | null;
    /** Wait for the main editor map to be ready. @unstable */
    wait: () => Promise<MapHost>;
    /** Run `attach` on the main editor map host and on every host that replaces it, undoing each
     *  run with what it returns once its host goes. Returns the stop. @unstable */
    each: (attach: (host: MapHost) => () => void) => (() => void);
    /** Fit the editor map's viewport to `bounds`. A `minExtent` prevents over-zoom on tiny areas. @unstable */
    fitToBounds: (bounds: Bounds | null, padding?: number, minExtent?: number) => void;
    /** Register a map-click interceptor. Returns a removal function. The most recently
     *  added interceptor that returns true consumes the click. @unstable */
    addClickInterceptor: (fn: ClickInterceptor) => (() => void);
    /** Run registered click interceptors (newest first). True if one consumed the click. @unstable */
    tryInterceptClick: (lat: number, lng: number, shiftKey?: boolean) => boolean;
    /** Set the callback for completed polygon draws. Null clears it. @unstable */
    setDrawInterceptor: (fn: DrawInterceptor | null) => void;
    /** Pass completed polygon rings to the draw interceptor. True if it consumed them. @unstable */
    tryInterceptDraw: (rings: number[][][]) => boolean;
    /** The raw engine instance if `host` is of the given kind, else null. @unstable */
    instance: <K extends MapHostKind>(host: MapHost | null, kind: K) => HostInstances[K] | null;
    /** @unstable */
    kindForMapType: (mapType: MapTypeKey) => MapHostKind;
    /** @unstable */
    create: (kind: MapHostKind, container: HTMLElement, prefs: MapEmbedPrefs, opts: CreateHostOpts) => Promise<MapHost>;
};

/** The marker scene the map surfaces render from, and its load lifecycle. @api @unstable */
declare const Scene: {
    /** The shared scene that all map surfaces render from. @unstable */
    get: () => CellManager;
    /** Set the default marker color (RGB bytes). @unstable */
    setDefaultColor: (r: number, g: number, b: number) => void;
    /** Change the default marker color and repaint. @unstable */
    recolor: (mc: RGB) => void;
    /** Current default marker color as RGBA. @unstable */
    defaultColor: () => RGBA;
    /** Snapshot of every rendered location's id and position (`[lng, lat, ...]`). @unstable */
    positions: () => {
        ids: Uint32Array;
        positions: Float32Array;
    };
    /**
     * Resolves once the scene has applied the frame for map version `version`, with what that
     * frame did. Resolves at once, with nothing applied, when the scene follows no map.
     * @unstable
     */
    reached: (version: number) => Promise<FrameSummary>;
    /** Resolves when the most recently started full scene load has finished (or immediately if none is in flight). @unstable */
    settled: () => Promise<void>;
    /** Load the whole scene again and follow every change to it from there. @unstable */
    load: (markerStyle?: MarkerStyle, mc?: RGB) => Promise<void>;
    /** Clear all marker data from the scene and stop following the map. @unstable */
    clear: () => void;
    /** What keeps the map showing as loading; the scene itself holds it until its markers are first drawn. @unstable */
    loading: {
        hold: () => (() => void);
        held: () => boolean;
    };
    /** The ids of the locations the listed selections select. @unstable */
    selected: () => SelectedIds;
    /** Reactive {@link Scene.selected}. @unstable */
    useSelected: () => SelectedIds;
};

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
    /** Awaited before the procedure joins a run; returning false excludes it. */
    prepare?: () => Promise<boolean>;
}
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
/** Every item a run scheduled, by id. @unstable */
export type ProcedureOutcomes = Record<string, ProcedureOutcome>;
/** One item's own progress. Counts are net of skipped locations. @unstable */
export interface ProcedurePart {
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
    /** `done`/`total` reflect the slowest item. `parts` carries each labeled item's own
     *  counts, ordered as declared. */
    onProgress?: (done: number, total: number, parts: ProcedurePart[]) => void;
    /** Each location as an item finishes with it (locations-only runs). The same location
     *  arrives again from each later item. */
    onPartial?: (rows: Location[]) => void;
}
/** @unstable */
export type BulkOpts = Pick<RunOpts, "signal" | "onProgress">;
/** An item for `Procedure.drive`, with the label its progress shows. @unstable */
export interface Scheduled {
    id: string;
    label: string | null;
    item: RunItem;
}
/** What a one-off run may set on top of what the spec declares. @unstable */
export interface RunSettings {
    id: string;
    label?: string;
    /** `collect` takes the answers instead of writing them. */
    sink?: Sink;
    /** Recompute locations that already hold what the procedure writes. */
    force?: boolean;
}
/** Procedure modules: ask one a question, or run one over locations. @api */
declare const Procedure: {
    /** Entry point of a procedure this app bundles. Plugins ship their own paths. @unstable */
    entry: (name: string) => string;
    /** The readable name behind an entry point, for surfaces that show one. @unstable */
    name: (entry: string) => string;
    /** The part of a spec the engine reads for a run and a query alike, with `config` as the
     *  JSON text the wire carries. @unstable */
    decl: (spec: ProcedureSpec, config?: unknown) => ProcedureDecl;
    /** An outcome for work that never ran. @unstable */
    noWork: () => BatchOutcome;
    /** Ask a procedure a read-only question under its declared network limits. Rejects when it
     *  exports no `query`, when the call fails, or when `signal` aborts. `onPartial` receives
     *  pages of answers as they resolve, ahead of the full result; each entry carries the id
     *  the emitting side chose for it. @unstable */
    query: <T = unknown, P = unknown>(spec: ProcedureSpec, input: unknown, opts?: {
        signal?: AbortSignal;
        onPartial?: (entries: {
            id: number;
            value: P;
        }[]) => void;
    }) => Promise<T>;
    /** Run a single procedure over `selector` and return its typed results. @unstable */
    run: <T, C>(spec: ProcedureSpec<T, C>, selector: Selector, opts: Omit<RunOpts, "force"> & RunSettings & {
        config?: Partial<NoInfer<C>>;
    }) => Promise<ProcedureOutcome<T>>;
    /** Drive scheduled items through the engine as one run and gather what comes back. @unstable */
    drive: (scheduled: Scheduled[], opts: RunOpts) => Promise<ProcedureOutcomes>;
};

/** A registered provider to run, and what this run changes about it. @unstable */
export interface ProviderRun<TConfig = unknown> {
    provider: Provider<unknown, TConfig>;
    /** Replaces the config the provider registered. */
    config?: Partial<NoInfer<TConfig>>;
    /** Recompute locations that already hold this provider's fields. Omitted, it follows
     *  the run's `force`. */
    force?: boolean;
    /** The `fieldDefs` keys to produce; omitted, every key it declares. */
    fields?: string[];
    /** The locations to run over; omitted, the run's selector. */
    select?: Selector;
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
/** Registered field producers: register one, list them, or run them over locations. @api */
declare const Provider: {
    /** Register a provider (e.g. a plugin's sun position). Unregistered when the plugin
     *  deactivates. Resolves once the provider can run. */
    register: (provider: Provider) => Promise<void>;
    /** All registered providers. @unstable */
    list: () => Provider[];
    /** The provider that produces a given extra field, if any. @unstable */
    forField: (field: string) => Provider | undefined;
    /** Display labels for a field's partition keys. Month-of-year keys are numeric tokens and
     *  become locale month names; otherwise falls back to the keys themselves when the field's
     *  procedure has no `label` query or returns a non-matching array. @unstable */
    labels: (field: string, keys: string[], key?: KeySpec) => Promise<string[]>;
    /** Run registered providers over the locations `selector` matches and write their results
     *  back. Resolves once every provider finishes, or on abort. @unstable */
    run: <C extends readonly unknown[]>(runs: { [K in keyof C]: ProviderRun<C[K]>; }, selector: Selector, opts?: RunOpts) => Promise<ProcedureOutcomes>;
};

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
/** The nested `sidecar` namespace on the plugin surface. @api */
declare const sidecar: {
    request: typeof request$1;
    installedVersion: typeof installedVersion$1;
};

/** @deprecated v0.8.1. Use `MMA.MapHost.get()` and narrow via `MMA.MapHost.instance`. @api @unstable */
declare function getGoogleMap(): google.maps.Map | null;
/** @deprecated v0.8.1. Use `MMA.MapHost.wait()`. @api @unstable */
declare function waitForGoogleMap(): Promise<google.maps.Map | null>;
/** @deprecated v0.8.2. Read `MMA.Store.get().map`. @api @unstable */
declare function getCurrentMap(): Omit<MapMeta, "extra" | "locationCount" | "pending"> | null;
/** @deprecated v0.8.2. Read `MMA.Store.get().mapId`. @api @unstable */
declare function getCurrentMapId(): string | null;
/** @deprecated v0.8.2. Read `MMA.Editor.get().open?.location`. @api @unstable */
declare function getActiveLocation(): Location | null;
/** @deprecated v0.8.2. Read `MMA.Scene.selected()`. @api @unstable */
declare function getSelectedLocationIds(): SelectedIds;
/** @deprecated v0.8.2. Read `MMA.Editor.get().workArea`. @api @unstable */
declare function getWorkArea(): WorkArea;
/** @deprecated v0.8.2. Read `MMA.SelectionList.listed()`. @api @unstable */
declare function getAllSelections(): Selection[];
/** @deprecated v0.8.2. Read `MMA.SelectionList.listed()`. @api @unstable */
declare function getGhostedSelections(): Set<string>;
/** @deprecated v0.8.2. Use `MMA.SelectionList.active()`. @api @unstable */
declare function getSelections(): Selection[];
/** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Locations", locations: [id], name: null }, { kind: "locations" })`. @api @unstable */
declare function fetchLocation(id: number): Promise<Location>;
/** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Locations", locations: ids, name: null }, { kind: "locations" })`. @api @unstable */
declare function fetchLocationsByIds(ids: number[]): Promise<Location[]>;
/** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Everything" }, { kind: "locations" })`. @api @unstable */
declare function fetchAllLocations(): Promise<Location[]>;
/** @deprecated v0.10.2. Use `MMA.Query.read(selector, { kind: "coverage" })`. @api @unstable */
declare function fieldCoverage(selector: Selector): Promise<[string, number][]>;
/** @deprecated v0.10.2. Use `MMA.Provider.register()`. @api @unstable */
declare function registerEnrichmentProvider(provider: Provider): void;
/** @deprecated v0.10.5. The user layer is store-owned state (`MMA.Store.get().fieldDefs`);
 *  use `MMA.Edit.meta({ extra: { fields } })` to change it, or `MMA.registerPluginFieldDefs()`
 *  for plugin-owned defs. @api @unstable */
declare function setUserFieldDefs(fields: Record<string, FieldDef>): Promise<void>;
/** @deprecated v0.10.5. Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [tagId], remove: [] })`. @api @unstable */
declare function addTagToLocations(tagId: number, locationIds: number[]): Promise<WorkResult>;
/** @deprecated v0.10.5. Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. @api @unstable */
declare function removeTagFromLocations(tagId: number, locationIds: number[]): Promise<WorkResult>;
/** @deprecated v0.10.5. Use `MMA.Edit.work(MMA.tagSelector(tagId), { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. @api @unstable */
declare function removeTagFromAllLocations(tagId: number): Promise<WorkResult>;
/** @deprecated v0.11.0. Use `MMA.storage()`. @api @unstable */
declare function createPluginStorage(id: string): PluginStorage;
/** @deprecated v0.11.0. Use `MMA.sidecar.request()`. @api @unstable */
declare function request<T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T>): Promise<T | null>;
/** @deprecated v0.11.0. Use `MMA.sidecar.installedVersion()`. @api @unstable */
declare function installedVersion(pluginId: string): Promise<string | null>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "ids" })`. @api @unstable */
declare function resolveIds(selector: Selector): Promise<number[]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "count" })`. @api @unstable */
declare function countIn(selector: Selector): Promise<number>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "bounds" })`. @api @unstable */
declare function fetchBounds(selector: Selector): Promise<[number, number, number, number] | null>;
/** @deprecated v0.11.3. Use `MMA.Query.read({ type: "Sample", selection: MMA.selection(selector), n }, { kind: "ids" })`. @api @unstable */
declare function sampleFrom(selector: Selector, n: number): Promise<number[]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "values", field })`. @api @unstable */
declare function fieldValues(selector: Selector, field: string): Promise<string[]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "countBy", fields: [field], key })`. @api @unstable */
declare function countBy(selector: Selector, field: string, key: KeySpec): Promise<CountBy>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "coverage" })`. @api @unstable */
declare function coverage(selector: Selector): Promise<[string, number][]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "columns", fields })`. @api @unstable */
declare function fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "groupBy", field, key })`. @api @unstable */
declare function partition(field: string, key: KeySpec, selector: Selector): Promise<PartitionBucket[]>;
/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "locations" })`. @api @unstable */
declare function fetchLocations(selector: Selector): Promise<Location[]>;
/** @deprecated v0.11.3. A provider's `fieldDefs` are offered as enrichment options on their
 *  own; set `defaultOff` on the provider to make them opt-in. @api @unstable */
declare function registerEnrichFields(_fields: EnrichFieldOption[]): void;
/** @deprecated v0.11.3. Use `MMA.Edit.selections(MMA.addSelection(...selectors))`. @api @unstable */
declare function addSelections(selectors: Selector[]): Promise<Mutation<ListedSelection>>;
/** @deprecated v0.11.3. Use `MMA.Edit.selections({ kind: "remove", keys })`. @api @unstable */
declare function removeSelections(keys: string[]): Promise<Mutation<ListedSelection>>;
/** @deprecated v0.11.3. Use `MMA.Edit.selections({ kind: "set", selections: [] })`. @api @unstable */
declare function resetSelections(): Promise<Mutation<ListedSelection>>;
/** @deprecated v0.11.7. Use the `{ type: "Selected" }` selector. @api @unstable */
declare function currentSelection(): Selector;
/** @deprecated v0.12.0. Use MMA.Query.read(selector, ask) instead. @api @unstable */
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
    /** One column per field: null for missing values and value-id lists for interned fields. */
    columns: (fields: string[]) => Promise<unknown[][]>;
    /** Group by a derived key; bins use bound order and other keys sort naturally. */
    partition: (field: string, key: KeySpec) => Promise<PartitionBucket[]>;
    /** Full matching locations, loading any large result from its temporary file. */
    locations: () => Promise<Location[]>;
};
/** @deprecated v0.12.0. Use `MMA.Editor.open(target)`, or `MMA.Editor.close()` in place of null. @api @unstable */
declare function setActiveLocation(target: MaybeLocation | null, checkDuplicates?: boolean): Promise<void>;
/** @deprecated v0.12.0. Use `MMA.Store.get`. @api */
declare const getMapState: typeof Store.get;
/** @deprecated v0.12.0. Use `MMA.Store.use`. @api */
declare const useMapState: typeof Store.use;
/** @deprecated v0.12.0. Use `MMA.Tag.counts`. @api */
declare const getTagCounts: typeof Tag.counts;
/** @deprecated v0.12.0. Use `MMA.Tag.all`. @api */
declare const getTags: typeof Tag.all;
/** @deprecated v0.12.0. Use `MMA.Tag.visible`. @api */
declare const getVisibleTags: typeof Tag.visible;
/** @deprecated v0.12.0. Use `MMA.Tag.get`. @api */
declare const getTag: typeof Tag.get;
/** @deprecated v0.12.0. Use `MMA.Tag.names`. @api */
declare const tagIdsToNames: typeof Tag.names;
/** @deprecated v0.12.0. Use `MMA.Tag.remove`. @api */
declare const deleteTags: typeof Tag.remove;
/** @deprecated v0.12.0. Use `MMA.Mutation.run`. @api */
declare const mutate: typeof Mutation.run;
/** @deprecated v0.12.0. Use `MMA.Mutation.settle`. @api */
declare const settled: typeof Mutation.settle;
/** @deprecated v0.12.0. Use `MMA.Query.read`. @api */
declare const read: typeof Query.read;
/** @deprecated v0.12.0. Use `MMA.Query.locationsOf`. @api */
declare const locationsOf: typeof Query.locationsOf;
/** @deprecated v0.12.0. Use `MMA.Location.add`. @api */
declare const addLocations: typeof Location.add;
/** @deprecated v0.12.0. Use `MMA.Location.duplicate`. @api */
declare const duplicateLocation: typeof Location.duplicate;
/** @deprecated v0.12.0. Use `MMA.Location.remove`. @api */
declare const removeLocations: typeof Location.remove;
/** @deprecated v0.12.0. Use `MMA.Location.update`. @api */
declare const updateLocations: typeof Location.update;
/** @deprecated v0.12.0. Use `MMA.Location.duplicateGroups`. @api @unstable */
declare const previewDuplicateGroups: typeof Location.duplicateGroups;
/** @deprecated v0.12.0. Use `MMA.Editor.openImport`. @api @unstable */
declare const openStagedLocation: typeof Editor.openImport;
/** @deprecated v0.12.0. Use `MMA.Editor.preview`. @api @unstable */
declare const previewLocation: typeof Editor.preview;
/** @deprecated v0.12.0. Use `MMA.Editor.resolve`. @api */
declare const resolveLocation: typeof Editor.resolve;
/** @deprecated v0.12.0. Use `MMA.Editor.open`. @api */
declare const openLocation: typeof Editor.open;
/** @deprecated v0.12.0. Use `MMA.Editor.close`. @api */
declare const closeLocation: typeof Editor.close;
/** @deprecated v0.12.0. Use `MMA.Editor.openDuplicate`. @api @unstable */
declare const openDuplicateLocation: typeof Editor.openDuplicate;
/** @deprecated v0.12.0. Use `MMA.Editor.removeDuplicate`. @api @unstable */
declare const removeDuplicate: typeof Editor.removeDuplicate;
/** @deprecated v0.12.0. Use `MMA.Editor.closeDuplicates`. @api @unstable */
declare const closeDuplicates: typeof Editor.closeDuplicates;
/** @deprecated v0.12.0. Use `MMA.Editor.setArea`. @api @unstable */
declare const setWorkArea: typeof Editor.setArea;
/** @deprecated v0.12.0. Use `MMA.Editor.openPlugin`. @api */
declare const setPluginMode: typeof Editor.openPlugin;
/** @deprecated v0.12.0. Use `MMA.Editor.closePlugin`. @api */
declare const exitPluginMode: typeof Editor.closePlugin;
/** @deprecated v0.12.0. Use `MMA.Field.rename`. @api */
declare const renameField: typeof Field$1.rename;
/** @deprecated v0.12.0. Use `MMA.Field.remove`. @api */
declare const deleteField: typeof Field$1.remove;
/** @deprecated v0.12.0. Use `MMA.SelectionList.active`. @api */
declare const getActiveSelections: typeof SelectionList.active;
/** @deprecated v0.12.0. Use `MMA.Edit.selections`. @api @unstable */
declare const applySelectionUpdate: typeof Edit.selections;
/** @deprecated v0.12.0. Use `MMA.SelectionList.select`. @api */
declare const select: typeof SelectionList.select;
/** @deprecated v0.12.0. Use `MMA.History.available`. @api @unstable */
declare const historyAvailable: typeof History.available;
/** @deprecated v0.12.0. Use `MMA.Commit.create`. @api */
declare const commitMap: typeof Commit.create;
/** @deprecated v0.12.0. Use `MMA.Commit.checkout`. @api @unstable */
declare const checkoutCommit: typeof Commit.checkout;
/** @deprecated v0.12.0. Use `MMA.Maps.init`. @api @unstable */
declare const initStore: typeof Maps.init;
/** @deprecated v0.12.0. Use `MMA.Maps.open`. @api */
declare const openMap: typeof Maps.open;
/** @deprecated v0.12.0. Use `MMA.Maps.close`. @api */
declare const closeMap: typeof Maps.close;
/** @deprecated v0.12.0. Use `MMA.Maps.discard`. @api @unstable */
declare const discardOpenMap: typeof Maps.discard;
/** @deprecated v0.12.0. Use `MMA.SelectionList.tagIds`. @api @unstable */
declare const getSelectedTagIds: typeof SelectionList.tagIds;
/** @deprecated v0.12.0. Use `MMA.SelectionList.tagIdsDeep`. @api @unstable */
declare const getSelectedTagIdsDeep: typeof SelectionList.tagIdsDeep;
/** @deprecated v0.12.0. Use `MMA.Maps.useList`. @api */
declare const useMapList: typeof Maps.useList;
/** @deprecated v0.12.0. Use `MMA.Maps.list`. @api */
declare const getMapList: typeof Maps.list;
/** @deprecated v0.12.0. Use `MMA.Maps.reload`. @api @unstable */
declare const reloadMapList: typeof Maps.reload;
/** @deprecated v0.12.0. Use `MMA.Maps.reload`. @api @unstable */
declare const invalidateMapList: typeof Maps.reload;
/** @deprecated v0.12.0. Use `MMA.Maps.create`. @api */
declare const createMap: typeof Maps.create;
/** @deprecated v0.12.0. Use `MMA.Maps.duplicate`. @api */
declare const duplicateMap: typeof Maps.duplicate;
/** @deprecated v0.12.0. Use `MMA.Maps.remove`. @api */
declare const deleteMap: typeof Maps.remove;
/** @deprecated v0.12.0. Use `MMA.Maps.openScratch`. @api */
declare const openScratchMap: typeof Maps.openScratch;
/** @deprecated v0.12.0. Use `MMA.Maps.isReserved`. @api @unstable */
declare const isReservedMap: typeof Maps.isReserved;
/** @deprecated v0.12.0. Use `MMA.Maps.copyName`. @api @unstable */
declare const copyName: typeof Maps.copyName;
/** @deprecated v0.12.0. Use `MMA.Maps.renameFolder`. @api */
declare const renameFolder: typeof Maps.renameFolder;
/** @deprecated v0.12.0. Use `MMA.Maps.moveToFolder`. @api */
declare const moveMapToFolder: typeof Maps.moveToFolder;
/** @deprecated v0.12.0. Use `MMA.Maps.removeFolder`. @api */
declare const deleteFolder: typeof Maps.removeFolder;
/** @deprecated v0.12.0. Use `MMA.Maps.registerBadges`. @api @unstable */
declare const registerMapBadges: typeof Maps.registerBadges;
/** @deprecated v0.12.0. Use `MMA.Maps.badgeSources`. @api @unstable */
declare const getMapBadgeSources: typeof Maps.badgeSources;
/** @deprecated v0.12.0. Use `MMA.Maps.badges`. @api @unstable */
declare const getMapBadges: typeof Maps.badges;
/** @deprecated v0.12.0. Use `MMA.Maps.useBadges`. @api @unstable */
declare const useMapBadges: typeof Maps.useBadges;
/** @deprecated v0.12.0. Use `MMA.Edit`. @api */
declare const edit: typeof Edit;
/** @deprecated v0.12.0. Use `MMA.Autosave`. @api */
declare const autosave: typeof Autosave;
/** @deprecated v0.12.0. Use `MMA.MapHost.get`. @api */
declare const getMapHost: typeof MapHost.get;
/** @deprecated v0.12.0. Use `MMA.MapHost.wait`. @api */
declare const waitForMapHost: typeof MapHost.wait;
/** @deprecated v0.12.0. Use `MMA.Provider.register`. @api */
declare const registerProvider: typeof Provider.register;
/** @deprecated v0.13.0. Use `MMA.Scene.positions`. @api @unstable */
declare const getScenePositions: typeof Scene.positions;

/** @unstable */
export type PanoDestination = string | google.maps.LatLngLiteral;
/** @unstable */
export type PanoFrame = CameraFrame & {
    zoom?: number;
};
/** @unstable */
export type PanoEvent = "pov_changed" | "zoom_changed" | "links_changed" | "status_changed" | "pano_changed";
/** @unstable */
export type PanoViewer = ReturnType<typeof createPano>;
/** Create an independent pano viewer with its own camera, requests, listeners and mounts. */
declare function createPano(): {
    /** Resolve and show a location's pano, optionally hidden until it loads; cancelled when overtaken. The value is the pano put on screen, null when sent to coordinates. */
    show: (loc: Location, { concealUntilReady }?: {
        concealUntilReady?: boolean;
    }) => Promise<Ok<string | null> | Cancelled>;
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
    /** Reserve a camera move across an async wait; it lands only if nothing moved the pano since. */
    reserveLook: () => (frame: PanoFrame) => boolean;
    /** The view held relative to each pano's camera frame while the viewport is locked, or null. */
    lockedView: () => (CameraFrame & {
        zoom?: number;
    } & {
        zoom: number;
    }) | null;
    /** Turn the camera to the locked view on the current pano. */
    applyLock: () => Promise<void>;
    /** Lock the viewport to the current view, or release the lock. True when it is now locked. */
    toggleLock: () => Promise<boolean>;
    /** The viewer's zoom scale: stored against display zoom, and its steps. */
    zoomScale: {
        range: {
            min: -3;
            max: 4;
        };
        /** Stored -> live pano zoom: 0 (unset) renders fully zoomed out for the current viewport. */
        display: (stored: number) => number;
        /** Live -> stored pano zoom: the fully-out floor collapses to 0 (unset); partial zooms persist. */
        stored: (display: number) => number;
        /** One zoom step in: fully-out returns to 0, then the 0..4 grid. */
        in: (z: number) => number;
        /** One zoom step out: down the grid to 0, then fully out. */
        out: (z: number) => number;
    };
    /** Nudge heading and pitch by a delta, keeping pitch in range. */
    nudge: (dHeading: number, dPitch: number) => void;
    /** Animate the camera to a frame, replacing any turn in progress. */
    turnTo: (target: CameraFrame) => void;
    /** Face north keeping the pitch, or look straight down zoomed out when already within two degrees of north. */
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
/** The app's default pano viewer. @api @unstable */
declare const Pano: {
    /** Resolve and show a location's pano, optionally hidden until it loads; cancelled when overtaken. The value is the pano put on screen, null when sent to coordinates. @unstable */
    show: (loc: Location, { concealUntilReady }?: {
        concealUntilReady?: boolean;
    }) => Promise<Ok<string | null> | Cancelled>;
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
    /** Reserve a camera move across an async wait; it lands only if nothing moved the pano since. @unstable */
    reserveLook: () => (frame: PanoFrame) => boolean;
    /** The view held relative to each pano's camera frame while the viewport is locked, or null. @unstable */
    lockedView: () => (CameraFrame & {
        zoom?: number;
    } & {
        zoom: number;
    }) | null;
    /** Turn the camera to the locked view on the current pano. @unstable */
    applyLock: () => Promise<void>;
    /** Lock the viewport to the current view, or release the lock. True when it is now locked. @unstable */
    toggleLock: () => Promise<boolean>;
    /** The viewer's zoom scale: stored against display zoom, and its steps. @unstable */
    zoomScale: {
        range: {
            min: -3;
            max: 4;
        };
        /** Stored -> live pano zoom: 0 (unset) renders fully zoomed out for the current viewport. */
        display: (stored: number) => number;
        /** Live -> stored pano zoom: the fully-out floor collapses to 0 (unset); partial zooms persist. */
        stored: (display: number) => number;
        /** One zoom step in: fully-out returns to 0, then the 0..4 grid. */
        in: (z: number) => number;
        /** One zoom step out: down the grid to 0, then fully out. */
        out: (z: number) => number;
    };
    /** Nudge heading and pitch by a delta, keeping pitch in range. @unstable */
    nudge: (dHeading: number, dPitch: number) => void;
    /** Animate the camera to a frame, replacing any turn in progress. @unstable */
    turnTo: (target: CameraFrame) => void;
    /** Face north keeping the pitch, or look straight down zoomed out when already within two degrees of north. @unstable */
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

/** Build the provider run list for enrichment, narrowed to `enrichFields` and the fields they
 *  read. Fields not offered in the enrichment settings are always included. @api @unstable */
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
 *  run is forced. @api @unstable */
declare const panoResolveProvider: Provider<{
    panoId: string;
}, PanoResolveConfig>;
/** Exact capture timestamp, narrowed from the `imageDate` month via binary search. @api @unstable */
declare const exactDateProvider: Provider;
/** Timezone at the location's coordinates. Requires `datetime` to be present. @api @unstable */
declare const timezoneProvider: Provider;
/** Subdivision (adm1) via offline point-in-polygon against the local border dataset.
 *  No Google dependency; downloads the adm1 archive on first use. @api @unstable */
declare const subdivisionProvider: Provider;
/** Core panorama metadata via Google's GetMetadata RPC. @api @unstable */
declare const svMetaProvider: Provider;
/** @unstable */
export type RoadDirection = "forwards" | "backwards";
/** @unstable */
export interface HeadingRoadConfig {
    direction: RoadDirection;
}
/** Pan a location's heading along the road. The driving direction is the pano's
 *  `centerHeading`; "forwards" faces it, "backwards" faces the opposite. @api @unstable */
declare const headingRoadProvider: Provider<unknown, HeadingRoadConfig>;
/** The providers the app registers at startup. @api @unstable */
declare const BUILTIN_PROVIDERS: readonly Provider[];
/** Enrich the locations in `selector` with every enrichment field the open map has on,
 *  resolving their panoramas first unless `resolve` is false. @api @unstable */
declare function enrich(selector: Selector, { resolve, ...opts }?: RunOpts & {
    resolve?: boolean;
}): Promise<ProcedureOutcomes>;
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
 *  into `categories` (keys of `VALIDATION_CATEGORIES`; the standard ones when omitted). @api @unstable */
declare function validateLocations(selector: Selector, opts?: BulkOpts & {
    config?: Partial<ValidateConfig>;
    categories?: readonly string[];
}): Promise<ValidationOutcome>;

/** The fields a plugin shows as itself, declared once by its manifest. */
export type PluginIdentity = Pick<PluginManifest, "id" | "name" | "description" | "icon" | "comingSoon" | "experimental">;
export interface Plugin extends PluginIdentity {
    core?: boolean;
    /** Keep the sidebar mounted (hidden) when the user leaves plugin mode.
     *  Only for plugins whose state can't be serialized (e.g. an iframe). */
    keepAlive?: boolean;
    activate(): void | (() => void);
    /** Mounted once at the root of every window while the plugin is enabled, such as a dialog it raises itself. */
    layer?: ComponentType;
    /** Drawn on the plugin's button wherever it appears, such as a status dot. */
    badge?: ComponentType;
    /** Show the plugin's button on the map list too, opening its modal. */
    onMapList?: boolean;
    /** Shown in the editor header beside the map name, such as a status pill. */
    headerItem?: ComponentType;
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
/** Register a plugin. `activate` runs when a map opens; its returned cleanup runs on map close. @api */
declare function registerPlugin(plugin: Plugin | PluginBehavior): void;
/** All registered plugins, sorted by name. @api */
declare function getPlugins(): Plugin[];
/** Look up a registered plugin by id. @api */
declare function getPlugin(id: string): Plugin | undefined;
/** True when the plugin contributes data only and has no UI surfaces. @api */
declare function isBackgroundPlugin(id: string): boolean;
/** Remove a plugin from the registry. @api @unstable */
declare function unregisterPlugin(id: string): void;
/** Enable or disable a plugin. @api @unstable */
declare function setPluginEnabled(id: string, enabled: boolean): void;
/** Activate a single plugin by id. @api @unstable */
declare function activatePlugin(id: string): void;
/** True once the MMA surface is installed and plugins are safe to call it. @api @unstable */
declare function isReady(): boolean;

/** @unstable */
export interface PruneResult {
    session: ReviewSession | null;
    cursorMoved: boolean;
}
/** Review sessions and their history. @api @unstable */
declare const Review: {
    /** Position of `id` in the session's worklist, or -1. O(1) per step. @unstable */
    positionOf: (s: ReviewSession, id: number) => number;
    /** Remove `removed` ids from a session's worklist and reviewed set. Advances the
     *  cursor when the cursor id itself was removed. @unstable */
    prune: (s: ReviewSession, removed: Set<number>) => PruneResult;
    /** Mark the current cursor reviewed and step forward. `done` is true when the
     *  session has no remaining items. @unstable */
    advance: (s: ReviewSession) => {
        session: ReviewSession;
        done: boolean;
    };
    /** Step backward without marking anything reviewed. Null when already at the start. @unstable */
    retreat: (s: ReviewSession) => ReviewSession | null;
    /** Position of the session cursor within its review order. @unstable */
    index: (s: ReviewSession) => number;
    /** The session's locations in `mode`: those reviewed, or those still to review. @unstable */
    ids: (s: ReviewSession, mode: ReviewMode) => number[];
    /** Union of reviewed ids across sessions, de-duplicated. @unstable */
    reviewedIds: (sessions: ReviewSession[]) => number[];
    /** True when the cursor is on the session's first location. @unstable */
    isAtStart: (s: ReviewSession) => boolean;
    /** True when the cursor is on the session's last location. @unstable */
    isAtEnd: (s: ReviewSession) => boolean;
    /** Current cursor location is in the reviewed set. @unstable */
    isCurrentReviewed: (s: ReviewSession) => boolean;
    /** Reactive active review session, or null. @unstable */
    useSession: () => ReviewSession | null;
    /** The active review session, or null. @unstable */
    session: () => ReviewSession | null;
    /** Start or resume a review over `ids`. When `source` is a selection, re-reviewing
     *  that selection resumes any in-progress session for it. @unstable */
    begin: (ids: number[], source?: Selection) => Promise<void>;
    /** Review the selected locations. With one active selection, the review belongs to it and
     *  resumes with it. @unstable */
    beginSelected: () => Promise<void>;
    /** Make a saved session the active one, dropping locations that no longer exist. Given
     *  the selection's current matches, any its worklist lacks are offered as new matches. @unstable */
    resume: (s: ReviewSession, currentMatches?: number[]) => Promise<void>;
    /** Reactive new matches of the active session's selection, not yet in its worklist. @unstable */
    useNewMatches: () => number[];
    /** Append the new matches to the end of the worklist, in the map's review order. @unstable */
    appendNewMatches: () => Promise<void>;
    /** Mark the current location reviewed and step to the next one. @unstable */
    next: () => Promise<void>;
    /** Step back to the previous location in the session. @unstable */
    prev: () => Promise<void>;
    /** Delete the current location and advance to the next one. Exits the pass if it
     *  was the last item. @unstable */
    deleteCurrent: () => Promise<void>;
    /** Exit the review UI but keep the session resumable (persisted as active). @unstable */
    cancel: () => void;
    /** Rename a review session. @unstable */
    rename: (id: string, name: string) => Promise<void>;
    /** Delete a review session (its progress, not the locations). @unstable */
    removeSession: (id: string) => Promise<void>;
    /** Review sessions for the open map, optionally filtered by status. @unstable */
    sessions: (status?: "active" | "done") => Promise<ReviewSession[]>;
    /** Select every location marked reviewed across all sessions on this map. @unstable */
    selectReviewed: () => Promise<void>;
    /** The locations of review session `s` that are reviewed, or still to review. @unstable */
    selector: (s: ReviewSession, mode: ReviewMode) => Selector;
};

/** Saved selection rules shared across maps. Tag membership is stored by name
 * so rules can be applied on maps with different tag ids. */

/** One part of a saved rule: what its chip reads as, and what it resolves to here. The
 *  label comes from the tree as saved, so a tag this map doesn't have still reads by the
 *  name it was saved under. @unstable */
export interface SavedPart {
    label: string;
    color: RGB;
    selector: Selector;
}
/** Saved selection rules. @api @unstable */
declare const SavedSelection: {
    /** Selection types that cannot be saved as rules because they are bound to the open map. @unstable */
    MAP_LOCAL_TYPES: readonly ["Locations", "Manual", "Validation", "Reviewed", "Selected"];
    /** Whether the selector tree contains only portable types (no map-local leaves). @unstable */
    isSaveable: (selector: Selector) => boolean;
    /** A rule's parts: its top-level `Union` is the list it was saved from, anything else is
     *  a single part. @unstable */
    parts: (saved: SavedSelection) => SavedPart[];
    /** The rules that exist, as identity only. Empty until the index loads: the first
     *  call starts the read and `saved-selections:changed` announces it. @unstable */
    index: () => SavedSelectionInfo[];
    /** Load the full rule bodies for the given `ids`. @unstable */
    load: (ids: string[]) => Promise<SavedSelection[]>;
    /** Every rule with its body. @unstable */
    loadAll: () => Promise<SavedSelection[]>;
    /** Persists the saveable selections as one rule. False when none of them are saveable. @unstable */
    save: (name: string, selections: Selection[]) => Promise<boolean>;
    /** Permanently delete a saved selection rule. @unstable */
    remove: (id: string) => Promise<void>;
    /** Adds the rule's parts to the sidebar, resolved against the open map. Returns how many
     *  were added. @unstable */
    apply: (saved: SavedSelection) => number;
};

/** @unstable */
export type Disposable = () => void;
/** Enroll a teardown callback under the current plugin. No-op outside activation. @api @unstable */
declare function trackDisposable(dispose: Disposable): void;
/** Resolve a relative path against the current plugin's base directory. Absolute
 *  paths and `res://` URLs pass through unchanged. @api @unstable */
declare function resolvePluginPath(path: string): string;
/** Subscribe to an editor event or a plugin's own event, automatically unsubscribed on plugin
 *  deactivation. @api */
declare function on<E extends EditorEvent | PluginEvent<unknown>>(event: E, handler: EventHandler<E>): () => void;
/** Name one of plugin `pluginId`'s own events, carrying a `T`. Define it once and share it, so
 *  whoever raises it and whoever hears it agree on the payload. @api @unstable */
declare function definePluginEvent<T = void>(pluginId: string, name: string): PluginEvent<T>;
/** Raise one of a plugin's own events, with its payload when it carries one. @api @unstable */
declare function emitPluginEvent<T>(event: PluginEvent<T>, ...payload: T extends void ? [] : [payload: T]): void;
/** React hook: what `read` returns, read again each time `event` is raised. `read` must return
 *  the same reference while nothing it reads has changed. @api @unstable */
declare function usePluginEvent<V>(event: PluginEvent<unknown>, read: () => V): V;

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
/** The seen-location history and how panorama visits are recorded into it. @api @unstable */
declare const Seen: {
    /** The map location each entry was seen at, while it still shows the entry's pano; null otherwise. @unstable */
    onMap: (list: readonly Pick<SeenPano, "locationId" | "panoId">[]) => Promise<(Location | null)[]>;
    /** A page of the seen (visited-panorama) history and how many entries match the filter. @unstable */
    list: (limit?: number, offset?: number, filter?: SeenFilter, thumbnails?: boolean) => Promise<SeenPage>;
    /** Distinct country codes that appear in the seen history. @unstable */
    countries: () => Promise<string[]>;
    /** Maps that have seen-history entries. @unstable */
    maps: () => Promise<SeenMapInfo[]>;
    /** Delete the entire seen history. Not undoable. @unstable */
    clear: () => Promise<void>;
    /** Suppress the next seen-history entry for `panoId`. @unstable */
    skipNext: (panoId: string) => void;
    /** Update the pending seen entry's geocode info (country, address). @unstable */
    updateGeo: (geo: GeoDisplay) => void;
    /** Record a panorama change for the seen history. Flushes the previous entry and stages the new one. @unstable */
    panoChanged: (location: PendingEntryLocation, geo: GeoDisplay | null, viewer: PanoViewer) => void;
    /** Write the pending seen entry to disk, if any. @unstable */
    flush: (viewer: PanoViewer) => void;
    /** Record a pano visit now at its starting view, with a thumbnail if that view is still on screen once imagery arrives. @unstable */
    record: (location: PendingEntryLocation & LocationPOV, viewer: PanoViewer) => Promise<void>;
    /** Open a seen entry's panorama in the Street View viewer. @unstable */
    loadPano: (entry: SeenPano, viewer: PanoViewer) => Promise<void>;
};

/** Pure selection transforms: build, compose, invert, rewrite, and remove selections. */

/** @api @unstable */
declare const UNARY_TYPES: readonly ["Invert"];
/** @unstable */
export type FilterOpKind = FilterOp["op"];
/** Whether a predicate reads the location's clock in its own timezone. Only a range can. @api @unstable */
declare const filterIsLocalTime: (test: FilterOp) => boolean;
/** Display symbol/word for each filter operator. Symbols are language-neutral; only the worded
 *  operators are marked for translation. @api @unstable */
declare const OP_LABELS: Record<FilterOpKind, string>;
/** Locations carrying `tagId`. A tag is membership in the `tags` list field and nothing
 *  else, so there is no tag selector to build. @api @unstable */
declare const tagSelector: (tagId: number) => Selector;
/** Locations with no tags: `tags` resolves to nothing on an untagged location. @api @unstable */
declare const untaggedSelector: () => Selector;
/** Locations whose heading was never set. @api @unstable */
declare const unpannedSelector: () => Selector;
/** Locations pinned to one exact pano (the flag plus a pano id), or the locations not
 *  pinned. @api @unstable */
declare function panoIdSelector(on: boolean): Selector;
/** Locations holding a value for `field`. @api @unstable */
declare const has: (field: string) => Selector;
/** Locations holding no value for `field`. @api @unstable */
declare const lacks: (field: string) => Selector;
/** Locations matching every one of `selectors`; with none, every location. @api @unstable */
declare const all: (...selectors: Selector[]) => Selector;
/** Locations matching any of `selectors`; with none, no location. @api @unstable */
declare const any: (...selectors: Selector[]) => Selector;
/** Locations not matching `selector`. @api @unstable */
declare const not: (selector: Selector) => Selector;
/** The interned value a selector tests membership of, or null when it tests something else.
 *  The single place that recognises value membership, so nothing else has to know its shape. @api @unstable */
declare function memberOf(selector: Selector): {
    field: string;
    id: number;
} | null;
/** The tag a selector names, or null when it names something else. @api @unstable */
declare function tagIdOf(selector: Selector): number | null;
/** What one selection type answers about itself; optional answers default at the lookup. @unstable */
export interface SelectionDescriptor<K extends Selector["type"]> {
    label(selector: Variant<Selector, K>, valueNames?: ValueNames): string;
}
/** The display label of each selector variant. @api @unstable */
declare const SELECTIONS: {
    [K in Selector["type"]]: SelectionDescriptor<K>;
};
/** Every child selection a selector wraps, whatever shape it wraps them in. @api @unstable */
declare function childSelections<S>(selector: Selector$1<S>): S[];
/** `selector` with its children replaced, keeping the shape it wraps them in. @api @unstable */
declare function withChildren<S>(selector: Selector$1<S>, children: S[]): Selector$1<S>;
/** An unaddressed selection input; the store supplies its key and default color. @api @unstable */
declare function selection(selector: Selector, color?: RGB): SelectionInput;
/** @api @unstable */
declare function buildSelection(selector: Selector): Promise<Selection>;
/** @unstable */
export type SelectionPath = number[];
/** @api @unstable */
declare function selectionAt(rows: ListedSelection[], path: SelectionPath): Selection | undefined;
/** @api @unstable */
declare const addSelection: (...selectors: Selector[]) => SelectionOp;
/** @api @unstable */
declare const toggleSelection: (...selectors: Selector[]) => SelectionOp;
/** @api @unstable */
declare const replaceSelection: (path: SelectionPath, selector: Selector) => SelectionOp;
/** Human-readable label for a selection. Pass `valueNames` to resolve interned values by
 *  saved name rather than the open map's records. @api @unstable */
declare function selectionDisplayName(sel: SelectionInput, valueNames?: ValueNames): string;

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
/** Convert a picker choice into the corresponding `Selector`. @api @unstable */
declare function selectorForPick(choice: SelectorPick): Selector;
/** React hook: selector state with live counts. Defaults to the current selection when one
 *  exists, else all locations. @api @unstable */
declare function useSelectorPick(initial?: SelectorPick): SelectorPickController;

/** @unstable */
declare function isOfficialPano(panoId: string): boolean;

/** How a coordinate search runs: how far it reaches, which collections it searches, and
 *  whether it picks the nearest or the best pano. `onPano` sees each point's answer the
 *  moment its search resolves, ahead of the full array. @unstable */
export interface SearchOpts {
    radius?: number;
    sources?: PanoType[];
    preference?: RankingStrategy;
    signal?: AbortSignal;
    onPano?: (index: number, pano: Pano | null) => void;
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
/** View a Google Maps link should open at. @unstable */
export type MapsPanoView = PanoView & Pick<Location, "lat" | "lng">;
/** @unstable */
export type PanoRenderMode = "equirectangular" | "perspective" | "thumbnail" | "tile";
/** @unstable */
export interface PanoDownloadConfig {
    mode: PanoRenderMode;
    zoom: number;
    tileX: number;
    tileY: number;
}
/** @unstable */
export interface BulkDownloadResult extends BatchOutcome {
    /** Temp file (single image or ZIP) ready for the export save dialog; null when nothing downloaded. */
    output: {
        path: string;
        name: string;
    } | null;
}
/** Google Street View: coverage lookups and pano metadata, search radii, pinning locations to
 *  their panos and turning them along the road, links into Google Maps, and panorama
 *  downloads. @api @unstable */
declare const StreetView: {
    /** Metres a coordinate search reaches by default. @unstable */
    searchRadius: number;
    /** Metres the viewer searches for official coverage when a pano's own timeline holds none. @unstable */
    officialFallbackRadius: number;
    /** Metres a jump to a typed-in coordinate searches. @unstable */
    jumpRadius: number;
    /** Whether a pano id names official Google coverage. @unstable */
    isOfficial: typeof isOfficialPano;
    /** A pano's stack merged with another's, for the all-unofficial case where the multi-year
     *  history lives on official coverage nearby. Entries are keyed by pano id and later
     *  sources win, so pass the pano itself last. Ascending by date, as every timeline is. @unstable */
    mergeTimelines: (sources: (Pano | null)[]) => Pano["time"];
    /** True when nothing in the timeline is official coverage, an empty stack included, so
     *  the multi-year history lives on official coverage nearby rather than on these panos. @unstable */
    allUnofficial: (time: Pano["time"]) => boolean;
    /** Full pano metadata for one or more panos, aligned to `panoIds`, null where a pano does
     *  not exist. Rejects when a lookup fails, so a failure is never taken for a missing pano.
     *  Duplicates are deduped and large batches are split automatically. @unstable */
    metadata: (panoIds: string[], signal?: AbortSignal) => Promise<(Pano | null)[]>;
    /** The nearest pano to each point, aligned to `points`, null where there is no coverage. @unstable */
    panosAt: (points: LatLng[], { radius, signal, onPano, ...search }?: SearchOpts) => Promise<(Pano | null)[]>;
    /** The pano a location should display: the one it is pinned to when that still resolves,
     *  otherwise whatever sits at its coordinates. @unstable */
    resolve: (loc: Location) => Promise<Pano | null>;
    /** Metres of map a search covers at `zoom` and latitude `lat`. @unstable */
    radiusAtZoom: (lat: number, zoom: number) => number;
    /** The radius (m) a map click searches for coverage: the zoom/lat extent, floored by
     *  `minRadius` (the per-map searchRadius) or the default search radius. @unstable */
    clickRadius: (lat: number, zoom: number, minRadius?: number) => number;
    /** The heading a new location starts at, from the pano's road links and a direction preference. @unstable */
    initialHeading: (data: Pano, opts?: {
        pointAlongRoad?: boolean;
        preferDirection?: string | null;
    }) => number;
    /** The location a map click lands on: the best panorama near the click, its heading, and
     *  whether it must be pinned because it is not the default coverage there. @unstable */
    lookup: (lat: number, lng: number, zoom: number, opts: {
        preferOfficial?: boolean;
        onlyOfficial?: boolean;
        pointAlongRoad?: boolean;
        preferDirection?: string | null;
        defaultPanoId?: boolean;
        preferHigherQuality?: boolean;
        radius?: number;
        minRadius?: number;
    }) => Promise<Location | null>;
    /** Walk linked panoramas from a starting pano in the given heading direction, returning
     *  the locations along the road, up to `maxSteps`. @unstable */
    follow: (startPanoId: string, heading: number, maxSteps?: number) => Promise<Location[]>;
    /** A small preview image of a pano facing `heading`. @unstable */
    thumbnailUrl: (panoId: string, heading: number, width?: number, height?: number) => string;
    /** Pin every location in the selector to its pano id, resolving pano ids first when asked. @unstable */
    pin: (selector: Selector, opts?: PinOpts) => Promise<PinOutcome>;
    /** Pan every heading in the selector along the road. @unstable */
    panHeading: (selector: Selector, direction: RoadDirection, opts?: BulkOpts) => Promise<BatchOutcome>;
    /** A google.com/maps Street View link aimed at `view`. Official panos embed a thumbnail
     *  (`!6s`) so the link unfurls with a preview; unofficial ones have none to point at. @unstable */
    mapsUrl: (view: MapsPanoView) => URL;
    /** Carry a location's tags (and its lat/lng load mode) on a Maps link, so importing it back
     *  reconstructs them. @unstable */
    appendLinkTags: (url: URL, loc: Location, tagsById: Record<number, Tag>) => void;
    /** Copy a Maps link to the clipboard, shortened unless `long`. @unstable */
    copyLink: (url: URL, { long }?: {
        long?: boolean;
    }) => Promise<void>;
    /** A Maps link shortened through Google's own shortener, or the link unchanged when that fails. @unstable */
    shortenLink: (longUrl: string) => Promise<string>;
    /** Download the full panorama as a single stitched JPEG. Toasts on success/failure. @unstable */
    download: (panoId: string, zoom?: number) => Promise<void>;
    /** Download panoramas for `locations`, uploading each image into a session dir (via
     *  mma-buf POST) that is packaged into a single file or Stored ZIP. @unstable */
    downloadAll: (locations: Location[], config: PanoDownloadConfig, opts?: BulkOpts) => Promise<BulkDownloadResult>;
};

/** Sort tags by the chosen mode: name, location count, or manual order. @api */
declare function sortTagsByMode(tags: Tag[], mode: TagSortMode, counts: Record<number, number>): Tag[];
/** Color for a tag named `name`. An existing tag uses its stored color. @api */
declare function tagColorFor(name: string, tags: Tag[]): string;
/** Tags staged on a location until it saves: existing tags by id, and typed names that Save creates. */
export interface PendingTags {
    ids: number[];
    names: string[];
}
/** Stage typed text as the existing tag it names, ignoring case, or as a name to create.
 *  Returns `pending` unchanged if already staged. @api */
declare function addPendingTag(pending: PendingTags, name: string, tags: Tag[]): PendingTags;
/** Stage the tag, or unstage it if it is already staged. @api */
declare function togglePendingTag(pending: PendingTags, id: number): PendingTags;
/** The tag ids pending tags save as, creating the typed names. A tag deleted meanwhile is left out. @api */
declare function pendingTagIds({ ids, names }: PendingTags): Promise<number[]>;
/** Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
 *  the `/`-path to its shortest unique suffix; otherwise returns the name verbatim. @api */
declare function displayTagName(name: string): string;

/** Low-level shell and file dialog access. */

/** @api @unstable */
declare const shell: {
    /** @unstable */
    Command: typeof Command;
};
/** @api @unstable */
declare const dialog: {
    /** @unstable */
    open: typeof open;
    /** @unstable */
    save: typeof save;
};

/** Deterministic wrappers the e2e suite drives, mounted as `MMA._test`. App code never calls them. @api @unstable */
declare const _test: {
    /** @unstable */
    mapOpen: {
        start: number;
        seen: Set<string>;
        begin(): void;
        mark(phase: string): void;
    };
    /** Force a full selection re-resolve and return the selected IDs. @unstable */
    syncSelections: () => Promise<{
        ids: number[];
    }>;
    /** Open a map by id and navigate to it. @unstable */
    openMap: (id: string) => Promise<void>;
    /** Close the current map and return to the map list. @unstable */
    closeMap: () => Promise<void>;
    /** Delete a map by id. @unstable */
    deleteMap: (id: string) => Promise<void>;
    /** Import locations from pasted text and commit them to the map. @unstable */
    importPaste: (text: string) => Promise<EditorImportResult[]>;
    /** Import a previewed file, optionally assigning tags. @unstable */
    importFile: (droppedFields: string[], tagNames?: string[]) => Promise<EditorImportResult>;
};

/** Show a brief toast notification. Optionally scoped to a `container` element. @api */
declare function toast(message: string, duration?: number, container?: HTMLElement): void;

/** A round picture `size` pixels wide, showing `fallback` (a plain figure by default) when there is no `src` or it fails to load, ringed in `ring` when given. */
declare function Avatar({ src, size, fallback, ring, className, style, ...props }: ComponentPropsWithRef<"span"> & {
    src?: string | null;
    size?: number;
    fallback?: ReactNode;
    ring?: string;
}): react.JSX.Element;

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
declare function ConfirmButton({ onConfirm, confirmLabel, icon, variant, children, onBlur, ...props }: Omit<ComponentPropsWithRef<typeof Button>, "onClick"> & {
    onConfirm: () => void;
    /** The label while armed. Defaults to "Are you sure?". */
    confirmLabel?: ReactNode;
    /** An icon to show until the first click, with the button's text as its label. */
    icon?: string;
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
     *  date filtering, which re-interprets the wall-clock in each pano's zone. */
    wallClock?: boolean;
}
/** @unstable */
declare function DatePicker({ mode, value, onChange, anyYear, onAnyYearToggle, showAnyYear, showTime, anyTime, onAnyTimeToggle, showAnyTime, tzLocal, onTzLocalToggle, showTzLocal, onYearSelect, wallClock, }: DatePickerProps): react.JSX.Element;

/** Controlled open/close pair every dialog component takes. @unstable */
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
/** A dialog's fixed width: small, medium, large or extra large. @unstable */
export type DialogSize = "sm" | "md" | "lg" | "xl";
/** @unstable */
declare function DialogContent({ className, title, size, aside, initialFocus, children, ...props }: ComponentProps<typeof Dialog$1.Popup> & {
    title: string;
    size?: DialogSize;
    /** Shown in the header between the title and the close button, such as a status. */
    aside?: ReactNode;
}): react.JSX.Element;
/** One button in a dialog footer. @unstable */
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
export type TagPillButtonVariant = "add" | "delete" | "edit" | "toggle";
/** A leading button that adds, removes, edits, or toggles a tag. @unstable */
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

/** Shared UI primitives for plugin sidebars and dialogs. @api */
declare const ui: {
    Avatar: typeof Avatar;
    Bar: typeof Bar;
    Button: typeof Button;
    Checkbox: typeof Checkbox;
    ColorPicker: typeof ColorPicker;
    /** @unstable */
    RgbPicker: typeof RgbPicker;
    /** @unstable */
    ConfirmButton: typeof ConfirmButton;
    CoverageBar: typeof CoverageBar;
    /** @unstable */
    DatePicker: typeof DatePicker;
    /** @unstable */
    ConfirmDialog: typeof ConfirmDialog;
    /** @unstable */
    Dialog: typeof Dialog;
    /** @unstable */
    DialogActions: typeof DialogActions;
    /** @unstable */
    DialogContent: typeof DialogContent;
    /** @unstable */
    DialogForm: typeof DialogForm;
    /** @unstable */
    DialogTrigger: _base_ui_components_react_dialog.DialogTrigger;
    /** @unstable */
    PromptDialog: typeof PromptDialog;
    /** @unstable */
    useCloseDialog: typeof useCloseDialog;
    Flag: typeof Flag;
    Hint: typeof Hint;
    Notice: typeof Notice;
    /** @unstable */
    HotkeyInput: typeof HotkeyInput;
    Icon: typeof Icon;
    /** @unstable */
    IconButton: typeof IconButton;
    /** @unstable */
    NSelect: typeof NSelect;
    ProgressRow: typeof ProgressRow;
    Radio: typeof Radio;
    SelectorPicker: typeof SelectorPicker;
    /** @unstable */
    SettingRow: typeof SettingRow;
    EmptyState: typeof EmptyState;
    Field: typeof Field;
    SegmentedControl: typeof SegmentedControl;
    Section: typeof Section;
    Sidebar: typeof Sidebar;
    Slider: typeof Slider;
    Spinner: typeof Spinner;
    /** @unstable */
    SuggestInput: typeof SuggestInput;
    Switch: typeof Switch;
    SwitchRow: typeof SwitchRow;
    /** @unstable */
    TagPill: typeof TagPill;
    /** @unstable */
    TagPillButton: typeof TagPillButton;
    TextInput: typeof TextInput;
    /** @unstable */
    ToolBlock: typeof ToolBlock;
    Tooltip: typeof Tooltip;
};

/** What a job's work is handed. */
export interface JobContext<P> {
    signal: AbortSignal;
    /** Push a progress value to the UI. Ignored once the job is cancelled. */
    report: (progress: P) => void;
}
/** A job's state, with the controls that start and stop it. */
export type Job<R, P = never> = JobState<R, P> & {
    /** Start `work`, resolving to how it settled. While a run is under way this does nothing
     *  and resolves cancelled, so a double-clicked button cannot start two. */
    run: <T extends R>(work: (ctx: JobContext<P>) => Promise<T>) => Promise<Settled<T>>;
    /** Stop the run under way; nothing it does afterwards can write back. */
    cancel: () => void;
};
/** User-triggered async work that reports progress and can be cancelled. Unmounting cancels. @api */
declare function useJob<R = unknown, P = never>(): Job<R, P>;

/** URL that serves a local file over the `mma-buf://` protocol. @api @unstable */
declare function mmaBufUrl(path: string): string;
/** Copy of `set` with `value` toggled, or forced on/off by `on`. @api @unstable */
declare function toggleInSet<T>(set: ReadonlySet<T>, value: T, on?: boolean): Set<T>;
/** The item `isBetter` prefers over every other, or null when there are none. @api @unstable */
declare function bestBy<T>(items: Iterable<T>, isBetter: (a: T, b: T) => boolean): T | null;
/** Shuffle `items` in place (Fisher-Yates) and return them. @api @unstable */
declare function shuffle<T>(items: T[]): T[];
/** Split `arr` into sub-arrays of at most `n` elements. @api @unstable */
declare function chunk<T>(arr: readonly T[], n: number): T[][];
/** Compare two semver strings (e.g. "0.6.1", "0.7.0-rc.2"). Returns >0 if a > b.
 *  Build metadata is ignored; a pre-release sorts below the release it precedes. @api @unstable */
declare function cmpVersion(a: string, b: string): number;
/** `["0.7.0", "rc.2"]` for `"v0.7.0-rc.2+build"`; the pre-release part is `""` when absent. @api @unstable */
declare function splitVersion(v: string): [core: string, pre: string];
/** True when `v` carries a semver pre-release tag, e.g. "1.0.0-beta.1". @api @unstable */
declare function isPrereleaseVersion(v: string): boolean;
/** True when the app runs in a browser instead of the desktop app. @api @unstable */
declare function isWeb(): boolean;
/** Prompt for files; resolves empty when the picker is dismissed. @api @unstable */
declare function pickFiles(accept: string, opts?: {
    multiple?: boolean;
}): Promise<File[]>;
/** Trigger a browser download from an in-memory Blob. @api @unstable */
declare function downloadBlob(blob: Blob, fileName: string): void;
/** Copy an image Blob to the clipboard. False when the platform refuses it. @api @unstable */
declare function copyImageToClipboard(blob: Blob): Promise<boolean>;
/** Compare strings with natural (numeric-aware) ordering. @api @unstable */
declare function compareNatural(a: string, b: string): number;
/** Current time as Unix seconds, the form Location timestamps use. @api @unstable */
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
 *  of work has elapsed. @api @unstable */
declare function phaseRate(prev: PhaseRate | null, done: number, total: number, now: number): {
    state: PhaseRate;
    rate: number | null;
};

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
/** @api @unstable */
declare const VALIDATION_CATEGORIES: readonly ValidationCategory[];
/** @api @unstable */
declare const STANDARD_VALIDATION_CATEGORIES: string[];
/** The category a key names, or null for one this version does not know. @api @unstable */
declare function validationCategory(key: string): ValidationCategory | null;

export type AccountApi = {
    /** The GitHub account the user is signed in with, and signing in or out of it. */
    Account: typeof Account;
};
export type AutosaveApi = {
    /** Debounced persistence of the open map: schedule, hold, cancel, or flush it. */
    Autosave: typeof Autosave;
};
export type BindingsConstsApi = {
    BUILTIN_FIELDS: typeof BUILTIN_FIELDS;
    CameraType: typeof CameraType;
    /** A capture of a pano's timeline to settle on. */
    CapturePick: typeof CapturePick;
    /** @unstable */
    DEFAULT_DUPLICATE_SCORE: typeof DEFAULT_DUPLICATE_SCORE;
    DEFAULT_MARKER_COLOR: typeof DEFAULT_MARKER_COLOR;
    /** A calendar component to group dates by. */
    DatePart: typeof DatePart;
    /** @unstable */
    ERROR_CODES: typeof ERROR_CODES;
    /**
     * Type discriminant for `Location.extra` field definitions.
     * Determines how the field is displayed and filtered in the UI.
     *
     */
    FieldType: typeof FieldType;
    /**
     * First-sync seeding when both sides already have pins. Only meaningful on the first sync
     * (empty mapping); afterwards it's plain three-way. `Merge` never deletes.
     * @unstable
     */
    FirstSyncMode: typeof FirstSyncMode;
    /** How a group of selections joins its members. */
    Group: typeof Group;
    /** @unstable */
    IssueState: typeof IssueState;
    KNOWN_FIELDS: typeof KNOWN_FIELDS;
    /** Per-location bitfield, sent and stored as a plain `u32`. */
    LocationFlag: typeof LocationFlag;
    /** How much of a map a destination keeps. Each shape keeps everything the one before it does. */
    MapShape: typeof MapShape;
    /** When a move target already holds a value, which side survives. */
    MergeWinner: typeof MergeWinner;
    OFFICIAL_ID_PATTERN: typeof OFFICIAL_ID_PATTERN;
    /** @unstable */
    PROJECTIONS: typeof PROJECTIONS;
    /** Which imagery collection a pano id belongs to. */
    PanoType: typeof PanoType;
    /** Where a moved selection lands beside its target. */
    Place: typeof Place;
    /**
     * Which pano the search picks; omitted means closest. BEST at a small radius can return a
     * neighbouring pano from the same capture run, so probe a pano's own coordinate with CLOSEST.
     *
     */
    RankingStrategy: typeof RankingStrategy;
    /**
     * What one attempt charges the bucket: the call itself, or one per row in its batch
     * (for APIs that bill multi-row requests per row).
     *
     */
    RateCost: typeof RateCost;
    /** Which side won a resolved conflict. @unstable */
    ResolutionSide: typeof ResolutionSide;
    /** Which locations of a review session a selection holds. */
    ReviewMode: typeof ReviewMode;
    /** @unstable */
    SCRATCH_MAP_ID: typeof SCRATCH_MAP_ID;
    /** Every sync provider: which way it carries changes, and what it keeps of a map. @unstable */
    SYNC_PROVIDERS: typeof SYNC_PROVIDERS;
    /**
     * Where a provider's results go. `Patch` applies them to the locations they name;
     * `Collect` delivers them to the caller and writes nothing. The declaration decides
     * this, never the contents of a result.
     *
     */
    Sink: typeof Sink;
    /** Which edit history stack to step through. */
    Stack: typeof Stack;
    /** Which way a link carries changes. @unstable */
    SyncDirection: typeof SyncDirection;
    /** What started a sync pass. @unstable */
    SyncTrigger: typeof SyncTrigger;
    /** Which edit history to step through. Each part of the map that undoes on its own has one. */
    Timeline: typeof Timeline;
    /** Country codes Vali has coverage data for. @unstable */
    VALI_COUNTRIES: typeof VALI_COUNTRIES;
    /**
     * One finding of a Street View coverage check. `validate` answers each row with the
     * findings that apply, combined into one number.
     *
     */
    ValidationFlag: typeof ValidationFlag;
};
export type ColorApi = {
    /**
     * Deterministic tag color from a name.
     * @unstable
     */
    colorForName: typeof colorForName;
    /** Convert "#rrggbb" to HSL. @unstable */
    hexToHsl: typeof hexToHsl;
    /** Parse "#rrggbb" or "#rgb" to an [r, g, b] byte tuple; black when it is not hex. @unstable */
    hexToRgb: typeof hexToRgb;
    /** Convert HSL to "#rrggbb". @unstable */
    hslToHex: typeof hslToHex;
    /** Convert HSL (h in degrees, s and l in 0-1) to an RGB byte tuple. @unstable */
    hslToRgb: typeof hslToRgb;
    /** A label's color: a user override if set, else a deterministic color from its name. @unstable */
    labelColor: typeof labelColor;
    /** `color` moved toward white on a dark `background`, or black on a light one, until the two
     *  reach WCAG AA contrast. @unstable */
    legible: typeof legible;
    /** WCAG relative luminance of a color, from 0 for black to 1 for white. @unstable */
    luminance: typeof luminance;
    /** Resolve an SV coverage color to hex. Accepts "#rrggbb" or a CSS custom-property
     *  ramp name (legacy stored format). @unstable */
    resolveSvColorHex: typeof resolveSvColorHex;
    /** Format an RGB tuple as a CSS `rgb(r, g, b)` string. @unstable */
    rgbCss: typeof rgbCss;
    /** Convert an RGB byte tuple to "#rrggbb". @unstable */
    rgbToHex: typeof rgbToHex;
    /** Return "#000" or "#fff" for readable text on the given hex background. @unstable */
    textColorFor: typeof textColorFor;
};
export type CommandsApi = {
    /** Every backend command, typed. Any of them can change in a release. @unstable */
    cmd: typeof cmd;
};
export type CommitApi = {
    /** Save and restore map versions. */
    Commit: typeof Commit;
};
export type CommitDiffApi = {
    /** Uncommitted changes and their preview on the map. @unstable */
    CommitDiff: typeof CommitDiff;
};
export type EditApi = {
    /** Edit map locations, metadata, value records, and selections. */
    Edit: typeof Edit;
};
export type EditorApi = {
    /** Open locations and change the editor pane. */
    Editor: typeof Editor;
};
export type FieldApi = {
    /** Rename or remove metadata fields across the map. */
    Field: typeof Field$1;
};
export type FieldDefRegistryApi = {
    /** The "Range" partition option (numeric binning). @unstable */
    RANGE_ID: typeof RANGE_ID;
    /** The value space a field declares, as bare strings. Distinct from the store's
     *  `fieldValues`, which reports the values actually present in the data. */
    declaredValues: typeof declaredValues;
    /** Translated display label for a field key, falling back to a sentence-cased version of the key. */
    fieldLabel: typeof fieldLabel;
    /** Display label for a field value. Enum values use their translated display name. */
    fieldValueLabel: typeof fieldValueLabel;
    /** Merged view of all field definitions across all layers. */
    getAllFieldDefs: typeof getAllFieldDefs;
    /** All built-in field keys (excluding virtual). @unstable */
    getBuiltinKeys: typeof getBuiltinKeys;
    /** Look up metadata for a field key. Returns `undefined` if no layer declares it. */
    getFieldDef: typeof getFieldDef;
    /** Every listable built-in, and every field this map defines. @unstable */
    getFieldKeys: typeof getFieldKeys;
    /** Keys this map defines a field for. Same reference until the user layer moves. */
    getKnownFieldKeys: typeof getKnownFieldKeys;
    /** True when `key` is a built-in Location field (stored top-level, not under `extra`). */
    isBuiltinField: typeof isBuiltinField;
    /** True when the field can be bulk-cleared. @unstable */
    isClearableField: typeof isClearableField;
    /** True when the field should appear in field pickers. @unstable */
    isListableField: typeof isListableField;
    /** True when the field can be bulk-edited. @unstable */
    isWritableField: typeof isWritableField;
    /** Partition-key dropdown options for a field type. @unstable */
    partitionKeyOptions: typeof partitionKeyOptions;
    /** Projections valid for a field type, in display order (first = dialog default). @unstable */
    projectionsForType: typeof projectionsForType;
    /** Register field definitions from an enrichment provider (called at activation). */
    registerPluginFieldDefs: typeof registerPluginFieldDefs;
    /** Remove plugin field definitions by key (called when a plugin is deactivated). */
    unregisterPluginFieldDefs: typeof unregisterPluginFieldDefs;
};
export type FieldDefsApi = {
    /** The fields enrichment fetches for `enrichFields` (the default set when null): the chosen
     *  ones and every field they read, so no field runs without its inputs. @unstable */
    enabledEnrichKeys: typeof enabledEnrichKeys;
    /** The enrichment fields `key`'s provider reads. @unstable */
    enrichInputs: typeof enrichInputs;
    /** All enrichment field keys (core and plugin-registered). @unstable */
    getAllEnrichKeys: typeof getAllEnrichKeys;
    /** Keys enriched when enrichFields is null (the default set: all options except defaultOff ones). @unstable */
    getDefaultEnrichKeys: typeof getDefaultEnrichKeys;
    /** All enrichment field options: the core fields, then every registered provider's own fields. @unstable */
    getEnrichFieldOptions: typeof getEnrichFieldOptions;
    /** True when enrichment fetches `key` for the given enrichment set. @unstable */
    isFieldEnabled: typeof isFieldEnabled;
    /** Build field definitions for well-known keys (e.g. `"altitude"`, `"countryCode"`). */
    knownFieldDefs: typeof knownFieldDefs;
};
export type HistoryApi = {
    /** Navigate undo and redo history. */
    History: typeof History;
};
export type ImportApi = {
    /** Stage, preview, and confirm an import into the open map. @unstable */
    Import: typeof Import;
};
export type JobsApi = {
    /** Cancel every live job of `scope` that can be cancelled. Owners observe their own
     *  abort and end their jobs; entries without a cancel are removed outright. @unstable */
    cancelJobs: typeof cancelJobs;
    /** Live jobs, for the tray. Reference changes on every update. @unstable */
    getJobs: typeof getJobs;
    /** Register a long-running operation with the global job tray. The caller owns the
     *  work; the registry owns only its presentation and the cancel/reveal controls. @unstable */
    registerJob: typeof registerJob;
    /** Sugar for promise-shaped work: registers a job wired to an AbortController, reports
     *  through the handle, ends the job however `fn` settles, and resolves to how it settled.
     *  A failure also toasts. @unstable */
    runJob: typeof runJob;
};
export type LayerApi = {
    /** A pending layer. Operations run in order; work still writing to a landed layer outlives close. @unstable */
    Layer: typeof Layer;
};
export type LegacyApi = {
    /** @deprecated v0.12.0. Use `MMA.Location.add`. */
    addLocations: typeof addLocations;
    /** @deprecated v0.11.3. Use `MMA.Edit.selections(MMA.addSelection(...selectors))`. @unstable */
    addSelections: typeof addSelections;
    /** @deprecated v0.10.5. Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [tagId], remove: [] })`. @unstable */
    addTagToLocations: typeof addTagToLocations;
    /** @deprecated v0.12.0. Use `MMA.Edit.selections`. @unstable */
    applySelectionUpdate: typeof applySelectionUpdate;
    /** @deprecated v0.12.0. Use `MMA.Autosave`. */
    autosave: typeof autosave;
    /** @deprecated v0.12.0. Use `MMA.Commit.checkout`. @unstable */
    checkoutCommit: typeof checkoutCommit;
    /** @deprecated v0.12.0. Use `MMA.Editor.closeDuplicates`. @unstable */
    closeDuplicates: typeof closeDuplicates;
    /** @deprecated v0.12.0. Use `MMA.Editor.close`. */
    closeLocation: typeof closeLocation;
    /** @deprecated v0.12.0. Use `MMA.Maps.close`. */
    closeMap: typeof closeMap;
    /** @deprecated v0.12.0. Use `MMA.Commit.create`. */
    commitMap: typeof commitMap;
    /** @deprecated v0.12.0. Use `MMA.Maps.copyName`. @unstable */
    copyName: typeof copyName;
    /** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "countBy", fields: [field], key })`. @unstable */
    countBy: typeof countBy;
    /** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "count" })`. @unstable */
    countIn: typeof countIn;
    /** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "coverage" })`. @unstable */
    coverage: typeof coverage;
    /** @deprecated v0.12.0. Use `MMA.Maps.create`. */
    createMap: typeof createMap;
    /** @deprecated v0.11.0. Use `MMA.storage()`. @unstable */
    createPluginStorage: typeof createPluginStorage;
    /** @deprecated v0.11.7. Use the `{ type: "Selected" }` selector. @unstable */
    currentSelection: typeof currentSelection;
    /** @deprecated v0.12.0. Use `MMA.Field.remove`. */
    deleteField: typeof deleteField;
    /** @deprecated v0.12.0. Use `MMA.Maps.removeFolder`. */
    deleteFolder: typeof deleteFolder;
    /** @deprecated v0.12.0. Use `MMA.Maps.remove`. */
    deleteMap: typeof deleteMap;
    /** @deprecated v0.12.0. Use `MMA.Tag.remove`. */
    deleteTags: typeof deleteTags;
    /** @deprecated v0.12.0. Use `MMA.Maps.discard`. @unstable */
    discardOpenMap: typeof discardOpenMap;
    /** @deprecated v0.12.0. Use `MMA.Location.duplicate`. */
    duplicateLocation: typeof duplicateLocation;
    /** @deprecated v0.12.0. Use `MMA.Maps.duplicate`. */
    duplicateMap: typeof duplicateMap;
    /** @deprecated v0.12.0. Use `MMA.Edit`. */
    edit: typeof edit;
    /** @deprecated v0.12.0. Use `MMA.Editor.closePlugin`. */
    exitPluginMode: typeof exitPluginMode;
    /** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Everything" }, { kind: "locations" })`. @unstable */
    fetchAllLocations: typeof fetchAllLocations;
    /** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "bounds" })`. @unstable */
    fetchBounds: typeof fetchBounds;
    /** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "columns", fields })`. @unstable */
    fetchColumns: typeof fetchColumns;
    /** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Locations", locations: [id], name: null }, { kind: "locations" })`. @unstable */
    fetchLocation: typeof fetchLocation;
    /** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "locations" })`. @unstable */
    fetchLocations: typeof fetchLocations;
    /** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Locations", locations: ids, name: null }, { kind: "locations" })`. @unstable */
    fetchLocationsByIds: typeof fetchLocationsByIds;
    /** @deprecated v0.10.2. Use `MMA.Query.read(selector, { kind: "coverage" })`. @unstable */
    fieldCoverage: typeof fieldCoverage;
    /** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "values", field })`. @unstable */
    fieldValues: typeof fieldValues;
    /** @deprecated v0.8.2. Read `MMA.Editor.get().open?.location`. @unstable */
    getActiveLocation: typeof getActiveLocation;
    /** @deprecated v0.12.0. Use `MMA.SelectionList.active`. */
    getActiveSelections: typeof getActiveSelections;
    /** @deprecated v0.8.2. Read `MMA.SelectionList.listed()`. @unstable */
    getAllSelections: typeof getAllSelections;
    /** @deprecated v0.8.2. Read `MMA.Store.get().map`. @unstable */
    getCurrentMap: typeof getCurrentMap;
    /** @deprecated v0.8.2. Read `MMA.Store.get().mapId`. @unstable */
    getCurrentMapId: typeof getCurrentMapId;
    /** @deprecated v0.8.2. Read `MMA.SelectionList.listed()`. @unstable */
    getGhostedSelections: typeof getGhostedSelections;
    /** @deprecated v0.8.1. Use `MMA.MapHost.get()` and narrow via `MMA.MapHost.instance`. @unstable */
    getGoogleMap: typeof getGoogleMap;
    /** @deprecated v0.12.0. Use `MMA.Maps.badgeSources`. @unstable */
    getMapBadgeSources: typeof getMapBadgeSources;
    /** @deprecated v0.12.0. Use `MMA.Maps.badges`. @unstable */
    getMapBadges: typeof getMapBadges;
    /** @deprecated v0.12.0. Use `MMA.MapHost.get`. */
    getMapHost: typeof getMapHost;
    /** @deprecated v0.12.0. Use `MMA.Maps.list`. */
    getMapList: typeof getMapList;
    /** @deprecated v0.12.0. Use `MMA.Store.get`. */
    getMapState: typeof getMapState;
    /** @deprecated v0.13.0. Use `MMA.Scene.positions`. @unstable */
    getScenePositions: typeof getScenePositions;
    /** @deprecated v0.8.2. Read `MMA.Scene.selected()`. @unstable */
    getSelectedLocationIds: typeof getSelectedLocationIds;
    /** @deprecated v0.12.0. Use `MMA.SelectionList.tagIds`. @unstable */
    getSelectedTagIds: typeof getSelectedTagIds;
    /** @deprecated v0.12.0. Use `MMA.SelectionList.tagIdsDeep`. @unstable */
    getSelectedTagIdsDeep: typeof getSelectedTagIdsDeep;
    /** @deprecated v0.8.2. Use `MMA.SelectionList.active()`. @unstable */
    getSelections: typeof getSelections;
    /** @deprecated v0.12.0. Use `MMA.Tag.get`. */
    getTag: typeof getTag;
    /** @deprecated v0.12.0. Use `MMA.Tag.counts`. */
    getTagCounts: typeof getTagCounts;
    /** @deprecated v0.12.0. Use `MMA.Tag.all`. */
    getTags: typeof getTags;
    /** @deprecated v0.12.0. Use `MMA.Tag.visible`. */
    getVisibleTags: typeof getVisibleTags;
    /** @deprecated v0.8.2. Read `MMA.Editor.get().workArea`. @unstable */
    getWorkArea: typeof getWorkArea;
    /** @deprecated v0.12.0. Use `MMA.History.available`. @unstable */
    historyAvailable: typeof historyAvailable;
    /** @deprecated v0.12.0. Use `MMA.Maps.init`. @unstable */
    initStore: typeof initStore;
    /** @deprecated v0.11.0. Use `MMA.sidecar.installedVersion()`. @unstable */
    installedVersion: typeof installedVersion;
    /** @deprecated v0.12.0. Use `MMA.Maps.reload`. @unstable */
    invalidateMapList: typeof invalidateMapList;
    /** @deprecated v0.12.0. Use `MMA.Maps.isReserved`. @unstable */
    isReservedMap: typeof isReservedMap;
    /** @deprecated v0.12.0. Use `MMA.Query.locationsOf`. */
    locationsOf: typeof locationsOf;
    /** @deprecated v0.12.0. Use `MMA.Maps.moveToFolder`. */
    moveMapToFolder: typeof moveMapToFolder;
    /** @deprecated v0.12.0. Use `MMA.Mutation.run`. */
    mutate: typeof mutate;
    /** @deprecated v0.12.0. Use `MMA.Editor.openDuplicate`. @unstable */
    openDuplicateLocation: typeof openDuplicateLocation;
    /** @deprecated v0.12.0. Use `MMA.Editor.open`. */
    openLocation: typeof openLocation;
    /** @deprecated v0.12.0. Use `MMA.Maps.open`. */
    openMap: typeof openMap;
    /** @deprecated v0.12.0. Use `MMA.Maps.openScratch`. */
    openScratchMap: typeof openScratchMap;
    /** @deprecated v0.12.0. Use `MMA.Editor.openImport`. @unstable */
    openStagedLocation: typeof openStagedLocation;
    /** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "groupBy", field, key })`. @unstable */
    partition: typeof partition;
    /** @deprecated v0.12.0. Use `MMA.Location.duplicateGroups`. @unstable */
    previewDuplicateGroups: typeof previewDuplicateGroups;
    /** @deprecated v0.12.0. Use `MMA.Editor.preview`. @unstable */
    previewLocation: typeof previewLocation;
    /** @deprecated v0.12.0. Use MMA.Query.read(selector, ask) instead. @unstable */
    query: typeof query;
    /** @deprecated v0.12.0. Use `MMA.Query.read`. */
    read: typeof read;
    /** @deprecated v0.11.3. A provider's `fieldDefs` are offered as enrichment options on their
     *  own; set `defaultOff` on the provider to make them opt-in. @unstable */
    registerEnrichFields: typeof registerEnrichFields;
    /** @deprecated v0.10.2. Use `MMA.Provider.register()`. @unstable */
    registerEnrichmentProvider: typeof registerEnrichmentProvider;
    /** @deprecated v0.12.0. Use `MMA.Maps.registerBadges`. @unstable */
    registerMapBadges: typeof registerMapBadges;
    /** @deprecated v0.12.0. Use `MMA.Provider.register`. */
    registerProvider: typeof registerProvider;
    /** @deprecated v0.12.0. Use `MMA.Maps.reload`. @unstable */
    reloadMapList: typeof reloadMapList;
    /** @deprecated v0.12.0. Use `MMA.Editor.removeDuplicate`. @unstable */
    removeDuplicate: typeof removeDuplicate;
    /** @deprecated v0.12.0. Use `MMA.Location.remove`. */
    removeLocations: typeof removeLocations;
    /** @deprecated v0.11.3. Use `MMA.Edit.selections({ kind: "remove", keys })`. @unstable */
    removeSelections: typeof removeSelections;
    /** @deprecated v0.10.5. Use `MMA.Edit.work(MMA.tagSelector(tagId), { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. @unstable */
    removeTagFromAllLocations: typeof removeTagFromAllLocations;
    /** @deprecated v0.10.5. Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. @unstable */
    removeTagFromLocations: typeof removeTagFromLocations;
    /** @deprecated v0.12.0. Use `MMA.Field.rename`. */
    renameField: typeof renameField;
    /** @deprecated v0.12.0. Use `MMA.Maps.renameFolder`. */
    renameFolder: typeof renameFolder;
    /** @deprecated v0.11.0. Use `MMA.sidecar.request()`. @unstable */
    request: typeof request;
    /** @deprecated v0.11.3. Use `MMA.Edit.selections({ kind: "set", selections: [] })`. @unstable */
    resetSelections: typeof resetSelections;
    /** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "ids" })`. @unstable */
    resolveIds: typeof resolveIds;
    /** @deprecated v0.12.0. Use `MMA.Editor.resolve`. */
    resolveLocation: typeof resolveLocation;
    /** @deprecated v0.11.3. Use `MMA.Query.read({ type: "Sample", selection: MMA.selection(selector), n }, { kind: "ids" })`. @unstable */
    sampleFrom: typeof sampleFrom;
    /** @deprecated v0.12.0. Use `MMA.SelectionList.select`. */
    select: typeof select;
    /** @deprecated v0.12.0. Use `MMA.Editor.open(target)`, or `MMA.Editor.close()` in place of null. @unstable */
    setActiveLocation: typeof setActiveLocation;
    /** @deprecated v0.12.0. Use `MMA.Editor.openPlugin`. */
    setPluginMode: typeof setPluginMode;
    /** @deprecated v0.10.5. The user layer is store-owned state (`MMA.Store.get().fieldDefs`);
     *  use `MMA.Edit.meta({ extra: { fields } })` to change it, or `MMA.registerPluginFieldDefs()`
     *  for plugin-owned defs. @unstable */
    setUserFieldDefs: typeof setUserFieldDefs;
    /** @deprecated v0.12.0. Use `MMA.Editor.setArea`. @unstable */
    setWorkArea: typeof setWorkArea;
    /** @deprecated v0.12.0. Use `MMA.Mutation.settle`. */
    settled: typeof settled;
    /** @deprecated v0.12.0. Use `MMA.Tag.names`. */
    tagIdsToNames: typeof tagIdsToNames;
    /** @deprecated v0.12.0. Use `MMA.Location.update`. */
    updateLocations: typeof updateLocations;
    /** @deprecated v0.12.0. Use `MMA.Maps.useBadges`. @unstable */
    useMapBadges: typeof useMapBadges;
    /** @deprecated v0.12.0. Use `MMA.Maps.useList`. */
    useMapList: typeof useMapList;
    /** @deprecated v0.12.0. Use `MMA.Store.use`. */
    useMapState: typeof useMapState;
    /** @deprecated v0.8.1. Use `MMA.MapHost.wait()`. @unstable */
    waitForGoogleMap: typeof waitForGoogleMap;
    /** @deprecated v0.12.0. Use `MMA.MapHost.wait`. */
    waitForMapHost: typeof waitForMapHost;
};
export type LocationApi = {
    /** Add, update, remove, and inspect map locations. */
    Location: typeof Location;
};
export type MapHostApi = {
    /** The embedded map host, its preferences, and click interceptors. @unstable */
    MapHost: typeof MapHost;
};
export type MapsApi = {
    /** Create, list, open, close, and organize maps. */
    Maps: typeof Maps;
};
export type MutationApi = {
    /** Run mutations and wait for their state and display updates. */
    Mutation: typeof Mutation;
};
export type PanoApi = {
    /** The app's default pano viewer. @unstable */
    Pano: typeof Pano;
};
export type PluginStorageApi = {
    /** Persistent key-value storage a plugin keeps with the open map, so every map has its own.
     *  Each write changes only one key, patched onto the current map settings. */
    mapStorage: typeof mapStorage;
    /** A typed value under `key` in the plugin's persistent store. A stored value of another
     *  type than `fallback` reads as `fallback`. */
    pluginSetting: typeof pluginSetting;
    /** Persistent key-value storage namespaced to a plugin. Survives restarts. */
    storage: typeof storage;
    /** React state hook backed by the plugin's persistent store. Survives sidebar
     *  unmount and app restart. Values are global, not per-map. */
    usePluginState: typeof usePluginState;
};
export type ProcedureApi = {
    /** Procedure modules: ask one a question, or run one over locations. */
    Procedure: typeof Procedure;
};
export type ProviderApi = {
    /** Registered field producers: register one, list them, or run them over locations. */
    Provider: typeof Provider;
};
export type ProvidersApi = {
    /** The providers the app registers at startup. @unstable */
    BUILTIN_PROVIDERS: typeof BUILTIN_PROVIDERS;
    /** Enrich the locations in `selector` with every enrichment field the open map has on,
     *  resolving their panoramas first unless `resolve` is false. @unstable */
    enrich: typeof enrich;
    /** Build the provider run list for enrichment, narrowed to `enrichFields` and the fields they
     *  read. Fields not offered in the enrichment settings are always included. @unstable */
    enrichRuns: typeof enrichRuns;
    /** Exact capture timestamp, narrowed from the `imageDate` month via binary search. @unstable */
    exactDateProvider: typeof exactDateProvider;
    /** Pan a location's heading along the road. The driving direction is the pano's
     *  `centerHeading`; "forwards" faces it, "backwards" faces the opposite. @unstable */
    headingRoadProvider: typeof headingRoadProvider;
    /** Pano-resolve provider for enrichment. Writes the `panoId` field and runs before any
     *  provider that depends on it. Rows that already have a pano id are skipped unless the
     *  run is forced. @unstable */
    panoResolveProvider: typeof panoResolveProvider;
    /** Subdivision (adm1) via offline point-in-polygon against the local border dataset.
     *  No Google dependency; downloads the adm1 archive on first use. @unstable */
    subdivisionProvider: typeof subdivisionProvider;
    /** Core panorama metadata via Google's GetMetadata RPC. @unstable */
    svMetaProvider: typeof svMetaProvider;
    /** Timezone at the location's coordinates. Requires `datetime` to be present. @unstable */
    timezoneProvider: typeof timezoneProvider;
    /** Check that each location's Street View coverage still exists, grouping the locations
     *  into `categories` (keys of `VALIDATION_CATEGORIES`; the standard ones when omitted). @unstable */
    validateLocations: typeof validateLocations;
};
export type QueryApi = {
    /** Read locations and summaries for a selector. */
    Query: typeof Query;
};
export type RegistryApi = {
    /** Activate a single plugin by id. @unstable */
    activatePlugin: typeof activatePlugin;
    /** Look up a registered plugin by id. */
    getPlugin: typeof getPlugin;
    /** All registered plugins, sorted by name. */
    getPlugins: typeof getPlugins;
    /** True when the plugin contributes data only and has no UI surfaces. */
    isBackgroundPlugin: typeof isBackgroundPlugin;
    /** True once the MMA surface is installed and plugins are safe to call it. @unstable */
    isReady: typeof isReady;
    /** Register a plugin. `activate` runs when a map opens; its returned cleanup runs on map close. */
    registerPlugin: typeof registerPlugin;
    /** Enable or disable a plugin. @unstable */
    setPluginEnabled: typeof setPluginEnabled;
    /** Remove a plugin from the registry. @unstable */
    unregisterPlugin: typeof unregisterPlugin;
};
export type ReviewApi = {
    /** Review sessions and their history. @unstable */
    Review: typeof Review;
};
export type SavedSelectionApi = {
    /** Saved selection rules. @unstable */
    SavedSelection: typeof SavedSelection;
};
export type SceneApi = {
    /** The marker scene the map surfaces render from, and its load lifecycle. @unstable */
    Scene: typeof Scene;
};
export type ScopeApi = {
    /** Name one of plugin `pluginId`'s own events, carrying a `T`. Define it once and share it, so
     *  whoever raises it and whoever hears it agree on the payload. @unstable */
    definePluginEvent: typeof definePluginEvent;
    /** Raise one of a plugin's own events, with its payload when it carries one. @unstable */
    emitPluginEvent: typeof emitPluginEvent;
    /** Subscribe to an editor event or a plugin's own event, automatically unsubscribed on plugin
     *  deactivation. */
    on: typeof on;
    /** Resolve a relative path against the current plugin's base directory. Absolute
     *  paths and `res://` URLs pass through unchanged. @unstable */
    resolvePluginPath: typeof resolvePluginPath;
    /** Enroll a teardown callback under the current plugin. No-op outside activation. @unstable */
    trackDisposable: typeof trackDisposable;
    /** React hook: what `read` returns, read again each time `event` is raised. `read` must return
     *  the same reference while nothing it reads has changed. @unstable */
    usePluginEvent: typeof usePluginEvent;
};
export type SeenApi = {
    /** The seen-location history and how panorama visits are recorded into it. @unstable */
    Seen: typeof Seen;
};
export type SelectionListApi = {
    /** Change the listed selections and inspect their active members. @unstable */
    SelectionList: typeof SelectionList;
};
export type SelectionsApi = {
    /** Display symbol/word for each filter operator. Symbols are language-neutral; only the worded
     *  operators are marked for translation. @unstable */
    OP_LABELS: typeof OP_LABELS;
    /** The display label of each selector variant. @unstable */
    SELECTIONS: typeof SELECTIONS;
    /** @unstable */
    UNARY_TYPES: typeof UNARY_TYPES;
    /** @unstable */
    addSelection: typeof addSelection;
    /** Locations matching every one of `selectors`; with none, every location. @unstable */
    all: typeof all;
    /** Locations matching any of `selectors`; with none, no location. @unstable */
    any: typeof any;
    /** @unstable */
    buildSelection: typeof buildSelection;
    /** Every child selection a selector wraps, whatever shape it wraps them in. @unstable */
    childSelections: typeof childSelections;
    /** Whether a predicate reads the location's clock in its own timezone. Only a range can. @unstable */
    filterIsLocalTime: typeof filterIsLocalTime;
    /** Locations holding a value for `field`. @unstable */
    has: typeof has;
    /** Locations holding no value for `field`. @unstable */
    lacks: typeof lacks;
    /** The interned value a selector tests membership of, or null when it tests something else.
     *  The single place that recognises value membership, so nothing else has to know its shape. @unstable */
    memberOf: typeof memberOf;
    /** Locations not matching `selector`. @unstable */
    not: typeof not;
    /** Locations pinned to one exact pano (the flag plus a pano id), or the locations not
     *  pinned. @unstable */
    panoIdSelector: typeof panoIdSelector;
    /** @unstable */
    replaceSelection: typeof replaceSelection;
    /** An unaddressed selection input; the store supplies its key and default color. @unstable */
    selection: typeof selection;
    /** @unstable */
    selectionAt: typeof selectionAt;
    /** Human-readable label for a selection. Pass `valueNames` to resolve interned values by
     *  saved name rather than the open map's records. @unstable */
    selectionDisplayName: typeof selectionDisplayName;
    /** The tag a selector names, or null when it names something else. @unstable */
    tagIdOf: typeof tagIdOf;
    /** Locations carrying `tagId`. A tag is membership in the `tags` list field and nothing
     *  else, so there is no tag selector to build. @unstable */
    tagSelector: typeof tagSelector;
    /** @unstable */
    toggleSelection: typeof toggleSelection;
    /** Locations whose heading was never set. @unstable */
    unpannedSelector: typeof unpannedSelector;
    /** Locations with no tags: `tags` resolves to nothing on an untagged location. @unstable */
    untaggedSelector: typeof untaggedSelector;
    /** `selector` with its children replaced, keeping the shape it wraps them in. @unstable */
    withChildren: typeof withChildren;
};
export type SelectorPickApi = {
    /** Convert a picker choice into the corresponding `Selector`. @unstable */
    selectorForPick: typeof selectorForPick;
    /** React hook: selector state with live counts. Defaults to the current selection when one
     *  exists, else all locations. @unstable */
    useSelectorPick: typeof useSelectorPick;
};
export type SettingsApi = {
    /** localStorage descriptor for the persisted settings object. @unstable */
    APP_SETTINGS: typeof APP_SETTINGS;
    /** Download size of each border detail level, in bytes. @unstable */
    BORDER_ARCHIVE_BYTES: typeof BORDER_ARCHIVE_BYTES;
    /** @unstable */
    BORDER_DETAILS: typeof BORDER_DETAILS;
    /** @unstable */
    DATE_TIMEZONES: typeof DATE_TIMEZONES;
    /** Default values for every app setting. @unstable */
    DEFAULTS: typeof DEFAULTS;
    /** @unstable */
    DISCORD_PRESENCE_MODES: typeof DISCORD_PRESENCE_MODES;
    /** @unstable */
    EXACT_DATE_FORMATS: typeof EXACT_DATE_FORMATS;
    /** @unstable */
    GEOCODE_PROVIDERS: typeof GEOCODE_PROVIDERS;
    /** @unstable */
    GEOCODE_PROVIDER_LABELS: typeof GEOCODE_PROVIDER_LABELS;
    /** Supported languages, labeled in their own script. `en-XA` is a dev-only pseudolocale. @unstable */
    LANGUAGES: typeof LANGUAGES;
    /** @unstable */
    MAP_LIST_FIELDS: typeof MAP_LIST_FIELDS;
    /** @unstable */
    MOVEMENT_CYCLE: typeof MOVEMENT_CYCLE;
    /** @unstable */
    MOVEMENT_MODES: typeof MOVEMENT_MODES;
    /** @unstable */
    OPACITY_TOGGLE_MODES: typeof OPACITY_TOGGLE_MODES;
    /** @unstable */
    POLYGON_COLOR_MODES: typeof POLYGON_COLOR_MODES;
    /** @unstable */
    PREVIEW_ASPECT_RATIOS: typeof PREVIEW_ASPECT_RATIOS;
    /** @unstable */
    SEEN_RESOLUTIONS: typeof SEEN_RESOLUTIONS;
    /** @unstable */
    SUBDIVISION_DETAILS: typeof SUBDIVISION_DETAILS;
    /** @unstable */
    TAG_FOLDER_COLOR_MODES: typeof TAG_FOLDER_COLOR_MODES;
    /** Tag-suggestion list cap stops (slider indices); 0 = unlimited ("All"). @unstable */
    TAG_SUGGESTION_LIMITS: typeof TAG_SUGGESTION_LIMITS;
    /** @unstable */
    TAG_VIEW_MODES: typeof TAG_VIEW_MODES;
    /** Distance units. `auto` reads the system locale's region, so a US/UK machine gets miles. @unstable */
    UNIT_SYSTEMS: typeof UNIT_SYSTEMS;
    /** The current app settings snapshot. @unstable */
    getSettings: typeof getSettings;
    /** True while the pano-UI toggle covers the navigation visuals too. @unstable */
    navHiddenWithUI: typeof navHiddenWithUI;
    /** Effective StreetViewPanorama display options derived from the current settings. @unstable */
    panoDisplayOptions: typeof panoDisplayOptions;
    /** Reset all settings to defaults. @unstable */
    resetSettings: typeof resetSettings;
    /** Update one setting and persist. Emits `settings:changed`. @unstable */
    setSetting: typeof setSetting;
    /** React hook: one setting value, re-rendering only when that key changes. @unstable */
    useSetting: typeof useSetting;
    /** React hook: all settings, re-rendering on any change. @unstable */
    useSettings: typeof useSettings;
};
export type SidecarApi = {
    /** The nested `sidecar` namespace on the plugin surface. */
    sidecar: typeof sidecar;
};
export type StoreApi = {
    /** Read and update the open map state. */
    Store: typeof Store;
};
export type StreetViewApi = {
    /** Google Street View: coverage lookups and pano metadata, search radii, pinning locations to
     *  their panos and turning them along the road, links into Google Maps, and panorama
     *  downloads. @unstable */
    StreetView: typeof StreetView;
};
export type TagApi = {
    /** Manage tag records and their assignment to locations. */
    Tag: typeof Tag;
};
export type TagsApi = {
    /** Stage typed text as the existing tag it names, ignoring case, or as a name to create.
     *  Returns `pending` unchanged if already staged. */
    addPendingTag: typeof addPendingTag;
    /** Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
     *  the `/`-path to its shortest unique suffix; otherwise returns the name verbatim. */
    displayTagName: typeof displayTagName;
    /** The tag ids pending tags save as, creating the typed names. A tag deleted meanwhile is left out. */
    pendingTagIds: typeof pendingTagIds;
    /** Sort tags by the chosen mode: name, location count, or manual order. */
    sortTagsByMode: typeof sortTagsByMode;
    /** Color for a tag named `name`. An existing tag uses its stored color. */
    tagColorFor: typeof tagColorFor;
    /** Stage the tag, or unstage it if it is already staged. */
    togglePendingTag: typeof togglePendingTag;
};
export type TauriApi = {
    /** @unstable */
    dialog: typeof dialog;
    /** @unstable */
    shell: typeof shell;
};
export type TestApiApi = {
    /** Deterministic wrappers the e2e suite drives, mounted as `MMA._test`. App code never calls them. @unstable */
    _test: typeof _test;
};
export type ToastApi = {
    /** Show a brief toast notification. Optionally scoped to a `container` element. */
    toast: typeof toast;
};
export type TypesApi = {
    /** Convert a [west, south, east, north] bbox tuple to Bounds, or null. @unstable */
    bboxTupleToBounds: typeof bboxTupleToBounds;
    /** Convert a Bounds object to a [south, west, north, east] tuple. @unstable */
    boundsToScoreTuple: typeof boundsToScoreTuple;
    /** A field definition with every optional attribute spelled absent. */
    createFieldDef: typeof createFieldDef;
    /** Build a new Location from lat/lng plus overrides. Its `id` is 0, whatever the
     *  overrides hold; adding it to the map returns its real id. */
    createLocation: typeof createLocation;
    /** A new Location at the viewer's live camera, carrying `source`'s flags, tagged `tagNames`
     *  through `records`, which the map it lands in matches to its own tags by name. `extra`
     *  describes the pano it was fetched for, so it only survives a drop that stayed on that
     *  pano. @unstable */
    dropLocation: typeof dropLocation;
    /** Pinned: the location always opens this exact pano. */
    isPinned: typeof isPinned;
    /** True when bounds span the entire world. */
    isWorldBounds: typeof isWorldBounds;
    /** Extract the id from a MaybeLocation. */
    locId: typeof locId;
    /** Convert a [south, west, north, east] tuple to a Bounds object. @unstable */
    scoreTupleToBounds: typeof scoreTupleToBounds;
    /** The location pinned to the pano it carries, or unpinned to float on default coverage. */
    setPinned: typeof setPinned;
};
export type UiApi = {
    /** Shared UI primitives for plugin sidebars and dialogs. */
    ui: typeof ui;
};
export type UseJobApi = {
    /** User-triggered async work that reports progress and can be cancelled. Unmounting cancels. */
    useJob: typeof useJob;
};
export type UtilApi = {
    /** The item `isBetter` prefers over every other, or null when there are none. @unstable */
    bestBy: typeof bestBy;
    /** Split `arr` into sub-arrays of at most `n` elements. @unstable */
    chunk: typeof chunk;
    /** Compare two semver strings (e.g. "0.6.1", "0.7.0-rc.2"). Returns >0 if a > b.
     *  Build metadata is ignored; a pre-release sorts below the release it precedes. @unstable */
    cmpVersion: typeof cmpVersion;
    /** Compare strings with natural (numeric-aware) ordering. @unstable */
    compareNatural: typeof compareNatural;
    /** Copy an image Blob to the clipboard. False when the platform refuses it. @unstable */
    copyImageToClipboard: typeof copyImageToClipboard;
    /** Trigger a browser download from an in-memory Blob. @unstable */
    downloadBlob: typeof downloadBlob;
    /** True when `v` carries a semver pre-release tag, e.g. "1.0.0-beta.1". @unstable */
    isPrereleaseVersion: typeof isPrereleaseVersion;
    /** True when the app runs in a browser instead of the desktop app. @unstable */
    isWeb: typeof isWeb;
    /** URL that serves a local file over the `mma-buf://` protocol. @unstable */
    mmaBufUrl: typeof mmaBufUrl;
    /** Current time as Unix seconds, the form Location timestamps use. @unstable */
    nowUnix: typeof nowUnix;
    /** Compute a locations/second rate for the current progress phase. Re-anchors when a
     *  new phase is detected (done went backward or total grew). Null until a quarter second
     *  of work has elapsed. @unstable */
    phaseRate: typeof phaseRate;
    /** Prompt for files; resolves empty when the picker is dismissed. @unstable */
    pickFiles: typeof pickFiles;
    /** Shuffle `items` in place (Fisher-Yates) and return them. @unstable */
    shuffle: typeof shuffle;
    /** `["0.7.0", "rc.2"]` for `"v0.7.0-rc.2+build"`; the pre-release part is `""` when absent. @unstable */
    splitVersion: typeof splitVersion;
    /** Copy of `set` with `value` toggled, or forced on/off by `on`. @unstable */
    toggleInSet: typeof toggleInSet;
};
export type ValidationCategoriesApi = {
    /** @unstable */
    STANDARD_VALIDATION_CATEGORIES: typeof STANDARD_VALIDATION_CATEGORIES;
    /** @unstable */
    VALIDATION_CATEGORIES: typeof VALIDATION_CATEGORIES;
    /** The category a key names, or null for one this version does not know. @unstable */
    validationCategory: typeof validationCategory;
};
/** The global `MMA` object (also `window.MMA`). */
interface MMA extends AccountApi, AutosaveApi, BindingsConstsApi, ColorApi, CommandsApi, CommitApi, CommitDiffApi, EditApi, EditorApi, FieldApi, FieldDefRegistryApi, FieldDefsApi, HistoryApi, ImportApi, JobsApi, LayerApi, LegacyApi, LocationApi, MapHostApi, MapsApi, MutationApi, PanoApi, PluginStorageApi, ProcedureApi, ProviderApi, ProvidersApi, QueryApi, RegistryApi, ReviewApi, SavedSelectionApi, SceneApi, ScopeApi, SeenApi, SelectionListApi, SelectionsApi, SelectorPickApi, SettingsApi, SidecarApi, StoreApi, StreetViewApi, TagApi, TagsApi, TauriApi, TestApiApi, ToastApi, TypesApi, UiApi, UseJobApi, UtilApi, ValidationCategoriesApi {
}

declare global {
    interface Window {
        MMA: MMA;
    }
    const MMA: MMA;
}

export type { MMA, MMA as MMAApi, commands, events };
export type { Answer, AppReady, Ask, AttachmentRef, BatchMode, CameraFrame, Change, ChangeEvent, CollabCopy, CollabPresence, CollabSession, CollabSessions, CommitInfo, CommitResult, ComparisonType, Conflict, ConflictKind, CoordOpts, CopyToMapResult, CountBy, Counts, DataLocation, DbStats, Derived, DeviceCodeInfo, EditResult, Edited, EditorImportPreview, EditorImportResult, Edits, ExportFormat, ExportProgress, ExprError, FieldChoice, FieldCount, FieldDef, FileSource, FilterOp, GeoResult, GgUser, GhUser, HeldValue, History as History, HoneycombRun, IdQuery, IdRange, ImageSize, ImportPreviewEntry, ImportProgress, ImportSource, ImportedMapInfo, IssueComment, IssueThread, JoinOutcome, JsonExport, KeySpec, Keys, ListedSelection, Location as Location, LocationList, LocationOp, MapDeleted, MapExtra, MapKeyAction, MapKeyBinding, MapListChanged, MapMeta, MapPreferences, MapSettings, Member, MmMapSummary, MmUser, Mutation as Mutation, NormalizedSyncLocation, NumericBinning, Op, Origin, Pano as Pano, PanoAnswer, PanoDate, PanoLink, PanoQuery, PanoTime, ParsedLocation, PartitionBucket, PatchOp, PluginBuild, PluginBuild_Deserialize, PluginManifest, PluginManifest_Deserialize, PluginSetting, PluginSidecar, PointSampling, Policy, PolygonGeometry, Pov, PresenceActivity, ProcedureActivity, ProcedureConfig, ProcedureDecl, ProcedureHost, ProcedureProgress, ProcedureRequest, ProcedureResponse, ProcedureResult, ProviderActivity, ProviderDecl, ProviderDef, QueryActivity, RGB, RateSpec, RenderRequest, ReplyTo, ReportRef, ResultEntry, RetrySpec, ReviewSession, Rows, RunItem, SavedSelection as SavedSelection, SavedSelectionInfo, ScoreBounds, SearchQuery, SeenEntry, SeenFilter, SeenMapInfo, SeenPage, SeenWriteEntry, Selection, SelectionEdit, SelectionInput, SelectionOp, Selector$1 as Selector, SessionLink, SetOp, Share, Shared, Shares, Shown, SideCounts, SidecarDone, SidecarLine, SidecarLog, SidecarProgress, StoreStatus, StoreWarning, SyncLogEntry, SyncLogResult, SyncReconcileResult, Target, Thinning, UpdateAvailable, UpdateProgress, ValiCountryStatus, ValiLocation, ValiLocation_Deserialize, ValiProgress, ValueNames, ValueRecord, Via, VirtualTag, Work, WorkResult };
