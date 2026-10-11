# MMA API reference

Every member of the global `MMA` object (also `window.MMA`), grouped by surface.

- `stable` members keep working across releases. A rename or removal ships with a shim.
- `unstable` members are documented but can change or disappear in any release.
- `since` is the first release a member shipped in: the `minAppVersion` a plugin using it needs.

## Contents

**Stable surfaces**

- [Consts](#consts)
- [Registry](#registry)
- [PluginStorage](#pluginstorage)
- [PluginEvents](#pluginevents)
- [Externals](#externals)
- [Sidecar](#sidecar)
- [FieldDefs](#fielddefs)
- [FieldDefRegistry](#fielddefregistry)
- [Query](#query)
- [Toast](#toast)
- [UseJob](#usejob)
- [Types](#types)
- [Tags](#tags)
- [Legacy](#legacy)
- [Ui](#ui)
- [Autosave](#autosave)
- [Edit](#edit)
- [Location](#location)
- [Tag](#tag)
- [Editor](#editor)
- [History](#history)
- [Commit](#commit)
- [Field](#field)
- [Store](#store)
- [Maps](#maps)
- [Query](#query)
- [Mutation](#mutation)

**Unstable surfaces**

- [SelectionOps](#selectionops)
- [Settings](#settings)
- [SelectorPick](#selectorpick)
- [Commands](#commands)
- [Tauri](#tauri)
- [PluginHost](#pluginhost)
- [Marketplace](#marketplace)
- [Scope](#scope)
- [FieldProjections](#fieldprojections)
- [Procedures](#procedures)
- [Enrich](#enrich)
- [Providers](#providers)
- [PinPano](#pinpano)
- [Validate](#validate)
- [ValidationCategories](#validationcategories)
- [ScenePositions](#scenepositions)
- [Color](#color)
- [Jobs](#jobs)
- [Test](#test)
- [Util](#util)
- [SelectionList](#selectionlist)
- [CommitDiff](#commitdiff)
- [Import](#import)
- [SavedSelection](#savedselection)
- [Scene](#scene)
- [MapHost](#maphost)
- [Review](#review)
- [Seen](#seen)
- [Pano](#pano)

## Consts

### BUILTIN_FIELDS

`stable` · since v0.10.3

```ts
BUILTIN_FIELDS: {
  id: {
    readonly type: "number";
    readonly label: "ID";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: "identity";
    readonly clearable: false;
  };
  lat: {
    readonly type: "number";
    readonly label: "Latitude";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: "identity";
    readonly clearable: false;
  };
  lng: {
    readonly type: "number";
    readonly label: "Longitude";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: "identity";
    readonly clearable: false;
  };
  heading: {
    readonly type: "number";
    readonly label: "Heading";
    readonly values: null;
    readonly comparison: { readonly type: "circular"; readonly period: 360 };
    readonly interned: false;
    readonly kind: "writable";
    readonly clearable: false;
  };
  pitch: {
    readonly type: "number";
    readonly label: "Pitch";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: "writable";
    readonly clearable: false;
  };
  zoom: {
    readonly type: "number";
    readonly label: "Zoom";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: "writable";
    readonly clearable: false;
  };
  panoId: {
    readonly type: "string";
    readonly label: "Pano ID";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: null;
    readonly clearable: true;
  };
  tags: {
    readonly type: "array";
    readonly label: "Tags";
    readonly values: null;
    readonly comparison: null;
    readonly interned: true;
    readonly kind: "writable";
    readonly clearable: false;
  };
  createdAt: {
    readonly type: "date";
    readonly label: "Created";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: null;
    readonly clearable: false;
  };
  modifiedAt: {
    readonly type: "date";
    readonly label: "Modified";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: null;
    readonly clearable: false;
  };
  tagCount: {
    readonly type: "number";
    readonly label: "Tag count";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: "virtual";
    readonly clearable: false;
  };
  loadAsPanoId: {
    readonly type: "boolean";
    readonly label: "Load as pano ID";
    readonly values: null;
    readonly comparison: null;
    readonly interned: false;
    readonly kind: "writable";
    readonly clearable: false;
  };
}
```

### CameraType

`stable` · since v0.11.0

```ts
CameraType: {
  /** First-generation Street View camera. */
  Gen1: "gen1";
  /** Second- or third-generation camera. */
  Gen2: "gen2";
  /** Fourth-generation camera. */
  Gen4: "gen4";
  /** A capture from a known bad camera. */
  Badcam: "badcam";
  /** An indoor capture from a tripod. */
  Tripod: "tripod";
  /** A special collect carried on foot or on another vehicle, such as a trekker. */
  Trekker: "trekker";
}
```

### CapturePick

`stable` · since v0.11.0

```ts
CapturePick: { readonly Newest: "newest"; readonly Oldest: "oldest" }
```

A capture of a pano's timeline to settle on.

### DatePart

`stable` · since v0.11.0

```ts
DatePart: {
  /** The calendar year. */
  Year: "year";
  /** The year and month. */
  YearMonth: "yearMonth";
  /** The calendar date. */
  Day: "day";
  /** The month, the same in every year. */
  MonthOfYear: "monthOfYear";
  /** The hour of the day. */
  HourOfDay: "hourOfDay";
}
```

A calendar component to group dates by.

### DEFAULT_DUPLICATE_SCORE

`unstable` · since v0.10.3

```ts
DEFAULT_DUPLICATE_SCORE: "tagCount + has(panoId) + loadAsPanoId + (heading != 0)"
```

### EFFECT_CALLS

`unstable` · since v0.10.7

```ts
EFFECT_CALLS: readonly ["fetch", "panos", "sidecar"]
```

### ERROR_CODES

`unstable` · since v0.10.7

```ts
ERROR_CODES: readonly [
  "auth",
  "attachment-not-staged",
  "attachment-too-large",
  "attachment-not-image",
  "upload-rejected",
  "report-rejected",
  "report-unreadable",
  "sign-in-timed-out",
  "sign-in-token-rejected",
  "issue-rejected",
  "geoguessr-polygonal",
  "geoguessr-draft-too-large",
]
```

### FieldType

`stable` · since v0.11.1

```ts
FieldType: {
  /** Text. */
  String: "string";
  /** A number. */
  Number: "number";
  /** True or false. */
  Boolean: "boolean";
  /** A point in time. */
  Date: "date";
  /** A year and month. */
  Month: "month";
  /** One of a fixed set of values. */
  Enum: "enum";
  /** A list of values. */
  Array: "array";
}
```

Type discriminant for `Location.extra` field definitions.
Determines how the field is displayed and filtered in the UI.

### FirstSyncMode

`unstable` · since v0.11.0

```ts
FirstSyncMode: {
  readonly Merge: "merge";
  readonly MirrorFromRemote: "mirrorFromRemote";
  readonly MirrorFromLocal: "mirrorFromLocal";
}
```

First-sync seeding when both sides already have pins. Only meaningful on the first sync
(empty mapping); afterwards it's plain three-way. `Merge` never deletes.

### FrameKind

`unstable` · since v0.11.5

```ts
FrameKind: { readonly Replace: 0; readonly Patch: 1 }
```

What a render frame does to the scene.

### IssueState

`unstable` · since v0.11.0

```ts
IssueState: { readonly Open: "open"; readonly Closed: "closed" }
```

### KNOWN_FIELDS

`stable` · since v0.10.3

```ts
KNOWN_FIELDS: readonly [
  {
    readonly key: "altitude";
    readonly type: "number";
    readonly label: "Altitude";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: false;
  },
  {
    readonly key: "countryCode";
    readonly type: "string";
    readonly label: "Country code";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: false;
  },
  {
    readonly key: "cameraType";
    readonly type: "enum";
    readonly label: "Camera type";
    readonly values: readonly ["gen1", "gen2", "gen4", "badcam", "tripod", "trekker"];
    readonly labels: readonly [
      readonly ["gen1", "Gen 1"],
      readonly ["gen2", "Gen 2/3"],
      readonly ["gen4", "Gen 4"],
      readonly ["badcam", "Bad cam"],
      readonly ["tripod", "Tripod"],
      readonly ["trekker", "Trekker"],
    ];
    readonly circularPeriod: null;
    readonly defaultOff: false;
  },
  {
    readonly key: "panoType";
    readonly type: "enum";
    readonly label: "Pano type";
    readonly values: readonly ["2", "3", "10"];
    readonly labels: readonly [
      readonly ["2", "Official"],
      readonly ["3", "Unknown"],
      readonly ["10", "User uploaded"],
    ];
    readonly circularPeriod: null;
    readonly defaultOff: false;
  },
  {
    readonly key: "imageDate";
    readonly type: "month";
    readonly label: "Image date";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: false;
  },
  {
    readonly key: "datetime";
    readonly type: "date";
    readonly label: "Exact date";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
  },
  {
    readonly key: "timezone";
    readonly type: "enum";
    readonly label: "Timezone";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
  },
  {
    readonly key: "drivingDirection";
    readonly type: "number";
    readonly label: "Driving direction";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: 360;
    readonly defaultOff: true;
  },
  {
    readonly key: "uploaderName";
    readonly type: "string";
    readonly label: "Uploader";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
  },
  {
    readonly key: "coverageDates";
    readonly type: "array";
    readonly label: "Coverage dates";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
  },
  {
    readonly key: "subdivision";
    readonly type: "string";
    readonly label: "Subdivision";
    readonly values: readonly [];
    readonly labels: readonly [];
    readonly circularPeriod: null;
    readonly defaultOff: true;
  },
]
```

### LOCATION_MERGED

`stable` · since v0.12.0

```ts
LOCATION_MERGED: readonly ["extra"]
```

### LocationFlag

`stable` · since v0.11.0

```ts
LocationFlag: {
  readonly None: 0;
  readonly LoadAsPanoId: 1;
  readonly Informational: 2;
}
```

Per-location bitfield, serialized as a plain `u32` over IPC and Arrow.

### MapShape

`stable` · since v0.11.3

```ts
MapShape: {
  readonly GeoGuessr: "geoguessr";
  readonly MapMaking: "mapMaking";
  readonly Local: "local";
}
```

How much of a map a destination keeps. Each shape keeps everything the one before it does.

### MergeWinner

`stable` · since v0.11.0

```ts
MergeWinner: { readonly From: "from"; readonly To: "to" }
```

When a move target already holds a value, which side survives.

### NO_SEL

`unstable` · since v0.11.5

```ts
NO_SEL: 4294967295
```

### OFFICIAL_ID_PATTERN

`stable` · since v0.10.7

```ts
OFFICIAL_ID_PATTERN: "^[-_A-Za-z0-9]{21}[AQgw]$"
```

### PanoType

`stable` · since v0.11.0

```ts
PanoType: {
  readonly Official: 2;
  readonly Unknown: 3;
  readonly UserUploaded: 10;
}
```

Which imagery collection a pano id belongs to.

### PLAIN_CALLS

`unstable` · since v0.10.7

```ts
PLAIN_CALLS: readonly [
  "classify",
  "neighbors",
  "progress",
  "fail",
  "emit",
  "aborted",
]
```

### PROJECTIONS

`unstable` · since v0.10.3

```ts
PROJECTIONS: readonly [
  {
    readonly id: "value";
    readonly appliesTo: readonly [
      "string",
      "enum",
      "boolean",
      "number",
      "month",
      "array",
    ];
    readonly needsTz: false;
  },
  {
    readonly id: "year";
    readonly appliesTo: readonly ["date", "month"];
    readonly needsTz: true;
  },
  {
    readonly id: "yearMonth";
    readonly appliesTo: readonly ["date"];
    readonly needsTz: true;
  },
  { readonly id: "day"; readonly appliesTo: readonly ["date"]; readonly needsTz: true },
  {
    readonly id: "monthOfYear";
    readonly appliesTo: readonly ["date", "month"];
    readonly needsTz: true;
  },
  {
    readonly id: "hourOfDay";
    readonly appliesTo: readonly ["date"];
    readonly needsTz: true;
  },
]
```

### RankingStrategy

`stable` · since v0.11.0

```ts
RankingStrategy: { readonly Best: 1; readonly Closest: 2 }
```

Which pano the search picks; omitted means closest. BEST at a small radius can return a
neighbouring pano from the same capture run, so probe a pano's own coordinate with CLOSEST.

### RateCost

`stable` · since v0.11.0

```ts
RateCost: { readonly Request: "request"; readonly Row: "row" }
```

What one attempt charges the bucket: the call itself, or one per row in its batch
(for APIs that bill multi-row requests per row).

### ResolutionSide

`unstable` · since v0.11.0

```ts
ResolutionSide: { readonly Local: "local"; readonly Remote: "remote" }
```

Which side won a resolved conflict.

### SCRATCH_MAP_ID

`unstable` · since v0.10.3

```ts
SCRATCH_MAP_ID: "scratch"
```

### Sink

`stable` · since v0.11.0

```ts
Sink: { readonly Patch: "patch"; readonly Collect: "collect" }
```

Where a provider's results go. `Patch` applies them to the locations they name;
`Collect` delivers them to the caller and writes nothing. The declaration decides
this, never the contents of a result.

### Stack

`stable` · since v0.12.0

```ts
Stack: { readonly Undo: "undo"; readonly Redo: "redo" }
```

Which edit history stack to step through.

### SYNC_PROVIDERS

`unstable` · since v0.11.4

```ts
SYNC_PROVIDERS: {
  readonly file: { readonly direction: "pullOnly"; readonly shape: "local" };
  readonly geoguessr: {
    readonly direction: "bidirectional";
    readonly shape: "geoguessr";
  };
  readonly "map-making.app": {
    readonly direction: "bidirectional";
    readonly shape: "mapMaking";
  };
}
```

Every sync provider: which way it carries changes, and what it keeps of a map.

### SyncDirection

`unstable` · since v0.11.4

```ts
SyncDirection: {
  readonly Bidirectional: "bidirectional";
  readonly PullOnly: "pullOnly";
}
```

Which way a link carries changes.

### SyncTrigger

`unstable` · since v0.11.4

```ts
SyncTrigger: {
  /** Sync now was pressed. */
  Manual: "manual";
  /** Live sync ran it, after an edit or on its schedule. */
  Live: "live";
  /** Linking the map ran its first sync. */
  Link: "link";
  /** Resolving held conflicts ran it. */
  Resolve: "resolve";
}
```

What started a sync pass.

### ValidationFlag

`stable` · since v0.11.4

```ts
ValidationFlag: {
  /** No findings: the location's coverage checked out. */
  None: 0;
  /** Official coverage newer than the location's stored pano exists. */
  Newer: 1;
  /** The location is pinned to a pano other than the one its coordinates load. */
  OffDefault: 2;
  /** The pano the location's coordinates load is not the newest capture there. */
  DefaultStale: 4;
  /** The location's pinned pano no longer loads, though coverage still exists at its coordinates. */
  PanoIdBroke: 8;
  /** The coverage the location shows is unofficial. */
  Unofficial: 16;
  /** The location shows bad-camera coverage, but its timeline holds a better camera capture. */
  GoodcamAvailable: 32;
  /** No coverage was found, neither the stored pano nor any within the search radius. */
  NotFound: 64;
}
```

One finding of a Street View coverage check. `validate` answers each row with the
findings that apply, combined into one number.

## Registry

### getPlugin

`stable` · since v0.10.3

```ts
getPlugin(id: string): Plugin | undefined
```

Look up a registered plugin by id.

### getPlugins

`stable` · since v0.10.3

```ts
getPlugins(): Plugin[]
```

All registered plugins, sorted by name.

### isBackgroundPlugin

`stable` · since v0.10.3

```ts
isBackgroundPlugin(id: string): boolean
```

True when the plugin contributes data only and has no UI surfaces.

### registerPlugin

`stable` · since v0.3.1

```ts
registerPlugin(plugin: Plugin | PluginBehavior): void
```

Register a plugin. `activate` runs when a map opens; its returned cleanup runs on map close.

### setPendingManifest

`unstable` · since v0.10.3

```ts
setPendingManifest(manifest: PluginManifest | null): void
```

Set the manifest used to fill identity fields on the next `registerPlugin` call.

### unregisterPlugin

`unstable` · since v0.10.3

```ts
unregisterPlugin(id: string): void
```

Remove a plugin from the registry.

## PluginStorage

### mapStorage

`stable` · since v0.11.4

```ts
mapStorage(id: string): MapPluginStorage
```

Persistent key-value storage a plugin keeps with the open map, so every map has its own.
Throws when no map is open.

### reloadStorage

`unstable` · since v0.11.3

```ts
reloadStorage(id: string): void
```

Re-read a plugin's store after another window wrote it.

### storage

`stable` · since v0.6.1

```ts
storage(id: string): PluginStorage
```

Persistent key-value storage namespaced to a plugin. Survives restarts.

### usePluginState

`stable` · since v0.7.4

```ts
usePluginState<T>(
  pluginId: string,
  key: string,
  initial: T | (() => T),
): readonly [T, (action: SetStateAction<T>) => void]
```

React state hook backed by the plugin's persistent store. Survives sidebar
unmount and app restart. Values are global, not per-map.

## PluginEvents

### definePluginEvent

`unstable` · since v0.11.0

```ts
definePluginEvent<T = void>(pluginId: string, name: string): PluginEvent<T>
```

Name one of plugin `pluginId`'s own events, carrying a `T`. Define it once and share it, so
whoever raises it and whoever hears it agree on the payload.

### emitPluginEvent

`unstable` · since v0.11.0

```ts
emitPluginEvent<T>(
  event: PluginEvent<T>,
  ...payload: T extends void ? [] : [payload: T]
): void
```

Raise one of a plugin's own events, with its payload when it carries one.

### on

`stable` · since v0.3.1

```ts
on<E extends EditorEvent | PluginEvent<unknown>>(
  event: E,
  handler: EventHandler<E>,
): () => void
```

Subscribe to an editor event or a plugin's own event, automatically unsubscribed on plugin
deactivation.

### usePluginEvent

`unstable` · since v0.11.0

```ts
usePluginEvent<V>(event: PluginEvent<unknown>, read: () => V): V
```

React hook: what `read` returns, read again each time `event` is raised. `read` must return
the same reference while nothing it reads has changed.

## Externals

### getAvailableExternals

`stable` · since v0.5.0

```ts
getAvailableExternals(): string[]
```

Names of every module available through `mmaRequire`.

### mmaRequire

`stable` · since v0.10.3

```ts
mmaRequire(id: string): unknown
```

Get a module the app bundles (e.g. "react", "@deck.gl/core") for use inside a plugin.
Lazy modules must be loaded with `preloadModules` first.

### preloadModules

`stable` · since v0.5.0

```ts
preloadModules(ids: string[]): Promise<void>
```

Load lazy bundled modules so `mmaRequire` can return them synchronously.

## Sidecar

### sidecar

`stable` · since v0.7.0

The nested `sidecar` namespace on the plugin surface.

#### sidecar.installedVersion

`stable` · since v0.7.0

```ts
sidecar.installedVersion(pluginId: string): Promise<string | null>
```

The sidecar version installed for a plugin, or null when it has none yet.

#### sidecar.request

`stable` · since v0.9.0

```ts
sidecar.request<T>(
  pluginId: string,
  command: string,
  payload?: unknown,
  opts?: SidecarOptions<T>,
): Promise<T | null>
```

Send a command to a plugin's sidecar and resolve with its last emitted JSON
object (null if it emitted none). `payload` is sent as JSON.

## FieldDefs

### getAllEnrichKeys

`unstable` · since v0.10.3

```ts
getAllEnrichKeys(): string[]
```

All enrichment field keys (core and plugin-registered).

### getDefaultEnrichKeys

`unstable` · since v0.10.3

```ts
getDefaultEnrichKeys(): string[]
```

Keys enriched when enrichFields is null (the default set: all options except defaultOff ones).

### getEnrichFieldOptions

`unstable` · since v0.10.3

```ts
getEnrichFieldOptions(): EnrichFieldOption[]
```

All enrichment field options: the core fields, then every registered provider's own fields.

### getProviderForField

`unstable` · since v0.10.3

```ts
getProviderForField(field: string): Provider | undefined
```

The provider that produces a given extra field, if any.

### getProviders

`unstable` · since v0.10.3

```ts
getProviders(): Provider[]
```

All registered providers.

### isFieldEnabled

`unstable` · since v0.10.3

```ts
isFieldEnabled(enrichFields: string[] | null, key: string): boolean
```

True when `key` is in the given enrichment set (or in the default set when null).

### knownFieldDefs

`stable` · since v0.10.3

```ts
knownFieldDefs(...keys: string[]): Record<string, FieldDef>
```

Build field definitions for well-known keys (e.g. `"altitude"`, `"countryCode"`).

### registerProvider

`stable` · since v0.10.2

```ts
registerProvider(provider: Provider): void
```

Register a provider (e.g. a plugin's sun position). Unregistered when the plugin
deactivates.

## FieldDefRegistry

### declaredValues

`stable` · since v0.11.1

```ts
declaredValues(def: FieldDef | undefined): string[] | null
```

The value space a field declares, as bare strings. Distinct from the store's
`fieldValues`, which reports the values actually present in the data.

### fieldLabel

`stable` · since v0.10.3

```ts
fieldLabel(key: string): string
```

Translated display label for a field key, falling back to a sentence-cased version of the key.

### fieldValueLabel

`stable` · since v0.10.3

```ts
fieldValueLabel(def: FieldDef | undefined, value: unknown): string
```

Display label for a field value. Enum values use their translated display name.

### getAllFieldDefs

`stable` · since v0.5.0

```ts
getAllFieldDefs(): Record<string, FieldDef>
```

Merged view of all field definitions across all layers.

### getBuiltinKeys

`unstable` · since v0.10.3

```ts
getBuiltinKeys(): string[]
```

All built-in field keys (excluding virtual).

### getFieldDef

`stable` · since v0.5.0

```ts
getFieldDef(key: string): FieldDef | undefined
```

Look up metadata for a field key. Returns `undefined` if no layer declares it.

### getFieldKeys

`unstable` · since v0.11.3

```ts
getFieldKeys(): string[]
```

Every listable built-in, and every field this map defines.

### getKnownFieldKeys

`stable` · since v0.5.0

```ts
getKnownFieldKeys(): ReadonlySet<string>
```

Keys this map defines a field for. Same reference until the user layer moves.

### isBuiltinField

`stable` · since v0.10.3

```ts
isBuiltinField(key: string): boolean
```

True when `key` is a built-in Location field (stored top-level, not under `extra`).

### isClearableField

`unstable` · since v0.10.3

```ts
isClearableField(key: string): boolean
```

True when the field can be bulk-cleared.

### isListableField

`unstable` · since v0.10.3

```ts
isListableField(key: string): boolean
```

True when the field should appear in field pickers.

### isWritableField

`unstable` · since v0.10.3

```ts
isWritableField(key: string): boolean
```

True when the field can be bulk-edited.

### registerPluginFieldDefs

`stable` · since v0.10.3

```ts
registerPluginFieldDefs(defs: Record<string, FieldDef>): void
```

Register field definitions from an enrichment provider (called at activation).

### unregisterPluginFieldDefs

`stable` · since v0.10.3

```ts
unregisterPluginFieldDefs(keys: string[]): void
```

Remove plugin field definitions by key (called when a plugin is deactivated).

## Query

### panosAt

`stable` · since v0.10.3

```ts
panosAt(
  points: LatLng[],
  radius?: number,
  opts?: SearchOpts,
  signal?: AbortSignal,
  onPano?: (index: number, pano: Pano | null) => void,
): Promise<(Pano | null)[]>
```

The nearest pano to each point, aligned to `points`, null where there is no coverage.
`opts.sources` narrows which collections are searched and `opts.preference` picks
nearest or best. `onPano` sees each point's answer the moment its search resolves,
ahead of the full array.

### svMetadata

`stable` · since v0.10.0

```ts
svMetadata(
  panoIds: string[],
  signal?: AbortSignal,
): Promise<(Pano | null)[]>
```

Full pano metadata for one or more panos, aligned to `panoIds`. Duplicates are
deduped and large batches are split automatically.

## Toast

### getToasts

`unstable` · since v0.10.3

```ts
getToasts(): ToastEntry[]
```

Current list of visible toasts.

### toast

`stable` · since v0.6.1

```ts
toast(
  message: string,
  duration?: number,
  container?: HTMLElement,
): void
```

Show a brief toast notification. Optionally scoped to a `container` element.

## UseJob

### useJob

`stable` · since v0.10.0

```ts
useJob<R = void, P = string>(
  fn: (ctx: JobContext<P>) => Promise<R>,
): Job<R, P>
```

A user-triggered async job that reports progress and can be cancelled.
Cancelling aborts the signal and stops the UI immediately; nothing the job does
afterwards can write back. Unmounting cancels. `run` while running is a no-op,
so a double-clicked button cannot start two.

## Types

### bboxTupleToBounds

`unstable` · since v0.10.3

```ts
bboxTupleToBounds(t: [number, number, number, number] | null): Bounds | null
```

Convert a [west, south, east, north] bbox tuple to Bounds, or null.

### boundsToScoreTuple

`unstable` · since v0.10.3

```ts
boundsToScoreTuple(b: Bounds): [number, number, number, number]
```

Convert a Bounds object to a [south, west, north, east] tuple.

### createFieldDef

`stable` · since v0.10.2

```ts
createFieldDef(
  type: FieldType,
  over?: Partial<Omit<FieldDef, "type">>,
): FieldDef
```

A field definition with every optional attribute spelled absent.

### createLocation

`stable` · since v0.3.1

```ts
createLocation(partial: Partial<Location> & LatLng): Location
```

Build a new Location from lat/lng plus overrides. Its `id` is 0, whatever the
overrides hold, until `addLocations` writes the real id back into the object.

### dropLocation

`unstable` · since v0.10.3

```ts
dropLocation(
  source: Location,
  live: PanoCapture,
  panoId: string | null,
  tags: number[],
): Location
```

A new Location at the viewer's live camera, carrying `source`'s flags and the given
tags. `extra` describes the pano it was fetched for, so it only survives a drop that
stayed on that pano.

### isPinned

`stable` · since v0.10.3

```ts
isPinned(loc: Location): loc is Location & {
  panoId: string;
}
```

Pinned: the location always opens this exact pano.

### isWorldBounds

`stable` · since v0.10.3

```ts
isWorldBounds(b: Bounds): boolean
```

True when bounds span the entire world.

### locId

`stable` · since v0.10.3

```ts
locId(m: MaybeLocation): number
```

Extract the id from a MaybeLocation.

### scoreTupleToBounds

`unstable` · since v0.10.3

```ts
scoreTupleToBounds(props: [number, number, number, number]): Bounds
```

Convert a [south, west, north, east] tuple to a Bounds object.

### setPinned

`stable` · since v0.10.7

```ts
setPinned(loc: Location, on: boolean): Location
```

The location pinned to the pano it carries, or unpinned to float on default coverage.

## Tags

### appendTagName

`stable` · since v0.10.3

```ts
appendTagName(pending: string[], name: string, tags: Tag[]): string[]
```

Add a name to a staged list: dedup case-insensitively, normalizing to an existing tag's
canonical casing. Returns the original array unchanged if already present.

### displayTagName

`stable` · since v0.10.3

```ts
displayTagName(name: string): string
```

Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
the `/`-path to its shortest unique suffix; otherwise returns the name verbatim.

### sortTagsByMode

`stable` · since v0.10.3

```ts
sortTagsByMode(
  tags: Tag[],
  mode: TagSortMode,
  counts: Record<number, number>,
): Tag[]
```

Sort tags by the chosen mode: name, location count, or manual order.

### tagColorFor

`stable` · since v0.10.3

```ts
tagColorFor(name: string, tags: Tag[]): string
```

Color for a tag named `name`. An existing tag uses its stored color.

## Legacy

Compatibility bindings for flat plugin calls.

### addLocations

`stable` · `deprecated` · since v0.3.1

```ts
addLocations(locs: Location[]): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Location.add`.

Add locations to the map. Real ids are assigned and written back into the passed
objects - build with `createLocation` (id 0) and read `loc.id` after. Undoable.

### addSelections

`unstable` · `deprecated` · since v0.5.0

```ts
addSelections(selectors: Selector[]): Promise<void>
```

**Deprecated in v0.11.3.** Use `MMA.SelectionList.update(MMA.addSelection(...selectors))`.

### addTagToLocations

`unstable` · `deprecated` · since v0.4.0

```ts
addTagToLocations(tagId: number, locationIds: number[]): Promise<WorkResult>
```

**Deprecated in v0.10.5.** Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [tagId], remove: [] })`.

### applySelectionUpdate

`unstable` · `deprecated` · since v0.10.3

```ts
applySelectionUpdate(op: SelectionOp): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.SelectionList.update`.

Update and resolve the listed selections. Use `onActive` to affect only active selections.

### autosave

`stable` · `deprecated` · since v0.12.0

**Deprecated in v0.12.1.** Use `MMA.Autosave`.

#### autosave.cancel

`unstable` · since v0.12.0

```ts
autosave.cancel(): void
```

Cancel any pending autosave timer.

#### autosave.flush

`unstable` · since v0.12.0

```ts
autosave.flush(): Promise<void>
```

Save any unsaved changes now instead of waiting for the timer.

#### autosave.hold

`unstable` · since v0.12.0

```ts
autosave.hold(): () => void
```

Defer autosave until the returned release function runs. Useful for batches that land many mutations.

#### autosave.schedule

`unstable` · since v0.12.0

```ts
autosave.schedule(): void
```

Schedule a debounced autosave. Mutations call this automatically.

#### autosave.scheduleAutoCommit

`unstable` · since v0.12.0

```ts
autosave.scheduleAutoCommit(mapId: string, importedCount: number): void
```

Background auto-commit after an import with autoCommit set.

#### autosave.waitForInflight

`unstable` · since v0.12.0

```ts
autosave.waitForInflight(): Promise<void> | null
```

Wait for any in-progress save to finish.

### checkoutCommit

`unstable` · `deprecated` · since v0.4.0

```ts
checkoutCommit(commitId: string): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Commit.checkout`.

Restore a previous commit as a new revert commit and refresh the view. Clears undo/redo.

### closeDuplicates

`unstable` · `deprecated` · since v0.4.0

```ts
closeDuplicates(): void
```

**Deprecated in v0.12.1.** Use `MMA.Editor.closeDuplicates`.

Close the duplicate-resolution panel and return to the overview.

### closeLocation

`stable` · `deprecated` · unreleased

```ts
closeLocation(): void
```

**Deprecated in v0.12.1.** Use `MMA.Editor.close`.

Close the open location and return to the pane it was opened from.

### closeMap

`stable` · `deprecated` · since v0.4.0

```ts
closeMap(): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.close`.

Close the open map, saving unsaved changes first.

### commitMap

`stable` · `deprecated` · since v0.4.0

```ts
commitMap(message?: string): Promise<string>
```

**Deprecated in v0.12.1.** Use `MMA.Commit.create`.

Commit all pending changes to the map's version history. Clears the undo stack.

### copyName

`unstable` · `deprecated` · since v0.11.4

```ts
copyName(name: string): string
```

**Deprecated in v0.12.1.** Use `MMA.Maps.copyName`.

The name a copy of the map named `name` starts with.

### countBy

`unstable` · `deprecated` · since v0.9.0

```ts
countBy(
  selector: Selector,
  field: string,
  key: KeySpec,
): Promise<CountBy>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read(selector, { kind: "countBy", fields: [field], key })`.

### countIn

`unstable` · `deprecated` · since v0.10.0

```ts
countIn(selector: Selector): Promise<number>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read(selector, { kind: "count" })`.

### coverage

`unstable` · `deprecated` · since v0.10.2

```ts
coverage(selector: Selector): Promise<[string, number][]>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read(selector, { kind: "coverage" })`.

### createMap

`stable` · `deprecated` · since v0.4.0

```ts
createMap(name: string, folder?: string | null): Promise<MapMeta>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.create`.

Create a new empty map and return its metadata.

### createPluginStorage

`unstable` · `deprecated` · since v0.10.3

```ts
createPluginStorage(id: string): PluginStorage
```

**Deprecated in v0.11.0.** Use `MMA.storage()`.

### currentSelection

`unstable` · `deprecated` · since v0.10.0

```ts
currentSelection(): Selector
```

**Deprecated in v0.11.7.** Use the `{ type: "Selected" }` selector.

### deleteField

`stable` · `deprecated` · since v0.5.1

```ts
deleteField(key: string): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Field.remove`.

Delete extra-field `key` from every location, its definition, and the listed selections,
in one undoable step.

### deleteFolder

`stable` · `deprecated` · since v0.4.0

```ts
deleteFolder(name: string): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.removeFolder`.

Delete a folder. Maps in it become unfoldered.

### deleteMap

`stable` · `deprecated` · since v0.4.0

```ts
deleteMap(id: string): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.remove`.

Permanently delete a map and all its data. Not undoable.

### deleteTags

`stable` · `deprecated` · since v0.4.0

```ts
deleteTags(tagIds: number[]): Promise<WorkResult>
```

**Deprecated in v0.12.1.** Use `MMA.Tag.remove`.

Remove tags from every location in one undoable step.
Unreferenced tags are hidden; undo restores them.

### discardOpenMap

`unstable` · `deprecated` · since v0.6.1

```ts
discardOpenMap(): void
```

**Deprecated in v0.12.1.** Use `MMA.Maps.discard`.

Drop the open map without persisting anything

### duplicateLocation

`stable` · `deprecated` · since v0.4.0

```ts
duplicateLocation(id: number): Promise<number | null>
```

**Deprecated in v0.12.1.** Use `MMA.Location.duplicate`.

Clone a location in place and return the new id, or null if it doesn't exist. Undoable.

### duplicateMap

`stable` · `deprecated` · since v0.11.4

```ts
duplicateMap(id: string, name: string): Promise<MapMeta>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.duplicate`.

Copy a map, uncommitted edits included, into a new map named `name` and return its metadata.

### edit

`stable` · `deprecated` · since v0.12.0

**Deprecated in v0.12.1.** Use `MMA.Edit`.

#### edit.locations

`unstable` · unreleased

```ts
edit.locations(...props: Parameters<typeof cmd.storeEdit>): Promise<
  MutationResult<{
    id: number;
    lat: number;
    lng: number;
    heading: number;
    pitch: number;
    zoom: number;
    panoId: string | null;
    flags: number;
    tags: number[];
    extra: { [key in string]: unknown } | null;
    createdAt: number;
    modifiedAt: number | null;
  }>
>
```

Edit locations on the map or in a pending layer. Map changes are undoable.

#### edit.meta

`stable` · since v0.12.0

```ts
edit.meta(
  patch: Omit<Parameters<typeof cmd.storeUpdateMapMeta>[0], "id"> & {
    id?: string;
  },
): Promise<void>
```

Patch a map's metadata and persist it: the open map's unless the patch names an `id`.
Settings merge key by key, so send only the keys that change.

#### edit.values

`stable` · since v0.12.0

```ts
edit.values(
  ...props: Parameters<typeof cmd.storeEditValues>
): Promise<MutationResult<ValueRecord>>
```

Edit an interned field's value records in one undoable step.

#### edit.work

`unstable` · since v0.12.0

```ts
edit.work(selector: Selector, op: Work): Promise<WorkResult>
```

Run `op` across every location `selector` matches, in one undoable step.

### exitPluginMode

`stable` · `deprecated` · since v0.3.1

```ts
exitPluginMode(): void
```

**Deprecated in v0.12.1.** Use `MMA.Editor.closePlugin`.

Close the plugin sidebar and return to the overview.

### fetchAllLocations

`unstable` · `deprecated` · since v0.4.0

```ts
fetchAllLocations(): Promise<Location[]>
```

**Deprecated in v0.8.4.** Use `MMA.Query.read({ type: "Everything" }, { kind: "locations" })`.

### fetchBounds

`unstable` · `deprecated` · since v0.9.0

```ts
fetchBounds(
  selector: Selector,
): Promise<[number, number, number, number] | null>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read(selector, { kind: "bounds" })`.

### fetchColumns

`unstable` · `deprecated` · since v0.10.0

```ts
fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read(selector, { kind: "columns", fields })`.

### fetchLocation

`unstable` · `deprecated` · since v0.4.0

```ts
fetchLocation(id: number): Promise<Location>
```

**Deprecated in v0.8.4.** Use `MMA.Query.read({ type: "Locations", locations: [id], name: null }, { kind: "locations" })`.

### fetchLocations

`unstable` · `deprecated` · since v0.9.0

```ts
fetchLocations(selector: Selector): Promise<Location[]>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read(selector, { kind: "locations" })`.

### fetchLocationsByIds

`unstable` · `deprecated` · since v0.4.0

```ts
fetchLocationsByIds(ids: number[]): Promise<Location[]>
```

**Deprecated in v0.8.4.** Use `MMA.Query.read({ type: "Locations", locations: ids, name: null }, { kind: "locations" })`.

### fieldCoverage

`unstable` · `deprecated` · since v0.9.0

```ts
fieldCoverage(selector: Selector): Promise<[string, number][]>
```

**Deprecated in v0.10.2.** Use `MMA.Query.read(selector, { kind: "coverage" })`.

### fieldValues

`unstable` · `deprecated` · since v0.9.0

```ts
fieldValues(selector: Selector, field: string): Promise<string[]>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read(selector, { kind: "values", field })`.

### getActiveLocation

`unstable` · `deprecated` · since v0.3.1

```ts
getActiveLocation(): Location | null
```

**Deprecated in v0.8.2.** Read `MMA.Store.get().open?.location`.

### getActiveSelections

`unstable` · `deprecated` · since v0.8.2

```ts
getActiveSelections(): Selection[]
```

**Deprecated in v0.12.1.** Use `MMA.SelectionList.active`.

Listed selections that are not ghosted.

### getAllSelections

`unstable` · `deprecated` · since v0.6.3

```ts
getAllSelections(): Selection[]
```

**Deprecated in v0.8.2.** Read `MMA.Store.get().selectionList`.

### getCurrentMap

`unstable` · `deprecated` · since v0.4.0

```ts
getCurrentMap(): MapMeta | null
```

**Deprecated in v0.8.2.** Read `MMA.Store.get().map`.

### getCurrentMapId

`unstable` · `deprecated` · since v0.4.0

```ts
getCurrentMapId(): string | null
```

**Deprecated in v0.8.2.** Read `MMA.Store.get().mapId`.

### getDirtyCount

`unstable` · `deprecated` · since v0.4.0

```ts
getDirtyCount(): Promise<number>
```

**Deprecated in v0.8.2.** Ask `MMA.Query.read` for the summary and take `dirtyCount`.

### getGhostedSelections

`unstable` · `deprecated` · since v0.7.4

```ts
getGhostedSelections(): Set<string>
```

**Deprecated in v0.8.2.** Read `MMA.Store.get().selectionList`.

### getGoogleMap

`unstable` · `deprecated` · since v0.3.1

```ts
getGoogleMap(): google.maps.Map | null
```

**Deprecated in v0.8.1.** Use `MMA.MapHost.get()` and narrow via `MMA.MapHost.instance`.

### getMapBadges

`unstable` · `deprecated` · since v0.11.3

```ts
getMapBadges(): Map<string, MapBadge[]>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.badges`.

Badges per map id, from every registered source.

### getMapBadgeSources

`unstable` · `deprecated` · since v0.11.3

```ts
getMapBadgeSources(): readonly BadgeSource[]
```

**Deprecated in v0.12.1.** Use `MMA.Maps.badgeSources`.

Every registered badge source, in registration order.

### getMapHost

`unstable` · `deprecated` · since v0.8.0

```ts
getMapHost(): MapHost | null
```

**Deprecated in v0.12.1.** Use `MMA.MapHost.get`.

Return the main editor map host, or null if not mounted.

### getMapList

`stable` · `deprecated` · since v0.7.0

```ts
getMapList(): MapMeta[]
```

**Deprecated in v0.12.1.** Use `MMA.Maps.list`.

The list of all maps (metadata only).

### getMapState

`stable` · `deprecated` · since v0.8.2

```ts
getMapState(): Readonly<MapState>
```

**Deprecated in v0.12.1.** Use `MMA.Store.get`.

Imperative snapshot of the map state.

### getSelectedLocationIds

`unstable` · `deprecated` · since v0.3.1

```ts
getSelectedLocationIds(): SelectedIds
```

**Deprecated in v0.8.2.** Read `MMA.Store.get().selectedLocationIds`.

### getSelectedTagIds

`unstable` · `deprecated` · since v0.8.2

```ts
getSelectedTagIds(): ReadonlySet<number>
```

**Deprecated in v0.12.1.** Use `MMA.SelectionList.tagIds`.

Tag ids with a top-level listed tag selection, including ghosted selections.

### getSelectedTagIdsDeep

`unstable` · `deprecated` · since v0.9.2

```ts
getSelectedTagIdsDeep(): readonly number[]
```

**Deprecated in v0.12.1.** Use `MMA.SelectionList.tagIdsDeep`.

Tag ids from active selection leaves, including repeated ids and composite children.

### getSelections

`unstable` · `deprecated` · since v0.3.1

```ts
getSelections(): Selection[]
```

**Deprecated in v0.8.2.** Use `MMA.SelectionList.active()`.

### getTag

`stable` · `deprecated` · since v0.7.0

```ts
getTag(id: number): Tag | undefined
```

**Deprecated in v0.12.1.** Use `MMA.Tag.get`.

Look up a tag record, including unreferenced tags.

### getTagCounts

`stable` · `deprecated` · since v0.4.0

```ts
getTagCounts(): Record<number, number>
```

**Deprecated in v0.12.1.** Use `MMA.Tag.counts`.

Per-tag location counts, keyed by numeric id.

### getTags

`stable` · `deprecated` · since v0.11.1

```ts
getTags(): Record<number, Tag>
```

**Deprecated in v0.12.1.** Use `MMA.Tag.all`.

Tag records, including unreferenced records and generated display defaults.

### getVisibleTags

`stable` · `deprecated` · since v0.4.0

```ts
getVisibleTags(): Tag[]
```

**Deprecated in v0.12.1.** Use `MMA.Tag.visible`.

Tag records referenced by at least one location.

### getWorkArea

`unstable` · `deprecated` · since v0.4.0

```ts
getWorkArea(): WorkArea
```

**Deprecated in v0.8.2.** Read `MMA.Store.get().workArea`.

### historyAvailable

`unstable` · `deprecated` · since v0.12.0

```ts
historyAvailable(
  history: MapState["history"],
  stack: Stack,
  key?: EntryKey,
): boolean
```

**Deprecated in v0.12.1.** Use `MMA.History.available`.

Whether a history action is available for one part or for the data edit as a whole.

### initStore

`unstable` · `deprecated` · since v0.4.0

```ts
initStore(): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.init`.

One-time store startup. The app calls this; plugins never need to.

### installedVersion

`unstable` · `deprecated` · since v0.10.3

```ts
installedVersion(pluginId: string): Promise<string | null>
```

**Deprecated in v0.11.0.** Use `MMA.sidecar.installedVersion()`.

### invalidateMapList

`unstable` · `deprecated` · since v0.4.0

```ts
invalidateMapList(): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.invalidate`.

Refresh the map list and notify other windows of the change.

### isReservedMap

`unstable` · `deprecated` · since v0.10.1

```ts
isReservedMap(id: string | null): boolean
```

**Deprecated in v0.12.1.** Use `MMA.Maps.isReserved`.

Whether `id` belongs to an app fixture rather than a user-created map.

### locationsOf

`stable` · `deprecated` · unreleased

```ts
locationsOf(list: LocationList): Promise<Location[]>
```

**Deprecated in v0.12.1.** Use `MMA.Query.locationsOf`.

The locations an answer carries, fetched from its temp file when it was too large to send inline.

### moveMapToFolder

`stable` · `deprecated` · since v0.4.0

```ts
moveMapToFolder(mapId: string, folder: string | null): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.moveToFolder`.

Move a map into a folder, or to the root when `folder` is null.

### mutate

`stable` · `deprecated` · since v0.4.0

```ts
mutate<R extends MutationResult = MutationResult>(
  fn: () => Promise<R>,
  ...fallback: MutationResult extends R ? [empty?: R] : [empty: R]
): Promise<R>
```

**Deprecated in v0.12.1.** Use `MMA.Mutation.run`.

### openDuplicateLocation

`unstable` · `deprecated` · since v0.4.0

```ts
openDuplicateLocation(loc: Location): void
```

**Deprecated in v0.12.1.** Use `MMA.Editor.openDuplicate`.

Open one location from the duplicate-resolution panel in the editor.

### openLocation

`stable` · `deprecated` · unreleased

```ts
openLocation(
  target: MaybeLocation,
  checkDuplicates?: boolean,
): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Editor.open`.

Open a location in the editor. With `checkDuplicates`, opening a spot with 2+ locations
within 2m opens the duplicate-resolution panel instead. A later opening or closing
supersedes one still loading.

### openMap

`stable` · `deprecated` · since v0.4.0

```ts
openMap(id: string): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.open`.

Open a map in this window, closing any currently open map first.

### openScratchMap

`stable` · `deprecated` · since v0.10.1

```ts
openScratchMap(): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.openScratch`.

Open the scratch map, creating it on first use.

### openStagedLocation

`unstable` · `deprecated` · since v0.6.0

```ts
openStagedLocation(index: number): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Editor.openImport`.

Preview a copy of a staged-import location. The import row stays staged until Confirm.

### partition

`unstable` · `deprecated` · since v0.6.2

```ts
partition(
  field: string,
  key: KeySpec,
  selector: Selector,
): Promise<PartitionBucket[]>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read(selector, { kind: "groupBy", field, key })`.

### previewDuplicateGroups

`unstable` · `deprecated` · since v0.5.1

```ts
previewDuplicateGroups(distance: number): Promise<number[][]>
```

**Deprecated in v0.12.1.** Use `MMA.Location.duplicateGroups`.

Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres.

### previewLocation

`unstable` · `deprecated` · since v0.12.0

```ts
previewLocation(loc: Location): void
```

**Deprecated in v0.12.1.** Use `MMA.Editor.preview`.

Open an arbitrary location read-only as a seen-preview: loads its pano without
adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves.

### query

`unstable` · `deprecated` · since v0.11.3

```ts
query(
  selector: Selector,
  target?: Target,
): {
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
}
```

**Deprecated in v0.12.0.** Use MMA.Query.read(selector, ask) instead.

### read

`stable` · `deprecated` · since v0.12.0

```ts
read<A extends Ask>(
  selector: Selector,
  ask: A,
  target?: Target,
): Promise<ReadResult<AnswerOf<A["kind"]>>>
```

**Deprecated in v0.12.1.** Use `MMA.Query.read`.

Ask one question about the locations `selector` matches. A full-location answer loads any
backing file automatically; ask for ids or columns when full locations are unnecessary.

### redo

`stable` · `deprecated` · since v0.4.0

```ts
redo(): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.History.redo`.

Redo the last undone edit.

### redoSelections

`unstable` · `deprecated` · since v0.12.0

```ts
redoSelections(): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.SelectionList.redo`.

Redo the last undone selection change without redoing data edits.

### registerEnrichFields

`unstable` · `deprecated` · since v0.3.1

```ts
registerEnrichFields(_fields: EnrichFieldOption[]): void
```

**Deprecated in v0.11.3.** A provider's `fieldDefs` are offered as enrichment options on their
own; set `defaultOff` on the provider to make them opt-in.

### registerEnrichmentProvider

`unstable` · `deprecated` · since v0.3.1

```ts
registerEnrichmentProvider(provider: Provider): void
```

**Deprecated in v0.10.2.** Use `MMA.registerProvider()`.

### registerMapBadges

`unstable` · `deprecated` · since v0.11.3

```ts
registerMapBadges(source: BadgeSource): void
```

**Deprecated in v0.12.1.** Use `MMA.Maps.registerBadges`.

Add a source of map-row badges.

### reloadMapList

`unstable` · `deprecated` · since v0.8.1

```ts
reloadMapList(): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.reload`.

Refresh the map list from disk.

### removeDuplicate

`unstable` · `deprecated` · since v0.4.0

```ts
removeDuplicate(id: number): void
```

**Deprecated in v0.12.1.** Use `MMA.Editor.removeDuplicate`.

Drop a location from the duplicate-resolution panel (does not delete it).

### removeLocations

`stable` · `deprecated` · since v0.3.1

```ts
removeLocations(ids: ReadonlyIdSet): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Location.remove`.

Remove locations by id. Undoable.

### removeSelections

`unstable` · `deprecated` · since v0.5.0

```ts
removeSelections(keys: string[]): Promise<void>
```

**Deprecated in v0.11.3.** Use `MMA.SelectionList.update(MMA.removeSelection(...keys))`.

### removeTagFromAllLocations

`unstable` · `deprecated` · since v0.4.0

```ts
removeTagFromAllLocations(tagId: number): Promise<WorkResult>
```

**Deprecated in v0.10.5.** Use `MMA.Edit.work(MMA.tagSelector(tagId), { kind: "listSet", key: "tags", add: [], remove: [tagId] })`.

### removeTagFromLocations

`unstable` · `deprecated` · since v0.4.0

```ts
removeTagFromLocations(tagId: number, locationIds: number[]): Promise<WorkResult>
```

**Deprecated in v0.10.5.** Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [], remove: [tagId] })`.

### renameField

`stable` · `deprecated` · since v0.5.1

```ts
renameField(
  from: string,
  to: string,
  winner?: MergeWinner,
): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Field.rename`.

Rename extra-field `from` to `to` across all locations, its definition, and the listed
selections, in one undoable step. When a location already holds `to`, `winner` decides
which value survives. Saved selections are map-independent rules and keep their names.

### renameFolder

`stable` · `deprecated` · since v0.4.0

```ts
renameFolder(from: string, to: string): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.renameFolder`.

Rename a folder, moving all its maps to the new name.

### request

`unstable` · `deprecated` · since v0.10.3

```ts
request<T>(
  pluginId: string,
  command: string,
  payload?: unknown,
  opts?: SidecarOptions<T>,
): Promise<T | null>
```

**Deprecated in v0.11.0.** Use `MMA.sidecar.request()`.

### resetSelections

`unstable` · `deprecated` · since v0.4.0

```ts
resetSelections(): Promise<void>
```

**Deprecated in v0.11.3.** Use `MMA.SelectionList.update({ kind: "set", selections: [] })`.

### resolveIds

`unstable` · `deprecated` · since v0.10.0

```ts
resolveIds(selector: Selector): Promise<number[]>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read(selector, { kind: "ids" })`.

### resolveLocation

`stable` · `deprecated` · since v0.6.6

```ts
resolveLocation(m: MaybeLocation): Promise<Location | null>
```

**Deprecated in v0.12.1.** Use `MMA.Editor.resolve`.

Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found.

### restoreSelections

`unstable` · `deprecated` · since v0.12.0

```ts
restoreSelections(): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.SelectionList.undo`.

Undo the last selection change without undoing data edits.

### sampleFrom

`unstable` · `deprecated` · since v0.10.0

```ts
sampleFrom(selector: Selector, n: number): Promise<number[]>
```

**Deprecated in v0.11.3.** Use `MMA.Query.read({ type: "Sample", selection: MMA.selection(selector), n }, { kind: "ids" })`.

### select

`unstable` · `deprecated` · since v0.12.0

```ts
select<
  R extends
    | number[]
    | {
        ids: number[];
      },
>(
  pick: (selector: Selector) => Promise<R>,
  perSelection?: boolean,
): Promise<{
  picked: number;
  results: R[];
}>
```

**Deprecated in v0.12.1.** Use `MMA.SelectionList.select`.

### setActiveLocation

`unstable` · `deprecated` · since v0.3.1

```ts
setActiveLocation(
  target: MaybeLocation | null,
  checkDuplicates?: boolean,
): Promise<void>
```

**Deprecated in v0.12.0.** Use `MMA.Editor.open(target)`, or `MMA.Editor.close()` in place of null.

### setCachedMapList

`unstable` · `deprecated` · since v0.8.1

```ts
setCachedMapList(list: MapMeta[]): void
```

**Deprecated in v0.12.1.** Use `MMA.Maps.setList`.

Set the map list directly without a disk read.

### setMap

`unstable` · `deprecated` · since v0.12.0

```ts
setMap(map: MapMeta): void
```

**Deprecated in v0.12.1.** Use `MMA.Store.setMeta`.

Replace the open map's row in state; persisting it is the caller's.

### setOpenLocation

`stable` · `deprecated` · unreleased

```ts
setOpenLocation(location: Location | null, session: number): void
```

**Deprecated in v0.12.1.** Use `MMA.Editor.setLocation`.

Set the open location if `session` is still current.

### setPluginMode

`stable` · `deprecated` · since v0.4.0

```ts
setPluginMode(pluginId: string): void
```

**Deprecated in v0.12.1.** Use `MMA.Editor.openPlugin`.

Open a plugin's sidebar (switches the editor pane to "plugin").

### setSelectedLocationIds

`unstable` · `deprecated` · since v0.6.6

```ts
setSelectedLocationIds(ids: SelectedIds): void
```

**Deprecated in v0.12.1.** Use `MMA.Store.setSelected`.

Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want.

### settled

`stable` · `deprecated` · since v0.12.0

```ts
settled(m: Mutation): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Mutation.settle`.

### setUserFieldDefs

`unstable` · `deprecated` · since v0.10.3

```ts
setUserFieldDefs(fields: Record<string, FieldDef>): Promise<void>
```

**Deprecated in v0.10.5.** The user layer is Rust-owned state (`MMA.Store.get().fieldDefs`);
use `MMA.Edit.meta({ extra: { fields } })` to change it, or `MMA.registerPluginFieldDefs()`
for plugin-owned defs.

### setWorkArea

`unstable` · `deprecated` · since v0.4.0

```ts
setWorkArea(area: WorkArea): void
```

**Deprecated in v0.12.1.** Use `MMA.Editor.setArea`.

Transition the editor pane, enforcing state invariants:
leaving "location" closes the open location, leaving "plugin" clears the plugin id.

### tagIdsToNames

`stable` · `deprecated` · since v0.9.0

```ts
tagIdsToNames(ids: number[]): string[]
```

**Deprecated in v0.12.1.** Use `MMA.Tag.names`.

Tag names for the given ids, skipping any that no longer resolve.

### undo

`stable` · `deprecated` · since v0.4.0

```ts
undo(): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.History.undo`.

Undo the last edit.

### updateLocations

`stable` · `deprecated` · since v0.6.3

```ts
updateLocations(updates: Patch<Location>[]): Promise<void>
```

**Deprecated in v0.12.1.** Use `MMA.Location.update`.

Patch locations by id. Only include the fields you're changing; `extra` merges
per-key (null deletes a key). Undoable by default.

### useMapBadges

`unstable` · `deprecated` · since v0.11.3

```ts
useMapBadges(): Map<string, MapBadge[]>
```

**Deprecated in v0.12.1.** Use `MMA.Maps.useBadges`.

Reactive Maps.badges.

### useMapList

`stable` · `deprecated` · since v0.4.0

```ts
useMapList(): MapMeta[]
```

**Deprecated in v0.12.1.** Use `MMA.Maps.useList`.

Reactive list of all maps (metadata only).

### useMapState

`stable` · `deprecated` · since v0.8.2

```ts
useMapState<T>(selector: (s: MapState) => T): T
```

**Deprecated in v0.12.1.** Use `MMA.Store.use`.

Reactive slice of the map state. Re-renders only when the selected value's
reference changes (`Object.is`), so selectors must return state fields or
memoized values, not a new value per call.

### waitForGoogleMap

`unstable` · `deprecated` · since v0.5.0

```ts
waitForGoogleMap(): Promise<google.maps.Map | null>
```

**Deprecated in v0.8.1.** Use `MMA.MapHost.wait()`.

### waitForMapHost

`unstable` · `deprecated` · since v0.8.0

```ts
waitForMapHost(): Promise<MapHost>
```

**Deprecated in v0.12.1.** Use `MMA.MapHost.wait`.

Wait for the main editor map to be ready.

## Ui

### ui

`stable` · since v0.6.1

Shared UI primitives for plugin sidebars and dialogs.

#### ui.Bar

`stable` · since v0.11.1

```ts
ui.Bar(props: {
  value: number;
  size?: BarSize;
  tone?: BarTone;
  className?: string;
}): react.JSX.Element
```

A bar filled to `value`, a share from 0 to 1.

#### ui.Button

`stable` · since v0.10.0

```ts
ui.Button(
  props: ComponentPropsWithRef<"button"> & {
    variant?: ButtonVariant;
    small?: boolean;
  },
): react.JSX.Element
```

#### ui.Checkbox

`stable` · since v0.10.0

```ts
ui.Checkbox(
  props: Omit<ComponentPropsWithRef<"input">, "children"> & ChoiceLabelProps,
): react.JSX.Element
```

A checkbox, with its label and hint beside it when given.

#### ui.ColorPicker

`stable` · since v0.10.0

```ts
ui.ColorPicker(props: {
  color: RGB;
  onChange: (color: RGB) => void;
  ariaLabel?: string;
}): react.JSX.Element
```

A color swatch that opens the picker in a popover on click.

#### ui.ConfirmButton

`unstable` · since v0.11.1

```ts
ui.ConfirmButton(
  props: Omit<ComponentPropsWithRef<typeof Button>, "onClick"> & {
    onConfirm: () => void;
    /** The label while armed. Defaults to "Are you sure?". */
    confirmLabel?: ReactNode;
  },
): react.JSX.Element
```

A button that asks "Are you sure?" on the first click and acts on the second. Moving focus
away disarms it.

#### ui.ConfirmDialog

`unstable` · since v0.11.1

```ts
ui.ConfirmDialog(
  props: DialogProps & {
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
  },
): react.JSX.Element
```

Asks the user to confirm one action, with room for extra options under the message.

#### ui.CoverageBar

`stable` · since v0.11.1

```ts
ui.CoverageBar(props: {
  ratio: number;
  size?: BarSize;
  status?: boolean;
  className?: string;
}): react.JSX.Element
```

Share of locations holding a value as a bar and a percentage, colored by whether every location is covered when `status` is set.

#### ui.DatePicker

`unstable` · since v0.10.0

```ts
ui.DatePicker(props: DatePickerProps): react.JSX.Element
```

#### ui.Dialog

`unstable` · since v0.10.0

```ts
ui.Dialog(
  props: Omit<ComponentProps<typeof Dialog$1.Root>, "onOpenChange"> & {
    onOpenChange?: (open: boolean) => void;
  },
): react.JSX.Element
```

#### ui.DialogActions

`unstable` · since v0.11.1

```ts
ui.DialogActions(props: {
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
}): react.JSX.Element
```

A dialog's footer: side content on the left, then Cancel, then the main action on the right.

#### ui.DialogContent

`unstable` · since v0.10.0

```ts
ui.DialogContent(
  props: ComponentProps<typeof Dialog$1.Popup> & {
    title: string;
    size?: DialogSize;
  },
): react.JSX.Element
```

#### ui.DialogForm

`unstable` · since v0.11.1

```ts
ui.DialogForm(
  props: Omit<ComponentPropsWithRef<"form">, "onSubmit"> & {
    onSubmit: () => void;
  },
): react.JSX.Element
```

A dialog body laid out as a column that runs `onSubmit` when submitted, Enter included.

#### ui.DialogTrigger

`unstable` · since v0.10.0

```ts
ui.DialogTrigger<Payload>(
  componentProps: DialogTriggerProps<Payload> & React.RefAttributes<HTMLElement>,
): React.JSX.Element
```

A button that opens the dialog.
Renders a `<button>` element.

Documentation: [Base UI Dialog](https://base-ui.com/react/components/dialog)

#### ui.EmptyState

`stable` · since v0.6.1

```ts
ui.EmptyState(props: {
  icon?: string;
  compact?: boolean;
  children: ReactNode;
}): react.JSX.Element
```

A message for a panel or list with nothing to show, with an optional icon. `compact` fits it
inline in a list.

#### ui.Field

`stable` · since v0.6.1

```ts
ui.Field(props: {
  label: ReactNode;
  hint?: ReactNode;
  row?: boolean;
  children: ReactNode;
}): react.JSX.Element
```

Labelled form row (label left, control right) for sidebar sections.

#### ui.Flag

`stable` · since v0.10.0

```ts
ui.Flag(props: {
  code: string | null;
  height?: number;
  className?: string;
}): react.JSX.Element | null
```

Country flag from the bundled SVG set. Renders nothing for a missing or malformed code.

#### ui.Hint

`stable` · since v0.11.1

```ts
ui.Hint(props: {
  tone?: "warning" | "error";
  children?: ReactNode;
}): react.JSX.Element
```

A line of secondary text, optionally marked as a warning or an error.

#### ui.HotkeyInput

`unstable` · since v0.10.0

```ts
ui.HotkeyInput(props: {
  value: string;
  onChange: (combo: string) => void;
}): react.JSX.Element
```

Click-to-record key combo input. Backspace/Delete clears, Escape cancels.

#### ui.Icon

`stable` · since v0.10.0

```ts
ui.Icon(props: IconProps): react.JSX.Element
```

#### ui.IconButton

`unstable` · since v0.11.1

```ts
ui.IconButton(
  props: Omit<ComponentPropsWithRef<"button">, "aria-label" | "title"> & {
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
  },
): react.JSX.Element
```

A button showing only an icon, named by its label.

#### ui.Notice

`stable` · since v0.11.1

```ts
ui.Notice(props: {
  tone: "info" | "warning" | "error" | "success";
  children: ReactNode;
}): react.JSX.Element
```

A boxed message that informs, warns, reports an error or confirms a success.

#### ui.NSelect

`unstable` · since v0.10.0

```ts
ui.NSelect(
  props: ComponentPropsWithRef<"select"> & {
    compact?: boolean;
    limited?: boolean;
  },
): react.JSX.Element
```

A dropdown. `compact` shrinks it to fit its value; `limited` caps the height of its option list.

#### ui.ProgressRow

`stable` · since v0.11.1

```ts
ui.ProgressRow(props: {
  label: ReactNode;
  count?: ReactNode;
  value: number;
  size?: BarSize;
  className?: string;
  children?: ReactNode;
}): react.JSX.Element
```

A progress bar under its label and count, with any extra detail below it.

#### ui.PromptDialog

`unstable` · since v0.11.1

```ts
ui.PromptDialog(
  props: DialogProps & {
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
  },
): react.JSX.Element
```

Asks for one line of text, submitted with Enter or the submit button.

#### ui.Radio

`stable` · since v0.10.0

```ts
ui.Radio(
  props: Omit<ComponentPropsWithRef<"input">, "children"> & ChoiceLabelProps,
): react.JSX.Element
```

A radio button, with its label and hint beside it when given.

#### ui.RgbPicker

`unstable` · since v0.10.0

```ts
ui.RgbPicker(props: {
  color: RGB;
  onChange: (color: RGB) => void;
}): react.JSX.Element
```

A color picker surface without a swatch. Takes and returns an `[r, g, b]` tuple, debounced.

#### ui.Section

`stable` · since v0.6.1

```ts
ui.Section(props: {
  title: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  addons?: ReactNode;
  children: ReactNode;
}): react.JSX.Element
```

Collapsible titled section inside a Sidebar.

#### ui.SegmentedControl

`stable` · since v0.6.1

```ts
ui.SegmentedControl<T extends string | number>(props: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  role?: "tabs" | "radio";
  fill?: boolean;
  className?: string;
}): react.JSX.Element
```

Row of mutually exclusive option buttons. `role` is `"tabs"` when the options switch between
panels and `"radio"` (the default) when they pick a value; `fill` stretches the options to
equal widths across the row.

#### ui.SelectorPicker

`stable` · since v0.10.0

```ts
ui.SelectorPicker(props: {
  ctl: SelectorPickController;
  className?: string;
}): react.JSX.Element
```

#### ui.SettingRow

`unstable` · since v0.10.0

```ts
ui.SettingRow(
  props: BoolRow | ControlRow | AutoBoolRow,
): react.JSX.Element | null
```

#### ui.Sidebar

`stable` · since v0.6.1

```ts
ui.Sidebar(props: {
  title: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  className?: string;
  flush?: boolean;
  /** Stays pinned below the body while it scrolls, for the sidebar's main actions. */
  footer?: ReactNode;
  children: ReactNode;
}): react.JSX.Element
```

Standard right-hand sidebar chrome (title, back button, scrollable body, pinned footer). Use for plugin sidebars.

#### ui.Slider

`stable` · since v0.10.0

```ts
ui.Slider(
  props: ComponentPropsWithRef<"input"> & {
    format?: (value: number) => ReactNode;
  },
): react.JSX.Element
```

A range input whose track fills up to its value, followed by the value itself when `format` is given.

#### ui.Spinner

`stable` · since v0.11.1

```ts
ui.Spinner(props: { size?: string; label?: string }): react.JSX.Element
```

A spinning ring shown while something loads. `size` is any length, such as `"10px"`.

#### ui.SuggestInput

`unstable` · since v0.10.0

```ts
ui.SuggestInput<T>(props: {
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
}): react.JSX.Element
```

Text input with a suggestion dropdown. Enter picks the first suggestion; Escape or an
outside click closes it. The dropdown shows whenever `suggestions` is non-empty, so
filter or fetch them yourself. The class props restyle it.

#### ui.Switch

`stable` · since v0.10.0

```ts
ui.Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}): react.JSX.Element
```

#### ui.SwitchRow

`stable` · since v0.10.0

```ts
ui.SwitchRow(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}): react.JSX.Element
```

A compact row with a switch on the left. Clicking anywhere on the row toggles it.

#### ui.TagPill

`unstable` · since v0.10.0

```ts
ui.TagPill<E extends ElementType = "span">(
  props: TagPillProps<E>,
): react.JSX.Element
```

A tag shown as a pill in its color.

#### ui.TagPillButton

`unstable` · since v0.10.0

```ts
ui.TagPillButton(
  props: ComponentPropsWithRef<"button"> & {
    variant: TagPillButtonVariant;
  },
): react.JSX.Element
```

The leading affordance inside a TagPill: remove, apply, or open the editor.

#### ui.TextInput

`stable` · since v0.10.0

```ts
ui.TextInput(props: ComponentPropsWithRef<"input">): react.JSX.Element
```

#### ui.ToolBlock

`unstable` · since v0.10.0

```ts
ui.ToolBlock(props: ToolBlockProps): react.JSX.Element
```

#### ui.Tooltip

`stable` · since v0.10.0

```ts
ui.Tooltip(props: {
  content: string;
  side?: Side;
  align?: Align;
  children: ReactElement;
}): ReactElement<Record<string, unknown>, string | react.JSXElementConstructor<any>>
```

Shows `content` as a tooltip when its child is hovered. The child is not wrapped.

#### ui.useCloseDialog

`unstable` · since v0.10.0

```ts
ui.useCloseDialog(): () => void
```

## Autosave

### Autosave

`stable` · unreleased

Debounced persistence of the open map: schedule, hold, cancel, or flush it.

#### Autosave.cancel

`unstable` · unreleased

```ts
Autosave.cancel(): void
```

Cancel any pending autosave timer.

#### Autosave.flush

`unstable` · unreleased

```ts
Autosave.flush(): Promise<void>
```

Save any unsaved changes now instead of waiting for the timer.

#### Autosave.hold

`unstable` · unreleased

```ts
Autosave.hold(): () => void
```

Defer autosave until the returned release function runs. Useful for batches that land many mutations.

#### Autosave.schedule

`unstable` · unreleased

```ts
Autosave.schedule(): void
```

Schedule a debounced autosave. Mutations call this automatically.

#### Autosave.scheduleAutoCommit

`unstable` · unreleased

```ts
Autosave.scheduleAutoCommit(mapId: string, importedCount: number): void
```

Background auto-commit after an import with autoCommit set.

#### Autosave.waitForInflight

`unstable` · unreleased

```ts
Autosave.waitForInflight(): Promise<void> | null
```

Wait for any in-progress save to finish.

## Edit

### Edit

`stable` · unreleased

Edit map locations, metadata, value records, and selections.

#### Edit.locations

`unstable` · unreleased

```ts
Edit.locations(...props: Parameters<typeof cmd.storeEdit>): Promise<
  MutationResult<{
    id: number;
    lat: number;
    lng: number;
    heading: number;
    pitch: number;
    zoom: number;
    panoId: string | null;
    flags: number;
    tags: number[];
    extra: { [key in string]: unknown } | null;
    createdAt: number;
    modifiedAt: number | null;
  }>
>
```

Edit locations on the map or in a pending layer. Map changes are undoable.

#### Edit.meta

`stable` · unreleased

```ts
Edit.meta(
  patch: Omit<Parameters<typeof cmd.storeUpdateMapMeta>[0], "id"> & {
    id?: string;
  },
): Promise<void>
```

Patch a map's metadata and persist it: the open map's unless the patch names an `id`.
Settings merge key by key, so send only the keys that change.

#### Edit.values

`stable` · unreleased

```ts
Edit.values(
  ...props: Parameters<typeof cmd.storeEditValues>
): Promise<MutationResult<ValueRecord>>
```

Edit an interned field's value records in one undoable step.

#### Edit.work

`unstable` · unreleased

```ts
Edit.work(selector: Selector, op: Work): Promise<WorkResult>
```

Run `op` across every location `selector` matches, in one undoable step.

## Location

### Location

`stable` · unreleased

Add, update, remove, and inspect map locations.

#### Location.add

`stable` · unreleased

```ts
Location.add(locs: Location[]): Promise<void>
```

Add locations to the map. Real ids are assigned and written back into the passed
objects - build with `createLocation` (id 0) and read `loc.id` after. Undoable.

#### Location.duplicate

`stable` · unreleased

```ts
Location.duplicate(id: number): Promise<number | null>
```

Clone a location in place and return the new id, or null if it doesn't exist. Undoable.

#### Location.duplicateGroups

`unstable` · unreleased

```ts
Location.duplicateGroups(distance: number): Promise<number[][]>
```

Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres.

#### Location.remove

`stable` · unreleased

```ts
Location.remove(ids: ReadonlyIdSet): Promise<void>
```

Remove locations by id. Undoable.

#### Location.update

`stable` · unreleased

```ts
Location.update(updates: Patch<Location>[]): Promise<void>
```

Patch locations by id. Only include the fields you're changing; `extra` merges
per-key (null deletes a key). Undoable by default.

## Tag

### Tag

`stable` · unreleased

Manage tag records and their assignment to locations.

#### Tag.all

`stable` · unreleased

```ts
Tag.all(): Record<number, Tag>
```

Tag records, including unreferenced records and generated display defaults.

#### Tag.assign

`stable` · unreleased

```ts
Tag.assign(
  selector: Selector,
  records: Omit<ValueRecord, "id">[],
): Promise<WorkResult>
```

Get or create tag records and assign them to matching locations.

#### Tag.counts

`stable` · unreleased

```ts
Tag.counts(): Record<number, number>
```

Per-tag location counts, keyed by numeric id.

#### Tag.create

`stable` · unreleased

```ts
Tag.create(records: Omit<ValueRecord, "id">[]): Promise<number[]>
```

Get or create tag records by name and return their ids.

#### Tag.get

`stable` · unreleased

```ts
Tag.get(id: number): Tag | undefined
```

Look up a tag record, including unreferenced tags.

#### Tag.names

`stable` · unreleased

```ts
Tag.names(ids: number[]): string[]
```

Tag names for the given ids, skipping any that no longer resolve.

#### Tag.remove

`stable` · unreleased

```ts
Tag.remove(tagIds: number[]): Promise<WorkResult>
```

Remove tags from every location in one undoable step.
Unreferenced tags are hidden; undo restores them.

#### Tag.rename

`stable` · unreleased

```ts
Tag.rename(
  ids: number[],
  name: string,
  scope?: Selector | null,
): Promise<void>
```

Move matching locations to a tag with the given name, optionally within a selector.

#### Tag.reorder

`stable` · unreleased

```ts
Tag.reorder(ids: number[]): Promise<MutationResult<ValueRecord>>
```

Set tag display order from an ordered list of ids.

#### Tag.update

`stable` · unreleased

```ts
Tag.update(
  updates: (Partial<ValueRecord> & Pick<ValueRecord, "id">)[],
): Promise<MutationResult<ValueRecord>>
```

Update tag display records in one undoable edit.

#### Tag.visible

`stable` · unreleased

```ts
Tag.visible(): Tag[]
```

Tag records referenced by at least one location.

## Editor

### Editor

`stable` · unreleased

Open locations and change the editor pane.

#### Editor.close

`stable` · unreleased

```ts
Editor.close(): void
```

Close the open location and return to the pane it was opened from.

#### Editor.closeDuplicates

`unstable` · unreleased

```ts
Editor.closeDuplicates(): void
```

Close the duplicate-resolution panel and return to the overview.

#### Editor.closePlugin

`stable` · unreleased

```ts
Editor.closePlugin(): void
```

Close the plugin sidebar and return to the overview.

#### Editor.layer

`stable` · unreleased

```ts
Editor.layer(session: number): Extract<
  Target,
  {
    kind: "pending";
  }
>
```

The pending layer holding the open location's draft edits for editor session `session`.

#### Editor.open

`stable` · unreleased

```ts
Editor.open(
  target: MaybeLocation,
  checkDuplicates?: boolean,
): Promise<void>
```

Open a location in the editor. With `checkDuplicates`, opening a spot with 2+ locations
within 2m opens the duplicate-resolution panel instead. A later opening or closing
supersedes one still loading.

#### Editor.openDuplicate

`unstable` · unreleased

```ts
Editor.openDuplicate(loc: Location): void
```

Open one location from the duplicate-resolution panel in the editor.

#### Editor.openImport

`unstable` · unreleased

```ts
Editor.openImport(index: number): Promise<void>
```

Preview a copy of a staged-import location. The import row stays staged until Confirm.

#### Editor.openPlugin

`stable` · unreleased

```ts
Editor.openPlugin(pluginId: string): void
```

Open a plugin's sidebar (switches the editor pane to "plugin").

#### Editor.preview

`unstable` · unreleased

```ts
Editor.preview(loc: Location): void
```

Open an arbitrary location read-only as a seen-preview: loads its pano without
adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves.

#### Editor.removeDuplicate

`unstable` · unreleased

```ts
Editor.removeDuplicate(id: number): void
```

Drop a location from the duplicate-resolution panel (does not delete it).

#### Editor.resolve

`stable` · unreleased

```ts
Editor.resolve(m: MaybeLocation): Promise<Location | null>
```

Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found.

#### Editor.setArea

`unstable` · unreleased

```ts
Editor.setArea(area: WorkArea): void
```

Transition the editor pane, enforcing state invariants:
leaving "location" closes the open location, leaving "plugin" clears the plugin id.

#### Editor.setLocation

`stable` · unreleased

```ts
Editor.setLocation(location: Location | null, session: number): void
```

Set the open location if `session` is still current.

## History

### History

`stable` · unreleased

Navigate undo and redo history.

#### History.available

`unstable` · unreleased

```ts
History.available(
  history: MapState["history"],
  stack: Stack,
  key?: EntryKey,
): boolean
```

Whether a history action is available for one part or for the data edit as a whole.

#### History.redo

`stable` · unreleased

```ts
History.redo(): Promise<void>
```

Redo the last undone edit.

#### History.undo

`stable` · unreleased

```ts
History.undo(): Promise<void>
```

Undo the last edit.

## Commit

### Commit

`stable` · unreleased

Save and restore map versions.

#### Commit.checkout

`unstable` · unreleased

```ts
Commit.checkout(commitId: string): Promise<void>
```

Restore a previous commit as a new revert commit and refresh the view. Clears undo/redo.

#### Commit.create

`stable` · unreleased

```ts
Commit.create(message?: string): Promise<string>
```

Commit all pending changes to the map's version history. Clears the undo stack.

## Field

### Field

`stable` · unreleased

Rename or remove metadata fields across the map.

#### Field.remove

`stable` · unreleased

```ts
Field.remove(key: string): Promise<void>
```

Delete extra-field `key` from every location, its definition, and the listed selections,
in one undoable step.

#### Field.rename

`stable` · unreleased

```ts
Field.rename(
  from: string,
  to: string,
  winner?: MergeWinner,
): Promise<void>
```

Rename extra-field `from` to `to` across all locations, its definition, and the listed
selections, in one undoable step. When a location already holds `to`, `winner` decides
which value survives. Saved selections are map-independent rules and keep their names.

## Store

### Store

`stable` · unreleased

Read the open map state and update its selection and metadata.

#### Store.get

`stable` · unreleased

```ts
Store.get(): Readonly<MapState>
```

Imperative snapshot of the map state.

#### Store.setMeta

`unstable` · unreleased

```ts
Store.setMeta(map: MapMeta): void
```

Replace the open map's row in state; persisting it is the caller's.

#### Store.setSelected

`unstable` · unreleased

```ts
Store.setSelected(ids: SelectedIds): void
```

Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want.

#### Store.use

`stable` · unreleased

```ts
Store.use<T>(selector: (s: MapState) => T): T
```

Reactive slice of the map state. Re-renders only when the selected value's
reference changes (`Object.is`), so selectors must return state fields or
memoized values, not a new value per call.

## Maps

### Maps

`stable` · unreleased

Create, list, open, close, and organize maps.

#### Maps.badges

`unstable` · unreleased

```ts
Maps.badges(): Map<string, MapBadge[]>
```

Badges per map id, from every registered source.

#### Maps.badgeSources

`unstable` · unreleased

```ts
Maps.badgeSources(): readonly BadgeSource[]
```

Every registered badge source, in registration order.

#### Maps.close

`stable` · unreleased

```ts
Maps.close(): Promise<void>
```

Close the open map, saving unsaved changes first.

#### Maps.copyName

`unstable` · unreleased

```ts
Maps.copyName(name: string): string
```

The name a copy of the map named `name` starts with.

#### Maps.create

`stable` · unreleased

```ts
Maps.create(name: string, folder?: string | null): Promise<MapMeta>
```

Create a new empty map and return its metadata.

#### Maps.discard

`unstable` · unreleased

```ts
Maps.discard(): void
```

Drop the open map without persisting anything

#### Maps.duplicate

`stable` · unreleased

```ts
Maps.duplicate(id: string, name: string): Promise<MapMeta>
```

Copy a map, uncommitted edits included, into a new map named `name` and return its metadata.

#### Maps.init

`unstable` · unreleased

```ts
Maps.init(): Promise<void>
```

One-time store startup. The app calls this; plugins never need to.

#### Maps.invalidate

`unstable` · unreleased

```ts
Maps.invalidate(): Promise<void>
```

Refresh the map list and notify other windows of the change.

#### Maps.isReserved

`unstable` · unreleased

```ts
Maps.isReserved(id: string | null): boolean
```

Whether `id` belongs to an app fixture rather than a user-created map.

#### Maps.list

`stable` · unreleased

```ts
Maps.list(): MapMeta[]
```

The list of all maps (metadata only).

#### Maps.moveToFolder

`stable` · unreleased

```ts
Maps.moveToFolder(mapId: string, folder: string | null): Promise<void>
```

Move a map into a folder, or to the root when `folder` is null.

#### Maps.open

`stable` · unreleased

```ts
Maps.open(id: string): Promise<void>
```

Open a map in this window, closing any currently open map first.

#### Maps.openScratch

`stable` · unreleased

```ts
Maps.openScratch(): Promise<void>
```

Open the scratch map, creating it on first use.

#### Maps.registerBadges

`unstable` · unreleased

```ts
Maps.registerBadges(source: BadgeSource): void
```

Add a source of map-row badges.

#### Maps.reload

`unstable` · unreleased

```ts
Maps.reload(): Promise<void>
```

Refresh the map list from disk.

#### Maps.remove

`stable` · unreleased

```ts
Maps.remove(id: string): Promise<void>
```

Permanently delete a map and all its data. Not undoable.

#### Maps.removeFolder

`stable` · unreleased

```ts
Maps.removeFolder(name: string): Promise<void>
```

Delete a folder. Maps in it become unfoldered.

#### Maps.renameFolder

`stable` · unreleased

```ts
Maps.renameFolder(from: string, to: string): Promise<void>
```

Rename a folder, moving all its maps to the new name.

#### Maps.setList

`unstable` · unreleased

```ts
Maps.setList(list: MapMeta[]): void
```

Set the map list directly without a disk read.

#### Maps.useBadges

`unstable` · unreleased

```ts
Maps.useBadges(): Map<string, MapBadge[]>
```

Reactive Maps.badges.

#### Maps.useList

`stable` · unreleased

```ts
Maps.useList(): MapMeta[]
```

Reactive list of all maps (metadata only).

## Query

### Query

`stable` · unreleased

Read locations and summaries for a selector.

#### Query.locationsOf

`stable` · unreleased

```ts
Query.locationsOf(list: LocationList): Promise<Location[]>
```

The locations an answer carries, fetched from its temp file when it was too large to send inline.

#### Query.read

`stable` · unreleased

```ts
Query.read<A extends Ask>(
  selector: Selector,
  ask: A,
  target?: Target,
): Promise<ReadResult<AnswerOf<A["kind"]>>>
```

Ask one question about the locations `selector` matches. A full-location answer loads any
backing file automatically; ask for ids or columns when full locations are unnecessary.

## Mutation

### Mutation

`stable` · unreleased

Run mutations and wait for their state and display updates.

#### Mutation.run

`stable` · unreleased

```ts
Mutation.run<R extends MutationResult = MutationResult>(
  fn: () => Promise<R>,
  ...fallback: MutationResult extends R ? [empty?: R] : [empty: R]
): Promise<R>
```

#### Mutation.settle

`stable` · unreleased

```ts
Mutation.settle(m: Mutation): Promise<void>
```

# Unstable surfaces

Everything below can change in any release.

## SelectionOps

Pure transforms over the selection list behind the sidebar.

### addSelection

`unstable` · since v0.4.0

```ts
addSelection(...selectors: Selector[]): SelectionOp
```

### all

`unstable` · since v0.11.0

```ts
all(...selectors: Selector[]): Selector
```

Locations matching every one of `selectors`; with none, every location.

### any

`unstable` · since v0.11.0

```ts
any(...selectors: Selector[]): Selector
```

Locations matching any of `selectors`; with none, no location.

### buildSelection

`unstable` · since v0.10.3

```ts
buildSelection(selector: Selector): Promise<Selection>
```

### childSelections

`unstable` · since v0.10.5

```ts
childSelections<S>(selector: Selector$1<S>): S[]
```

Every child selection a selector wraps, whatever shape it wraps them in.

### composeSelections

`unstable` · since v0.4.0

```ts
composeSelections(
  drag: SelectionPath,
  drop: SelectionPath,
  mode: GroupType,
): SelectionOp
```

### filterIsLocalTime

`unstable` · since v0.10.3

```ts
filterIsLocalTime(test: FilterOp): boolean
```

Whether a predicate reads the location's clock in its own timezone. Only a range can.

### has

`unstable` · since v0.11.0

```ts
has(field: string): Selector
```

Locations holding a value for `field`.

### intersectSelections

`unstable` · since v0.10.3

```ts
intersectSelections(keys?: string[] | null): SelectionOp
```

### invertSelections

`unstable` · since v0.10.3

```ts
invertSelections(keys?: string[] | null): SelectionOp
```

### isolateGhost

`unstable` · since v0.10.3

```ts
isolateGhost(index: number): SelectionOp
```

### lacks

`unstable` · since v0.11.0

```ts
lacks(field: string): Selector
```

Locations holding no value for `field`.

### moveSelection

`unstable` · since v0.11.3

```ts
moveSelection(
  from: SelectionPath,
  to: SelectionPath,
  position: "before" | "after",
): SelectionOp
```

### not

`unstable` · since v0.11.0

```ts
not(selector: Selector): Selector
```

Locations not matching `selector`.

### onActive

`unstable` · since v0.11.3

```ts
onActive(op: SelectionOp): SelectionOp
```

### OP_LABELS

`unstable` · since v0.10.3

```ts
OP_LABELS: Record<
  | "between"
  | "between_anytime"
  | "between_anyyear"
  | "contains"
  | "eq"
  | "gt"
  | "gte"
  | "has"
  | "lt"
  | "lte"
  | "neq"
  | "notcontains"
  | "nothas",
  string
>
```

Display symbol/word for each filter operator. Symbols are language-neutral; only the worded
operators are marked for translation.

### panoIdSelector

`unstable` · since v0.11.1

```ts
panoIdSelector(on: boolean): Selector
```

Locations pinned to one exact pano (the flag plus a pano id, mirroring Rust's
`Selector::pano_ids`), or the locations not pinned.

### removeSelection

`unstable` · since v0.4.0

```ts
removeSelection(...keys: string[]): SelectionOp
```

### removeSelectionAt

`unstable` · since v0.11.3

```ts
removeSelectionAt(path: SelectionPath): SelectionOp
```

### replaceSelection

`unstable` · since v0.10.3

```ts
replaceSelection(path: SelectionPath, selector: Selector): SelectionOp
```

### selection

`unstable` · since v0.12.0

```ts
selection(selector: Selector, color?: RGB): SelectionInput
```

An unaddressed selection input; Rust supplies its key and default color.

### selectionAt

`unstable` · since v0.11.3

```ts
selectionAt(
  rows: ListedSelection[],
  path: SelectionPath,
): Selection | undefined
```

### selectionDisplayName

`unstable` · since v0.10.3

```ts
selectionDisplayName(
  sel: SelectionInput,
  tagNames?: Record<number, string>,
): string
```

Human-readable label for a selection. Pass `tagNames` to resolve tags by saved name
rather than the open map's tags.

### SELECTIONS

`unstable` · since v0.10.3

```ts
SELECTIONS: {
  Duplicates: SelectionDescriptor<"Duplicates">;
  EvenlySpaced: SelectionDescriptor<"EvenlySpaced">;
  Everything: SelectionDescriptor<"Everything">;
  Filter: SelectionDescriptor<"Filter">;
  Intersection: SelectionDescriptor<"Intersection">;
  Invert: SelectionDescriptor<"Invert">;
  Locations: SelectionDescriptor<"Locations">;
  Manual: SelectionDescriptor<"Manual">;
  Nearby: SelectionDescriptor<"Nearby">;
  Nearest: SelectionDescriptor<"Nearest">;
  Polygon: SelectionDescriptor<"Polygon">;
  Ranked: SelectionDescriptor<"Ranked">;
  Reviewed: SelectionDescriptor<"Reviewed">;
  Sample: SelectionDescriptor<"Sample">;
  Selected: SelectionDescriptor<"Selected">;
  Spaced: SelectionDescriptor<"Spaced">;
  Uncommitted: SelectionDescriptor<"Uncommitted">;
  Union: SelectionDescriptor<"Union">;
  Validation: SelectionDescriptor<"Validation">;
}
```

Per-type descriptor for each selector variant: key derivation, display label, and optional color/location overrides.

### setPolygonName

`unstable` · since v0.4.0

```ts
setPolygonName(path: SelectionPath, name: string): SelectionOp
```

### setSelectionColor

`unstable` · since v0.4.0

```ts
setSelectionColor(path: SelectionPath, color: RGB): SelectionOp
```

### setSelections

`unstable` · since v0.12.0

```ts
setSelections(selections: SelectionInput[]): SelectionOp
```

### tagIdOf

`unstable` · since v0.11.1

```ts
tagIdOf(selector: Selector): number | null
```

The tag a selector names, or null when it names something else. The single place that
recognises tag membership, so nothing else has to know its shape.

### tagSelector

`unstable` · since v0.11.1

```ts
tagSelector(tagId: number): Selector
```

Locations carrying `tagId`. A tag is membership in the `tags` list field and nothing
else, so there is no tag selector to build.

### toggleGhost

`unstable` · since v0.10.3

```ts
toggleGhost(index: number): SelectionOp
```

### toggleGhostAll

`unstable` · since v0.10.3

```ts
toggleGhostAll: SelectionOp
```

### toggleInvert

`unstable` · since v0.11.3

```ts
toggleInvert(path: SelectionPath): SelectionOp
```

### toggleManualSelection

`unstable` · since v0.4.0

```ts
toggleManualSelection(id: number): SelectionOp
```

### toggleSelection

`unstable` · since v0.11.3

```ts
toggleSelection(...selectors: Selector[]): SelectionOp
```

### UNARY_TYPES

`unstable` · since v0.10.3

```ts
UNARY_TYPES: readonly ["Invert"]
```

### unionSelections

`unstable` · since v0.10.3

```ts
unionSelections(keys?: string[] | null): SelectionOp
```

### unpannedSelector

`unstable` · since v0.11.1

```ts
unpannedSelector(): Selector
```

Locations whose heading was never set.

### untaggedSelector

`unstable` · since v0.11.1

```ts
untaggedSelector(): Selector
```

Locations with no tags: `tags` resolves to nothing on an untagged location.

### withChildren

`unstable` · since v0.10.5

```ts
withChildren<S>(selector: Selector$1<S>, children: S[]): Selector$1<S>
```

`selector` with its children replaced, keeping the shape it wraps them in.

## Settings

App settings and their option tables; the shape moves with every setting added.

### APP_SETTINGS

`unstable` · since v0.10.3

```ts
APP_SETTINGS: PersistedStore<{
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
  hiddenMapBadges: string[];
  language: Language;
  units: UnitSystem;
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
  svTrail: boolean;
  svTrailColor: RGB;
  svTrailPosition: boolean;
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
  remoteApi: boolean;
  remoteApiKey: string;
  pinnedCommands: PinnedEntry[];
}>
```

A value saved in local storage: its key and its defaults.

### BORDER_ARCHIVE_BYTES

`unstable` · since v0.10.3

```ts
BORDER_ARCHIVE_BYTES: {
  readonly medium: 7460312;
  readonly heavy: 21514464;
  readonly adm1: 56891952;
}
```

Download size of each border detail level, in bytes.

### BORDER_DETAILS

`unstable` · since v0.10.3

```ts
BORDER_DETAILS: {
  readonly light: "Standard (bundled)";
  readonly medium: "High ({size})";
  readonly heavy: "Ultra ({size})";
}
```

### CSS_VAR_SETTINGS

`unstable` · since v0.10.3

```ts
CSS_VAR_SETTINGS: readonly (readonly [
  cssVar: string,
  value: (s: AppSettings) => string,
])[]
```

App settings exposed as CSS custom properties on `:root`.

### DATE_TIMEZONES

`unstable` · since v0.10.3

```ts
DATE_TIMEZONES: { readonly location: "Location timezone"; readonly utc: "UTC" }
```

### DEFAULTS

`unstable` · since v0.10.3

```ts
DEFAULTS: {
  showCameraBadges: boolean;
  showLinksControl: boolean;
  clickToGo: boolean;
  showRoadLabels: boolean;
  defaultMovementMode: "moving" | "nmpz" | "no-move";
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
  exactDateFormat: "date" | "datetime";
  dateTimezone: "location" | "utc";
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
  seenResolution: "high" | "low" | "medium";
  mapPanSpeed: number;
  panoLookSpeed: number;
  slowModifier: number;
  showFps: boolean;
  mapListFields: ("created" | "lastOpened" | "locationCount")[];
  /** Ids of map-row badge sources that are hidden. */
  hiddenMapBadges: string[];
  /** Read once at boot; changing it relaunches the app rather than re-rendering. */
  language: "de" | "en" | "en-XA" | "es" | "fr" | "ja" | "pl" | "ru" | "zh-Hans";
  /** Every distance the UI shows or accepts; stored values stay metric. */
  units: "auto" | "imperial" | "metric";
  /** Reopen the maps that were open when the session last ended (main window closed). */
  restoreSession: boolean;
  /** Offer pre-release builds to the updater as well as full releases. */
  prereleaseUpdates: boolean;
  /** Discord Rich Presence: off, generic (no map name), or full (map name + count). */
  discordPresence: "full" | "generic" | "off";
  /** Per-label color overrides (hex), keyed by lowercased label name. Shared across all maps. */
  labelColors: Record<string, string>;
  geocodeProvider: "google" | "local" | "nominatim";
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
  opacityToggleMode: "full" | "previous";
  /** Initial color mode for newly drawn polygon selections. Recoloring by hand overrides either mode. */
  polygonColorMode: "fixed" | "random";
  polygonColor: RGB;
  panoDotScaled: boolean;
  tagViewMode: "flat" | "tree";
  /** Tree view only: render each tag as the shortest path suffix that's still unique. */
  truncateTagPaths: boolean;
  /** Tree view: how a colorless folder row gets its color. `direct` uses tagFolderColor; `firstChild` inherits the first own-colored descendant in display order, with tagFolderColor as the fallback for colorless subtrees. */
  tagFolderColorMode: "direct" | "firstChild";
  tagFolderColor: RGB;
  tagSortMode: TagSortMode;
  /** Gap between tag pills (px), shared by flat and tree views via `--tag-gap`. */
  tagGap: number;
  animateTagReorder: boolean;
  borderDetail: "heavy" | "light" | "medium";
  subdivisionDetail: "adm1" | "off";
  previewAspectRatio: "16 / 10" | "16 / 9" | "21 / 9" | "32 / 9" | "4 / 3" | "free";
  tagSuggestionLimit: number;
  /** Local REST transport for window.MMA (Settings > Advanced). */
  remoteApi: boolean;
  remoteApiKey: string;
  pinnedCommands: PinnedEntry[];
}
```

Default values for every app setting.

### DISCORD_PRESENCE_MODES

`unstable` · since v0.10.3

```ts
DISCORD_PRESENCE_MODES: {
  readonly off: "Off";
  readonly generic: "Generic (no map name)";
  readonly full: "Full (map name + count)";
}
```

### EXACT_DATE_FORMATS

`unstable` · since v0.10.3

```ts
EXACT_DATE_FORMATS: {
  readonly date: "Date only";
  readonly datetime: "Date + time";
}
```

### GEOCODE_PROVIDER_LABELS

`unstable` · since v0.10.3

```ts
GEOCODE_PROVIDER_LABELS: Record<"google" | "local" | "nominatim", string>
```

### GEOCODE_PROVIDERS

`unstable` · since v0.10.3

```ts
GEOCODE_PROVIDERS: {
  readonly local: "Local (offline)";
  readonly nominatim: "Nominatim";
  readonly google: "Google (from panorama)";
}
```

### getSettings

`unstable` · since v0.4.0

```ts
getSettings(): AppSettings
```

The current app settings snapshot.

### LANGUAGES

`unstable` · since v0.10.3

```ts
LANGUAGES: {
  en: "English";
  de: "Deutsch";
  es: "Español";
  fr: "Français";
  ja: "日本語";
  pl: "Polski";
  ru: "Русский";
  "zh-Hans": "简体中文";
  "en-XA": "Pseudolocale";
}
```

Supported languages, labeled in their own script. `en-XA` is a dev-only pseudolocale.

### MAP_LIST_FIELDS

`unstable` · since v0.10.3

```ts
MAP_LIST_FIELDS: {
  readonly locationCount: "Location count";
  readonly lastOpened: "Last opened";
  readonly created: "Date created";
}
```

### MOVEMENT_CYCLE

`unstable` · since v0.10.3

```ts
MOVEMENT_CYCLE: ("moving" | "nmpz" | "no-move")[]
```

### MOVEMENT_MODES

`unstable` · since v0.10.3

```ts
MOVEMENT_MODES: {
  readonly moving: "Moving";
  readonly "no-move": "No Move";
  readonly nmpz: "NMPZ";
}
```

### navHiddenWithUI

`unstable` · since v0.10.3

```ts
navHiddenWithUI(s: AppSettings): boolean
```

True while the pano-UI toggle covers the navigation visuals too.

### OPACITY_TOGGLE_MODES

`unstable` · since v0.10.3

```ts
OPACITY_TOGGLE_MODES: {
  readonly previous: "Last used opacity";
  readonly full: "Full opacity";
}
```

### panoDisplayOptions

`unstable` · since v0.10.3

```ts
panoDisplayOptions(s: AppSettings): {
  linksControl: boolean;
  clickToGo: boolean;
  showRoadLabels: boolean;
  scrollwheel: boolean;
}
```

Effective StreetViewPanorama display options derived from the current settings.

### POLYGON_COLOR_MODES

`unstable` · since v0.10.3

```ts
POLYGON_COLOR_MODES: { readonly random: "Random"; readonly fixed: "Fixed color" }
```

### PREVIEW_ASPECT_RATIOS

`unstable` · since v0.10.3

```ts
PREVIEW_ASPECT_RATIOS: {
  "4 / 3": "4:3";
  "16 / 10": "16:10";
  "16 / 9": "16:9";
  "21 / 9": "21:9";
  "32 / 9": "32:9";
  free: "Free";
}
```

### PRIVATE_SETTINGS

`unstable` · since v0.10.3

```ts
PRIVATE_SETTINGS: ReadonlySet<
  | "activeLocationColor"
  | "animateTagReorder"
  | "borderDetail"
  | "clickToGo"
  | "customCss"
  | "dateTimezone"
  | "defaultMovementMode"
  | "discordPresence"
  | "enableSeen"
  | "enableSeenThumbnails"
  | "enterOpensCenter"
  | "exactDateFormat"
  | "followActiveInReview"
  | "fullscreenMap"
  | "fullscreenMiniLocationScale"
  | "fullscreenMinimapCloseDelay"
  | "fullscreenMinimapScale"
  | "geocodeProvider"
  | "hiddenMapBadges"
  | "hideNavWithUI"
  | "hidePanoUI"
  | "importPreviewColor"
  | "labelColors"
  | "language"
  | "mapListFields"
  | "mapPanSpeed"
  | "markerColor"
  | "nominatimApiKey"
  | "opacityToggleMode"
  | "panToImported"
  | "panoDotColor"
  | "panoDotScaled"
  | "panoLookSpeed"
  | "pastePadding"
  | "pinnedCommands"
  | "polygonColor"
  | "polygonColorMode"
  | "prereleaseUpdates"
  | "previewAspectRatio"
  | "remoteApi"
  | "remoteApiKey"
  | "restoreSession"
  | "seenResolution"
  | "showCameraBadges"
  | "showCar"
  | "showCompass"
  | "showCompassTape"
  | "showCoordinateDisplay"
  | "showCrosshair"
  | "showFps"
  | "showFullscreenButton"
  | "showFullscreenDatePicker"
  | "showFullscreenGeocode"
  | "showFullscreenMapMeta"
  | "showFullscreenMiniLocationPreview"
  | "showFullscreenMinimap"
  | "showFullscreenReviewBar"
  | "showFullscreenTagbar"
  | "showGroundArrow"
  | "showJumpButtons"
  | "showLinksControl"
  | "showMapLinks"
  | "showNavArrow"
  | "showPanoMetadata"
  | "showReturnToSpawn"
  | "showRoadLabels"
  | "showScreenshotButton"
  | "showZoom"
  | "slowModifier"
  | "subdivisionDetail"
  | "svTrail"
  | "svTrailColor"
  | "svTrailPosition"
  | "tagFolderColor"
  | "tagFolderColorMode"
  | "tagGap"
  | "tagSortMode"
  | "tagSuggestionLimit"
  | "tagViewMode"
  | "truncateTagPaths"
  | "units"
>
```

Settings holding private information that should not be exfiltrated.

### resetSettings

`unstable` · since v0.10.3

```ts
resetSettings(): void
```

Reset all settings to defaults.

### SEEN_RESOLUTIONS

`unstable` · since v0.10.3

```ts
SEEN_RESOLUTIONS: {
  readonly low: "Low (160x90)";
  readonly medium: "Medium (320x180)";
  readonly high: "High (640x360)";
}
```

### setSetting

`unstable` · since v0.4.0

```ts
setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): void
```

Update one setting and persist. Emits `settings:changed`.

### SUBDIVISION_DETAILS

`unstable` · since v0.10.3

```ts
SUBDIVISION_DETAILS: { readonly off: "Off"; readonly adm1: "States / provinces" }
```

### TAG_FOLDER_COLOR_MODES

`unstable` · since v0.10.3

```ts
TAG_FOLDER_COLOR_MODES: {
  readonly direct: "Fixed color";
  readonly firstChild: "Inherit first child";
}
```

### TAG_SUGGESTION_LIMITS

`unstable` · since v0.10.3

```ts
TAG_SUGGESTION_LIMITS: readonly [5, 10, 25, 50, 0]
```

Tag-suggestion list cap stops (slider indices); 0 = unlimited ("All").

### TAG_VIEW_MODES

`unstable` · since v0.10.3

```ts
TAG_VIEW_MODES: { readonly flat: "Flat"; readonly tree: "Tree" }
```

### UNIT_SYSTEMS

`unstable` · since v0.10.3

```ts
UNIT_SYSTEMS: {
  readonly auto: "Automatic";
  readonly metric: "Metric (m / km)";
  readonly imperial: "Imperial (ft / mi)";
}
```

Distance units. `auto` reads the system locale's region, so a US/UK machine gets miles.

### useSetting

`unstable` · since v0.10.3

```ts
useSetting<K extends keyof AppSettings>(key: K): AppSettings[K]
```

React hook: one setting value, re-rendering only when that key changes.

### useSettings

`unstable` · since v0.10.3

```ts
useSettings(): AppSettings
```

React hook: all settings, re-rendering on any change.

## SelectorPick

The selector picker the pick dialogs share; its choices move with the UI.

### createSelectorPick

`unstable` · since v0.10.0

```ts
createSelectorPick(initial?: SelectorPick): SelectorPickHandle
```

A standalone "all locations vs current selection" switch, for features that operate on a subset.

### selectorForPick

`unstable` · since v0.10.0

```ts
selectorForPick(choice: SelectorPick): Selector
```

Convert a picker choice into the corresponding `Selector`.

### useSelectorPick

`unstable` · since v0.10.0

```ts
useSelectorPick(initial?: SelectorPick): SelectorPickController
```

React hook: selector state with live counts. Defaults to the current selection when one
exists, else all locations. Use `createSelectorPick` when non-React code also reads the selector.

## Commands

The raw command layer under the app-level API; any of them can change in a release.

### cmd

`unstable` · since v0.4.0

Every backend command, typed. Any of them can change in a release.

#### cmd.appReady

`unstable` · since v0.5.2

```ts
cmd.appReady(): Promise<number>
```

Milliseconds from app launch until the window was ready.

#### cmd.appUptime

`unstable` · since v0.11.0

```ts
cmd.appUptime(): Promise<number>
```

Seconds the app has been running, counted from launch rather than from whenever a
window last loaded its page.

#### cmd.borderClassify

`unstable` · since v0.8.1

```ts
cmd.borderClassify(
  level: string,
  points: [number, number][],
): Promise<(string | null)[]>
```

Classify each `(lat, lng)` to the name of its containing border feature at
`level` (subdivision names for "adm1"). `null` for points outside every feature.

#### cmd.borderLookup

`unstable` · since v0.5.1

```ts
cmd.borderLookup(
  lat: number,
  lng: number,
  level: string,
): Promise<PolygonGeometry | null>
```

Return the border polygon containing (`lat`, `lng`) at the given detail
`level`, or `null` if the point falls outside every feature.

#### cmd.bulkImportCancel

`unstable` · since v0.6.7

```ts
cmd.bulkImportCancel(): Promise<null>
```

Discard the previewed import without importing. Call when the user cancels the
import dialog.

#### cmd.bulkImportConfirm

`unstable` · since v0.4.0

```ts
cmd.bulkImportConfirm(
  path: string,
  selectedIndices: number[],
): Promise<ImportedMapInfo[]>
```

Import the maps at `selectedIndices` from a previously previewed file.
Emits `bulk-import-progress` per map.

#### cmd.bulkImportPreview

`unstable` · since v0.4.0

```ts
cmd.bulkImportPreview(path: string): Promise<ImportPreviewEntry[]>
```

Parse a file (JSON or ZIP of JSONs) and return a preview of each map found,
without persisting anything. Call `bulkImportConfirm` to import the maps.

#### cmd.checkBorderFile

`unstable` · since v0.5.0

```ts
cmd.checkBorderFile(level: string): Promise<boolean>
```

Whether the border dataset for `level` is available on disk.

#### cmd.claimPluginUpdatePass

`unstable` · since v0.10.5

```ts
cmd.claimPluginUpdatePass(): Promise<boolean>
```

True for the first caller per app run, which runs the background plugin update check.

#### cmd.discordPresenceClear

`unstable` · since v0.7.6

```ts
cmd.discordPresenceClear(): Promise<null>
```

Clear the Discord Rich Presence activity. No-op when Discord is not running.

#### cmd.discordPresenceSet

`unstable` · since v0.7.6

```ts
cmd.discordPresenceSet(activity: PresenceActivity): Promise<null>
```

Set the Discord Rich Presence activity. No-op when Discord is not running.

#### cmd.downloadBorderFile

`unstable` · since v0.5.0

```ts
cmd.downloadBorderFile(level: string): Promise<null>
```

Download the border dataset for `level` from the repository.

#### cmd.feedbackAnonymousAvailable

`unstable` · since v0.9.0

```ts
cmd.feedbackAnonymousAvailable(): Promise<boolean>
```

Whether the anonymous tier is available in this build.

#### cmd.feedbackAnonymousThread

`unstable` · since v0.9.0

```ts
cmd.feedbackAnonymousThread(number: number, token: string): Promise<IssueThread>
```

Fetch the current state and replies for an anonymous report.

#### cmd.feedbackLogTail

`unstable` · since v0.9.0

```ts
cmd.feedbackLogTail(): Promise<string>
```

The tail of `mma.log`, scrubbed. Empty string when there is no log yet.

#### cmd.feedbackRequestLabel

`unstable` · since v0.9.0

```ts
cmd.feedbackRequestLabel(number: number): Promise<null>
```

Request that standard labels be applied to a report the user filed. Best-effort:
a failure here does not affect the report itself.

#### cmd.feedbackSubmitAnonymous

`unstable` · since v0.9.0

```ts
cmd.feedbackSubmitAnonymous(
  title: string,
  body: string,
  installId: string,
): Promise<AnonIssueRef>
```

File a bug report anonymously (no account required). Returns a reference the
caller can use to check for replies via `feedbackAnonymousThread`.

#### cmd.feedbackUploadAttachment

`unstable` · since v0.9.0

```ts
cmd.feedbackUploadAttachment(path: string, name: string): Promise<AttachmentRef>
```

Upload an image attachment for a bug report and return its URL.

#### cmd.fieldExprError

`unstable` · since v0.10.0

```ts
cmd.fieldExprError(src: string): Promise<ExprError | null>
```

The parse error for `src`, or `null` when it parses.

#### cmd.fileSourceProbe

`unstable` · since v0.11.4

```ts
cmd.fileSourceProbe(address: string): Promise<FileSource>
```

Read the map file at a path or http(s) URL, to link a map to it.

#### cmd.geoguessrHasSession

`unstable` · since v0.8.1

```ts
cmd.geoguessrHasSession(): Promise<boolean>
```

Local-only check: is a token stored? Says nothing about its validity.

#### cmd.geoguessrLogin

`unstable` · since v0.8.1

```ts
cmd.geoguessrLogin(): Promise<string>
```

Open the GeoGuessr sign-in window and wait for authentication to complete.
Returns the signed-in nickname.

#### cmd.geoguessrLogout

`unstable` · since v0.8.1

```ts
cmd.geoguessrLogout(): Promise<null>
```

Sign out of GeoGuessr and clear the stored session.

#### cmd.geoguessrMe

`unstable` · since v0.8.1

```ts
cmd.geoguessrMe(): Promise<GgUser | null>
```

The signed-in user, or `null` when there is no session (or it was rejected).

#### cmd.getAppDataDir

`unstable` · since v0.4.0

```ts
cmd.getAppDataDir(): Promise<string>
```

Return the app's data directory path.

#### cmd.getDataLocation

`unstable` · since v0.6.8

```ts
cmd.getDataLocation(): Promise<DataLocation>
```

Return the current and default data-folder paths, and whether a custom override is active.

#### cmd.githubCreateIssue

`unstable` · since v0.9.0

```ts
cmd.githubCreateIssue(
  title: string,
  body: string,
  labels: string[],
): Promise<IssueRef>
```

File a bug report as the signed-in GitHub user.

#### cmd.githubHasSession

`unstable` · since v0.9.0

```ts
cmd.githubHasSession(): Promise<boolean>
```

Local-only check: is a token stored? Says nothing about its validity.

#### cmd.githubIssueThread

`unstable` · since v0.9.0

```ts
cmd.githubIssueThread(number: number): Promise<IssueThread>
```

Fetch a report's current state and comments as the signed-in GitHub user.

#### cmd.githubLogout

`unstable` · since v0.9.0

```ts
cmd.githubLogout(): Promise<null>
```

Sign out of GitHub and clear the stored session.

#### cmd.githubMe

`unstable` · since v0.9.0

```ts
cmd.githubMe(): Promise<GhUser | null>
```

The signed-in user, or `null` when there is no session (or it was rejected).

#### cmd.githubPollLogin

`unstable` · since v0.9.0

```ts
cmd.githubPollLogin(): Promise<GhUser>
```

Wait for the user to authorize the code from `githubStartLogin`.
Resolves with the signed-in account.

#### cmd.githubStartLogin

`unstable` · since v0.9.0

```ts
cmd.githubStartLogin(): Promise<DeviceCodeInfo>
```

Begin device-flow sign-in. Returns the code to show the user; call
`githubPollLogin` afterwards to wait for them to finish authorizing.

#### cmd.honeycombPoints

`unstable` · since v0.11.0

```ts
cmd.honeycombPoints(
  polygon: PolygonGeometry,
  spacingM: number,
): Promise<HoneycombRun[]>
```

The points of a honeycomb about `spacingM` metres apart that fall inside the polygon,
one entry per row of points.

#### cmd.installPlugin

`unstable` · since v0.5.0

```ts
cmd.installPlugin(id: string, gitRef: string | null): Promise<PluginManifest>
```

Install a plugin from the marketplace: its manifest, main script, and procedure module.
`gitRef` pins an older build; `null` installs the latest.

#### cmd.listUserPlugins

`unstable` · since v0.4.0

```ts
cmd.listUserPlugins(): Promise<PluginManifest[]>
```

Manifests of every installed plugin.

#### cmd.mapMakingCreateMap

`unstable` · since v0.11.4

```ts
cmd.mapMakingCreateMap(name: string): Promise<MmMapSummary>
```

Create an empty map named `name` for the stored key.

#### cmd.mapMakingHasKey

`unstable` · since v0.10.7

```ts
cmd.mapMakingHasKey(): Promise<boolean>
```

Local-only check: is a key stored? Says nothing about its validity.

#### cmd.mapMakingMaps

`unstable` · since v0.10.7

```ts
cmd.mapMakingMaps(): Promise<MmMapSummary[]>
```

Linkable maps for the stored key.

#### cmd.mapMakingMe

`unstable` · since v0.10.7

```ts
cmd.mapMakingMe(): Promise<MmUser | null>
```

The account behind the stored key, or null when no key is stored.

#### cmd.mapMakingSetKey

`unstable` · since v0.10.7

```ts
cmd.mapMakingSetKey(key: string | null): Promise<null>
```

Store the API key, or clear it with null.

#### cmd.mapMakingValidate

`unstable` · since v0.10.7

```ts
cmd.mapMakingValidate(key: string): Promise<MmUser>
```

Check `key` against the remote without storing it.

#### cmd.openDataFolder

`unstable` · since v0.4.0

```ts
cmd.openDataFolder(): Promise<null>
```

Open the app's data folder in the OS file explorer.

#### cmd.openLogFile

`unstable` · since v0.7.4

```ts
cmd.openLogFile(): Promise<null>
```

Open the app's log file in the OS default handler.

#### cmd.parseMapsUrl

`unstable` · since v0.10.7

```ts
cmd.parseMapsUrl(input: string): Promise<ParsedLocation | null>
```

The location a pasted Maps URL names, short links resolved.

#### cmd.polygonBounds

`unstable` · since v0.11.0

```ts
cmd.polygonBounds(
  polygon: PolygonGeometry,
): Promise<[number, number, number, number] | null>
```

Bounding box `[west, south, east, north]` of the polygon itself, or `null` when it
has no vertices. `west > east` means the box crosses the antimeridian.

#### cmd.polygonContainsPoints

`unstable` · since v0.11.0

```ts
cmd.polygonContainsPoints(
  polygon: PolygonGeometry,
  lats: number[],
  lngs: number[],
): Promise<boolean[]>
```

Whether each of the points sits inside the polygon.

#### cmd.polygonFill

`unstable` · since v0.11.4

```ts
cmd.polygonFill(polygon: PolygonGeometry): Promise<[number, number][][][]>
```

The area a polygon selects, as polygons whose edges never cross, for drawing its fill.

#### cmd.polygonPoissonPoints

`unstable` · since v0.11.0

```ts
cmd.polygonPoissonPoints(
  polygon: PolygonGeometry,
  spacingM: number,
): Promise<[number, number][]>
```

Points covering the polygon with no two closer than `spacingM` metres and no gap
wider than about twice that, in random order.

#### cmd.polygonRandomPoints

`unstable` · since v0.11.0

```ts
cmd.polygonRandomPoints(
  polygon: PolygonGeometry,
  count: number,
): Promise<[number, number][]>
```

Up to `count` points drawn uniformly at random inside the polygon, as `[lng, lat]`
pairs. Fewer come back when the polygon fills little of its bounding box.

#### cmd.procedureActivity

`unstable` · since v0.11.0

```ts
cmd.procedureActivity(): Promise<ProcedureActivity>
```

What the procedure engine is working on right now.

#### cmd.procedureCancel

`unstable` · since v0.10.0

```ts
cmd.procedureCancel(runId: number): Promise<null>
```

Stop a run before its next batch. Already-applied patches stay applied.

#### cmd.procedureQuery

`unstable` · since v0.10.0

```ts
cmd.procedureQuery(
  procedure: ProcedureDecl,
  input: string,
  runId: number | null,
): Promise<string>
```

Run a procedure's read-only `query` export. `input` and the result are defined
by the procedure module. A `runId` from `procedureReserveRun` streams partial results
under it and lets `procedureCancel` stop the query.

#### cmd.procedureReserveRun

`unstable` · since v0.11.1

```ts
cmd.procedureReserveRun(): Promise<number>
```

Reserve a run id up front, for a query or location run that answers only when it is over:
its streamed results carry the id, and `procedureCancel` stops it.

#### cmd.procedureRun

`unstable` · since v0.10.0

```ts
cmd.procedureRun(
  providers: ProviderDecl[],
  force: boolean,
  target: Target | null,
): Promise<number>
```

Start a procedure run over the open map's locations. Returns immediately with
the run id. Emits `procedure-progress` and `procedure-result` as work completes.

#### cmd.readFile

`unstable` · since v0.4.0

```ts
cmd.readFile(path: string): Promise<string>
```

Read a file as UTF-8 text (temp files, plugin sources).

#### cmd.remoteApiRespond

`unstable` · since v0.8.0

```ts
cmd.remoteApiRespond(id: number, ok: boolean, payload: string): Promise<void>
```

Deliver the result for remote API request `id`. `payload` is JSON text.

#### cmd.remoteApiStart

`unstable` · since v0.8.0

```ts
cmd.remoteApiStart(key: string): Promise<string>
```

Start (or re-key) the remote API server. Idempotent: a running server just
picks up the new key. Returns the base URL.

#### cmd.remoteApiStop

`unstable` · since v0.8.0

```ts
cmd.remoteApiStop(): Promise<null>
```

Stop the remote API server.

#### cmd.remoteMappingClear

`unstable` · since v0.8.1

```ts
cmd.remoteMappingClear(provider: string, mapId: string): Promise<null>
```

Drop all mapping rows for a linked map (unlink).

#### cmd.revealWindow

`unstable` · since v0.10.6

```ts
cmd.revealWindow(maximized: boolean): Promise<void>
```

Show the window with the system open animation, maximized if `maximized` is set.

#### cmd.reverseGeocode

`unstable` · since v0.4.0

```ts
cmd.reverseGeocode(lat: number, lng: number): Promise<GeoResult | null>
```

Return the nearest city, administrative region, and country for a coordinate.
Never `null`: every landmass is covered.

#### cmd.selectionBuild

`unstable` · since v0.12.0

```ts
cmd.selectionBuild(selections: SelectionInput[]): Promise<Selection[]>
```

Compile unaddressed selections into keyed store inputs.

#### cmd.setDataLocation

`unstable` · since v0.6.8

```ts
cmd.setDataLocation(path: string | null): Promise<null>
```

Set or clear the data-folder override. Takes effect after relaunch and does not
move existing data.

#### cmd.sidecarCancel

`unstable` · since v0.9.0

```ts
cmd.sidecarCancel(reqId: number): Promise<null>
```

Cancel a running sidecar request. No-op if the request already finished.

#### cmd.sidecarInstall

`unstable` · since v0.7.0

```ts
cmd.sidecarInstall(
  pluginId: string,
  name: string,
  version: string,
): Promise<null>
```

Download and install a plugin's sidecar bundle. Emits `sidecar-install-progress`.

#### cmd.sidecarInstalledVersion

`unstable` · since v0.7.0

```ts
cmd.sidecarInstalledVersion(pluginId: string): Promise<string | null>
```

Installed sidecar version for a plugin, or `null` if not installed.

#### cmd.sidecarRequest

`unstable` · since v0.9.0

```ts
cmd.sidecarRequest(
  pluginId: string,
  command: string,
  payload: string | null,
): Promise<number>
```

Run one unit of work on a plugin's sidecar. Commands the manifest lists under
`serve` go to the plugin's resident process; the rest get a one-shot child.
Streams `sidecar-line` (one JSON object per unit) and `sidecar-log` (stderr),
then exactly one `sidecar-done`, all keyed by the returned request id.

#### cmd.sidecarStop

`unstable` · since v0.9.0

```ts
cmd.sidecarStop(pluginId: string): Promise<null>
```

Stop all sidecar processes for a plugin.

#### cmd.sidecarStopAll

`unstable` · since v0.9.0

```ts
cmd.sidecarStopAll(): Promise<null>
```

Stop all sidecar processes across every plugin.

#### cmd.storeAddLocationsToMap

`unstable` · since v0.10.2

```ts
cmd.storeAddLocationsToMap(
  targetMapId: string,
  locations: Location[],
): Promise<CopyToMapResult>
```

Add caller-supplied locations to another map. Tags are matched by name against this
map's tag table.

#### cmd.storeAddLocationsUploaded

`unstable` · since v0.10.0

```ts
cmd.storeAddLocationsUploaded(sessionDir: string): Promise<
  MutationResult<{
    /**  Monotonically increasing within a map. Zero until the store assigns one. */
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
    extra: { [key in string]: unknown } | null;
    /**  Unix timestamp (seconds) */
    createdAt: number;
    modifiedAt: number | null;
  }>
>
```

Add locations from an upload session (see `storeUploadBegin`) as one undoable change.

#### cmd.storeApplySavedSelection

`unstable` · since v0.12.0

```ts
cmd.storeApplySavedSelection(id: string): Promise<
  MutationResult<{
    /**  Monotonically increasing within a map. Zero until the store assigns one. */
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
    extra: { [key in string]: unknown } | null;
    /**  Unix timestamp (seconds) */
    createdAt: number;
    modifiedAt: number | null;
  }>
>
```

Apply a saved rule with its value names resolved against the open map.

#### cmd.storeCheckoutCommit

`unstable` · since v0.4.0

```ts
cmd.storeCheckoutCommit(
  mapId: string,
  commitId: string,
): Promise<
  MutationResult<{
    /**  Monotonically increasing within a map. Zero until the store assigns one. */
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
    extra: { [key in string]: unknown } | null;
    /**  Unix timestamp (seconds) */
    createdAt: number;
    modifiedAt: number | null;
  }>
>
```

Restore a map to a previous commit. An open map changes through its normal write path.

#### cmd.storeCloseMap

`unstable` · since v0.4.0

```ts
cmd.storeCloseMap(): Promise<null>
```

Close the open map, saving unsaved changes first.

#### cmd.storeCommit

`unstable` · since v0.6.5

```ts
cmd.storeCommit(mapId: string, message: string | null): Promise<CommitResult>
```

Commit the map's uncommitted changes. Returns the new commit ID. Clears undo/redo.

#### cmd.storeCommitDiff

`unstable` · since v0.4.0

```ts
cmd.storeCommitDiff(): Promise<Counts>
```

Return the uncommitted location change counts.

#### cmd.storeCopyLocationsToMap

`unstable` · since v0.6.0

```ts
cmd.storeCopyLocationsToMap(
  targetMapId: string,
  selector: Selector$1<SelectionInput>,
): Promise<CopyToMapResult>
```

Copy locations already stored in this map into another map.

#### cmd.storeCountryDistribution

`unstable` · since v0.5.2

```ts
cmd.storeCountryDistribution(
  selector: Selector$1<SelectionInput>,
  level: string,
): Promise<[string, number][]>
```

Count locations by country using offline point-in-polygon. Returns (ISO-A2, count) pairs.
`level` selects border precision, falling back to "light" if unavailable.

#### cmd.storeCreateMap

`unstable` · since v0.4.0

```ts
cmd.storeCreateMap(name: string, folder: string | null): Promise<MapMeta>
```

Create a new empty map with the preferences new maps start from. Returns the full metadata.

#### cmd.storeDbStats

`unstable` · since v0.4.0

```ts
cmd.storeDbStats(): Promise<DbStats>
```

Return aggregate database statistics: counts, file size, and configuration.

#### cmd.storeDeleteFolder

`unstable` · since v0.4.0

```ts
cmd.storeDeleteFolder(name: string): Promise<null>
```

Delete a folder, moving its maps to the root level.

#### cmd.storeDeleteMap

`unstable` · since v0.4.0

```ts
cmd.storeDeleteMap(id: string): Promise<null>
```

Delete a map and all its data permanently.

#### cmd.storeDeleteSavedSelection

`unstable` · since v0.10.0

```ts
cmd.storeDeleteSavedSelection(id: string): Promise<null>
```

Delete a saved selection rule by `id`.

#### cmd.storeDrop

`unstable` · since v0.12.0

```ts
cmd.storeDrop(name: string): Promise<null>
```

Drop a named pending layer and everything it holds.

#### cmd.storeDuplicateMap

`unstable` · since v0.11.4

```ts
cmd.storeDuplicateMap(id: string, name: string): Promise<MapMeta>
```

Copy a map, uncommitted edits included, into a new map named `name`. Version history,
edit history, sync links, and review sessions stay with the original.

#### cmd.storeEdit

`unstable` · since v0.12.0

```ts
cmd.storeEdit(
  target: Target,
  edits: Op<Location, Partial<Location> & Pick<Location, "id">, number>[],
  opts: EditOpts | null,
): Promise<
  MutationResult<{
    /**  Monotonically increasing within a map. Zero until the store assigns one. */
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
    extra: { [key in string]: unknown } | null;
    /**  Unix timestamp (seconds) */
    createdAt: number;
    modifiedAt: number | null;
  }>
>
```

Edit locations where target says; a pending layer holds edits until land.

#### cmd.storeEditSelections

`unstable` · since v0.12.0

```ts
cmd.storeEditSelections(op: SelectionOp): Promise<
  MutationResult<{
    /**  Monotonically increasing within a map. Zero until the store assigns one. */
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
    extra: { [key in string]: unknown } | null;
    /**  Unix timestamp (seconds) */
    createdAt: number;
    modifiedAt: number | null;
  }>
>
```

Edit the selection tree.

#### cmd.storeEditValues

`unstable` · unreleased

```ts
cmd.storeEditValues(
  field: string,
  edits: Op<ValueRecord, Partial<ValueRecord> & Pick<ValueRecord, "id">, number>[],
): Promise<MutationResult<ValueRecord>>
```

Edit an interned field's value records; membership uses ordinary location edits.

#### cmd.storeExportBulkZip

`unstable` · since v0.4.0

```ts
cmd.storeExportBulkZip(): Promise<string>
```

Export every map as a ZIP of JSON files. Duplicate map names get a numeric suffix.
Emits `bulk-export-progress` per map.

#### cmd.storeExportCsv

`unstable` · since v0.4.0

```ts
cmd.storeExportCsv(selector: Selector$1<SelectionInput>): Promise<string>
```

Export locations as a minimal lat/lng CSV file.

#### cmd.storeExportGeojson

`unstable` · since v0.4.0

```ts
cmd.storeExportGeojson(
  selector: Selector$1<SelectionInput>,
  tagsJson: string,
): Promise<string>
```

Export locations as a GeoJSON FeatureCollection of Point features.
Each feature carries its tag names in `properties.tags`.

#### cmd.storeExportJson

`unstable` · since v0.4.0

```ts
cmd.storeExportJson(opts: ExportOpts): Promise<string>
```

Export locations as a `{name, customCoordinates}` JSON file, including tags and field defs.

#### cmd.storeGetCommitDelta

`unstable` · since v0.5.1

```ts
cmd.storeGetCommitDelta(mapId: string, commitId: string): Promise<Change<Location>>
```

Read a single commit's change: the locations it added, removed and updated.

#### cmd.storeGetMap

`unstable` · since v0.4.0

```ts
cmd.storeGetMap(id: string): Promise<MapMeta | null>
```

Fetch a single map's metadata by ID. Returns `null` if not found.

#### cmd.storeGetMapDefaults

`unstable` · since v0.11.4

```ts
cmd.storeGetMapDefaults(): Promise<MapPreferences | null>
```

The preferences new maps start from, or `null` when they start from the factory defaults.

#### cmd.storeGetSavedSelections

`unstable` · since v0.10.0

```ts
cmd.storeGetSavedSelections(ids: string[]): Promise<SavedSelection[]>
```

Fetch the full saved selection rules for the given `ids`, including their selector trees.

#### cmd.storeImportCancel

`unstable` · since v0.11.3

```ts
cmd.storeImportCancel(): Promise<null>
```

Discard the staged import without importing it.

#### cmd.storeImportFile

`unstable` · since v0.4.0

```ts
cmd.storeImportFile(
  droppedFields: string[],
  tagNames: string[],
): Promise<EditorImportResult>
```

Commit a previously previewed editor import into the open map, optionally
dropping fields in `droppedFields` (e.g. `"heading"`, `"extra.countryCode"`)
and/or applying each of `tagNames` to every imported location.

#### cmd.storeImportLegacySavedSelections

`unstable` · since v0.10.0

```ts
cmd.storeImportLegacySavedSelections(json: string): Promise<number>
```

Import saved selections kept in local storage by older versions. No-op when
rules already exist. Returns the number of rules imported.

#### cmd.storeImportPastePreview

`unstable` · since v0.5.1

```ts
cmd.storeImportPastePreview(text: string): Promise<EditorImportPreview>
```

Parse pasted text (JSON or CSV) and stage it for preview. Works like
`storeImportPreview` but reads from a string instead of a file.

#### cmd.storeImportPreview

`unstable` · since v0.4.0

```ts
cmd.storeImportPreview(path: string): Promise<EditorImportPreview>
```

Parse a file and return field-level statistics and preview positions for the
editor import dialog. Call `storeImportFile` to commit the import.

#### cmd.storeListCommits

`unstable` · since v0.4.0

```ts
cmd.storeListCommits(mapId: string): Promise<CommitInfo[]>
```

List all commits for a map, newest first.

#### cmd.storeListMaps

`unstable` · since v0.4.0

```ts
cmd.storeListMaps(): Promise<MapMeta[]>
```

Return metadata for every map in the database.

#### cmd.storeListSavedSelections

`unstable` · since v0.10.0

```ts
cmd.storeListSavedSelections(): Promise<SavedSelectionInfo[]>
```

List every saved selection rule (name, color, date), without their selector trees.

#### cmd.storeOpenMap

`unstable` · since v0.4.0

```ts
cmd.storeOpenMap(mapId: string): Promise<StoreStatus>
```

Open a map and return its initial state (per-value counts, metadata, undo/redo availability).
Must be called before any other store commands.

#### cmd.storeRead

`unstable` · since v0.12.0

```ts
cmd.storeRead(
  target: Target,
  selector: Selector$1<SelectionInput>,
  ask: Ask,
): Promise<Answer>
```

Answer one question about the target's locations matched by selector.

#### cmd.storeRenameFolder

`unstable` · since v0.4.0

```ts
cmd.storeRenameFolder(from: string, to: string): Promise<null>
```

Rename a folder across all maps that reference it.

#### cmd.storeResolvePick

`unstable` · since v0.4.0

```ts
cmd.storeResolvePick(cell: string, cellIndex: number): Promise<number | null>
```

Resolve a marker pick (cell key + index within cell) to a location ID.

#### cmd.storeReviewCreate

`unstable` · since v0.5.2

```ts
cmd.storeReviewCreate(session: ReviewCreate): Promise<ReviewSession>
```

Create a new review session from a frozen worklist of location IDs.

#### cmd.storeReviewDelete

`unstable` · since v0.5.2

```ts
cmd.storeReviewDelete(id: string): Promise<null>
```

Delete a review session.

#### cmd.storeReviewGet

`unstable` · since v0.5.2

```ts
cmd.storeReviewGet(
  mapId: string,
  sourceKey: string,
): Promise<ReviewSession | null>
```

Look up the most recent active review session for a map and source key.

#### cmd.storeReviewList

`unstable` · since v0.5.2

```ts
cmd.storeReviewList(
  mapId: string,
  status: string | null,
): Promise<ReviewSession[]>
```

List review sessions for a map, newest first. Optionally filter by `status`.

#### cmd.storeReviewUpdate

`unstable` · since v0.5.2

```ts
cmd.storeReviewUpdate(
  update: Partial<
    Omit<
      ReviewSession,
      "mapId" | "sourceKey" | "sourceProps" | "createdAt" | "updatedAt"
    >
  > &
    Pick<ReviewSession, "id">,
): Promise<null>
```

Apply a partial update to a review session.

#### cmd.storeSaveDirty

`unstable` · since v0.4.0

```ts
cmd.storeSaveDirty(): Promise<null>
```

Save uncommitted changes to disk. No-op when nothing has changed.

#### cmd.storeSaveExportFile

`unstable` · since v0.5.2

```ts
cmd.storeSaveExportFile(srcPath: string, destPath: string): Promise<null>
```

Move a temp export file to `destPath` and remove the temp source.

#### cmd.storeSaveSelection

`unstable` · since v0.10.0

```ts
cmd.storeSaveSelection(
  name: string,
  selector: Selector$1<SelectionInput>,
  color: RGB,
): Promise<SavedSelection>
```

Save a new selection rule.

#### cmd.storeScratchMap

`unstable` · since v0.10.1

```ts
cmd.storeScratchMap(): Promise<MapMeta>
```

Open the scratch map, creating it if this is its first use. Ordinary in every way
except that `storeListMaps` leaves it out and it is emptied on every launch.

#### cmd.storeSeenClear

`unstable` · since v0.4.0

```ts
cmd.storeSeenClear(): Promise<null>
```

Deletes all seen history entries.

#### cmd.storeSeenCount

`unstable` · since v0.4.0

```ts
cmd.storeSeenCount(filter: SeenFilter | null): Promise<number>
```

Returns the total number of seen entries matching the filter (for pagination).

#### cmd.storeSeenCountries

`unstable` · since v0.4.0

```ts
cmd.storeSeenCountries(): Promise<string[]>
```

Return all distinct country codes in the seen history, sorted alphabetically.

#### cmd.storeSeenList

`unstable` · since v0.4.0

```ts
cmd.storeSeenList(
  limit: number,
  offset: number,
  filter: SeenFilter | null,
  thumbnails: boolean,
): Promise<SeenEntry[]>
```

Returns a page of seen entries, newest first, with optional filtering.

#### cmd.storeSeenMaps

`unstable` · since v0.4.0

```ts
cmd.storeSeenMaps(): Promise<SeenMapInfo[]>
```

Returns all distinct maps that have seen entries, with resolved display names.

#### cmd.storeSeenWrite

`unstable` · since v0.4.0

```ts
cmd.storeSeenWrite(entry: SeenWriteEntry): Promise<null>
```

Record a panorama visit. The history is capped; oldest entries are evicted when full.

#### cmd.storeSetDerived

`unstable` · since v0.12.0

```ts
cmd.storeSetDerived(edges: { [key in string]: string[] }): Promise<null>
```

Register field dependencies. Changing an input clears fields derived from it.

#### cmd.storeSetMapDefaults

`unstable` · since v0.11.4

```ts
cmd.storeSetMapDefaults(preferences: MapPreferences | null): Promise<null>
```

Set the preferences new maps start from; `null` restores the factory defaults. Maps
that already exist keep their own.

#### cmd.storeSetMarkerColor

`unstable` · since v0.7.1

```ts
cmd.storeSetMarkerColor(color: RGB): Promise<null>
```

Set the default marker color for new render updates.

#### cmd.storeStep

`unstable` · since v0.12.0

```ts
cmd.storeStep(
  stack: Stack,
  key: EntryKey | null,
): Promise<
  MutationResult<{
    /**  Monotonically increasing within a map. Zero until the store assigns one. */
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
    extra: { [key in string]: unknown } | null;
    /**  Unix timestamp (seconds) */
    createdAt: number;
    modifiedAt: number | null;
  }>
>
```

Undo the newest edit, or redo the newest undone one.

#### cmd.storeSubscribeChanges

`unstable` · since v0.12.0

```ts
cmd.storeSubscribeChanges(changes: Channel<ChangeEvent>): Promise<null>
```

Subscribe to map changes, including the ids of added, removed, and updated rows.

#### cmd.storeSubscribeFrames

`unstable` · since v0.11.5

```ts
cmd.storeSubscribeFrames(
  frames: Channel<ArrayBuffer>,
  req: RenderRequest,
): Promise<null>
```

Draw the open map's markers: `frames` receives the whole scene, then every change to it.

#### cmd.storeSummary

`unstable` · since v0.12.0

```ts
cmd.storeSummary(): Promise<Summary>
```

Return the open store's location count, version and dirty count.

#### cmd.storeTouchMapOpened

`unstable` · since v0.4.0

```ts
cmd.storeTouchMapOpened(mapId: string): Promise<null>
```

Mark a map as opened now, for sorting the map list by recency.

#### cmd.storeUpdateMapMeta

`unstable` · since v0.4.0

```ts
cmd.storeUpdateMapMeta(
  patch: Partial<
    Omit<
      MapMeta,
      | "locationCount"
      | "pending"
      | "createdAt"
      | "updatedAt"
      | "lastOpenedAt"
      | "settings"
    >
  > & {
    settings?: Partial<MapSettings>;
  } & Pick<MapMeta, "id">,
): Promise<
  MutationResult<{
    /**  Monotonically increasing within a map. Zero until the store assigns one. */
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
    extra: { [key in string]: unknown } | null;
    /**  Unix timestamp (seconds) */
    createdAt: number;
    modifiedAt: number | null;
  }>
>
```

Patch map metadata, leaving omitted fields unchanged.
Open maps save through their store; tag records are edited separately.
A closed map writes straight to disk and reaches no version.

#### cmd.storeUploadAbort

`unstable` · since v0.7.4

```ts
cmd.storeUploadAbort(sessionDir: string): Promise<null>
```

Remove an abandoned upload session dir (e.g. cancelled operation).

#### cmd.storeUploadBegin

`unstable` · since v0.7.4

```ts
cmd.storeUploadBegin(): Promise<string>
```

Create a temp session directory for binary uploads. Files written into it are
packaged by `storeUploadFinish`.

#### cmd.storeUploadFinish

`unstable` · since v0.7.4

```ts
cmd.storeUploadFinish(sessionDir: string): Promise<string>
```

Package an upload session's files into a single output and remove the session
directory. Returns a temp path for `storeSaveExportFile`.

#### cmd.storeWork

`unstable` · since v0.12.0

```ts
cmd.storeWork(
  selector: Selector$1<SelectionInput>,
  work: Work,
): Promise<WorkResult>
```

Run work over every location matched by selector.

#### cmd.syncLogAppend

`unstable` · since v0.11.4

```ts
cmd.syncLogAppend(
  provider: string,
  mapId: string,
  entry: SyncLogEntry,
): Promise<null>
```

Record a settled sync pass for a map. Only the most recent passes per provider are kept.

#### cmd.syncLogList

`unstable` · since v0.11.4

```ts
cmd.syncLogList(provider: string, mapId: string): Promise<SyncLogEntry[]>
```

A map's recorded sync passes with a provider, newest first.

#### cmd.syncReconcile

`unstable` · since v0.8.1

```ts
cmd.syncReconcile(
  provider: string,
  mapId: string,
  remoteMapId: string,
  firstSync: FirstSyncMode | null,
  resolutions: [string, ResolutionSide][] | null,
): Promise<SyncReconcileResult>
```

Reconcile a linked map against its remote, pushing local changes and pulling
remote ones. Returns the creates, updates, and deletes for each side to apply.

#### cmd.timezoneAt

`unstable` · since v0.10.6

```ts
cmd.timezoneAt(lat: number, lng: number): Promise<string | null>
```

IANA timezone at a coordinate, or `null` outside the valid range.

#### cmd.uninstallPlugin

`unstable` · since v0.5.0

```ts
cmd.uninstallPlugin(id: string): Promise<null>
```

Delete a plugin's directory.

#### cmd.updateCheck

`unstable` · since v0.10.0

```ts
cmd.updateCheck(endpoint: string): Promise<UpdateAvailable | null>
```

Check for an update at `endpoint` (a release's `latest.json`). Returns `null`
when the announced version is not newer than the running one.

#### cmd.updateInstall

`unstable` · since v0.10.0

```ts
cmd.updateInstall(): Promise<null>
```

Download and install whatever the last `updateCheck` found. The installer replaces the
running app, so nothing after this is guaranteed to run. Save state first.

#### cmd.valiCancel

`unstable` · since v0.7.1

```ts
cmd.valiCancel(): Promise<void>
```

Cancel an in-flight vali generate or download.

#### cmd.valiCountries

`unstable` · since v0.9.0

```ts
cmd.valiCountries(): Promise<string[]>
```

Country codes Vali has coverage data for.

#### cmd.valiDataStatus

`unstable` · since v0.9.0

```ts
cmd.valiDataStatus(): Promise<ValiCountryStatus[]>
```

Countries whose downloaded coverage data is older than the published copy. Fails while
offline; treat that as unknown, not up to date.

#### cmd.valiDownload

`unstable` · since v0.7.0

```ts
cmd.valiDownload(
  country: string | null,
  full: boolean,
  updates: boolean,
): Promise<null>
```

Download Vali coverage data. `country` = code/continent alias/None for all.

#### cmd.valiDownloadStale

`unstable` · since v0.9.0

```ts
cmd.valiDownloadStale(): Promise<null>
```

Download exactly the countries `valiDataStatus` reports as out of date. No-op when nothing
is stale, so the caller can fire it without checking first.

#### cmd.valiGenerate

`unstable` · since v0.7.0

```ts
cmd.valiGenerate(definition: string): Promise<ValiLocation[]>
```

Generate locations from a Vali map definition (JSON text). Missing country
data is auto-downloaded like the Vali CLI. Returns the generated locations.

#### cmd.valiSubdivisions

`unstable` · since v0.7.0

```ts
cmd.valiSubdivisions(country: string): Promise<string>
```

Subdivision weights for a country (JSON text, same shape as `vali subdivisions`).

#### cmd.writeTempFile

`unstable` · since v0.4.0

```ts
cmd.writeTempFile(name: string, content: string): Promise<string>
```

Write text to a temp file and return its path. `name` is a leaf filename
(cannot contain path separators).

## Tauri

Raw command, shell, and file dialog access.

### dialog

`unstable` · since v0.3.1

#### dialog.open

`unstable` · since v0.3.1

```ts
dialog.open<T extends OpenDialogOptions>(
  options?: T,
): Promise<OpenDialogReturn<T>>
```

Open a file/directory selection dialog.

The selected paths are added to the filesystem and asset protocol scopes.
When security is more important than the easy of use of this API,
prefer writing a dedicated command instead.

Note that the scope change is not persisted, so the values are cleared when the application is restarted.
You can save it to the filesystem using [tauri-plugin-persisted-scope](https://github.com/tauri-apps/tauri-plugin-persisted-scope).

#### dialog.save

`unstable` · since v0.3.1

```ts
dialog.save(options?: SaveDialogOptions): Promise<string | null>
```

Open a file/directory save dialog.

The selected path is added to the filesystem and asset protocol scopes.
When security is more important than the easy of use of this API,
prefer writing a dedicated command instead.

Note that the scope change is not persisted, so the values are cleared when the application is restarted.
You can save it to the filesystem using [tauri-plugin-persisted-scope](https://github.com/tauri-apps/tauri-plugin-persisted-scope).

### invoke

`unstable` · since v0.3.1

```ts
invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T>
```

Sends a message to the backend.

### shell

`unstable` · since v0.3.1

```ts
shell: { Command: typeof Command }
```

Low-level command, shell, and file dialog access.

## PluginHost

Enabling plugins and their activation lifecycle.

### activatePlugin

`unstable` · since v0.10.3

```ts
activatePlugin(id: string): void
```

Activate a single plugin by id.

### activatePlugins

`unstable` · since v0.10.3

```ts
activatePlugins(): void
```

Activate all enabled plugins. Called when a map opens.

### deactivatePlugin

`unstable` · since v0.10.3

```ts
deactivatePlugin(id: string): void
```

Deactivate a single plugin and stop its sidecar.

### deactivatePlugins

`unstable` · since v0.10.3

```ts
deactivatePlugins(): void
```

Deactivate all plugins and stop their sidecars. Called when a map closes.

### getEnabledPlugins

`unstable` · since v0.10.3

```ts
getEnabledPlugins(): Plugin[]
```

All registered plugins the user has enabled.

### isPluginEnabled

`unstable` · since v0.10.3

```ts
isPluginEnabled(id: string): boolean
```

True when the plugin is enabled by the user.

### isReady

`unstable` · since v0.10.3

```ts
isReady(): boolean
```

True once the MMA surface is installed and plugins are safe to call it.

### markReady

`unstable` · since v0.10.3

```ts
markReady(): void
```

Mark the plugin surface as ready.

### setPluginEnabled

`unstable` · since v0.10.3

```ts
setPluginEnabled(id: string, enabled: boolean): void
```

Enable or disable a plugin.

## Marketplace

The plugin marketplace and its update checks.

### autoUpdatePlugin

`unstable` · since v0.10.3

```ts
autoUpdatePlugin(
  m: PluginManifest,
  latest: PluginManifest | undefined,
  appVersion: string,
): Promise<PluginManifest>
```

Auto-update a plugin to the newest compatible build before loading it. Falls back
to what is on disk on failure.

### fetchPluginRegistry

`unstable` · since v0.10.3

```ts
fetchPluginRegistry(): Promise<PluginManifest[]>
```

Fetch the marketplace plugin registry. Later calls return the first result until restart.

### isPluginCompatible

`unstable` · since v0.10.3

```ts
isPluginCompatible(
  minAppVersion: string | null | undefined,
  appVersion: string,
): boolean
```

True when `appVersion` meets the plugin's minimum version requirement.

### isPluginUpdatable

`unstable` · since v0.10.3

```ts
isPluginUpdatable(
  installedVersion: string | undefined,
  latestVersion: string | undefined,
): boolean
```

True when a newer version is published and the installed version is known.

### needsBuildUpdate

`unstable` · since v0.10.3

```ts
needsBuildUpdate(
  installedVersion: string | undefined,
  target: ResolvedBuild,
  installedSidecarVersion: string | null | undefined,
): boolean
```

True when the installed plugin or its sidecar should be refreshed to `target`.

### needsUpdate

`unstable` · since v0.10.3

```ts
needsUpdate(
  installedVersion: string | undefined,
  latestVersion: string | undefined,
  installedSidecarVersion: string | null | undefined,
  latestSidecarVersion: string | undefined,
): boolean
```

True when either the plugin or its sidecar has a newer published version.

### resolveBuild

`unstable` · since v0.10.3

```ts
resolveBuild(
  entry: PluginManifest,
  appVersion: string,
): ResolvedBuild | null
```

The newest build of a plugin this app version can run. Falls back through older
pinned builds when the latest is incompatible. Null when none fit.

## Scope

Which plugin owns a registration, and its teardown.

### disposePlugin

`unstable` · since v0.10.3

```ts
disposePlugin(id: string): void
```

Run all teardowns a plugin registered (in reverse order) and clear them.

### resolvePluginPath

`unstable` · since v0.10.3

```ts
resolvePluginPath(path: string): string
```

Resolve a relative path against the current plugin's base directory. Absolute
paths and `res://` URLs pass through unchanged.

### runAsPlugin

`unstable` · since v0.10.3

```ts
runAsPlugin<T>(id: string, fn: () => T): T
```

Run `fn` as plugin `id`. Registrations made during `fn` are tracked for teardown.

### setPluginBaseDir

`unstable` · since v0.10.3

```ts
setPluginBaseDir(id: string, dir: string): void
```

Set the base directory for a plugin's assets on disk.

### trackDisposable

`unstable` · since v0.10.3

```ts
trackDisposable(dispose: Disposable): void
```

Enroll a teardown callback under the current plugin. No-op outside activation.

## FieldProjections

The keys a field can be grouped by.

### partitionKeyOptions

`unstable` · since v0.10.3

```ts
partitionKeyOptions(
  type: FieldType,
  rangeForDates: boolean,
): {
  id: string;
  label: string;
}[]
```

Partition-key dropdown options for a field type.

### projectionsForType

`unstable` · since v0.10.3

```ts
projectionsForType(type: FieldType): FieldProjection[]
```

Projections valid for a field type, in display order (first = dialog default).

### RANGE_ID

`unstable` · since v0.10.3

```ts
RANGE_ID: "range"
```

The "Range" partition option (numeric binning).

## Procedures

Running procedures directly, outside a registered provider.

### noWork

`unstable` · since v0.10.3

```ts
noWork(): BatchOutcome
```

### procedureEntry

`unstable` · since v0.10.3

```ts
procedureEntry(name: string): string
```

Entry point of a procedure this app bundles. Plugins ship their own paths.

### procedureName

`unstable` · since v0.11.0

```ts
procedureName(entry: string): string
```

The readable name behind an entry point, for surfaces that show one.

### queryProcedure

`unstable` · since v0.10.3

```ts
queryProcedure<T = unknown, P = unknown>(
  spec: ProcedureSpec,
  input: unknown,
  signal?: AbortSignal,
  onPartial?: (
    entries: {
      id: number;
      value: P;
    }[],
  ) => void,
): Promise<T>
```

Ask a procedure a read-only question under its declared network limits. Rejects when it
exports no `query`, when the call fails, or when `signal` aborts. `onPartial` receives
pages of answers as they resolve, ahead of the full result; each entry carries the id
the emitting side chose for it.

### resolveFieldLabels

`unstable` · since v0.10.3

```ts
resolveFieldLabels(
  field: string,
  keys: string[],
  key?: KeySpec,
): Promise<string[]>
```

Display labels for a field's partition keys. Month-of-year keys are numeric tokens and
become locale month names; otherwise falls back to the keys themselves when the field's
procedure has no `label` query or returns a non-matching array.

### runProcedure

`unstable` · since v0.10.3

```ts
runProcedure<T, C>(
  spec: ProcedureSpec<T, C>,
  selector: Selector,
  opts: Omit<RunOpts, "force"> &
    Omit<DeclOpts, "fields" | "requires" | "config"> & {
      id: string;
      config?: Partial<NoInfer<C>>;
    },
): Promise<ProcedureOutcome<T>>
```

Run a single procedure over `selector` and return its typed results.

### runProviders

`unstable` · since v0.10.3

```ts
runProviders<C extends readonly unknown[]>(
  items: {
    [K in keyof C]: ProviderRun<C[K]>;
  },
  selector: Selector,
  opts?: RunOpts,
): Promise<ProviderOutcomes>
```

Run a set of providers over the locations `selector` matches and write their results back.
Resolves once every provider finishes, or on abort.

## Enrich

Enrichment passes over the open map.

### enrich

`unstable` · since v0.10.3

```ts
enrich(
  selector: Selector,
  props?: RunOpts & {
    resolve?: boolean;
  },
): Promise<ProviderOutcomes>
```

## Providers

The providers the app registers for enrichment.

### enrichRuns

`unstable` · since v0.10.3

```ts
enrichRuns(
  enrichFields: string[] | null,
  exclude?: string[],
): ProviderRun[]
```

Build the provider run list for enrichment, narrowed to `enrichFields`. Fields not
offered in the enrichment settings are always included.

### exactDateProvider

`unstable` · since v0.10.3

```ts
exactDateProvider: {
  id: string;
  /** Name shown in enrichment progress and results. */
  label: string;
  /** The procedure that computes this provider's fields. */
  procedure: ProcedureSpec<unknown, unknown>;
  /** Extra-field keys this provider produces. Each is offered as an enrichment option. */
  fieldDefs: Record<string, FieldDef> | undefined;
  /** Leaves this provider's fields out of the default enrichment set, so users opt in. */
  defaultOff: boolean | undefined;
  /** Core columns this provider writes (e.g. `panoId`). */
  provides: string[] | undefined;
  /** Fields this provider reads; it runs after their producers finish. */
  requires: string[] | undefined;
}
```

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

### panoResolveProvider

`unstable` · since v0.10.3

```ts
panoResolveProvider: {
  id: string;
  /** Name shown in enrichment progress and results. */
  label: string;
  /** The procedure that computes this provider's fields. */
  procedure: ProcedureSpec<{ panoId: string }, PanoResolveConfig>;
  /** Extra-field keys this provider produces. Each is offered as an enrichment option. */
  fieldDefs: Record<string, FieldDef> | undefined;
  /** Leaves this provider's fields out of the default enrichment set, so users opt in. */
  defaultOff: boolean | undefined;
  /** Core columns this provider writes (e.g. `panoId`). */
  provides: string[] | undefined;
  /** Fields this provider reads; it runs after their producers finish. */
  requires: string[] | undefined;
}
```

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

### subdivisionProvider

`unstable` · since v0.10.3

```ts
subdivisionProvider: {
  id: string;
  /** Name shown in enrichment progress and results. */
  label: string;
  /** The procedure that computes this provider's fields. */
  procedure: ProcedureSpec<unknown, unknown>;
  /** Extra-field keys this provider produces. Each is offered as an enrichment option. */
  fieldDefs: Record<string, FieldDef> | undefined;
  /** Leaves this provider's fields out of the default enrichment set, so users opt in. */
  defaultOff: boolean | undefined;
  /** Core columns this provider writes (e.g. `panoId`). */
  provides: string[] | undefined;
  /** Fields this provider reads; it runs after their producers finish. */
  requires: string[] | undefined;
}
```

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

### svMetaProvider

`unstable` · since v0.10.3

```ts
svMetaProvider: {
  id: string;
  /** Name shown in enrichment progress and results. */
  label: string;
  /** The procedure that computes this provider's fields. */
  procedure: ProcedureSpec<unknown, unknown>;
  /** Extra-field keys this provider produces. Each is offered as an enrichment option. */
  fieldDefs: Record<string, FieldDef> | undefined;
  /** Leaves this provider's fields out of the default enrichment set, so users opt in. */
  defaultOff: boolean | undefined;
  /** Core columns this provider writes (e.g. `panoId`). */
  provides: string[] | undefined;
  /** Fields this provider reads; it runs after their producers finish. */
  requires: string[] | undefined;
}
```

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

### timezoneProvider

`unstable` · since v0.10.3

```ts
timezoneProvider: {
  id: string;
  /** Name shown in enrichment progress and results. */
  label: string;
  /** The procedure that computes this provider's fields. */
  procedure: ProcedureSpec<unknown, unknown>;
  /** Extra-field keys this provider produces. Each is offered as an enrichment option. */
  fieldDefs: Record<string, FieldDef> | undefined;
  /** Leaves this provider's fields out of the default enrichment set, so users opt in. */
  defaultOff: boolean | undefined;
  /** Core columns this provider writes (e.g. `panoId`). */
  provides: string[] | undefined;
  /** Fields this provider reads; it runs after their producers finish. */
  requires: string[] | undefined;
}
```

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

## PinPano

Bulk pinning locations to their panoramas.

### bulkPinToPano

`unstable` · since v0.4.0

```ts
bulkPinToPano(selector: Selector, opts?: PinOpts): Promise<PinOutcome>
```

Pin every location in the selector to its pano id, resolving pano ids first when asked.

## Validate

Coverage validation passes.

### validateLocations

`unstable` · since v0.4.0

```ts
validateLocations(
  selector: Selector,
  opts?: BulkOpts & {
    config?: Partial<ValidateConfig>;
    categories?: readonly string[];
  },
): Promise<ValidationOutcome>
```

Check that each location's Street View coverage still exists, grouping the locations
into `categories` (keys of `VALIDATION_CATEGORIES`; the standard ones when omitted).

## ValidationCategories

The validation categories users pick from, over the flags a check answers.

### STANDARD_VALIDATION_CATEGORIES

`unstable` · since v0.11.4

```ts
STANDARD_VALIDATION_CATEGORIES: string[]
```

### VALIDATION_CATEGORIES

`unstable` · since v0.11.4

```ts
VALIDATION_CATEGORIES: readonly ValidationCategory[]
```

### validationCategory

`unstable` · since v0.11.4

```ts
validationCategory(key: string): ValidationCategory | null
```

The category a key names, or null for one this version does not know.

## ScenePositions

Screen positions of the rendered markers.

### getScenePositions

`unstable` · since v0.9.0

```ts
getScenePositions(): {
  ids: Uint32Array;
  positions: Float32Array;
}
```

Snapshot of every rendered location's id and position (`[lng, lat, ...]`).

## Color

Color conversion helpers.

### applyAccentColor

`unstable` · since v0.10.3

```ts
applyAccentColor(hex: string): void
```

Set the app's `--accent` and `--on-accent` CSS custom properties from a hex color.

### colorForName

`unstable` · since v0.10.3

```ts
colorForName(name: string): string
```

Deterministic tag color from a name.

### hexToHsl

`unstable` · since v0.10.3

```ts
hexToHsl(hex: string): HSL
```

Convert "#rrggbb" to HSL.

### hexToRgb

`unstable` · since v0.10.3

```ts
hexToRgb(hex: string): RGB
```

Parse "#rrggbb" or "#rgb" to an [r, g, b] byte tuple; black when it is not hex.

### hslToHex

`unstable` · since v0.10.3

```ts
hslToHex(props: HSL): string
```

Convert HSL to "#rrggbb".

### hslToRgb

`unstable` · since v0.10.3

```ts
hslToRgb(h: number, s: number, l: number): RGB
```

Convert HSL (h in degrees, s and l in 0-1) to an RGB byte tuple.

### labelColor

`unstable` · since v0.10.3

```ts
labelColor(name: string, overrides: Record<string, string>): string
```

A label's color: a user override if set, else a deterministic color from its name.

### resolveSvColorHex

`unstable` · since v0.10.3

```ts
resolveSvColorHex(color: string): string
```

Resolve an SV coverage color to hex. Accepts "#rrggbb" or a CSS custom-property
ramp name (legacy stored format).

### rgbCss

`unstable` · since v0.10.3

```ts
rgbCss(props: RGB): string
```

Format an RGB tuple as a CSS `rgb(r, g, b)` string.

### rgbToHex

`unstable` · since v0.10.3

```ts
rgbToHex(rgb: RGB): string
```

Convert an RGB byte tuple to "#rrggbb".

### textColorFor

`unstable` · since v0.10.3

```ts
textColorFor(bg: string): string
```

Return "#000" or "#fff" for readable text on the given hex background.

## Jobs

The global job tray.

### cancelJobs

`unstable` · since v0.10.7

```ts
cancelJobs(scope: JobScope): void
```

Cancel every live job of `scope` that can be cancelled. Owners observe their own
abort and end their jobs; entries without a cancel are removed outright.

### confirmMapExit

`unstable` · since v0.10.7

```ts
confirmMapExit(kind: MapExitKind): Promise<boolean>
```

Gate a user action that would end every map-scoped job. Resolves true immediately when
none are live; otherwise raises the confirm dialog, and true means the jobs were
cancelled and the action should proceed.

### getExitRequest

`unstable` · since v0.10.7

```ts
getExitRequest(): {
  kind: MapExitKind;
} | null
```

The pending map-exit confirmation, for the dialog.

### getJobs

`unstable` · since v0.10.7

```ts
getJobs(): JobEntry[]
```

Live jobs, for the tray. Reference changes on every update.

### registerJob

`unstable` · since v0.10.7

```ts
registerJob(label: string, opts?: JobOpts): JobHandle
```

Register a long-running operation with the global job tray. The caller owns the
work; the registry owns only its presentation and the cancel/reveal controls.

### resolveMapExit

`unstable` · since v0.10.7

```ts
resolveMapExit(ok: boolean): void
```

Answer the pending map-exit confirmation.

### runJob

`unstable` · since v0.10.7

```ts
runJob<R>(
  label: string,
  fn: (ctx: JobRunContext) => Promise<R>,
  opts?: Omit<JobOpts, "cancel">,
): Promise<R | null>
```

Sugar for promise-shaped work: registers a job wired to an AbortController, reports
through the handle, and ends the job however `fn` settles. Cancelling resolves null;
a real failure toasts and rethrows.

## Test

### _test

`unstable` · since v0.6.1

The nested `_test` namespace on the plugin surface.

#### _test.closeMap

`unstable` · since v0.6.1

```ts
_test.closeMap(): Promise<void>
```

Close the current map and return to the map list.

#### _test.deleteMap

`unstable` · since v0.6.1

```ts
_test.deleteMap(id: string): Promise<void>
```

Delete a map by id.

#### _test.importFile

`unstable` · since v0.6.1

```ts
_test.importFile(
  droppedFields: string[],
  tagNames?: string[],
): Promise<EditorImportResult>
```

Import a previewed file, optionally assigning tags.

#### _test.importPaste

`unstable` · since v0.6.1

```ts
_test.importPaste(text: string): Promise<EditorImportResult[]>
```

Import locations from pasted text and commit them to the map.

#### _test.mapOpen

`unstable` · since v0.11.0

```ts
_test.mapOpen: {
  start: number;
  seen: Set<string>;
  begin(): void;
  mark(phase: string): void;
}
```

Cross-module stopwatch for map-open latency.

#### _test.openMap

`unstable` · since v0.6.1

```ts
_test.openMap(id: string): Promise<void>
```

Open a map by id and navigate to it.

#### _test.procedureEntry

`unstable` · since v0.10.0

```ts
_test.procedureEntry(name: string): string
```

Entry point of a procedure this app bundles. Plugins ship their own paths.

#### _test.runProcedure

`unstable` · since v0.10.0

```ts
_test.runProcedure<T, C>(
  spec: ProcedureSpec<T, C>,
  selector: Selector,
  opts: Omit<RunOpts, "force"> &
    Omit<DeclOpts, "fields" | "requires" | "config"> & {
      id: string;
      config?: Partial<NoInfer<C>>;
    },
): Promise<ProcedureOutcome<T>>
```

Run a single procedure over `selector` and return its typed results.

#### _test.syncSelections

`unstable` · since v0.8.2

```ts
_test.syncSelections(): Promise<{
  ids: number[];
}>
```

Force a full selection re-resolve and return the selected IDs.

## Util

General-purpose helpers.

### bestBy

`unstable` · since v0.10.3

```ts
bestBy<T>(
  items: Iterable<T>,
  isBetter: (a: T, b: T) => boolean,
): T | null
```

The item `isBetter` prefers over every other, or null when there are none.

### chunk

`unstable` · since v0.10.3

```ts
chunk<T>(arr: readonly T[], n: number): T[][]
```

Split `arr` into sub-arrays of at most `n` elements.

### cmpVersion

`unstable` · since v0.10.3

```ts
cmpVersion(a: string, b: string): number
```

Compare two semver strings (e.g. "0.6.1", "0.7.0-rc.2"). Returns >0 if a > b.
Build metadata is ignored; a pre-release sorts below the release it precedes.

### compareNatural

`unstable` · since v0.10.3

```ts
compareNatural(a: string, b: string): number
```

Compare strings with natural (numeric-aware) ordering.

### copyImageToClipboard

`unstable` · since v0.10.3

```ts
copyImageToClipboard(blob: Blob): Promise<boolean>
```

Copy an image Blob to the clipboard. False when the platform refuses it.

### downloadBlob

`unstable` · since v0.10.3

```ts
downloadBlob(blob: Blob, fileName: string): void
```

Trigger a browser download from an in-memory Blob.

### isPrereleaseVersion

`unstable` · since v0.10.3

```ts
isPrereleaseVersion(v: string): boolean
```

True when `v` carries a semver pre-release tag, e.g. "1.0.0-beta.1".

### isWeb

`unstable` · since v0.10.3

```ts
isWeb(): boolean
```

True when the app runs in a browser instead of the desktop app.

### mmaBufUrl

`unstable` · since v0.5.0

```ts
mmaBufUrl(path: string): string
```

URL that serves a local file over the `mma-buf://` protocol.

### nowUnix

`unstable` · since v0.10.3

```ts
nowUnix(): number
```

Current time as Unix seconds, the form Location timestamps use.

### phaseRate

`unstable` · since v0.10.4

```ts
phaseRate(
  prev: PhaseRate | null,
  done: number,
  total: number,
  now: number,
): {
  state: PhaseRate;
  rate: number | null;
}
```

Compute a locations/second rate for the current progress phase. Re-anchors when a
new phase is detected (done went backward or total grew). Null until a quarter second
of work has elapsed.

### pickFiles

`unstable` · since v0.11.4

```ts
pickFiles(
  accept: string,
  opts?: {
    multiple?: boolean;
  },
): Promise<File[]>
```

Prompt for files; resolves empty when the picker is dismissed.

### schemeBase

`unstable` · since v0.10.3

```ts
schemeBase(scheme: string): string
```

Base URL for a custom URI scheme, platform-adjusted.

### shuffle

`unstable` · since v0.11.0

```ts
shuffle<T>(items: T[]): T[]
```

Shuffle `items` in place (Fisher-Yates) and return them.

### splitVersion

`unstable` · since v0.10.3

```ts
splitVersion(v: string): [core: string, pre: string]
```

`["0.7.0", "rc.2"]` for `"v0.7.0-rc.2+build"`; the pre-release part is `""` when absent.

### toggleInSet

`unstable` · since v0.10.3

```ts
toggleInSet<T>(set: ReadonlySet<T>, value: T, on?: boolean): Set<T>
```

Copy of `set` with `value` toggled, or forced on/off by `on`.

## SelectionList

### SelectionList

`unstable` · unreleased

Change the listed selections and inspect their active members.

#### SelectionList.active

`unstable` · unreleased

```ts
SelectionList.active(): Selection[]
```

Listed selections that are not ghosted.

#### SelectionList.redo

`unstable` · unreleased

```ts
SelectionList.redo(): Promise<void>
```

Redo the last undone selection change without redoing data edits.

#### SelectionList.select

`unstable` · unreleased

```ts
SelectionList.select<
  R extends
    | number[]
    | {
        ids: number[];
      },
>(
  pick: (selector: Selector) => Promise<R>,
  perSelection?: boolean,
): Promise<{
  picked: number;
  results: R[];
}>
```

#### SelectionList.tagIds

`unstable` · unreleased

```ts
SelectionList.tagIds(): ReadonlySet<number>
```

Tag ids with a top-level listed tag selection, including ghosted selections.

#### SelectionList.tagIdsDeep

`unstable` · unreleased

```ts
SelectionList.tagIdsDeep(): readonly number[]
```

Tag ids from active selection leaves, including repeated ids and composite children.

#### SelectionList.undo

`unstable` · unreleased

```ts
SelectionList.undo(): Promise<void>
```

Undo the last selection change without undoing data edits.

#### SelectionList.update

`unstable` · unreleased

```ts
SelectionList.update(op: SelectionOp): Promise<void>
```

Update and resolve the listed selections. Use `onActive` to affect only active selections.

## CommitDiff

### CommitDiff

`unstable` · unreleased

Uncommitted changes and their preview on the map.

#### CommitDiff.begin

`unstable` · unreleased

```ts
CommitDiff.begin(commit: CommitInfo): Promise<void>
```

Fetch a commit's change and overlay its added/removed/updated locations on the map,
temporarily replacing the regular markers.

#### CommitDiff.end

`unstable` · unreleased

```ts
CommitDiff.end(): void
```

Leave commit-diff preview and restore the regular markers.

#### CommitDiff.has

`unstable` · unreleased

```ts
CommitDiff.has(): boolean
```

Whether there are uncommitted changes (adds, removes, or updates).

#### CommitDiff.positions

`unstable` · unreleased

```ts
CommitDiff.positions(locs: LatLng[]): Float32Array
```

Pack `[lng, lat]` pairs into an interleaved Float32Array.

#### CommitDiff.preview

`unstable` · unreleased

```ts
CommitDiff.preview(): CommitDiffPreview | null
```

The current commit-diff preview, or null when not previewing.

#### CommitDiff.reset

`unstable` · unreleased

```ts
CommitDiff.reset(): void
```

Clear commit-diff preview state.

#### CommitDiff.resetCounts

`unstable` · unreleased

```ts
CommitDiff.resetCounts(): void
```

Reset the uncommitted-change counts to zero.

#### CommitDiff.use

`unstable` · unreleased

```ts
CommitDiff.use(): Counts
```

React hook: the uncommitted add/remove/modify counts, kept in sync with the store.

## Import

### Import

`unstable` · unreleased

Stage, preview, and confirm an import into the open map.

#### Import.cancel

`unstable` · unreleased

```ts
Import.cancel(): void
```

Discard the staged import without committing.

#### Import.confirm

`unstable` · unreleased

```ts
Import.confirm(
  droppedFields: string[],
  tagNames?: string[],
): Promise<EditorImportResult | null>
```

Commit the staged import, optionally dropping fields and applying bulk tags.

#### Import.fromPath

`unstable` · unreleased

```ts
Import.fromPath(path: string): Promise<void>
```

Import from a file path.

#### Import.paste

`unstable` · unreleased

```ts
Import.paste(text: string): Promise<void>
```

Stage pasted text for preview. Throws if no locations are found.

#### Import.previewPositions

`unstable` · unreleased

```ts
Import.previewPositions(): Float32Array<ArrayBufferLike>
```

The preview marker positions for the staged import.

#### Import.reset

`unstable` · unreleased

```ts
Import.reset(): void
```

Discard the staged import and its pending layer.

#### Import.staging

`unstable` · unreleased

```ts
Import.staging(): ImportStaging | null
```

The current staged import, or null if none.

#### Import.target

`unstable` · unreleased

```ts
Import.target(): Target
```

The pending layer holding this window's staged import locations.

## SavedSelection

### SavedSelection

`unstable` · unreleased

Saved selection rules.

#### SavedSelection.apply

`unstable` · unreleased

```ts
SavedSelection.apply(saved: SavedSelection): number
```

Adds the rule's parts to the sidebar, resolved against the open map. Returns how many
were added.

#### SavedSelection.index

`unstable` · unreleased

```ts
SavedSelection.index(): SavedSelectionInfo[]
```

The rules that exist, as identity only. Empty until the index loads: the first
call starts the read and `saved-selections:changed` announces it.

#### SavedSelection.isSaveable

`unstable` · unreleased

```ts
SavedSelection.isSaveable(selector: Selector): boolean
```

Whether the selector tree contains only portable types (no map-local leaves).

#### SavedSelection.load

`unstable` · unreleased

```ts
SavedSelection.load(ids: string[]): Promise<SavedSelection[]>
```

Load the full rule bodies for the given `ids`.

#### SavedSelection.loadAll

`unstable` · unreleased

```ts
SavedSelection.loadAll(): Promise<SavedSelection[]>
```

Every rule with its body.

#### SavedSelection.MAP_LOCAL_TYPES

`unstable` · unreleased

```ts
SavedSelection.MAP_LOCAL_TYPES: readonly [
  "Locations",
  "Manual",
  "Validation",
  "Reviewed",
  "Selected",
]
```

Selection types that cannot be saved as rules because they are bound to the open map.

#### SavedSelection.parts

`unstable` · unreleased

```ts
SavedSelection.parts(saved: SavedSelection): SavedPart[]
```

A rule's parts: its top-level `Union` is the list it was saved from, anything else is
a single part.

#### SavedSelection.remove

`unstable` · unreleased

```ts
SavedSelection.remove(id: string): Promise<void>
```

Permanently delete a saved selection rule.

#### SavedSelection.save

`unstable` · unreleased

```ts
SavedSelection.save(name: string, selections: Selection[]): Promise<boolean>
```

Persists the saveable selections as one rule. False when none of them are saveable.

## Scene

### Scene

`unstable` · unreleased

The marker scene the map surfaces render from, and its load lifecycle.

#### Scene.clear

`unstable` · unreleased

```ts
Scene.clear(): void
```

Clear all marker data from the scene and stop following the map.

#### Scene.defaultColor

`unstable` · unreleased

```ts
Scene.defaultColor(): RGBA
```

Current default marker color as RGBA.

#### Scene.get

`unstable` · unreleased

```ts
Scene.get(): CellManager
```

The shared scene that all map surfaces render from.

#### Scene.load

`unstable` · unreleased

```ts
Scene.load(markerStyle?: MarkerStyle, mc?: RGB): Promise<void>
```

Load the whole scene again and follow every change to it from there.

#### Scene.reached

`unstable` · unreleased

```ts
Scene.reached(version: number): Promise<FrameSummary>
```

Resolves once the scene has applied the frame for map version `version`, with what that
frame did. Resolves at once, with nothing applied, when the scene follows no map.

#### Scene.recolor

`unstable` · unreleased

```ts
Scene.recolor(mc: RGB): void
```

Change the default marker color and repaint.

#### Scene.setDefaultColor

`unstable` · unreleased

```ts
Scene.setDefaultColor(r: number, g: number, b: number): void
```

Set the default marker color (RGB bytes).

#### Scene.settled

`unstable` · unreleased

```ts
Scene.settled(): Promise<void>
```

Resolves when the most recently started full scene load has finished (or immediately if none is in flight).

#### Scene.start

`unstable` · unreleased

```ts
Scene.start(): () => void
```

Start following open-location changes. Returns a stop function.

## MapHost

### MapHost

`unstable` · unreleased

The embedded map host, its preferences, and click interceptors.

#### MapHost.addClickInterceptor

`unstable` · unreleased

```ts
MapHost.addClickInterceptor(fn: ClickInterceptor): () => void
```

Register a map-click interceptor. Returns a removal function. The most recently
added interceptor that returns true consumes the click.

#### MapHost.create

`unstable` · unreleased

```ts
MapHost.create(
  kind: MapHostKind,
  container: HTMLElement,
  prefs: MapEmbedPrefs,
  opts: CreateHostOpts,
): Promise<MapHost>
```

#### MapHost.fitToBounds

`unstable` · unreleased

```ts
MapHost.fitToBounds(
  bounds: Bounds | null,
  padding?: number,
  minExtent?: number,
): void
```

Fit the editor map's viewport to `bounds`. A `minExtent` prevents over-zoom on tiny areas.

#### MapHost.get

`unstable` · unreleased

```ts
MapHost.get(): MapHost | null
```

Return the main editor map host, or null if not mounted.

#### MapHost.instance

`unstable` · unreleased

```ts
MapHost.instance<K extends MapHostKind>(
  host: MapHost | null,
  kind: K,
): HostInstances[K] | null
```

The raw engine instance if `host` is of the given kind, else null.

#### MapHost.kindForMapType

`unstable` · unreleased

```ts
MapHost.kindForMapType(mapType: MapTypeKey): MapHostKind
```

#### MapHost.set

`unstable` · unreleased

```ts
MapHost.set(host: MapHost | null): void
```

Set or clear the main editor map host.

#### MapHost.setDrawInterceptor

`unstable` · unreleased

```ts
MapHost.setDrawInterceptor(fn: DrawInterceptor | null): void
```

Set the callback for completed polygon draws. Null clears it.

#### MapHost.tryInterceptClick

`unstable` · unreleased

```ts
MapHost.tryInterceptClick(lat: number, lng: number, shiftKey?: boolean): boolean
```

Run registered click interceptors (newest first). True if one consumed the click.

#### MapHost.tryInterceptDraw

`unstable` · unreleased

```ts
MapHost.tryInterceptDraw(rings: number[][][]): boolean
```

Pass completed polygon rings to the draw interceptor. True if it consumed them.

#### MapHost.wait

`unstable` · unreleased

```ts
MapHost.wait(): Promise<MapHost>
```

Wait for the main editor map to be ready.

## Review

### Review

`unstable` · unreleased

Review sessions and their history.

#### Review.advance

`unstable` · unreleased

```ts
Review.advance(s: ReviewSession): {
  session: ReviewSession;
  done: boolean;
}
```

Mark the current cursor reviewed and step forward. `done` is true when the
session has no remaining items.

#### Review.begin

`unstable` · unreleased

```ts
Review.begin(ids: number[], source?: Selection): Promise<void>
```

Start or resume a review over `ids`. When `source` is a selection, re-reviewing
that selection resumes any in-progress session for it.

#### Review.beginSelected

`unstable` · unreleased

```ts
Review.beginSelected(): Promise<void>
```

Review the selected locations. With one active selection, the review belongs to it and
resumes with it.

#### Review.cancel

`unstable` · unreleased

```ts
Review.cancel(): void
```

Exit the review UI but keep the session resumable (persisted as active).

#### Review.deleteCurrent

`unstable` · unreleased

```ts
Review.deleteCurrent(): Promise<void>
```

Delete the current location and advance to the next one. Exits the pass if it
was the last item.

#### Review.ids

`unstable` · unreleased

```ts
Review.ids(s: ReviewSession, mode: ReviewMode): number[]
```

The session's locations in `mode`: those reviewed, or those still to review.

#### Review.index

`unstable` · unreleased

```ts
Review.index(s: ReviewSession): number
```

Position of the session cursor within its review order.

#### Review.isAtEnd

`unstable` · unreleased

```ts
Review.isAtEnd(s: ReviewSession): boolean
```

True when the cursor is on the session's last location.

#### Review.isAtStart

`unstable` · unreleased

```ts
Review.isAtStart(s: ReviewSession): boolean
```

True when the cursor is on the session's first location.

#### Review.isCurrentReviewed

`unstable` · unreleased

```ts
Review.isCurrentReviewed(s: ReviewSession): boolean
```

Current cursor location is in the reviewed set.

#### Review.next

`unstable` · unreleased

```ts
Review.next(): Promise<void>
```

Mark the current location reviewed and step to the next one.

#### Review.positionOf

`unstable` · unreleased

```ts
Review.positionOf(s: ReviewSession, id: number): number
```

Position of `id` in the session's worklist, or -1. O(1) per step.

#### Review.prev

`unstable` · unreleased

```ts
Review.prev(): Promise<void>
```

Step back to the previous location in the session.

#### Review.prune

`unstable` · unreleased

```ts
Review.prune(s: ReviewSession, removed: Set<number>): PruneResult
```

Remove `removed` ids from a session's worklist and reviewed set. Advances the
cursor when the cursor id itself was removed.

#### Review.removeSession

`unstable` · unreleased

```ts
Review.removeSession(id: string): Promise<void>
```

Delete a review session (its progress, not the locations).

#### Review.rename

`unstable` · unreleased

```ts
Review.rename(id: string, name: string): Promise<void>
```

Rename a review session.

#### Review.resume

`unstable` · unreleased

```ts
Review.resume(s: ReviewSession): Promise<void>
```

Resume a session picked from the resume modal.

#### Review.retreat

`unstable` · unreleased

```ts
Review.retreat(s: ReviewSession): ReviewSession | null
```

Step backward without marking anything reviewed. Null when already at the start.

#### Review.reviewedIds

`unstable` · unreleased

```ts
Review.reviewedIds(sessions: ReviewSession[]): number[]
```

Union of reviewed ids across sessions, de-duplicated.

#### Review.selector

`unstable` · unreleased

```ts
Review.selector(s: ReviewSession, mode: ReviewMode): Selector
```

The locations of review session `s` that are reviewed, or still to review.

#### Review.selectReviewed

`unstable` · unreleased

```ts
Review.selectReviewed(): Promise<void>
```

Select every location marked reviewed across all sessions on this map.

#### Review.session

`unstable` · unreleased

```ts
Review.session(): ReviewSession | null
```

The active review session, or null.

#### Review.sessions

`unstable` · unreleased

```ts
Review.sessions(status?: "active" | "done"): Promise<ReviewSession[]>
```

Review sessions for the open map, optionally filtered by status.

#### Review.useSession

`unstable` · unreleased

```ts
Review.useSession(): ReviewSession | null
```

Reactive active review session, or null.

## Seen

### Seen

`unstable` · unreleased

The seen-location history and how panorama visits are recorded into it.

#### Seen.clear

`unstable` · unreleased

```ts
Seen.clear(): Promise<void>
```

Delete the entire seen history. Not undoable.

#### Seen.count

`unstable` · unreleased

```ts
Seen.count(filter?: SeenFilter): Promise<number>
```

Number of seen entries matching the filter (all when omitted).

#### Seen.countries

`unstable` · unreleased

```ts
Seen.countries(): Promise<string[]>
```

Distinct country codes that appear in the seen history.

#### Seen.entries

`unstable` · unreleased

```ts
Seen.entries(
  limit?: number,
  offset?: number,
  filter?: SeenFilter,
  thumbnails?: boolean,
): Promise<SeenEntry[]>
```

Fetch a page of the seen (visited-panorama) history.

#### Seen.flush

`unstable` · unreleased

```ts
Seen.flush(viewer: PanoViewer): void
```

Write the pending seen entry to disk, if any.

#### Seen.loadPano

`unstable` · unreleased

```ts
Seen.loadPano(entry: SeenPano, viewer: PanoViewer): Promise<void>
```

Open a seen entry's panorama in the Street View viewer.

#### Seen.maps

`unstable` · unreleased

```ts
Seen.maps(): Promise<SeenMapInfo[]>
```

Maps that have seen-history entries.

#### Seen.panoChanged

`unstable` · unreleased

```ts
Seen.panoChanged(
  location: PendingEntryLocation,
  geo: GeoDisplay | null,
  viewer: PanoViewer,
): void
```

Record a panorama change for the seen history. Flushes the previous entry and stages the new one.

#### Seen.record

`unstable` · unreleased

```ts
Seen.record(
  location: PendingEntryLocation & LocationPOV,
  viewer: PanoViewer,
): Promise<void>
```

Record a pano visit now at its starting view, with a thumbnail if that view is still on screen once imagery arrives.

#### Seen.skipNext

`unstable` · unreleased

```ts
Seen.skipNext(panoId: string): void
```

Suppress the next seen-history entry for `panoId`.

#### Seen.updateGeo

`unstable` · unreleased

```ts
Seen.updateGeo(geo: GeoDisplay): void
```

Update the pending seen entry's geocode info (country, address).

## Pano

### Pano

`unstable` · unreleased

The shared panorama viewer.

#### Pano.canvas

`unstable` · unreleased

```ts
Pano.canvas(): HTMLCanvasElement | null
```

The live WebGL scene canvas, or null before the first render.

#### Pano.capture

`unstable` · unreleased

```ts
Pano.capture(): PanoCapture | null
```

The viewer read back into Location fields, or null until it has a position.

#### Pano.captureImage

`unstable` · unreleased

```ts
Pano.captureImage(width: number, height: number): HTMLCanvasElement | null
```

Cover-crop the live frame into an exact image, or null until real imagery renders.

#### Pano.captureView

`unstable` · unreleased

```ts
Pano.captureView(): LocationPOV
```

The camera in the stored zoom domain, zeroed without a viewer.

#### Pano.configure

`unstable` · unreleased

```ts
Pano.configure(options: google.maps.StreetViewPanoramaOptions): void
```

Apply display options to the viewer.

#### Pano.dispose

`unstable` · unreleased

```ts
Pano.dispose(): void
```

Release the viewer, its container and every listener; the instance is unusable afterwards.

#### Pano.exists

`unstable` · unreleased

```ts
Pano.exists(): boolean
```

Whether the viewer has been created.

#### Pano.faceRoad

`unstable` · unreleased

```ts
Pano.faceRoad(): void
```

Face the linked road nearest the camera heading.

#### Pano.hide

`unstable` · unreleased

```ts
Pano.hide(): void
```

Hide the viewer.

#### Pano.isLoaded

`unstable` · unreleased

```ts
Pano.isLoaded(): boolean
```

Whether the viewer has finished loading its current pano.

#### Pano.jump

`unstable` · unreleased

```ts
Pano.jump(to: PanoDestination, frame?: PanoFrame): void
```

Move to a pano id or position now, optionally setting the camera, overtaking pending requests.

#### Pano.jumpAhead

`unstable` · unreleased

```ts
Pano.jumpAhead(headingOffset: number): Promise<boolean>
```

Jump to the nearest official pano ahead of the camera, turned by `headingOffset` degrees.

#### Pano.links

`unstable` · unreleased

```ts
Pano.links(): google.maps.StreetViewLink[]
```

The current pano's navigable links.

#### Pano.look

`unstable` · unreleased

```ts
Pano.look(frame: PanoFrame): void
```

Point the camera now.

#### Pano.mount

`unstable` · unreleased

```ts
Pano.mount(target: HTMLElement): () => void
```

Parent the viewer into a container; the newest mount wins until released.

#### Pano.nudge

`unstable` · unreleased

```ts
Pano.nudge(dHeading: number, dPitch: number): void
```

Nudge heading and pitch by a delta, keeping pitch in range.

#### Pano.on

`unstable` · unreleased

```ts
Pano.on(event: PanoEvent, fn: () => void): () => void
```

Listen to a viewer event, across viewer rebuilds; returns an unsubscribe.

#### Pano.panoId

`unstable` · unreleased

```ts
Pano.panoId(): string | null
```

The current pano id, or null before one loads.

#### Pano.pointNorth

`unstable` · unreleased

```ts
Pano.pointNorth(): void
```

Face north level, or look straight down zoomed out when already facing north.

#### Pano.position

`unstable` · unreleased

```ts
Pano.position(): google.maps.LatLngLiteral | null
```

The current pano's position, or null before one loads.

#### Pano.pov

`unstable` · unreleased

```ts
Pano.pov(): CameraFrame
```

The camera heading and pitch.

#### Pano.preload

`unstable` · unreleased

```ts
Pano.preload(loc: Location): Promise<void>
```

Stage a location's pano while nothing newer is pending, so a later show is instant.

#### Pano.reload

`unstable` · unreleased

```ts
Pano.reload(fallback: google.maps.LatLngLiteral): void
```

Rebuild a stuck viewer in place, keeping its pano and camera.

#### Pano.reserveLook

`unstable` · unreleased

```ts
Pano.reserveLook(): (frame: PanoFrame) => boolean
```

Reserve a camera move across an async wait; it lands only if nothing moved the pano since.

#### Pano.resetZoom

`unstable` · unreleased

```ts
Pano.resetZoom(): void
```

Zoom fully out.

#### Pano.show

`unstable` · unreleased

```ts
Pano.show(
  loc: Location,
  props?: {
    concealUntilReady?: boolean;
  },
): Promise<ShowResult>
```

Resolve and show a location's pano, optionally hidden until it loads; "superseded" when overtaken.

#### Pano.showCrosshair

`unstable` · unreleased

```ts
Pano.showCrosshair(): () => void
```

Draw the crosshair over the viewer; returns a remove.

#### Pano.snapshot

`unstable` · unreleased

```ts
Pano.snapshot(): PanoView
```

Freeze the live camera for an offscreen render; throws until a pano is ready.

#### Pano.step

`unstable` · unreleased

```ts
Pano.step(direction: "forward" | "backward"): boolean
```

Step to the linked pano nearest the camera heading, or its reverse.

#### Pano.toast

`unstable` · unreleased

```ts
Pano.toast(message: string, durationMs: number): void
```

Show a toast anchored over the viewer.

#### Pano.turnAround

`unstable` · unreleased

```ts
Pano.turnAround(): void
```

Turn to face the opposite direction.

#### Pano.turnTo

`unstable` · unreleased

```ts
Pano.turnTo(target: CameraFrame): void
```

Animate the camera to a frame, replacing any turn in progress.

#### Pano.turnToNextLink

`unstable` · unreleased

```ts
Pano.turnToNextLink(): void
```

Turn to the next linked road clockwise from the camera.

#### Pano.zoom

`unstable` · unreleased

```ts
Pano.zoom(): number
```

The viewer's display zoom.

#### Pano.zoomIn

`unstable` · unreleased

```ts
Pano.zoomIn(): void
```

Step the zoom in.

#### Pano.zoomOut

`unstable` · unreleased

```ts
Pano.zoomOut(): void
```

Step the zoom out.
