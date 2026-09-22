# MMA API reference

Every member of the global `MMA` object (also `window.MMA`), grouped by surface.

- `stable` members keep working across releases. A rename or removal ships with a shim.
- `unstable` members are documented but can change or disappear in any release.
- `since` is the first release a member shipped in: the `minAppVersion` a plugin using it needs.

## Contents

**Stable surfaces**

- [Consts](#consts)
- [Store](#store)
- [SelectorPick](#selectorpick)
- [MapList](#maplist)
- [Registry](#registry)
- [PluginStorage](#pluginstorage)
- [PluginEvents](#pluginevents)
- [Externals](#externals)
- [Sidecar](#sidecar)
- [Ui](#ui)
- [FieldDefs](#fielddefs)
- [FieldDefRegistry](#fielddefregistry)
- [Seen](#seen)
- [Enrich](#enrich)
- [PinPano](#pinpano)
- [Validate](#validate)
- [Query](#query)
- [MapState](#mapstate)
- [ScenePositions](#scenepositions)
- [Toast](#toast)
- [UseJob](#usejob)
- [Types](#types)

**Unstable surfaces**

- [SelectionOps](#selectionops)
- [SelectionActions](#selectionactions)
- [SavedSelections](#savedselections)
- [Settings](#settings)
- [ImportStaging](#importstaging)
- [CommitDiff](#commitdiff)
- [Review](#review)
- [Commands](#commands)
- [Tauri](#tauri)
- [PluginHost](#pluginhost)
- [Marketplace](#marketplace)
- [Scope](#scope)
- [FieldProjections](#fieldprojections)
- [Procedures](#procedures)
- [SeenRecorder](#seenrecorder)
- [Pano](#pano)
- [Providers](#providers)
- [SceneStore](#scenestore)
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
EFFECT_CALLS: readonly ["fetch", "fetchMany", "panos", "sidecar"]
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

### LocationFlag

`stable` · since v0.11.0

```ts
LocationFlag: {
  /** No flags set. */
  None: 0;
  /** When the location has a stored pano, it opens exactly that pano instead of the nearest coverage. */
  LoadAsPanoId: 1;
  /** Legacy marker (web). Kept as imported, with no effect in the app. */
  Informational: 2;
  /** A location from a pending import, opened for preview and not yet on the map. */
  ImportPreview: 4;
  /** A pano opened from the seen history overlay, not yet on the map. */
  SeenOverlay: 8;
}
```

Per-location bitfield, serialized as a plain `u32` over IPC and Arrow.

### MergeWinner

`stable` · since v0.11.0

```ts
MergeWinner: { readonly From: "from"; readonly To: "to" }
```

When a move target already holds a value, which side survives.

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

### ValidationState

`stable` · since v0.11.0

```ts
ValidationState: {
  /** The location's coverage checked out, with nothing to report. */
  Ok: 0;
  /** The location is pinned to a pano, and newer official coverage exists that it does not show. */
  UpdateAvailable: 1;
  /** Newer official coverage exists here, and the unpinned location already shows it. */
  UpdateApplied: 2;
  /** The location shows bad-camera coverage, but its timeline holds a better camera capture. */
  GoodcamAvailable: 6;
  /** The location's pinned pano no longer loads, though coverage still exists at its coordinates. */
  PanoIdBroke: 4;
  /** The coverage the location shows is unofficial. */
  Unofficial: 5;
  /** No coverage was found, neither the stored pano nor any within the search radius. */
  NotFound: 3;
}
```

Outcome of a Street View coverage check, as `validate` answers it per row.

### VIRTUAL_FLAGS

`unstable` · since v0.10.3

```ts
VIRTUAL_FLAGS: 12
```

## Store

### addLocations

`stable` · since v0.3.1

```ts
addLocations(locs: Location[]): Promise<void>
```

Add locations to the map. Real ids are assigned and written back into the passed
objects - build with `createLocation` (id 0) and read `loc.id` after. Undoable.
Emits `location:add`.

### addSelections

`stable` · since v0.5.0

```ts
addSelections(selectors: Selector[]): Promise<void>
```

Add selectors to the active selection list.

### applyFieldOp

`unstable` · since v0.10.0

```ts
applyFieldOp(
  selector: Selector,
  op: FieldOp,
  recordUndo: boolean,
): Promise<FieldOpResult>
```

Apply a field operation across all locations matching `selector`. Emits `location:invalidate`.

### applySelectionUpdate

`unstable` · since v0.10.3

```ts
applySelectionUpdate(
  op: (sels: Selection[], ghosted: ReadonlySet<string>) => Selection[] | SelectionPatch,
): Promise<void>
```

Apply a selection transform function and re-resolve the selection.
The function receives the current selections and ghosted set, and returns either
a new `Selection[]` or a `SelectionPatch`. No-op when nothing changed.

### cancelAutosave

`unstable` · since v0.8.1

```ts
cancelAutosave(): void
```

Cancel any pending autosave timer.

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

### countBy

`stable` · since v0.9.0

```ts
countBy(
  selector: Selector,
  field: string,
  key: KeySpec,
): Promise<CountBy>
```

Group by a derived key and count.

### countIn

`stable` · since v0.10.0

```ts
countIn(selector: Selector): Promise<number>
```

How many locations the selector resolves to.

### coverage

`stable` · since v0.10.2

```ts
coverage(selector: Selector): Promise<[string, number][]>
```

How many locations hold a value for each field, key-sorted.

### createTags

`stable` · since v0.4.0

```ts
createTags(names: string[], selector?: Selector): Promise<Tag[]>
```

Get-or-create tags by name (case-insensitive; ids are allocated by the store) and
return them in request order. Pass `selector` to also put the tags on those
locations. Emits `tag:add`.

### currentSelection

`stable` · since v0.10.0

```ts
currentSelection(): Selector
```

The live selection as a `Selector`: the union of the active selection nodes.

### deleteField

`stable` · since v0.5.1

```ts
deleteField(key: string): Promise<void>
```

Delete extra-field `key` from every location, its definition, and references.

### deleteTags

`stable` · since v0.4.0

```ts
deleteTags(tagIds: number[]): Promise<void>
```

Delete tags: strip them from every location in one undoable mutation. The emptied
metadata goes dark (count 0 hides it); undo restores the rows and the tags with
them. Emits `tag:remove`.

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

### emitBitmask

`unstable` · since v0.5.3

```ts
emitBitmask(bytes: number[]): void
```

Decode a selection bitmask and draw it on the map.

### exitPluginMode

`stable` · since v0.3.1

```ts
exitPluginMode(): void
```

Close the plugin sidebar and return to the overview.

### fetchBounds

`stable` · since v0.9.0

```ts
fetchBounds(
  selector: Selector,
): Promise<[number, number, number, number] | null>
```

Bounding box `[west, south, east, north]`, or null when the selector is empty.

### fetchColumns

`stable` · since v0.10.0

```ts
fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]>
```

One column per field over the selected set. `null` where a location
lacks the field; `"tags"` returns a column of tag-id arrays.

### fetchLocations

`stable` · since v0.9.0

```ts
fetchLocations(selector: Selector): Promise<Location[]>
```

Fetch full location rows matching a selector. Missing ids are skipped.

Every row lands in memory, so an unscoped call on a large map is expensive.
Prefer a narrower selector or a projection (`fetchColumns`, `countBy`) when possible.

### fieldValues

`stable` · since v0.9.0

```ts
fieldValues(selector: Selector, field: string): Promise<string[]>
```

Distinct values of `field`, sorted.

### flushSave

`unstable` · since v0.4.0

```ts
flushSave(): Promise<void>
```

Save any unsaved changes now instead of waiting for the autosave timer.

### getActiveSelections

`stable` · since v0.8.2

```ts
getActiveSelections(): Selection[]
```

Active (non-ghosted) selections, the default for any operational logic.

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

Per-tag location counts: `valueCounts.tags` re-keyed by numeric id.

### getTags

`stable` · since v0.11.1

```ts
getTags(): Record<number, Tag>
```

The tag view: `valueMeta.tags` piles dressed over the counts, recomputed only when
either slice moves. A tag is visible exactly while something carries it (count > 0);
a value present in data without metadata (foreign import) shows under a derived
name/color; emptied metadata lingers dark until its name is reused.

### getVisibleTags

`stable` · since v0.4.0

```ts
getVisibleTags(): Tag[]
```

Tags that exist from the user's point of view: the ones something carries. Raw
`tags` also holds dark metadata ghosts (count=0, visible=false) - almost nothing
should enumerate those.

### holdAutosave

`unstable` · since v0.10.0

```ts
holdAutosave(): () => void
```

Defer autosave until the returned release function runs. Useful for batches that land many mutations.

### initStore

`unstable` · since v0.4.0

```ts
initStore(): Promise<void>
```

One-time store startup. The app calls this; plugins never need to.

### mergeDuplicates

`unstable` · since v0.5.1

```ts
mergeDuplicates(distance: number): Promise<void>
```

Merge each transitive duplicate group into one survivor (tags unioned), ranked by the
map's duplicate preference. One undoable edit.

### mutate

`unstable` · since v0.4.0

```ts
mutate(fn: () => Promise<MutationResult>): Promise<MutationResult>
mutate<
  R extends {
    mutation: MutationResult;
  },
>(fn: () => Promise<R>, empty: R): Promise<R>
```

Run a mutation, apply its result to the map, and schedule a save. A result that wraps its
mutation comes back whole; `empty` is its answer when no map is open.

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

Open a staged-import location read-only, as if it were active. It is not on the map and
cannot be edited.

### partition

`stable` · since v0.6.2

```ts
partition(
  field: string,
  key: KeySpec,
  selector: Selector,
): Promise<PartitionBucket[]>
```

Group the selected location set by a derived key. Numeric bins arrive in bound order;
other keys are sorted naturally.

### patchMapMeta

`stable` · since v0.10.1

```ts
patchMapMeta(id: string, patch: MapMetaPatch_Deserialize): Promise<void>
```

Patch any map's metadata by id and persist it. Updates the open map's state when it is that map.

### previewDuplicateGroups

`unstable` · since v0.5.1

```ts
previewDuplicateGroups(distance: number): Promise<number[][]>
```

Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres.

### previewVirtualLocation

`unstable` · since v0.6.3

```ts
previewVirtualLocation(loc: Location): void
```

Open an arbitrary location read-only as a virtual seen-preview: loads its pano without
adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves.

### pruneDuplicates

`unstable` · since v0.6.0

```ts
pruneDuplicates(selector: Selector, distance: number): Promise<number>
```

Prune duplicates within a resolved selection: keeps the most relevant location per
cluster (<= 25m) or thins to enforce spacing (> 25m). Returns the number pruned.

### redo

`stable` · since v0.4.0

```ts
redo(): Promise<void>
```

Redo the last undone edit.

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

### removeSelections

`stable` · since v0.5.0

```ts
removeSelections(keys: string[]): Promise<void>
```

Drop selections by key.

### renameField

`stable` · since v0.5.1

```ts
renameField(
  from: string,
  to: string,
  winner?: MergeWinner,
): Promise<void>
```

Rename extra-field `from` to `to` across all locations, its definition, and selections.
When a location already holds `to`, `winner` decides which value survives.

### renameTagsIn

`stable` · unreleased

```ts
renameTagsIn(
  tagIds: number[],
  name: string,
  selector: Selector,
): Promise<void>
```

Move the locations `selector` picks that carry any of `tagIds` onto the tag named `name`,
found or created, in one undoable mutation. Every other location keeps its tags, so a tag
the selection only partly covers splits in two.

### reorderTags

`stable` · since v0.4.0

```ts
reorderTags(orderedIds: number[]): Promise<void>
```

Persist a new tag display order.

### resetSelections

`stable` · since v0.4.0

```ts
resetSelections(): Promise<void>
```

Clear all selections.

### resolveIds

`stable` · since v0.10.0

```ts
resolveIds(selector: Selector): Promise<number[]>
```

Ids of every location the selector resolves to.

### resolveLocation

`stable` · since v0.6.6

```ts
resolveLocation(m: MaybeLocation): Promise<Location | null>
```

Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found.

### sampleFrom

`stable` · since v0.10.0

```ts
sampleFrom(selector: Selector, n: number): Promise<number[]>
```

`n` ids drawn uniformly at random, without replacement.

### scheduleAutoCommit

`unstable` · since v0.8.1

```ts
scheduleAutoCommit(mapId: string, importedCount: number): void
```

Background auto-commit after an import with autoCommit set.

### scheduleSave

`unstable` · since v0.4.0

```ts
scheduleSave(): void
```

Schedule a debounced autosave. Mutations call this automatically.

### selectEvenlySpacedFromSelection

`unstable` · since v0.11.0

```ts
selectEvenlySpacedFromSelection(
  opts: {
    count?: number;
    spacingM?: number;
  },
  perSelection?: boolean,
): Promise<{
  picked: number;
  distanceM: number;
}>
```

Replace the current selection with evenly spaced ids laid out on a honeycomb - either at
most `count` ids spaced as widely as that allows, or ids about `spacingM` apart. No two
picks sit closer than half the spacing. With `perSelection`, each active selection is
picked from separately. Returns the count picked and the spacing used.

### selectRandomFromSelection

`unstable` · since v0.5.2

```ts
selectRandomFromSelection(count: number, perSelection?: boolean): Promise<number>
```

Replace the current selection with up to `count` ids picked at random.
With `perSelection`, picks up to `count` from each active selection separately.
Returns the number of ids actually picked (0 when nothing is selected).

### selectSpacedFromSelection

`unstable` · since v0.7.4

```ts
selectSpacedFromSelection(
  opts: {
    count?: number;
    minDistanceM?: number;
  },
  perSelection?: boolean,
): Promise<{
  picked: number;
  distanceM: number;
}>
```

Replace the current selection with spatially spaced ids - either `count` ids maximizing
spacing, or as many as fit at `minDistanceM`. With `perSelection`, each active selection
is picked from separately. Returns the count picked and the minimum distance achieved.

### setActiveLocation

`stable` · since v0.3.1

```ts
setActiveLocation(
  target: MaybeLocation | null,
  checkDuplicates?: boolean,
): Promise<void>
```

Open a location in the editor (null closes it). With `checkDuplicates`, opening a spot
with 2+ locations within 2m opens the duplicate-resolution panel instead.

### setMapExtraFields

`stable` · since v0.4.0

```ts
setMapExtraFields(fields: Record<string, FieldDef>): Promise<void>
```

Replace the map's extra-field definitions (types/labels for `Location.extra` keys).

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

### setTags

`stable` · since v0.11.1

```ts
setTags(
  add: number[],
  remove: number[],
  selector: Selector,
): Promise<void> | Promise<FieldOpResult>
```

Put `add` on every location the selector resolves to and strip `remove` from them,
in one undoable mutation. There is no tag-specific write path: `tags` is an ordinary
list-valued field, so this is the same `listSet` any `array` field takes. Locations
already in the requested state are untouched; `add` wins for a tag in both lists.

### setWorkArea

`unstable` · since v0.4.0

```ts
setWorkArea(area: WorkArea): void
```

Transition the editor pane, enforcing state invariants:
leaving "location" clears the active location, leaving "plugin" clears the plugin id.

### syncSelections

`unstable` · since v0.4.0

```ts
syncSelections(): Promise<void>
```

Re-resolve all selections against the current map data and update the overlay.
Use when the underlying data changed but the selections themselves did not.

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
updateLocations(
  updates: Update<LocationPatch_Deserialize>[],
  opts?: {
    undoable?: boolean;
  },
): Promise<void>
```

Patch locations by id. Only include the fields you're changing; `extra` merges
per-key (null deletes a key). Undoable by default.

### updateMapMeta

`stable` · since v0.4.0

```ts
updateMapMeta(patch: MapMetaPatch_Deserialize): Promise<void> | undefined
```

`patchMapMeta` for the map open in this window.

### updateTags

`stable` · since v0.4.0

```ts
updateTags(updates: Update<TagPatch>[]): Promise<void>
```

Rename or recolor tags. A rename colliding with an existing tag name
(case-insensitive) merges the two: every location is remapped to the survivor
(undoable) and the emptied source's metadata goes dark.

### useMapState

`stable` · since v0.8.2

```ts
useMapState<T>(selector: (s: MapState) => T): T
```

Reactive slice of the map state. Re-renders only when the selected value's
reference changes (`Object.is`), so selectors must return state fields or
memoized values, not a new value per call.

### waitForInflightPersist

`unstable` · since v0.8.1

```ts
waitForInflightPersist(): Promise<void> | null
```

Wait for any in-progress save to finish.

## SelectorPick

### createSelectorPick

`stable` · since v0.10.0

```ts
createSelectorPick(initial?: SelectorPick): SelectorPickHandle
```

A standalone "all locations vs current selection" switch, for features that operate on a subset.

### selectorForPick

`stable` · since v0.10.0

```ts
selectorForPick(choice: SelectorPick): Selector
```

Convert a picker choice into the corresponding `Selector`.

### useSelectorPick

`stable` · since v0.10.0

```ts
useSelectorPick(initial?: SelectorPick): SelectorPickController
```

React hook: selector state with live counts. Defaults to the current selection when one
exists, else all locations. Use `createSelectorPick` when non-React code also reads the selector.

## MapList

### createMap

`stable` · since v0.4.0

```ts
createMap(name: string, folder?: string | null): Promise<MapMeta>
```

Create a new empty map and return its metadata.

### deleteFolder

`stable` · since v0.4.0

```ts
deleteFolder(name: string): Promise<void>
```

Delete a folder. Maps in it become unfoldered.

### deleteMap

`stable` · since v0.4.0

```ts
deleteMap(id: string): Promise<void>
```

Permanently delete a map and all its data. Not undoable.

### getMapBadges

`unstable` · unreleased

```ts
getMapBadges(): Map<string, MapBadge[]>
```

Badges per map id, from every registered source.

### getMapBadgeSources

`unstable` · unreleased

```ts
getMapBadgeSources(): readonly BadgeSource[]
```

Every registered badge source, in registration order.

### getMapList

`stable` · since v0.7.0

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

`stable` · since v0.4.0

```ts
moveMapToFolder(mapId: string, folder: string | null): Promise<void>
```

Move a map into a folder, or to the root when `folder` is null.

### openScratchMap

`stable` · since v0.10.1

```ts
openScratchMap(): Promise<void>
```

Open the scratch map, creating it on first use.

### registerMapBadges

`unstable` · unreleased

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

`stable` · since v0.4.0

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

`unstable` · unreleased

```ts
useMapBadges(): Map<string, MapBadge[]>
```

Reactive {@link getMapBadges}.

### useMapList

`stable` · since v0.4.0

```ts
useMapList(): MapMeta[]
```

Reactive list of all maps (metadata only).

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

### reloadStorage

`unstable` · unreleased

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

## Ui

### ui

`stable` · since v0.6.1

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
  children: ReactNode;
}): react.JSX.Element
```

Standard right-hand sidebar chrome (title, back button, scrollable body). Use for plugin sidebars.

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

## FieldDefs

### derivedFrom

`unstable` · since v0.10.3

```ts
derivedFrom(changed: Iterable<string>): Set<string>
```

Every field transitively derived from the `changed` keys via the provider graph.

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

### withoutDerivedFrom

`unstable` · since v0.10.3

```ts
withoutDerivedFrom(
  extra: Record<string, unknown> | null,
  changed: Iterable<string>,
): Record<string, unknown> | null
```

Remove fields transitively derived from `changed` from an `extra` record.

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

### getKnownFieldKeys

`stable` · since v0.5.0

```ts
getKnownFieldKeys(): ReadonlySet<string>
```

Keys some location on this map carries. Same reference until the user layer moves.

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

## Seen

### clearSeen

`stable` · since v0.4.0

```ts
clearSeen(): Promise<void>
```

Delete the entire seen history. Not undoable.

### getSeenCount

`stable` · since v0.4.0

```ts
getSeenCount(filter?: SeenFilter): Promise<number>
```

Number of seen entries matching the filter (all when omitted).

### getSeenCountries

`stable` · since v0.10.3

```ts
getSeenCountries(): Promise<string[]>
```

Distinct country codes that appear in the seen history.

### getSeenEntries

`stable` · since v0.4.0

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

`stable` · since v0.10.3

```ts
getSeenMaps(): Promise<SeenMapInfo[]>
```

Maps that have seen-history entries.

## Enrich

### enrich

`stable` · since v0.10.3

```ts
enrich(
  loc: Location,
  opts?: Omit<RunOpts, "onProgress">,
): Promise<Location>
```

Enrich a single location with the map's enabled metadata fields. Existing fields are
kept unless `force` re-derives all of them. Returns the enriched location without
writing it. Returns the location unchanged when enrichment is disabled.

### enrichAll

`stable` · since v0.4.0

```ts
enrichAll(selector: Selector, opts?: RunOpts): Promise<EnrichOutcome[]>
```

Bulk-enrich a selector: resolve missing pano ids, then run every field-producing
provider (metadata, exact date, timezone, subdivision).

## PinPano

### bulkPinToPano

`stable` · since v0.4.0

```ts
bulkPinToPano(selector: Selector, opts?: PinOpts): Promise<PinOutcome>
```

Pin every location in the selector to its pano id, resolving pano ids first when asked.

## Validate

### validateLocations

`stable` · since v0.4.0

```ts
validateLocations(
  selector: Selector,
  opts?: BulkOpts & {
    config?: Partial<ValidateConfig>;
  },
): Promise<ValidationOutcome>
```

Check that each location's Street View coverage still exists.

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

## MapState

### addClickInterceptor

`stable` · since v0.10.3

```ts
addClickInterceptor(fn: ClickInterceptor): () => void
```

Register a map-click interceptor. Returns a removal function. The most recently
added interceptor that returns true consumes the click.

### fitMapToBounds

`stable` · since v0.10.3

```ts
fitMapToBounds(
  bounds: Bounds | null,
  padding?: number,
  minExtent?: number,
): void
```

Fit the editor map's viewport to `bounds`. A `minExtent` prevents over-zoom on tiny areas.

### getMapHost

`stable` · since v0.8.0

```ts
getMapHost(): MapHost | null
```

Return the main editor map host, or null if not mounted.

### setDrawInterceptor

`stable` · since v0.10.3

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

`stable` · since v0.8.0

```ts
waitForMapHost(): Promise<MapHost>
```

Wait for the main editor map to be ready.

## ScenePositions

### getScenePositions

`stable` · since v0.9.0

```ts
getScenePositions(): {
  ids: Uint32Array;
  positions: Float32Array;
}
```

Snapshot of every rendered location's id and position (`[lng, lat, ...]`).

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

### applyLocationPatch

`stable` · since v0.10.3

```ts
applyLocationPatch(loc: Location, patch: LocationPatch_Deserialize): Location
```

Apply a LocationPatch to a location. `extra` follows JSON Merge Patch (RFC 7386):
keys shallow-merge, a null value deletes its key, and a null patch clears extra.

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

Build a Location from lat/lng plus overrides. `id` stays 0 until `addLocations`
writes the real id back into the object.

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

### extraPatch

`stable` · since v0.10.3

```ts
extraPatch(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, unknown>
```

The `extra` merge patch that turns `before` into `after`: changed keys carry their
new value, keys `after` lacks carry null.

### isImportPreview

`unstable` · since v0.10.3

```ts
isImportPreview(loc: Location): boolean
```

True when the location is an import preview (not yet committed).

### isPinned

`stable` · since v0.10.3

```ts
isPinned(loc: Location): loc is Location & {
  panoId: string;
}
```

Pinned: the location always opens this exact pano.

### isSeenPreview

`unstable` · since v0.10.3

```ts
isSeenPreview(loc: Location): boolean
```

True when the location is a seen-history overlay preview.

### isVirtualLocation

`stable` · since v0.10.3

```ts
isVirtualLocation(loc: { id: number }): boolean
```

True for virtual (preview-only) locations, which have negative ids and are not
part of the map.

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

### sameRow

`unstable` · since v0.10.3

```ts
sameRow(a: Location, b: Location): boolean
```

The same location on the same pano: what makes one row's answer another row's.

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

# Unstable surfaces

Everything below can change in any release.

## SelectionOps

Pure transforms over the selection list behind the sidebar.

### addSelection

`unstable` · since v0.4.0

```ts
addSelection(selector: Selector): (current: Selection[]) => Selection[]
```

Append a new selection built from `selector`, deduplicating by key.

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

### batch

`unstable` · since v0.10.3

```ts
batch<T, S>(
  op: (item: T) => (state: S) => S,
): (items: T[]) => (state: S) => S
```

Lift a single-item curried transform into one that folds over an array of items.

### buildSelection

`unstable` · since v0.10.3

```ts
buildSelection(selector: Selector): Selection
```

Create a Selection with a deterministic key and color from its selector.

### childSelections

`unstable` · since v0.10.5

```ts
childSelections(selector: Selector): Selection[]
```

Every child selection a selector wraps, whatever shape it wraps them in.

### colorForKey

`unstable` · since v0.10.3

```ts
colorForKey(key: string): RGB
```

Deterministic color derived from a selection key string.

### composeSelections

`unstable` · since v0.4.0

```ts
composeSelections(
  dragKey: string,
  dropKey: string,
  mode: GroupType,
  dragParent?: string | null,
  dropParent?: string | null,
): (current: Selection[]) => Selection[]
```

Merge the dragged selection into the drop target as a composite, absorbing existing
children of the same type. Handles nested cases across parent groups.

### composeSiblings

`unstable` · since v0.10.3

```ts
composeSiblings(
  current: Selection[],
  parentKey: string,
  dragKey: string,
  dropKey: string,
  mode: GroupType,
): Selection[]
```

Compose two siblings inside the same parent group into a nested composite.

### composeWithChild

`unstable` · since v0.10.3

```ts
composeWithChild(
  current: Selection[],
  dragKey: string,
  parentKey: string,
  childKey: string,
  mode: GroupType,
): Selection[]
```

Compose a top-level selection with a child inside a parent group.

### decomposeChild

`unstable` · since v0.4.0

```ts
decomposeChild(
  parentKey: string,
  childKey: string,
): (current: Selection[]) => Selection[]
```

Pull a child out of a composite back into the top-level list, children and all. Parent collapses
if only one child remains, and disappears if none do.

### displayTagName

`unstable` · since v0.10.3

```ts
displayTagName(name: string): string
```

Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
the `/`-path to its shortest unique suffix; otherwise returns the name verbatim.

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
intersectSelections(
  keys?: string[] | null,
): (current: Selection[]) => Selection[]
```

Merge the targeted selections (or all, when `keys` is null) into a single Intersection.

### invertSelections

`unstable` · since v0.10.3

```ts
invertSelections(
  keys?: string[] | null,
): (current: Selection[]) => Selection[]
```

Invert targeted selections. Single target toggles in-place at any depth; multiple are wrapped in Union then Invert.

### isolateGhost

`unstable` · since v0.10.3

```ts
isolateGhost(
  key: string,
): (sels: Selection[], ghosted: ReadonlySet<string>) => SelectionPatch
```

Solo one selection by ghosting all others. Repeat to clear all ghosts.

### isolateGhostKeys

`unstable` · since v0.10.3

```ts
isolateGhostKeys(
  keys: string[],
  ghosted: ReadonlySet<string>,
  key: string,
): Set<string>
```

Ghost keys that "solo" `key`: everything except it. Returns an empty set when `key`
is already the sole visible selection, so a repeat call un-isolates (clears all ghosts).

### lacks

`unstable` · since v0.11.0

```ts
lacks(field: string): Selector
```

Locations holding no value for `field`.

### locationsKey

`unstable` · since v0.10.7

```ts
locationsKey(ids: number[]): string
```

Key an id list by hashing it: the same ids in the same order give the same key.
Order-sensitive, like the list it identifies. Key length is constant.

### not

`unstable` · since v0.11.0

```ts
not(selector: Selector): Selector
```

Locations not matching `selector`.

### OP_LABELS

`unstable` · since v0.10.3

```ts
OP_LABELS: Record<
  | "has"
  | "nothas"
  | "eq"
  | "neq"
  | "contains"
  | "notcontains"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "between"
  | "between_anyyear"
  | "between_anytime",
  string
>
```

### panoIdOf

`unstable` · since v0.11.1

```ts
panoIdOf(selector: Selector): boolean | null
```

Whether a selector is the pinned composite `panoIdSelector` builds (`true`), its
inversion (`false`), or something else (`null`). Display-only.

### panoIdSelector

`unstable` · since v0.11.1

```ts
panoIdSelector(on: boolean): Selector
```

Locations pinned to one exact pano (the flag plus a pano id, mirroring Rust's
`Selector::pano_ids`), or the locations not pinned.

### removeFromComposite

`unstable` · since v0.10.3

```ts
removeFromComposite(
  parentKey: string,
  childKey: string,
): (current: Selection[]) => Selection[]
```

Remove a child from a composite, ungrouping any nested group's children into the parent.

### removeSelection

`unstable` · since v0.4.0

```ts
removeSelection(key: string): (current: Selection[]) => Selection[]
```

Remove a selection by key. Composites unwrap their children back into the list.

### reorderSelections

`unstable` · since v0.10.3

```ts
reorderSelections(
  fromKey: string,
  toKey: string,
  position: "before" | "after",
): (current: Selection[]) => Selection[]
```

Move selection `fromKey` before or after `toKey` in the list.

### replaceSelection

`unstable` · since v0.10.3

```ts
replaceSelection(
  current: Selection[],
  oldKey: string,
  selector: Selector,
): Selection[]
```

Replace the selection at `oldKey` (at any depth) with one built from `selector`. If the new
key collides with an existing selection, the existing one wins and the replacement is dropped.

### rewriteSelectionFields

`unstable` · since v0.10.3

```ts
rewriteSelectionFields(
  from: string,
  to: string | null,
): (selections: Selection[]) => Selection[]
```

Rename or remove a field across all Filter selections. When `to` is null, filters on that field are dropped.

### sampleIds

`unstable` · since v0.10.3

```ts
sampleIds(ids: number[], n: number): number[]
```

Pick `n` distinct ids uniformly at random from `ids`. `n` is floored and clamped to
`[0, ids.length]`, so an over-large count returns all ids. `ids` is not mutated.

### selectionDisplayName

`unstable` · since v0.10.3

```ts
selectionDisplayName(sel: Selection, tagNames?: Record<number, string>): string
```

Human-readable label for a selection. Pass `tagNames` to resolve tags by saved name
rather than the open map's tags.

### SELECTIONS

`unstable` · since v0.10.3

```ts
SELECTIONS: {
  Locations: SelectionDescriptor<"Locations">;
  Everything: SelectionDescriptor<"Everything">;
  Polygon: SelectionDescriptor<"Polygon">;
  Uncommitted: SelectionDescriptor<"Uncommitted">;
  Manual: SelectionDescriptor<"Manual">;
  Duplicates: SelectionDescriptor<"Duplicates">;
  ValidationState: SelectionDescriptor<"ValidationState">;
  Reviewed: SelectionDescriptor<"Reviewed">;
  Intersection: SelectionDescriptor<"Intersection">;
  Union: SelectionDescriptor<"Union">;
  Invert: SelectionDescriptor<"Invert">;
  Filter: SelectionDescriptor<"Filter">;
  Ranked: SelectionDescriptor<"Ranked">;
}
```

Per-type descriptor for each selector variant: key derivation, display label, and optional color/location overrides.

### setPolygonName

`unstable` · since v0.4.0

```ts
setPolygonName(
  key: string,
  name: string,
): (current: Selection[]) => Selection[]
```

Rename a Polygon selection's display name.

### setSelectionColors

`unstable` · since v0.5.0

```ts
setSelectionColors(entries: Selection[]): (current: Selection[]) => Selection[]
```

Update the colors of selections by matching keys from `entries`.

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
toggleGhost(
  key: string,
): (_sels: Selection[], ghosted: ReadonlySet<string>) => SelectionPatch
```

Toggle one selection's ghosted (dimmed) state.

### toggleGhostAll

`unstable` · since v0.10.3

```ts
toggleGhostAll(): (
  sels: Selection[],
  ghosted: ReadonlySet<string>,
) => SelectionPatch
```

Ghost all selections, or clear all ghosts if every selection is already ghosted.

### toggleManualSelection

`unstable` · since v0.4.0

```ts
toggleManualSelection(locationId: number): (current: Selection[]) => Selection[]
```

Add or remove a location from the Manual selection, creating it if needed.

### UNARY_TYPES

`unstable` · since v0.10.3

```ts
UNARY_TYPES: readonly ["Invert"]
```

### unionSelections

`unstable` · since v0.10.3

```ts
unionSelections(
  keys?: string[] | null,
): (current: Selection[]) => Selection[]
```

Merge the targeted selections (or all, when `keys` is null) into a single Union.

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
withChildren(selector: Selector, children: Selection[]): Selector
```

`selector` with its children replaced, keeping the shape it wraps them in.

## SelectionActions

Editing the selection list the way the sidebar does.

### getSelectedTagIds

`unstable` · since v0.8.2

```ts
getSelectedTagIds(): ReadonlySet<number>
```

Tag ids that currently have a top-level Tag selection active.

### getSelectedTagIdsDeep

`unstable` · since v0.9.2

```ts
getSelectedTagIdsDeep(): readonly number[]
```

Tag ids of every Tag leaf in the active selection tree, in list order.
Includes composite children, excludes ghosted selections; ids may repeat.

### toggleTagSelections

`unstable` · since v0.4.0

```ts
toggleTagSelections(tagIds: number[]): void
```

Toggle tag selections on or off for the given tags.

### updateFilterSelection

`unstable` · since v0.5.1

```ts
updateFilterSelection(oldKey: string, selector: Selector): Promise<void>
```

Edit an existing filter (or any selection) in place by key, preserving its
position inside any AND/OR/Invert composite. Carries ghost state to the new key.

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
MAP_LOCAL_TYPES: readonly ["Locations", "Manual", "ValidationState", "Reviewed"]
```

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

### savedSelector

`unstable` · since v0.10.0

```ts
savedSelector(id: string): Selector
```

A saved rule as a single `Selector`, resolved against the open map. Matches nothing
until the body arrives; fetching it emits `saved-selections:changed`, so a caller that
re-reads on that event gets the real tree.

### useSavedSelectionIndex

`unstable` · since v0.10.3

```ts
useSavedSelectionIndex(): SavedSelectionInfo[]
```

React hook: the saved selection index, re-rendering on changes.

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
  defaultMovementMode: "moving" | "no-move" | "nmpz";
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
  seenResolution: "low" | "medium" | "high";
  mapPanSpeed: number;
  panoLookSpeed: number;
  slowModifier: number;
  showFps: boolean;
  mapListFields: ("locationCount" | "lastOpened" | "created")[];
  /** Ids of map-row badge sources the user turned off. */
  hiddenMapBadges: string[];
  /** Read once at boot; changing it relaunches the app rather than re-rendering. */
  language: "en" | "de" | "es" | "fr" | "ja" | "pl" | "ru" | "zh-Hans" | "en-XA";
  /** Every distance the UI shows or accepts; stored values stay metric. */
  units: "auto" | "metric" | "imperial";
  /** Reopen the maps that were open when the session last ended (main window closed). */
  restoreSession: boolean;
  /** Offer pre-release builds to the updater as well as full releases. */
  prereleaseUpdates: boolean;
  /** Discord Rich Presence: off, generic (no map name), or full (map name + count). */
  discordPresence: "off" | "generic" | "full";
  /** Per-label color overrides (hex), keyed by lowercased label name. Shared across all maps. */
  labelColors: Record<string, string>;
  geocodeProvider: "local" | "nominatim" | "google";
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
  polygonColorMode: "random" | "fixed";
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
  borderDetail: "medium" | "light" | "heavy";
  subdivisionDetail: "off" | "adm1";
  previewAspectRatio: "4 / 3" | "16 / 10" | "16 / 9" | "21 / 9" | "32 / 9" | "free";
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
GEOCODE_PROVIDER_LABELS: Record<"local" | "nominatim" | "google", string>
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
MOVEMENT_CYCLE: ("moving" | "no-move" | "nmpz")[]
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
  | "showCameraBadges"
  | "showLinksControl"
  | "clickToGo"
  | "showRoadLabels"
  | "defaultMovementMode"
  | "showCar"
  | "showCrosshair"
  | "showCompass"
  | "showCompassTape"
  | "showZoom"
  | "showReturnToSpawn"
  | "showJumpButtons"
  | "showMapLinks"
  | "showCoordinateDisplay"
  | "showFullscreenButton"
  | "showScreenshotButton"
  | "showPanoMetadata"
  | "exactDateFormat"
  | "dateTimezone"
  | "showNavArrow"
  | "showGroundArrow"
  | "hidePanoUI"
  | "hideNavWithUI"
  | "fullscreenMap"
  | "showFullscreenMapMeta"
  | "showFullscreenMiniLocationPreview"
  | "fullscreenMiniLocationScale"
  | "showFullscreenMinimap"
  | "fullscreenMinimapScale"
  | "fullscreenMinimapCloseDelay"
  | "showFullscreenTagbar"
  | "showFullscreenDatePicker"
  | "showFullscreenReviewBar"
  | "showFullscreenGeocode"
  | "customCss"
  | "enableSeen"
  | "enableSeenThumbnails"
  | "seenResolution"
  | "mapPanSpeed"
  | "panoLookSpeed"
  | "slowModifier"
  | "showFps"
  | "mapListFields"
  | "hiddenMapBadges"
  | "language"
  | "units"
  | "restoreSession"
  | "prereleaseUpdates"
  | "discordPresence"
  | "labelColors"
  | "geocodeProvider"
  | "nominatimApiKey"
  | "panToImported"
  | "enterOpensCenter"
  | "pastePadding"
  | "followActiveInReview"
  | "markerColor"
  | "activeLocationColor"
  | "importPreviewColor"
  | "svTrail"
  | "svTrailColor"
  | "svTrailPosition"
  | "panoDotColor"
  | "opacityToggleMode"
  | "polygonColorMode"
  | "polygonColor"
  | "panoDotScaled"
  | "tagViewMode"
  | "truncateTagPaths"
  | "tagFolderColorMode"
  | "tagFolderColor"
  | "tagSortMode"
  | "tagGap"
  | "animateTagReorder"
  | "borderDetail"
  | "subdivisionDetail"
  | "previewAspectRatio"
  | "tagSuggestionLimit"
  | "remoteApi"
  | "remoteApiKey"
  | "pinnedCommands"
>
```

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
  tagName?: string,
): Promise<EditorImportResult | null>
```

Commit the staged import, optionally dropping fields and applying a bulk tag.

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

### resetImportState

`unstable` · since v0.8.1

```ts
resetImportState(): void
```

Clear staged import state.

## CommitDiff

Uncommitted changes and their preview on the map.

### beginCommitDiffPreview

`unstable` · since v0.5.1

```ts
beginCommitDiffPreview(commit: CommitInfo): Promise<void>
```

Fetch a commit's delta and overlay its added/removed/modified locations on the map,
temporarily replacing the regular markers.

### categorizeCommitDelta

`unstable` · since v0.5.1

```ts
categorizeCommitDelta(delta: CommitDelta): {
  added: Location[];
  removed: Location[];
  modified: Location[];
}
```

Split a commit delta into added, removed, and modified locations. A location on both
sides of the delta counts as modified.

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

Whether there are uncommitted changes (adds, removes, or modifications).

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
useCommitDiff(): CommitDiff
```

React hook: the uncommitted add/remove/modify counts, kept in sync with the store.

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

`unstable` · unreleased

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
was the last item. Emits `location:remove`.

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

### reviewSet

`unstable` · unreleased

```ts
reviewSet(s: ReviewSession, mode: ReviewMode): number[]
```

The session's locations in `mode`: those reviewed, or those still to review.

### selectReviewedHistory

`unstable` · since v0.6.3

```ts
selectReviewedHistory(): Promise<void>
```

Select every location marked reviewed across all sessions on this map.

### selectReviewSet

`unstable` · since v0.5.2

```ts
selectReviewSet(s: ReviewSession, mode: ReviewMode): Promise<void>
```

Add a reviewed or unreviewed overlay selection for a session.

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

Commands

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
cmd.procedureRun(providers: ProviderDecl[], force: boolean): Promise<number>
```

Start a procedure run over the open map's locations. Returns immediately with
the run id. Emits `procedure-progress` and `procedure-result` as work completes.

#### cmd.procedureRunRows

`unstable` · since v0.10.2

```ts
cmd.procedureRunRows(
  providers: ProviderDecl[],
  force: boolean,
  rows: Location[],
  runId: number | null,
): Promise<RowsRun>
```

Run providers over caller-supplied `rows` and return them as modified. Does not
affect the open map. A `runId` from `procedureReserveRun` streams results under it and
lets `procedureCancel` stop the run.

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

#### cmd.remoteMappingDelete

`unstable` · since v0.8.1

```ts
cmd.remoteMappingDelete(
  provider: string,
  mapId: string,
  localIds: number[],
): Promise<null>
```

Remove specific mapping rows by `localIds` for a linked map.

#### cmd.remoteMappingGet

`unstable` · since v0.8.1

```ts
cmd.remoteMappingGet(provider: string, mapId: string): Promise<RemoteMappingRow[]>
```

Get all local-to-remote id mapping rows for a linked map.

#### cmd.remoteMappingUpsert

`unstable` · since v0.8.1

```ts
cmd.remoteMappingUpsert(
  provider: string,
  mapId: string,
  rows: RemoteMappingRow[],
): Promise<null>
```

Insert or update local-to-remote id mapping rows for a linked map.

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

#### cmd.storeAddLocations

`unstable` · since v0.4.0

```ts
cmd.storeAddLocations(locations: Location[]): Promise<MutationResult>
```

Add new locations, allocating sequential IDs. Undoable.

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

#### cmd.storeApplyFieldOp

`unstable` · since v0.9.0

```ts
cmd.storeApplyFieldOp(
  selector: Selector,
  op: FieldOp,
  recordUndo: boolean | null,
): Promise<FieldOpResult>
```

Apply a field operation to every location matched by `selector`.

#### cmd.storeBounds

`unstable` · since v0.4.0

```ts
cmd.storeBounds(
  selector: Selector,
): Promise<[number, number, number, number] | null>
```

Bounding box `[west, south, east, north]`, or `null` when the set is empty.

#### cmd.storeCheckoutCommit

`unstable` · since v0.4.0

```ts
cmd.storeCheckoutCommit(mapId: string, commitId: string): Promise<null>
```

Restore a map to the state captured by a previous commit. The caller must reopen
the map afterwards (undo/redo is cleared).

#### cmd.storeCloseMap

`unstable` · since v0.4.0

```ts
cmd.storeCloseMap(): Promise<null>
```

Close the open map, saving unsaved changes first.

#### cmd.storeCollect

`unstable` · since v0.10.0

```ts
cmd.storeCollect(selector: Selector): Promise<Rows>
```

Collect all matched locations as full rows. Prefer a projection (`storeColumns`,
`storeValues`) when only specific fields are needed.

#### cmd.storeColumns

`unstable` · since v0.10.0

```ts
cmd.storeColumns(selector: Selector, fields: string[]): Promise<Columns>
```

Read specific fields across matched locations, returned as one column per field.

#### cmd.storeCommit

`unstable` · since v0.6.5

```ts
cmd.storeCommit(mapId: string, message: string | null): Promise<CommitResult>
```

Commit the map's uncommitted changes. Returns the new commit ID. `message`
defaults to a generated `+a -r ~m` summary. Clears undo/redo.

#### cmd.storeCommitDiff

`unstable` · since v0.4.0

```ts
cmd.storeCommitDiff(): Promise<[number, number, number]>
```

Return the uncommitted change counts (added, removed, modified) since the last commit.

#### cmd.storeCopyLocationsToMap

`unstable` · since v0.6.0

```ts
cmd.storeCopyLocationsToMap(
  targetMapId: string,
  selector: Selector,
): Promise<CopyToMapResult>
```

Copy locations already stored in this map into another map.

#### cmd.storeCount

`unstable` · since v0.10.0

```ts
cmd.storeCount(selector: Selector): Promise<number>
```

Count how many locations the selector matches.

#### cmd.storeCountBy

`unstable` · since v0.10.0

```ts
cmd.storeCountBy(
  selector: Selector,
  field: string,
  key: KeySpec,
): Promise<CountBy>
```

Group locations by a derived key, returning counts only (no member ids) and how many
distinct locations those groups cover.

#### cmd.storeCountryDistribution

`unstable` · since v0.5.2

```ts
cmd.storeCountryDistribution(
  selector: Selector,
  level: string,
): Promise<[string, number][]>
```

Count locations by country using offline point-in-polygon. Returns (ISO-A2, count) pairs.
`level` selects border precision, falling back to "light" if unavailable.

#### cmd.storeCoverage

`unstable` · since v0.10.0

```ts
cmd.storeCoverage(selector: Selector): Promise<[string, number][]>
```

How many rows hold a value for each field, key-sorted: `extra` keys and the built-in
columns a row can lack.

#### cmd.storeCreateMap

`unstable` · since v0.4.0

```ts
cmd.storeCreateMap(name: string, folder: string | null): Promise<MapMeta>
```

Create a new empty map with default settings. Returns the full metadata.

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

#### cmd.storeDuplicateGroups

`unstable` · since v0.5.1

```ts
cmd.storeDuplicateGroups(distance: number): Promise<number[][]>
```

Find groups of locations within `distance` metres of each other (transitive).
Returns groups of IDs, each with at least two members.

#### cmd.storeEvenlySpaced

`unstable` · since v0.11.0

```ts
cmd.storeEvenlySpaced(
  selector: Selector,
  targetCount: number | null,
  spacingM: number | null,
): Promise<SpacedPickResult>
```

An evenly spaced subset laid out on a honeycomb: exactly one of `targetCount` (at most
N, spaced as widely as that allows) or `spacingM` (about that far apart, and never
closer than half of it).

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
cmd.storeExportCsv(selector: Selector): Promise<string>
```

Export locations as a minimal lat/lng CSV file.

#### cmd.storeExportGeojson

`unstable` · since v0.4.0

```ts
cmd.storeExportGeojson(selector: Selector, tagsJson: string): Promise<string>
```

Export locations as a GeoJSON FeatureCollection of Point features.
Each feature carries its tag names in `properties.tags`.

#### cmd.storeExportJson

`unstable` · since v0.4.0

```ts
cmd.storeExportJson(opts: ExportOpts): Promise<string>
```

Export locations as a `{name, customCoordinates}` JSON file, including tags and field defs.

#### cmd.storeFillRenderFile

`unstable` · since v0.4.0

```ts
cmd.storeFillRenderFile(req: RenderRequest): Promise<string>
```

Rebuild all marker render data from scratch and return the file path to fetch it from.

#### cmd.storeFindNearby

`unstable` · since v0.4.0

```ts
cmd.storeFindNearby(
  lat: number,
  lng: number,
  radiusM: number,
): Promise<Location[]>
```

Find all locations within `radiusM` metres of (`lat`, `lng`).

#### cmd.storeGetCommitDelta

`unstable` · since v0.5.1

```ts
cmd.storeGetCommitDelta(mapId: string, commitId: string): Promise<CommitDelta>
```

Read a single commit's delta (created and removed locations).

#### cmd.storeGetMap

`unstable` · since v0.4.0

```ts
cmd.storeGetMap(id: string): Promise<MapMeta | null>
```

Fetch a single map's metadata by ID. Returns `null` if not found.

#### cmd.storeGetSavedSelections

`unstable` · since v0.10.0

```ts
cmd.storeGetSavedSelections(ids: string[]): Promise<SavedSelection[]>
```

Fetch the full saved selection rules for the given `ids`, including their selector trees.

#### cmd.storeGetSummary

`unstable` · since v0.4.0

```ts
cmd.storeGetSummary(): Promise<SummaryResult>
```

Return the map's current location count, store version, and unsaved-change count.

#### cmd.storeGroupBy

`unstable` · since v0.10.0

```ts
cmd.storeGroupBy(
  selector: Selector,
  field: string,
  key: KeySpec,
): Promise<PartitionBucket[]>
```

Group by a derived key, returning `{ key, ids, bin }` per group.

#### cmd.storeImportFile

`unstable` · since v0.4.0

```ts
cmd.storeImportFile(
  droppedFields: string[],
  tagName: string | null,
): Promise<EditorImportResult>
```

Commit a previously previewed editor import into the open map, optionally
dropping fields in `droppedFields` (e.g. `"heading"`, `"extra.countryCode"`)
and/or applying `tagName` to every imported location.

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

#### cmd.storeImportStagedLocation

`unstable` · since v0.6.0

```ts
cmd.storeImportStagedLocation(index: number): Promise<Location>
```

Return one staged (not yet imported) location by its preview `index`, for
read-only preview in the editor.

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

#### cmd.storeMergeDuplicates

`unstable` · since v0.5.1

```ts
cmd.storeMergeDuplicates(
  distance: number,
  score: string | null,
): Promise<MutationResult>
```

Merge each duplicate group within `distance` metres into one location, unioning tags
and extra fields. `score` ranks which location survives; blank uses the default ranking.
Undoable.

#### cmd.storeNearAny

`unstable` · since v0.7.0

```ts
cmd.storeNearAny(
  lats: number[],
  lngs: number[],
  radiusM: number,
): Promise<boolean[]>
```

For each input point, whether any existing location lies within `radiusM` metres.
Batch form for probing many coordinates at once.

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

Patch an interned field's value metadata: get-or-create names, edit display
metadata, reorder. Metadata only - membership writes go through the ordinary
`listSet` field op. `tags` is the first (and so far only) interned field.

#### cmd.storePruneDuplicates

`unstable` · since v0.6.0

```ts
cmd.storePruneDuplicates(
  selector: Selector,
  distance: number,
  score: string | null,
): Promise<MutationResult>
```

Remove duplicate locations within `distance` metres of each other, keeping the
best-scored survivor per cluster. Undoable.

#### cmd.storeRedo

`unstable` · since v0.4.0

```ts
cmd.storeRedo(): Promise<MutationResult>
```

Redo the last undone edit.

#### cmd.storeRemoveLocations

`unstable` · since v0.4.0

```ts
cmd.storeRemoveLocations(ids: number[]): Promise<MutationResult>
```

Remove locations by ID. Undoable.

#### cmd.storeRenameFolder

`unstable` · since v0.4.0

```ts
cmd.storeRenameFolder(from: string, to: string): Promise<null>
```

Rename a folder across all maps that reference it.

#### cmd.storeResolve

`unstable` · since v0.10.0

```ts
cmd.storeResolve(selector: Selector): Promise<number[]>
```

Ids of every location the selector resolves to, ascending.

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
cmd.storeReviewUpdate(update: ReviewUpdate): Promise<null>
```

Apply a partial update to a review session.

#### cmd.storeSample

`unstable` · since v0.10.0

```ts
cmd.storeSample(selector: Selector, n: number): Promise<number[]>
```

`n` ids drawn uniformly at random from the selected set, without replacement.

#### cmd.storeSaveDirty

`unstable` · since v0.4.0

```ts
cmd.storeSaveDirty(): Promise<SaveResult>
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
  selector: Selector,
  tagNames: { [key in number]: string },
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

#### cmd.storeSetActive

`unstable` · since v0.4.0

```ts
cmd.storeSetActive(id: number | null): Promise<null>
```

Set (or clear) the active location.

#### cmd.storeSetMarkerColor

`unstable` · since v0.7.1

```ts
cmd.storeSetMarkerColor(color: [number, number, number]): Promise<null>
```

Set the default marker color for new render updates.

#### cmd.storeSpaced

`unstable` · since v0.10.0

```ts
cmd.storeSpaced(
  selector: Selector,
  targetCount: number | null,
  minDistanceM: number | null,
): Promise<SpacedPickResult>
```

An evenly spaced subset: exactly one of `targetCount` (thin to N, maximizing
spacing) or `minDistanceM` (keep as many as fit at that spacing).

#### cmd.storeSyncSelections

`unstable` · since v0.4.0

```ts
cmd.storeSyncSelections(sels: SelectionInput[]): Promise<SelectionSync>
```

Replace all active selections and resolve them against current data. Returns
per-selection counts and a bitmask for the marker overlay.

#### cmd.storeTouchMapOpened

`unstable` · since v0.4.0

```ts
cmd.storeTouchMapOpened(mapId: string): Promise<null>
```

Mark a map as opened now, for sorting the map list by recency.

#### cmd.storeUndo

`unstable` · since v0.4.0

```ts
cmd.storeUndo(): Promise<MutationResult>
```

Undo the last edit.

#### cmd.storeUpdateLocations

`unstable` · since v0.4.0

```ts
cmd.storeUpdateLocations(
  updates: Update<LocationPatch_Deserialize>[],
  recordUndo: boolean | null,
): Promise<MutationResult>
```

Apply partial patches to existing locations. `recordUndo` defaults to true;
set to false for ephemeral updates (e.g., plugin-driven batch modifications
that manage their own undo).

#### cmd.storeUpdateMapMeta

`unstable` · since v0.4.0

```ts
cmd.storeUpdateMapMeta(
  id: string,
  patch: MapMetaPatch_Deserialize,
): Promise<MutationResult | null>
```

Apply a partial update to a map's metadata. Omitted fields are left unchanged.
Returns a mutation result when the open map's field definitions changed.

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

#### cmd.storeValues

`unstable` · since v0.10.0

```ts
cmd.storeValues(selector: Selector, field: string): Promise<string[]>
```

Distinct values of `field` across the selected set, sorted.

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
  latestSidecarVersion: string | undefined,
): boolean
```

True when the installed plugin should be refreshed to `target`.

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
runProviders<C extends readonly unknown[]>(
  items: {
    [K in keyof C]: ProviderRun<C[K]>;
  },
  rows: Location[],
  opts?: RunOpts,
): Promise<RowsRun>
```

Run a set of providers over `rows`. When `rows` is a Selector, matching locations
are processed in place and results are written back. When `rows` is a Location array,
locations are processed independently and returned as modified copies. Resolves once
every provider finishes, or on abort.

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

## SceneStore

The marker scene the map surfaces render from, and its load lifecycle.

### clearScene

`unstable` · since v0.10.3

```ts
clearScene(): void
```

Clear all marker data from the scene.

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
loadScene(markerStyle: MarkerStyle, mc?: RGB): Promise<void>
```

Rebuild the full scene for all locations.

### recolorScene

`unstable` · since v0.10.3

```ts
recolorScene(mc: RGB): void
```

Change the default marker color and repaint.

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

Start listening for deltas, selections, and active-location changes. Returns a stop function.

### whenSceneSettled

`unstable` · since v0.10.3

```ts
whenSceneSettled(): Promise<void>
```

Resolves when the most recently started full scene load has finished (or immediately if none is in flight).

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

Parse "#rrggbb" to an [r, g, b] byte tuple.

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
rgbToHex(props: RGB): string
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
  tagName?: string,
): Promise<EditorImportResult>
```

Import a previewed file, optionally assigning a tag.

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

### appendTagName

`unstable` · since v0.10.3

```ts
appendTagName(pending: string[], name: string, tags: Tag[]): string[]
```

Add a name to a staged list: dedup case-insensitively, normalizing to an existing tag's
canonical casing. Returns the original array unchanged if already present.

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

### sortTagsByMode

`unstable` · since v0.10.3

```ts
sortTagsByMode(
  tags: Tag[],
  mode: TagSortMode,
  counts: Record<number, number>,
): Tag[]
```

Sort tags by the chosen mode: name, location count, or manual order.

### splitVersion

`unstable` · since v0.10.3

```ts
splitVersion(v: string): [core: string, pre: string]
```

`["0.7.0", "rc.2"]` for `"v0.7.0-rc.2+build"`; the pre-release part is `""` when absent.

### tagColorFor

`unstable` · since v0.10.3

```ts
tagColorFor(name: string, tags: Tag[]): string
```

Color for a tag named `name`. An existing tag uses its stored color.

### toggleInSet

`unstable` · since v0.10.3

```ts
toggleInSet<T>(set: ReadonlySet<T>, value: T, on?: boolean): Set<T>
```

Copy of `set` with `value` toggled, or forced on/off by `on`.

## Legacy

Shims for removed APIs.

### addTagToLocations

`unstable` · `deprecated` · since v0.4.0

```ts
addTagToLocations(
  tagId: number,
  locationIds: number[],
): Promise<void> | Promise<FieldOpResult>
```

**Deprecated in v0.10.5.** Use `MMA.setTags([tagId], [], { type: "Locations", locations: ids, name: null })`.

### createPluginStorage

`unstable` · `deprecated` · since v0.10.3

```ts
createPluginStorage(id: string): PluginStorage
```

**Deprecated in v0.11.0.** Use `MMA.storage()`.

### fetchAllLocations

`unstable` · `deprecated` · since v0.4.0

```ts
fetchAllLocations(): Promise<Location[]>
```

**Deprecated in v0.8.4.** Use `MMA.fetchLocations({ type: "Everything" })`.

### fetchLocation

`unstable` · `deprecated` · since v0.4.0

```ts
fetchLocation(id: number): Promise<Location>
```

**Deprecated in v0.8.4.** Use `MMA.fetchLocations({ type: "Locations", locations: [id], name: null })`.

### fetchLocationsByIds

`unstable` · `deprecated` · since v0.4.0

```ts
fetchLocationsByIds(ids: number[]): Promise<Location[]>
```

**Deprecated in v0.8.4.** Use `MMA.fetchLocations({ type: "Locations", locations: ids, name: null })`.

### fieldCoverage

`unstable` · `deprecated` · since v0.9.0

```ts
fieldCoverage(selector: Selector): Promise<[string, number][]>
```

**Deprecated in v0.10.2.** Use `MMA.coverage()`.

### getActiveLocation

`unstable` · `deprecated` · since v0.3.1

```ts
getActiveLocation(): Location | null
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().activeLocation`.

### getAllSelections

`unstable` · `deprecated` · since v0.6.3

```ts
getAllSelections(): Selection[]
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().selections`.

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

**Deprecated in v0.8.2.** Read `(await MMA.cmd.storeGetSummary()).dirtyCount`.

### getGhostedSelections

`unstable` · `deprecated` · since v0.7.4

```ts
getGhostedSelections(): ReadonlySet<string>
```

**Deprecated in v0.8.2.** Read `MMA.getMapState().ghostedSelections`.

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

### removeTagFromAllLocations

`unstable` · `deprecated` · since v0.4.0

```ts
removeTagFromAllLocations(tagId: number): Promise<void> | Promise<FieldOpResult>
```

**Deprecated in v0.10.5.** Use `MMA.setTags([], [tagId], MMA.tagSelector(tagId))`.

### removeTagFromLocations

`unstable` · `deprecated` · since v0.4.0

```ts
removeTagFromLocations(
  tagId: number,
  locationIds: number[],
): Promise<void> | Promise<FieldOpResult>
```

**Deprecated in v0.10.5.** Use `MMA.setTags([], [tagId], { type: "Locations", locations: ids, name: null })`.

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

### setUserFieldDefs

`unstable` · `deprecated` · since v0.10.3

```ts
setUserFieldDefs(defs: Record<string, FieldDef>): Promise<void>
```

**Deprecated in v0.10.5.** The user layer is Rust-owned state (`MMA.getMapState().fieldDefs`);
use `MMA.setMapExtraFields()` to change it, or `MMA.registerPluginFieldDefs()` for
plugin-owned defs.

### waitForGoogleMap

`unstable` · `deprecated` · since v0.5.0

```ts
waitForGoogleMap(): Promise<google.maps.Map | null>
```

**Deprecated in v0.8.1.** Use `MMA.waitForMapHost()`.
