# MMA API reference

Every member of the global `MMA` object (also `window.MMA`), grouped by surface.

- `stable` members keep working across releases. A rename or removal ships with a shim.
- `unstable` members are documented but can change or disappear in any release.
- `since` is the first release a member shipped in: the `minAppVersion` a plugin using it needs.

## Contents

**Stable surfaces**

- [Consts](#consts)
- [Store](#store)
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

**Unstable surfaces**

- [SelectionOps](#selectionops)
- [SelectionActions](#selectionactions)
- [SavedSelections](#savedselections)
- [Settings](#settings)
- [ImportStaging](#importstaging)
- [CommitDiff](#commitdiff)
- [SelectorPick](#selectorpick)
- [MapList](#maplist)
- [Review](#review)
- [Commands](#commands)
- [Tauri](#tauri)
- [PluginHost](#pluginhost)
- [Marketplace](#marketplace)
- [Scope](#scope)
- [FieldProjections](#fieldprojections)
- [Procedures](#procedures)
- [Seen](#seen)
- [SeenRecorder](#seenrecorder)
- [Pano](#pano)
- [Enrich](#enrich)
- [Providers](#providers)
- [PinPano](#pinpano)
- [Validate](#validate)
- [ValidationCategories](#validationcategories)
- [MapState](#mapstate)
- [SceneStore](#scenestore)
- [ScenePositions](#scenepositions)
- [Color](#color)
- [Jobs](#jobs)
- [Test](#test)
- [Util](#util)
- [Legacy](#legacy)

## Consts

### BUILTIN_FIELDS

`stable` · since v0.10.3

```ts
BUILTIN_FIELDS: readonly [
  {
    readonly key: "id";
    readonly label: "ID";
    readonly type: "number";
    readonly kind: "identity";
    readonly comparison: null;
    readonly interned: false;
  },
  {
    readonly key: "lat";
    readonly label: "Latitude";
    readonly type: "number";
    readonly kind: "identity";
    readonly comparison: null;
    readonly interned: false;
  },
  {
    readonly key: "lng";
    readonly label: "Longitude";
    readonly type: "number";
    readonly kind: "identity";
    readonly comparison: null;
    readonly interned: false;
  },
  {
    readonly key: "heading";
    readonly label: "Heading";
    readonly type: "number";
    readonly kind: "writable";
    readonly comparison: { readonly type: "circular"; readonly period: 360 };
    readonly interned: false;
  },
  {
    readonly key: "pitch";
    readonly label: "Pitch";
    readonly type: "number";
    readonly kind: "writable";
    readonly comparison: null;
    readonly interned: false;
  },
  {
    readonly key: "zoom";
    readonly label: "Zoom";
    readonly type: "number";
    readonly kind: "writable";
    readonly comparison: null;
    readonly interned: false;
  },
  {
    readonly key: "panoId";
    readonly label: "Pano ID";
    readonly type: "string";
    readonly kind: null;
    readonly comparison: null;
    readonly interned: false;
  },
  {
    readonly key: "tags";
    readonly label: "Tags";
    readonly type: "array";
    readonly kind: "writable";
    readonly comparison: null;
    readonly interned: true;
  },
  {
    readonly key: "createdAt";
    readonly label: "Created";
    readonly type: "date";
    readonly kind: null;
    readonly comparison: null;
    readonly interned: false;
  },
  {
    readonly key: "modifiedAt";
    readonly label: "Modified";
    readonly type: "date";
    readonly kind: null;
    readonly comparison: null;
    readonly interned: false;
  },
  {
    readonly key: "tagCount";
    readonly label: "Tag count";
    readonly type: "number";
    readonly kind: "virtual";
    readonly comparison: null;
    readonly interned: false;
  },
  {
    readonly key: "loadAsPanoId";
    readonly label: "Load as pano ID";
    readonly type: "boolean";
    readonly kind: "writable";
    readonly comparison: null;
    readonly interned: false;
  },
]
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

### CLEARABLE_BUILTINS

`unstable` · since v0.10.3

```ts
CLEARABLE_BUILTINS: readonly ["panoId"]
```

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

`stable` · unreleased

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

`stable` · unreleased

```ts
Stack: { readonly Undo: "undo"; readonly Redo: "redo" }
```

Which way through the edit history: back over what was done, or forward over what
was undone.

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

## Store

### addLocations

`stable` · since v0.3.1

```ts
addLocations(locs: Location[]): Promise<void>
```

Add locations to the map. Real ids are assigned and written back into the passed
objects - build with `createLocation` (id 0) and read `loc.id` after. Undoable.

### applySelectionUpdate

`unstable` · since v0.10.3

```ts
applySelectionUpdate(op: SelectionOp): Promise<void>
```

Apply `op` to the listed selections and have the store hold and resolve the result: the
one way the selection changes. Lift an op over the active selections alone with
`onActive`. No-op when nothing changed.

### checkoutCommit

`unstable` · since v0.4.0

```ts
checkoutCommit(commitId: string): Promise<void>
```

Restore the map to a previous commit's state and reopen it. Clears undo/redo.

### closeDuplicates

`unstable` · since v0.4.0

```ts
closeDuplicates(): void
```

Close the duplicate-resolution panel and return to the overview.

### closeMap

`stable` · since v0.4.0

```ts
closeMap(): Promise<void>
```

Close the open map, saving unsaved changes first.

### commitMap

`stable` · since v0.4.0

```ts
commitMap(message?: string): Promise<string>
```

Commit all pending changes to the map's version history. Clears the undo stack.

### deleteField

`stable` · since v0.5.1

```ts
deleteField(key: string): Promise<void>
```

Delete extra-field `key` from every location, its definition, and the listed selections,
in one undoable step.

### deleteTags

`stable` · since v0.4.0

```ts
deleteTags(tagIds: number[]): Promise<WorkResult>
```

Strip `tagIds` from every location in one undoable step. The emptied records go dark
(count 0 hides them); undo restores the rows and the tags with them.

### discardOpenMap

`unstable` · since v0.6.1

```ts
discardOpenMap(): void
```

Drop the open map without persisting anything

### duplicateLocation

`stable` · since v0.4.0

```ts
duplicateLocation(id: number): Promise<number | null>
```

Clone a location in place and return the new id, or null if it doesn't exist. Undoable.

### exitPluginMode

`stable` · since v0.3.1

```ts
exitPluginMode(): void
```

Close the plugin sidebar and return to the overview.

### getActiveSelections

`stable` · since v0.8.2

```ts
getActiveSelections(): Selection[]
```

The selection: every listed selection that is not ghosted.

### getMapState

`stable` · since v0.8.2

```ts
getMapState(): Readonly<MapState>
```

Imperative snapshot of the map state.

### getTag

`stable` · since v0.7.0

```ts
getTag(id: number): Tag | undefined
```

Raw by-id tag lookup — includes dark metadata ghosts so stale references
(e.g. a selection whose tag just died) still resolve to a name.

### getTagCounts

`stable` · since v0.4.0

```ts
getTagCounts(): Record<number, number>
```

Per-tag location counts, keyed by numeric id.

### getTags

`stable` · since v0.11.1

```ts
getTags(): Record<number, Tag>
```

The tag view: each value's record dressed as a tag. A tag is visible exactly while
something carries it (count > 0); a value present in data without a record (foreign
import) shows under a derived name/color; an emptied record lingers dark until its
name is reused.

### getVisibleTags

`stable` · since v0.4.0

```ts
getVisibleTags(): Tag[]
```

Tags that exist from the user's point of view: the ones something carries. Raw
`tags` also holds dark metadata ghosts (count=0, visible=false) - almost nothing
should enumerate those.

### historyAvailable

`unstable` · unreleased

```ts
historyAvailable(
  history: MapState["history"],
  stack: Stack,
  key?: EntryKey,
): boolean
```

Whether a history action is available for one part or for the data edit as a whole.

### initStore

`unstable` · since v0.4.0

```ts
initStore(): Promise<void>
```

One-time store startup. The app calls this; plugins never need to.

### mutate

`stable` · since v0.4.0

```ts
mutate<R extends MutationResult = MutationResult>(
  fn: () => Promise<R>,
  ...fallback: MutationResult extends R ? [empty?: R] : [empty: R]
): Promise<R>
```

### openDuplicateLocation

`unstable` · since v0.4.0

```ts
openDuplicateLocation(loc: Location): void
```

Open one location from the duplicate-resolution panel in the editor.

### openMap

`stable` · since v0.4.0

```ts
openMap(id: string): Promise<void>
```

Open a map in this window, closing any currently open map first.

### openStagedLocation

`unstable` · since v0.6.0

```ts
openStagedLocation(index: number): Promise<void>
```

Open a staged-import location, as if it were active: the viewer previews a copy, and
the staged row itself stays in the import layer until Confirm lands it.

### previewDuplicateGroups

`unstable` · since v0.5.1

```ts
previewDuplicateGroups(distance: number): Promise<number[][]>
```

Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres.

### previewLocation

`unstable` · unreleased

```ts
previewLocation(loc: Location): void
```

Open an arbitrary location read-only as a seen-preview: loads its pano without
adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves.

### query

`stable` · since v0.11.3

```ts
query(
  selector: Selector,
  target?: Target,
): {
  /** The resolved ids, in map order. */
  ids: () => Promise<number[]>;
  /** How many locations resolve. */
  count: () => Promise<number>;
  /** Bounding box `[west, south, east, north]`, or null when nothing resolves. */
  bounds: () => Promise<[number, number, number, number] | null>;
  /** `n` ids drawn uniformly at random, without replacement. */
  sample: (n: number) => Promise<number[]>;
  /** Distinct values of `field`, sorted. */
  values: (field: string) => Promise<string[]>;
  /** Group each field by a derived key and count, one result per field. */
  countBy: (fields: string[], key: KeySpec) => Promise<CountBy[]>;
  /** How many locations hold a value for each field, key-sorted. */
  coverage: () => Promise<[string, number][]>;
  /** One column per field. `null` where a location lacks the field; `"tags"`
   *  returns a column of tag-id arrays. */
  columns: (fields: string[]) => Promise<unknown[][]>;
  /** Group by a derived key. Numeric bins arrive in bound order; other keys are
   *  sorted naturally. */
  partition: (field: string, key: KeySpec) => Promise<PartitionBucket[]>;
  /** Every matching location as a full row; missing ids are skipped.
   *
   *  Every row lands in memory, so an unscoped call on a large map is expensive.
   *  Prefer a narrower selector or a projection (`columns`, `countBy`) when possible. */
  locations: () => Promise<Location[]>;
}
```

Questions about the locations a selector resolves to. Each call answers once,
against the map as it is now; ask again after a change.

### read

`stable` · unreleased

```ts
read<K extends Answer["kind"]>(
  selector: Selector,
  ask: Ask,
  kind: K,
  target?: Target,
): Promise<AnswerOf<K>>
```

The one read: `ask` a question of the rows `selector` resolves to. Answers once,
against the map as it is now.

### redo

`stable` · since v0.4.0

```ts
redo(): Promise<void>
```

Redo the last undone edit.

### redoSelections

`unstable` · unreleased

```ts
redoSelections(): Promise<void>
```

Redo the last undone selection change without redoing data edits.

### removeDuplicate

`unstable` · since v0.4.0

```ts
removeDuplicate(id: number): void
```

Drop a location from the duplicate-resolution panel (does not delete it).

### removeLocations

`stable` · since v0.3.1

```ts
removeLocations(ids: ReadonlyIdSet): Promise<void>
```

Remove locations by id. Undoable.

### renameField

`stable` · since v0.5.1

```ts
renameField(
  from: string,
  to: string,
  winner?: MergeWinner,
): Promise<void>
```

Rename extra-field `from` to `to` across all locations, its definition, and the listed
selections, in one undoable step. When a location already holds `to`, `winner` decides
which value survives. Saved selections are map-independent rules and keep their names.

### resolveLocation

`stable` · since v0.6.6

```ts
resolveLocation(m: MaybeLocation): Promise<Location | null>
```

Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found.

### restoreSelections

`unstable` · unreleased

```ts
restoreSelections(): Promise<void>
```

Undo the last selection change without undoing data edits.

### rowsOf

`stable` · unreleased

```ts
rowsOf(rows: AnswerOf<"rows">["rows"]): Promise<Location[]>
```

Full rows out of a rows answer, fetched from disk when they were many.

### select

`stable` · unreleased

```ts
select<
  R extends {
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

### setActiveLocation

`stable` · since v0.3.1

```ts
setActiveLocation(
  target: MaybeLocation | null,
  checkDuplicates?: boolean,
): Promise<void>
```

Open a location in the editor (null closes it). With `checkDuplicates`, opening a spot
with 2+ locations within 2m opens the duplicate-resolution panel instead. A later
opening of any kind supersedes one still loading.

### setMap

`unstable` · unreleased

```ts
setMap(map: MapMeta): void
```

Replace the open map's row in state; persisting it is the caller's.

### setOpenRow

`stable` · unreleased

```ts
setOpenRow(row: Location | null, session: number): void
```

The open row as the viewer's layer last read it, dropped unless `session` is still open.
The layer is the single writer; everything else only looks.

### setPluginMode

`stable` · since v0.4.0

```ts
setPluginMode(pluginId: string): void
```

Open a plugin's sidebar (switches the editor pane to "plugin").

### setSelectedLocationIds

`unstable` · since v0.6.6

```ts
setSelectedLocationIds(ids: SelectedIds): void
```

Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want.

### settled

`stable` · unreleased

```ts
settled(m: Mutation): Promise<void>
```

### setWorkArea

`unstable` · since v0.4.0

```ts
setWorkArea(area: WorkArea): void
```

Transition the editor pane, enforcing state invariants:
leaving "location" clears the active location, leaving "plugin" clears the plugin id.

### tagIdsToNames

`stable` · since v0.9.0

```ts
tagIdsToNames(ids: number[]): string[]
```

Tag names for the given ids, skipping any that no longer resolve.

### undo

`stable` · since v0.4.0

```ts
undo(): Promise<void>
```

Undo the last edit.

### updateLocations

`stable` · since v0.6.3

```ts
updateLocations(updates: Patch<Location>[]): Promise<void>
```

Patch locations by id. Only include the fields you're changing; `extra` merges
per-key (null deletes a key). Undoable by default.

### useMapState

`stable` · since v0.8.2

```ts
useMapState<T>(selector: (s: MapState) => T): T
```

Reactive slice of the map state. Re-renders only when the selected value's
reference changes (`Object.is`), so selectors must return state fields or
memoized values, not a new value per call.

### VIEWER

`stable` · unreleased

```ts
VIEWER: { readonly kind: "pending"; readonly name: "viewer" }
```

The viewer's own pending layer: its edits read over the map's rows as they are now,
and nothing reaches the map until a save lands them.

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

```ts
sidecar: {
  request: typeof request$1;
  installedVersion: typeof installedVersion$1;
}
```

The nested `sidecar` namespace on the plugin surface.

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

`unstable` · unreleased

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

`unstable` · unreleased

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

Locations with no tags: `tags` resolves to nothing on an untagged row.

### withChildren

`unstable` · since v0.10.5

```ts
withChildren<S>(selector: Selector$1<S>, children: S[]): Selector$1<S>
```

`selector` with its children replaced, keeping the shape it wraps them in.

## SelectionActions

Editing the selection list the way the sidebar does.

### getSelectedTagIds

`unstable` · since v0.8.2

```ts
getSelectedTagIds(): ReadonlySet<number>
```

Tag ids that have a top-level Tag selection listed, ghosted or not.

### getSelectedTagIdsDeep

`unstable` · since v0.9.2

```ts
getSelectedTagIdsDeep(): readonly number[]
```

Tag ids of every Tag leaf in the active selection tree, in list order.
Includes composite children, excludes ghosted selections; ids may repeat.

## SavedSelections

Saved selection rules.

### applySavedSelection

`unstable` · since v0.10.3

```ts
applySavedSelection(saved: SavedSelection): number
```

Adds the rule's parts to the sidebar, resolved against the open map. Returns how many
were added.

### deleteSavedSelection

`unstable` · since v0.10.3

```ts
deleteSavedSelection(id: string): Promise<void>
```

Permanently delete a saved selection rule.

### getSavedSelectionIndex

`unstable` · since v0.10.0

```ts
getSavedSelectionIndex(): SavedSelectionInfo[]
```

The rules that exist, as identity only. Empty until the index loads: the first
call starts the read and `saved-selections:changed` announces it.

### isSaveable

`unstable` · since v0.10.3

```ts
isSaveable(selector: Selector): boolean
```

Whether the selector tree contains only portable types (no map-local leaves).

### loadAllSavedSelections

`unstable` · since v0.10.3

```ts
loadAllSavedSelections(): Promise<SavedSelection[]>
```

Every rule with its body.

### loadSavedSelections

`unstable` · since v0.10.0

```ts
loadSavedSelections(ids: string[]): Promise<SavedSelection[]>
```

Load the full rule bodies for the given `ids`.

### MAP_LOCAL_TYPES

`unstable` · since v0.10.3

```ts
MAP_LOCAL_TYPES: readonly [
  "Locations",
  "Manual",
  "Validation",
  "Reviewed",
  "Selected",
]
```

Selection types that cannot be saved as rules because they are bound to the open map.

### saveCurrentSelections

`unstable` · since v0.10.3

```ts
saveCurrentSelections(name: string, selections: Selection[]): Promise<boolean>
```

Persists the saveable selections as one rule. False when none of them are saveable.

### savedParts

`unstable` · since v0.10.0

```ts
savedParts(saved: SavedSelection): SavedPart[]
```

A rule's parts: its top-level `Union` is the list it was saved from, anything else is
a single part.

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

## ImportStaging

Stage, preview, and confirm an import into the open map.

### beginImportFromPath

`unstable` · since v0.5.2

```ts
beginImportFromPath(path: string): Promise<void>
```

Import from a file path.

### beginImportPaste

`unstable` · since v0.5.1

```ts
beginImportPaste(text: string): Promise<void>
```

Stage pasted text for preview. Throws if no locations are found.

### cancelImport

`unstable` · since v0.5.1

```ts
cancelImport(): void
```

Discard the staged import without committing.

### confirmImport

`unstable` · since v0.5.1

```ts
confirmImport(
  droppedFields: string[],
  tagNames?: string[],
): Promise<EditorImportResult | null>
```

Commit the staged import, optionally dropping fields and applying bulk tags.

### getImportPreviewPositions

`unstable` · since v0.5.1

```ts
getImportPreviewPositions(): Float32Array<ArrayBufferLike>
```

The preview marker positions for the staged import.

### getImportStaging

`unstable` · since v0.8.1

```ts
getImportStaging(): ImportStaging | null
```

The current staged import, or null if none.

### importTarget

`unstable` · unreleased

```ts
importTarget(): Target
```

The pending layer holding this window's staged import rows.

### resetImportState

`unstable` · since v0.8.1

```ts
resetImportState(): void
```

Discard the staged import, freeing its parse.

## CommitDiff

Uncommitted changes and their preview on the map.

### beginCommitDiffPreview

`unstable` · since v0.5.1

```ts
beginCommitDiffPreview(commit: CommitInfo): Promise<void>
```

Fetch a commit's change and overlay its added/removed/updated locations on the map,
temporarily replacing the regular markers.

### diffPositions

`unstable` · since v0.5.1

```ts
diffPositions(locs: LatLng[]): Float32Array
```

Pack `[lng, lat]` pairs into an interleaved Float32Array.

### endCommitDiffPreview

`unstable` · since v0.5.1

```ts
endCommitDiffPreview(): void
```

Leave commit-diff preview and restore the regular markers.

### getCommitDiffPreview

`unstable` · since v0.5.1

```ts
getCommitDiffPreview(): CommitDiffPreview | null
```

The current commit-diff preview, or null when not previewing.

### hasCommitDiff

`unstable` · since v0.4.0

```ts
hasCommitDiff(): boolean
```

Whether there are uncommitted changes (adds, removes, or updates).

### resetCommitDiffCounts

`unstable` · since v0.8.2

```ts
resetCommitDiffCounts(): void
```

Reset the uncommitted-change counts to zero.

### resetCommitDiffState

`unstable` · since v0.8.1

```ts
resetCommitDiffState(): void
```

Clear commit-diff preview state.

### useCommitDiff

`unstable` · since v0.4.0

```ts
useCommitDiff(): Counts
```

React hook: the uncommitted add/remove/modify counts, kept in sync with the store.

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

## MapList

The cached map list and its refresh.

### copyName

`unstable` · since v0.11.4

```ts
copyName(name: string): string
```

The name a copy of the map named `name` starts with.

### createMap

`unstable` · since v0.4.0

```ts
createMap(name: string, folder?: string | null): Promise<MapMeta>
```

Create a new empty map and return its metadata.

### deleteFolder

`unstable` · since v0.4.0

```ts
deleteFolder(name: string): Promise<void>
```

Delete a folder. Maps in it become unfoldered.

### deleteMap

`unstable` · since v0.4.0

```ts
deleteMap(id: string): Promise<void>
```

Permanently delete a map and all its data. Not undoable.

### duplicateMap

`unstable` · since v0.11.4

```ts
duplicateMap(id: string, name: string): Promise<MapMeta>
```

Copy a map, uncommitted edits included, into a new map named `name` and return its metadata.

### getMapBadges

`unstable` · since v0.11.3

```ts
getMapBadges(): Map<string, MapBadge[]>
```

Badges per map id, from every registered source.

### getMapBadgeSources

`unstable` · since v0.11.3

```ts
getMapBadgeSources(): readonly BadgeSource[]
```

Every registered badge source, in registration order.

### getMapList

`unstable` · since v0.7.0

```ts
getMapList(): MapMeta[]
```

The list of all maps (metadata only).

### invalidateMapList

`unstable` · since v0.4.0

```ts
invalidateMapList(): Promise<void>
```

Refresh the map list and notify other windows of the change.

### isReservedMap

`unstable` · since v0.10.1

```ts
isReservedMap(id: string | null): boolean
```

Whether `id` belongs to an app fixture rather than a user-created map.

### moveMapToFolder

`unstable` · since v0.4.0

```ts
moveMapToFolder(mapId: string, folder: string | null): Promise<void>
```

Move a map into a folder, or to the root when `folder` is null.

### openScratchMap

`unstable` · since v0.10.1

```ts
openScratchMap(): Promise<void>
```

Open the scratch map, creating it on first use.

### registerMapBadges

`unstable` · since v0.11.3

```ts
registerMapBadges(source: BadgeSource): void
```

Add a source of map-row badges.

### reloadMapList

`unstable` · since v0.8.1

```ts
reloadMapList(): Promise<void>
```

Refresh the map list from disk.

### renameFolder

`unstable` · since v0.4.0

```ts
renameFolder(from: string, to: string): Promise<void>
```

Rename a folder, moving all its maps to the new name.

### setCachedMapList

`unstable` · since v0.8.1

```ts
setCachedMapList(list: MapMeta[]): void
```

Set the map list directly without a disk read.

### useMapBadges

`unstable` · since v0.11.3

```ts
useMapBadges(): Map<string, MapBadge[]>
```

Reactive getMapBadges.

### useMapList

`unstable` · since v0.4.0

```ts
useMapList(): MapMeta[]
```

Reactive list of all maps (metadata only).

## Review

Review sessions and their history.

### advance

`unstable` · since v0.5.2

```ts
advance(s: ReviewSession): {
  session: ReviewSession;
  done: boolean;
}
```

Mark the current cursor reviewed and step forward. `done` is true when the
session has no remaining items.

### beginReview

`unstable` · since v0.4.0

```ts
beginReview(ids: number[], source?: Selection): Promise<void>
```

Start or resume a review over `ids`. When `source` is a selection, re-reviewing
that selection resumes any in-progress session for it.

### cancelReview

`unstable` · since v0.4.0

```ts
cancelReview(): void
```

Exit the review UI but keep the session resumable (persisted as active).

### deleteSession

`unstable` · since v0.5.2

```ts
deleteSession(id: string): Promise<void>
```

Delete a review session (its progress, not the locations).

### getReviewSession

`unstable` · since v0.5.2

```ts
getReviewSession(): ReviewSession | null
```

The active review session, or null.

### isAtEnd

`unstable` · since v0.11.3

```ts
isAtEnd(s: ReviewSession): boolean
```

True when the cursor is on the session's last location.

### isAtStart

`unstable` · since v0.5.2

```ts
isAtStart(s: ReviewSession): boolean
```

True when the cursor is on the session's first location.

### isCurrentReviewed

`unstable` · since v0.5.2

```ts
isCurrentReviewed(s: ReviewSession): boolean
```

Current cursor location is in the reviewed set.

### listSessions

`unstable` · since v0.5.2

```ts
listSessions(status?: "active" | "done"): Promise<ReviewSession[]>
```

Review sessions for the open map, optionally filtered by status.

### positionOf

`unstable` · since v0.10.7

```ts
positionOf(s: ReviewSession, id: number): number
```

Position of `id` in the session's worklist, or -1. O(1) per step.

### pruneSession

`unstable` · since v0.5.2

```ts
pruneSession(s: ReviewSession, removed: Set<number>): PruneResult
```

Remove `removed` ids from a session's worklist and reviewed set. Advances the
cursor when the cursor id itself was removed.

### renameReview

`unstable` · since v0.6.3

```ts
renameReview(id: string, name: string): Promise<void>
```

Rename a review session.

### resumeReview

`unstable` · since v0.5.2

```ts
resumeReview(s: ReviewSession): Promise<void>
```

Resume a session picked from the resume modal.

### retreat

`unstable` · since v0.5.2

```ts
retreat(s: ReviewSession): ReviewSession | null
```

Step backward without marking anything reviewed. Null when already at the start.

### reviewDelete

`unstable` · since v0.4.0

```ts
reviewDelete(): Promise<void>
```

Delete the current location and advance to the next one. Exits the pass if it
was the last item.

### reviewedHistoryIds

`unstable` · since v0.6.3

```ts
reviewedHistoryIds(sessions: ReviewSession[]): number[]
```

Union of reviewed ids across sessions, de-duplicated.

### reviewIndex

`unstable` · since v0.5.2

```ts
reviewIndex(s: ReviewSession): number
```

Position of the session cursor within its review order.

### reviewNext

`unstable` · since v0.4.0

```ts
reviewNext(): Promise<void>
```

Mark the current location reviewed and step to the next one.

### reviewPrev

`unstable` · since v0.4.0

```ts
reviewPrev(): Promise<void>
```

Step back to the previous location in the session.

### reviewSelected

`unstable` · since v0.11.3

```ts
reviewSelected(): Promise<void>
```

Review the selected locations. With one active selection, the review belongs to it and
resumes with it.

### reviewSet

`unstable` · since v0.11.3

```ts
reviewSet(s: ReviewSession, mode: ReviewMode): number[]
```

The session's locations in `mode`: those reviewed, or those still to review.

### reviewSetSelector

`unstable` · since v0.11.3

```ts
reviewSetSelector(s: ReviewSession, mode: ReviewMode): Selector
```

The locations of review session `s` that are reviewed, or still to review.

### selectReviewedHistory

`unstable` · since v0.6.3

```ts
selectReviewedHistory(): Promise<void>
```

Select every location marked reviewed across all sessions on this map.

### useReviewSession

`unstable` · since v0.5.2

```ts
useReviewSession(): ReviewSession | null
```

Reactive active review session, or null.

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

Reserve a run id up front, for a query or row run that answers only when it is over:
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

`unstable` · unreleased

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
cmd.storeAddLocationsUploaded(sessionDir: string): Promise<MutationResult>
```

Add locations from an upload session (see `storeUploadBegin`) as one undoable change.

#### cmd.storeApplySavedSelection

`unstable` · unreleased

```ts
cmd.storeApplySavedSelection(id: string): Promise<MutationResult>
```

Apply a saved rule with its value names resolved against the open map.

#### cmd.storeCheckoutCommit

`unstable` · since v0.4.0

```ts
cmd.storeCheckoutCommit(mapId: string, commitId: string): Promise<MutationResult>
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

`unstable` · unreleased

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

`unstable` · unreleased

```ts
cmd.storeEdit(
  target: Target,
  edits: Op<Location, Partial<Location> & Pick<Location, "id">, number>[],
  opts: EditOpts | null,
): Promise<MutationResult>
```

Edit rows where target says; a pending layer holds edits until land.

#### cmd.storeEditSelections

`unstable` · unreleased

```ts
cmd.storeEditSelections(op: SelectionOp): Promise<MutationResult>
```

Edit the selection tree.

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

#### cmd.storePatchFieldValues

`unstable` · since v0.11.1

```ts
cmd.storePatchFieldValues(
  field: string,
  patch: FieldValuesPatch,
): Promise<FieldValuesResult>
```

Patch an interned field's value records; membership uses ordinary row edits.

#### cmd.storeRead

`unstable` · unreleased

```ts
cmd.storeRead(
  target: Target,
  selector: Selector$1<SelectionInput>,
  ask: Ask,
): Promise<Answer>
```

Answer one question about the target's rows matched by selector.

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
  color: [number, number, number],
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

`unstable` · unreleased

```ts
cmd.storeSetDerived(edges: { [key in string]: string[] }): Promise<null>
```

Declare which fields are computed from which: each input field and the fields derived
from it. A write that changes an input clears what was derived from it.

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
cmd.storeSetMarkerColor(color: [number, number, number]): Promise<null>
```

Set the default marker color for new render updates.

#### cmd.storeStep

`unstable` · unreleased

```ts
cmd.storeStep(stack: Stack, key: EntryKey | null): Promise<MutationResult>
```

Undo the newest edit, or redo the newest undone one.

#### cmd.storeSubscribeChanges

`unstable` · unreleased

```ts
cmd.storeSubscribeChanges(changes: Channel<ChangeEvent>): Promise<null>
```

Hear every change to the open map's rows: `changes` receives the ids each landed
change created, deleted and rewrote, whatever caused it.

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

`unstable` · unreleased

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
      "locationCount" | "pending" | "createdAt" | "updatedAt" | "lastOpenedAt"
    >
  > &
    Pick<MapMeta, "id">,
): Promise<null>
```

Apply a partial update to a map's metadata. Omitted fields are left unchanged. An open
map's store takes the update and saves it with the map; its tags change only through
their values.

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

`unstable` · unreleased

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

```ts
dialog: { open: typeof open; save: typeof save }
```

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
  rows: Selector,
  opts?: RunOpts,
): Promise<ProviderOutcomes>
```

Run a set of providers over `rows`. When `rows` is a Selector, matching locations
are processed in place and results are written back. When `rows` is a Location array,
locations are processed independently and returned as modified copies. Resolves once
every provider finishes, or on abort.

## Seen

The seen-location history.

### clearSeen

`unstable` · since v0.4.0

```ts
clearSeen(): Promise<void>
```

Delete the entire seen history. Not undoable.

### getSeenCount

`unstable` · since v0.4.0

```ts
getSeenCount(filter?: SeenFilter): Promise<number>
```

Number of seen entries matching the filter (all when omitted).

### getSeenCountries

`unstable` · since v0.10.3

```ts
getSeenCountries(): Promise<string[]>
```

Distinct country codes that appear in the seen history.

### getSeenEntries

`unstable` · since v0.4.0

```ts
getSeenEntries(
  limit?: number,
  offset?: number,
  filter?: SeenFilter,
  thumbnails?: boolean,
): Promise<SeenEntry[]>
```

Fetch a page of the seen (visited-panorama) history.

### getSeenMaps

`unstable` · since v0.10.3

```ts
getSeenMaps(): Promise<SeenMapInfo[]>
```

Maps that have seen-history entries.

## SeenRecorder

How the app records panorama visits into the seen history.

### loadSeenPano

`unstable` · since v0.4.0

```ts
loadSeenPano(entry: SeenPano, viewer: PanoViewer): Promise<void>
```

Open a seen entry's panorama in the Street View viewer.

### seenFlush

`unstable` · since v0.10.3

```ts
seenFlush(viewer: PanoViewer): void
```

Write the pending seen entry to disk, if any.

### seenPanoChanged

`unstable` · since v0.10.3

```ts
seenPanoChanged(
  location: PendingEntryLocation,
  geo: GeoDisplay | null,
  viewer: PanoViewer,
): void
```

Record a panorama change for the seen history. Flushes the previous entry and stages the new one.

### seenRecord

`unstable` · since v0.11.0

```ts
seenRecord(
  location: PendingEntryLocation & LocationPOV,
  viewer: PanoViewer,
): Promise<void>
```

Record a pano visit now at its starting view, with a thumbnail if that view is still on screen once imagery arrives.

### seenSkipNext

`unstable` · since v0.10.3

```ts
seenSkipNext(panoId: string): void
```

Suppress the next seen-history entry for `panoId`.

### seenUpdateGeo

`unstable` · since v0.10.3

```ts
seenUpdateGeo(geo: GeoDisplay): void
```

Update the pending seen entry's geocode info (country, address).

## Pano

The shared panorama viewer.

### createPano

`unstable` · since v0.11.0

```ts
createPano(): {
  /** Resolve and show a location's pano, optionally hidden until it loads; "superseded" when overtaken. */
  show: (
    loc: Location,
    {
      concealUntilReady,
    }?: {
      concealUntilReady?: boolean;
    },
  ) => Promise<ShowResult>;
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
}
```

Create an independent pano viewer with its own camera, requests, listeners and mounts.

### pano

`unstable` · since v0.11.0

The app's default pano viewer.

#### pano.canvas

`unstable` · since v0.11.0

```ts
pano.canvas(): HTMLCanvasElement | null
```

The live WebGL scene canvas, or null before the first render.

#### pano.capture

`unstable` · since v0.11.0

```ts
pano.capture(): PanoCapture | null
```

The viewer read back into Location fields, or null until it has a position.

#### pano.captureImage

`unstable` · since v0.11.0

```ts
pano.captureImage(width: number, height: number): HTMLCanvasElement | null
```

Cover-crop the live frame into an exact image, or null until real imagery renders.

#### pano.captureView

`unstable` · since v0.11.0

```ts
pano.captureView(): LocationPOV
```

The camera in the stored zoom domain, zeroed without a viewer.

#### pano.configure

`unstable` · since v0.11.0

```ts
pano.configure(options: google.maps.StreetViewPanoramaOptions): void
```

Apply display options to the viewer.

#### pano.dispose

`unstable` · since v0.11.0

```ts
pano.dispose(): void
```

Release the viewer, its container and every listener; the instance is unusable afterwards.

#### pano.exists

`unstable` · since v0.11.0

```ts
pano.exists(): boolean
```

Whether the viewer has been created.

#### pano.faceRoad

`unstable` · since v0.11.0

```ts
pano.faceRoad(): void
```

Face the linked road nearest the camera heading.

#### pano.hide

`unstable` · since v0.11.0

```ts
pano.hide(): void
```

Hide the viewer.

#### pano.isLoaded

`unstable` · since v0.11.0

```ts
pano.isLoaded(): boolean
```

Whether the viewer has finished loading its current pano.

#### pano.jump

`unstable` · since v0.11.0

```ts
pano.jump(to: PanoDestination, frame?: PanoFrame): void
```

Move to a pano id or position now, optionally setting the camera, overtaking pending requests.

#### pano.jumpAhead

`unstable` · since v0.11.0

```ts
pano.jumpAhead(headingOffset: number): Promise<boolean>
```

Jump to the nearest official pano ahead of the camera, turned by `headingOffset` degrees.

#### pano.links

`unstable` · since v0.11.0

```ts
pano.links(): google.maps.StreetViewLink[]
```

The current pano's navigable links.

#### pano.look

`unstable` · since v0.11.0

```ts
pano.look(frame: PanoFrame): void
```

Point the camera now.

#### pano.mount

`unstable` · since v0.11.0

```ts
pano.mount(target: HTMLElement): () => void
```

Parent the viewer into a container; the newest mount wins until released.

#### pano.nudge

`unstable` · since v0.11.0

```ts
pano.nudge(dHeading: number, dPitch: number): void
```

Nudge heading and pitch by a delta, keeping pitch in range.

#### pano.on

`unstable` · since v0.11.0

```ts
pano.on(event: PanoEvent, fn: () => void): () => void
```

Listen to a viewer event, across viewer rebuilds; returns an unsubscribe.

#### pano.panoId

`unstable` · since v0.11.0

```ts
pano.panoId(): string | null
```

The current pano id, or null before one loads.

#### pano.pointNorth

`unstable` · since v0.11.0

```ts
pano.pointNorth(): void
```

Face north level, or look straight down zoomed out when already facing north.

#### pano.position

`unstable` · since v0.11.0

```ts
pano.position(): google.maps.LatLngLiteral | null
```

The current pano's position, or null before one loads.

#### pano.pov

`unstable` · since v0.11.0

```ts
pano.pov(): CameraFrame
```

The camera heading and pitch.

#### pano.preload

`unstable` · since v0.11.0

```ts
pano.preload(loc: Location): Promise<void>
```

Stage a location's pano while nothing newer is pending, so a later show is instant.

#### pano.reload

`unstable` · since v0.11.0

```ts
pano.reload(fallback: google.maps.LatLngLiteral): void
```

Rebuild a stuck viewer in place, keeping its pano and camera.

#### pano.reserveLook

`unstable` · since v0.11.0

```ts
pano.reserveLook(): (frame: PanoFrame) => boolean
```

Reserve a camera move across an async wait; it lands only if nothing moved the pano since.

#### pano.resetZoom

`unstable` · since v0.11.0

```ts
pano.resetZoom(): void
```

Zoom fully out.

#### pano.show

`unstable` · since v0.11.0

```ts
pano.show(
  loc: Location,
  props?: {
    concealUntilReady?: boolean;
  },
): Promise<ShowResult>
```

Resolve and show a location's pano, optionally hidden until it loads; "superseded" when overtaken.

#### pano.showCrosshair

`unstable` · since v0.11.0

```ts
pano.showCrosshair(): () => void
```

Draw the crosshair over the viewer; returns a remove.

#### pano.snapshot

`unstable` · since v0.11.0

```ts
pano.snapshot(): PanoView
```

Freeze the live camera for an offscreen render; throws until a pano is ready.

#### pano.step

`unstable` · since v0.11.0

```ts
pano.step(direction: "forward" | "backward"): boolean
```

Step to the linked pano nearest the camera heading, or its reverse.

#### pano.toast

`unstable` · since v0.11.0

```ts
pano.toast(message: string, durationMs: number): void
```

Show a toast anchored over the viewer.

#### pano.turnAround

`unstable` · since v0.11.0

```ts
pano.turnAround(): void
```

Turn to face the opposite direction.

#### pano.turnTo

`unstable` · since v0.11.0

```ts
pano.turnTo(target: CameraFrame): void
```

Animate the camera to a frame, replacing any turn in progress.

#### pano.turnToNextLink

`unstable` · since v0.11.0

```ts
pano.turnToNextLink(): void
```

Turn to the next linked road clockwise from the camera.

#### pano.zoom

`unstable` · since v0.11.0

```ts
pano.zoom(): number
```

The viewer's display zoom.

#### pano.zoomIn

`unstable` · since v0.11.0

```ts
pano.zoomIn(): void
```

Step the zoom in.

#### pano.zoomOut

`unstable` · since v0.11.0

```ts
pano.zoomOut(): void
```

Step the zoom out.

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

## MapState

The embedded map host, its preferences, and click interceptors.

### addClickInterceptor

`unstable` · since v0.10.3

```ts
addClickInterceptor(fn: ClickInterceptor): () => void
```

Register a map-click interceptor. Returns a removal function. The most recently
added interceptor that returns true consumes the click.

### fitMapToBounds

`unstable` · since v0.10.3

```ts
fitMapToBounds(
  bounds: Bounds | null,
  padding?: number,
  minExtent?: number,
): void
```

Fit the editor map's viewport to `bounds`. A `minExtent` prevents over-zoom on tiny areas.

### getMapHost

`unstable` · since v0.8.0

```ts
getMapHost(): MapHost | null
```

Return the main editor map host, or null if not mounted.

### setDrawInterceptor

`unstable` · since v0.10.3

```ts
setDrawInterceptor(fn: DrawInterceptor | null): void
```

Set the callback for completed polygon draws. Null clears it.

### setMapHost

`unstable` · since v0.10.3

```ts
setMapHost(host: MapHost | null): void
```

Set or clear the main editor map host.

### tryInterceptClick

`unstable` · since v0.10.3

```ts
tryInterceptClick(lat: number, lng: number, shiftKey?: boolean): boolean
```

Run registered click interceptors (newest first). True if one consumed the click.

### tryInterceptDraw

`unstable` · since v0.10.3

```ts
tryInterceptDraw(rings: number[][][]): boolean
```

Pass completed polygon rings to the draw interceptor. True if it consumed them.

### waitForMapHost

`unstable` · since v0.8.0

```ts
waitForMapHost(): Promise<MapHost>
```

Wait for the main editor map to be ready.

## SceneStore

The marker scene the map surfaces render from, and its load lifecycle.

### clearScene

`unstable` · since v0.10.3

```ts
clearScene(): void
```

Clear all marker data from the scene and stop following the map.

### getMarkerDefaultColor

`unstable` · since v0.10.3

```ts
getMarkerDefaultColor(): RGBA
```

Current default marker color as RGBA.

### getScene

`unstable` · since v0.10.3

```ts
getScene(): CellManager
```

The shared scene that all map surfaces render from.

### loadScene

`unstable` · since v0.10.3

```ts
loadScene(markerStyle?: MarkerStyle, mc?: RGB): Promise<void>
```

Load the whole scene again and follow every change to it from there.

### recolorScene

`unstable` · since v0.10.3

```ts
recolorScene(mc: RGB): void
```

Change the default marker color and repaint.

### sceneReached

`unstable` · since v0.11.5

```ts
sceneReached(version: number): Promise<FrameSummary>
```

Resolves once the scene has applied the frame for map version `version`, with what that
frame did. Resolves at once, with nothing applied, when the scene follows no map.

### setMarkerDefaultColor

`unstable` · since v0.10.3

```ts
setMarkerDefaultColor(r: number, g: number, b: number): void
```

Set the default marker color (RGB bytes).

### startSceneEngine

`unstable` · since v0.10.3

```ts
startSceneEngine(): () => void
```

Start following active-location changes. Returns a stop function.

### whenSceneSettled

`unstable` · since v0.10.3

```ts
whenSceneSettled(): Promise<void>
```

Resolves when the most recently started full scene load has finished (or immediately if none is in flight).

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

## Legacy

Shims for removed APIs.

### addSelections

`unstable` · `deprecated` · since v0.5.0

```ts
addSelections(selectors: Selector[]): Promise<void>
```

**Deprecated in v0.11.3.** Use `MMA.applySelectionUpdate(MMA.addSelection(...selectors))`.

### addTagToLocations

`unstable` · `deprecated` · since v0.4.0

```ts
addTagToLocations(tagId: number, locationIds: number[]): Promise<WorkResult>
```

**Deprecated in v0.10.5.** Use `MMA.edit.work(selector, { kind: "listSet", key: "tags", add: [tagId], remove: [] })`.

### countBy

`unstable` · `deprecated` · since v0.9.0

```ts
countBy(
  selector: Selector,
  field: string,
  key: KeySpec,
): Promise<CountBy>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).countBy([field], key)`.

### countIn

`unstable` · `deprecated` · since v0.10.0

```ts
countIn(selector: Selector): Promise<number>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).count()`.

### coverage

`unstable` · `deprecated` · since v0.10.2

```ts
coverage(selector: Selector): Promise<[string, number][]>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).coverage()`.

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

### fetchAllLocations

`unstable` · `deprecated` · since v0.4.0

```ts
fetchAllLocations(): Promise<Location[]>
```

**Deprecated in v0.8.4.** Use `MMA.query({ type: "Everything" }).locations()`.

### fetchBounds

`unstable` · `deprecated` · since v0.9.0

```ts
fetchBounds(
  selector: Selector,
): Promise<[number, number, number, number] | null>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).bounds()`.

### fetchColumns

`unstable` · `deprecated` · since v0.10.0

```ts
fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).columns(fields)`.

### fetchLocation

`unstable` · `deprecated` · since v0.4.0

```ts
fetchLocation(id: number): Promise<Location>
```

**Deprecated in v0.8.4.** Use `MMA.query({ type: "Locations", locations: [id], name: null }).locations()`.

### fetchLocations

`unstable` · `deprecated` · since v0.9.0

```ts
fetchLocations(selector: Selector): Promise<Location[]>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).locations()`.

### fetchLocationsByIds

`unstable` · `deprecated` · since v0.4.0

```ts
fetchLocationsByIds(ids: number[]): Promise<Location[]>
```

**Deprecated in v0.8.4.** Use `MMA.query({ type: "Locations", locations: ids, name: null }).locations()`.

### fieldCoverage

`unstable` · `deprecated` · since v0.9.0

```ts
fieldCoverage(selector: Selector): Promise<[string, number][]>
```

**Deprecated in v0.10.2.** Use `MMA.query(selector).coverage()`.

### fieldValues

`unstable` · `deprecated` · since v0.9.0

```ts
fieldValues(selector: Selector, field: string): Promise<string[]>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).values(field)`.

### getActiveLocation

`unstable` · `deprecated` · since v0.3.1

```ts
getActiveLocation(): Location | null
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().open?.row`.

### getAllSelections

`unstable` · `deprecated` · since v0.6.3

```ts
getAllSelections(): Selection[]
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().selectionList`.

### getCurrentMap

`unstable` · `deprecated` · since v0.4.0

```ts
getCurrentMap(): MapMeta | null
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().map`.

### getCurrentMapId

`unstable` · `deprecated` · since v0.4.0

```ts
getCurrentMapId(): string | null
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().mapId`.

### getDirtyCount

`unstable` · `deprecated` · since v0.4.0

```ts
getDirtyCount(): Promise<number>
```

**Deprecated in v0.8.2.** Ask `MMA.read` for the summary and take `dirtyCount`.

### getGhostedSelections

`unstable` · `deprecated` · since v0.7.4

```ts
getGhostedSelections(): Set<string>
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().selectionList`.

### getGoogleMap

`unstable` · `deprecated` · since v0.3.1

```ts
getGoogleMap(): google.maps.Map | null
```

**Deprecated in v0.8.1.** Use `MMA.getMapHost()` and narrow via `hostInstance`.

### getSelectedLocationIds

`unstable` · `deprecated` · since v0.3.1

```ts
getSelectedLocationIds(): SelectedIds
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().selectedLocationIds`.

### getSelections

`unstable` · `deprecated` · since v0.3.1

```ts
getSelections(): Selection[]
```

**Deprecated in v0.8.2.** Use `MMA.getActiveSelections()`.

### getWorkArea

`unstable` · `deprecated` · since v0.4.0

```ts
getWorkArea(): WorkArea
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().workArea`.

### installedVersion

`unstable` · `deprecated` · since v0.10.3

```ts
installedVersion(pluginId: string): Promise<string | null>
```

**Deprecated in v0.11.0.** Use `MMA.sidecar.installedVersion()`.

### partition

`unstable` · `deprecated` · since v0.6.2

```ts
partition(
  field: string,
  key: KeySpec,
  selector: Selector,
): Promise<PartitionBucket[]>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).partition(field, key)`.

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

### removeSelections

`unstable` · `deprecated` · since v0.5.0

```ts
removeSelections(keys: string[]): Promise<void>
```

**Deprecated in v0.11.3.** Use `MMA.applySelectionUpdate(MMA.removeSelection(...keys))`.

### removeTagFromAllLocations

`unstable` · `deprecated` · since v0.4.0

```ts
removeTagFromAllLocations(tagId: number): Promise<WorkResult>
```

**Deprecated in v0.10.5.** Use `MMA.edit.work(MMA.tagSelector(tagId), { kind: "listSet", key: "tags", add: [], remove: [tagId] })`.

### removeTagFromLocations

`unstable` · `deprecated` · since v0.4.0

```ts
removeTagFromLocations(tagId: number, locationIds: number[]): Promise<WorkResult>
```

**Deprecated in v0.10.5.** Use `MMA.edit.work(selector, { kind: "listSet", key: "tags", add: [], remove: [tagId] })`.

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

**Deprecated in v0.11.3.** Use `MMA.applySelectionUpdate({ kind: "set", selections: [] })`.

### resolveIds

`unstable` · `deprecated` · since v0.10.0

```ts
resolveIds(selector: Selector): Promise<number[]>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).ids()`.

### sampleFrom

`unstable` · `deprecated` · since v0.10.0

```ts
sampleFrom(selector: Selector, n: number): Promise<number[]>
```

**Deprecated in v0.11.3.** Use `MMA.query(selector).sample(n)`.

### setUserFieldDefs

`unstable` · `deprecated` · since v0.10.3

```ts
setUserFieldDefs(fields: Record<string, FieldDef>): Promise<void>
```

**Deprecated in v0.10.5.** The user layer is Rust-owned state (`MMA.getMapState().fieldDefs`);
use `MMA.edit.meta({ extra: { fields } })` to change it, or `MMA.registerPluginFieldDefs()`
for plugin-owned defs.

### waitForGoogleMap

`unstable` · `deprecated` · since v0.5.0

```ts
waitForGoogleMap(): Promise<google.maps.Map | null>
```

**Deprecated in v0.8.1.** Use `MMA.waitForMapHost()`.
