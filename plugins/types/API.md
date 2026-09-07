# MMA API reference

Every member of the global `MMA` object, grouped by surface. Generated from the app
source alongside `mma.d.ts` -- do not edit by hand. Members marked *(unstable)* can
change in any release.

- [Consts](#consts)
- [Store](#store)
- [SelectionOps](#selectionops)
- [SavedSelections](#savedselections)
- [Settings](#settings)
- [ImportStaging](#importstaging)
- [CommitDiff](#commitdiff)
- [SelectorPick](#selectorpick)
- [MapList](#maplist)
- [Review](#review)
- [Commands](#commands)
- [Tauri](#tauri)
- [Registry](#registry)
- [Scope](#scope)
- [Externals](#externals)
- [Sidecar](#sidecar)
- [Ui](#ui)
- [FieldDefs](#fielddefs)
- [FieldDefRegistry](#fielddefregistry)
- [Procedures](#procedures)
- [Seen](#seen)
- [PanoSingleton](#panosingleton)
- [Enrich](#enrich)
- [PinPano](#pinpano)
- [Validate](#validate)
- [Query](#query)
- [MapState](#mapstate)
- [SceneStore](#scenestore)
- [Color](#color)
- [Toast](#toast)
- [UseJob](#usejob)
- [Test](#test)
- [Types](#types)
- [Util](#util)
- [Legacy](#legacy)

## Consts

Unified MMA API -- the single public surface for plugins, tests, and app code.
Exposed as `window.MMA` (and the global `MMA`).

### `BUILTIN_FIELDS: readonly [{ readonly key: "lat"; readonly label: "Latitude"; readonly type: "number"; readonly kind: "identity"; readonly comparison: null; }, { readonly key: "lng"; readonly label: "Longitude"; readonly type: "number"; readonly kind: "identity"; readonly comparison: null; }, ... 8 more ..., { ...; }]`

### `CLEARABLE_BUILTINS: readonly ["panoId"]`

### `DEFAULT_DUPLICATE_SCORE: "tagCount + has(panoId) + loadAsPanoId + (heading != 0)"`

### `KNOWN_FIELDS: readonly [{ readonly key: "altitude"; readonly type: "number"; readonly label: "Altitude"; readonly values: readonly []; readonly labels: readonly []; readonly circularPeriod: null; readonly defaultOff: false; }, { ...; }, ... 8 more ..., { ...; }]`

### `PROJECTIONS: readonly [{ readonly id: "value"; readonly appliesTo: readonly ["string", "enum", "number", "month"]; readonly needsTz: false; }, { readonly id: "year"; readonly appliesTo: readonly ["date", "month"]; readonly needsTz: true; }, { ...; }, { ...; }, { ...; }, { ...; }]`

### `SCRATCH_MAP_ID: "scratch"`

### `VIRTUAL_FLAGS: 12`

## Store

### `addLocations(locs: Location[]): Promise<void>`

Add locations to the map. Rust assigns real ids and they are written back into
the passed objects -- build with `createLocation` (id 0) and read `loc.id` after. Undoable.

### `addSelections(selectors: Selector[]): Promise<void>`

Add selectors to the active selection list.

### `addTagToLocations(tagId: number, locationIds: number[]): Promise<void>`

Add a tag to locations (skips ones that already have it). Undoable.

### `applyFieldOp(selector: Selector, op: FieldOp, recordUndo: boolean): Promise<FieldOpResult>`

Rewrite a field across `selector` in Rust. The per-location patches never exist in
JS -- which is the point -- so instead of `location:update` this emits a coarse
`location:invalidate` (derived views re-query) and refreshes the open editor's
location.

### `applySelectionUpdate(op: (sels: Selection[], ghosted: ReadonlySet<string>) => Selection[] | Partial<SelectionState>): Promise<void>`

Apply a pure selection transform, then sync to Rust.
Ops return a SelectionPatch - either or both of { selections, ghosted }.
A bare Selection[] is shorthand for { selections }.
Skips IPC when the op produced no change (reference equality).

### `cancelAutosave(): void` *(unstable)*

### `checkoutCommit(commitId: string): Promise<void>`

Restore the map to a previous commit's state and reopen it. Clears undo/redo.

### `closeDuplicates(): void` *(unstable)*

Close the duplicate-resolution panel and return to the overview.

### `closeMap(): Promise<void>`

Close the open map, saving unsaved changes first.

### `commitMap(message?: string | undefined): Promise<string>`

Bake overlay, write the commit delta, create a VCS commit. Resets undo stack.

### `countBy(selector: Selector, field: string, key: KeySpec): Promise<[string, number][]>`

Group by a derived key and count, without shipping member ids.

### `countIn(selector: Selector): Promise<number>`

How many locations the selector resolves to, without shipping any of them.

### `coverage(selector: Selector): Promise<[string, number][]>`

How many locations hold a value for each field, key-sorted: `extra` keys and the
built-in columns a row can lack.

### `createTags(names: string[], selector?: Selector | undefined): Promise<Tag[]>`

Get-or-create tags by name. Returns the tag objects for use
in subsequent location updates. Idempotent — existing tags are returned
as-is, new names get auto-generated colors.

Pass `selector` to assign the tags to those locations in the same mutation. Prefer that
over a follow-up `addTagToLocations`: it is one round trip instead of three, and the
tag never renders at count 0 in between. The default assigns nothing.

### `currentSelection(): Selector`

The live selection as a `Selector`: the union of the active selection nodes. What
every "operate on the selection" call site sends -- Rust holds no notion of "selected",
so the tree JS already has is the definition.

### `deleteField(key: string): Promise<void>`

Delete extra-field `key` from every location, its definition, and references.

### `deleteTags(tagIds: number[]): Promise<void>`

Delete tags and strip them from all locations. Undoable (the location
changes are in the undo stack; visibility auto-restores on undo).

### `discardOpenMap(): void` *(unstable)*

Drop the open map without persisting anything

### `duplicateLocation(id: number): Promise<number | null>`

Clone a location in place and return the new id, or null if it doesn't exist. Undoable.

### `emitBitmask(bytes: number[]): void` *(unstable)*

Decode the inline bitmask bytes from Rust and emit to the event bus.

### `exitPluginMode(): void`

Close the plugin sidebar and return to the overview.

### `fetchBounds(selector: Selector): Promise<[number, number, number, number] | null>`

Bounding box `[west, south, east, north]`, or null when the selector is empty.
The whole-map box is an O(1) cache hit in Rust; narrower ones scan.

### `fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]>`

One column per field over the selected set: values, never rows. `null` where a row
lacks the field; `"tags"` is a column of tag-id arrays.

### `fetchLocations(selector: Selector): Promise<Location[]>`

Materialize a selector's location rows -- by id, by selection, or the whole map.
Rust picks the transport (inline vs staged file) by size. Missing ids are skipped.

Every row lands in webview memory, so an unscoped call costs O(map) -- at millions of
locations that is the tab's whole heap. Prefer a projection, or an enrichment
procedure that runs beside the data. Trusted, not policed: selector it yourself.

### `fieldValues(selector: Selector, field: string): Promise<string[]>`

Distinct values of `field`, sorted.

### `flushSave(): Promise<void>` *(unstable)*

Save any unsaved changes now instead of waiting for the autosave timer.

### `getActiveSelections(): Selection[]`

Active (non-ghosted) selections, the default for any operational logic.

### `getMapState(): Readonly<MapState>`

Imperative snapshot of the map state.

### `getSelectedTagIds(): ReadonlySet<number>`

Tag ids that currently have a Tag selection (cached; keyed on the selection list,
identity-stable while the set of ids is unchanged).

### `getSelectedTagIdsDeep(): readonly number[]`

Tag ids of every Tag leaf in the active selection tree, in list order --
composite children included, ghosted selections excluded, ids may repeat.
Deep counterpart of getSelectedTagIds (top-level only, as a set).

### `getTag(id: number): Tag | undefined`

Raw by-id tag lookup — includes soft-deleted ghosts so stale references
(e.g. a selection whose tag just died) still resolve to a name.

### `getVisibleTags(): Tag[]`

Tags that exist from the user's point of view. Raw `tags` also holds soft-deleted ghosts (count=0, visible=false, kept for undo revival) — almost nothing outside the undo/revival machinery should enumerate those.

### `holdAutosave(): () => void` *(unstable)*

Defer autosave until the returned release runs. A bulk run that lands many mutations
would otherwise re-serialize the whole overlay on each one; one save at the end is enough.

### `initStore(): Promise<void>` *(unstable)*

One-time store startup. The app calls this; plugins never need to.

### `mapOpen`

Cross-module stopwatch for map-open latency.

#### `mapOpen.begin(): void`

#### `mapOpen.mark(phase: string): void`

#### `mapOpen.seen: Set<string>`

#### `mapOpen.start: number`

### `mergeDuplicates(distance: number): Promise<void>` *(unstable)*

Merge each transitive duplicate group into one survivor (tags unioned), ranked by the
map's duplicate preference. One undoable edit.

### `mutate(fn: () => Promise<MutationResult>): Promise<MutationResult>`

Run a mutation IPC, emit its render delta, sync JS state, and schedule a save.

### `openDuplicateLocation(loc: Location): void` *(unstable)*

Open one location from the duplicate-resolution panel in the editor.

### `openMap(id: string): Promise<void>`

Open a map in this window, closing any currently open map first.

### `openStagedLocation(index: number): Promise<void>` *(unstable)*

Open a staged-import location read-only, "as if" it were active. The location becomes
virtual (negative id; ImportPreview flag) so identity and mutate-guards derive from it.

### `partition(field: string, key: KeySpec, selector: Selector): Promise<PartitionBucket[]>`

Group the selected location set by a derived key - entirely in Rust, no locations fetched.
Numeric bins arrive in bound order; projection keys are sorted naturally for display.

### `patchMapMeta(id: string, patch: MapMetaPatch_Deserialize): Promise<void>`

Optimistically patch any map's meta by id, persist, and refresh the map list. Mirrors
onto the open map's state when it is that map.

### `previewDuplicateGroups(distance: number): Promise<number[][]>` *(unstable)*

Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres.

### `previewVirtualLocation(loc: Location): void` *(unstable)*

Open an arbitrary location read-only as a virtual seen-preview: loads its pano without
adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves.

### `pruneDuplicates(selector: Selector, distance: number): Promise<number>` *(unstable)*

Prune duplicates within a resolved selection: keeps the most relevant location per
cluster (<= 25m) or thins to enforce spacing (> 25m). Returns the number pruned.

### `redo(): Promise<void>`

Redo the last undone edit.

### `removeDuplicate(id: number): void` *(unstable)*

Drop a location from the duplicate-resolution panel (does not delete it).

### `removeLocations(ids: ReadonlyIdSet): Promise<void>`

Remove locations by id. Undoable.

### `removeSelections(keys: string[]): Promise<void>`

Drop selections by key.

### `removeTagFromAllLocations(tagId: number): Promise<void>`

Remove a tag from every location that has it. Undoable.

### `removeTagFromLocations(tagId: number, locationIds: number[]): Promise<void>`

Remove a tag from the given locations. Undoable.

### `renameField(from: string, to: string, winner?: MergeWinner | undefined): Promise<void>`

Rename or merge extra-field `from` into `to` across all locations, then migrate
its definition and every selection that references it. Merge ≡ rename; `winner`
decides the survivor only where a location already holds `to`.

### `reorderTags(orderedIds: number[]): Promise<void>`

Persist a new tag display order.

### `resetSelections(): Promise<void>`

Clear all selections.

### `resolveIds(selector: Selector): Promise<number[]>`

Ids of every location the selector resolves to.

### `resolveLocation(m: MaybeLocation): Promise<Location | null>`

Materialize a `MaybeLocation`.

### `sampleFrom(selector: Selector, n: number): Promise<number[]>`

`n` ids drawn uniformly at random, without replacement.

### `scheduleAutoCommit(mapId: string, importedCount: number): void` *(unstable)*

Background auto-commit after an import with autoCommit set.

### `scheduleSave(): void` *(unstable)*

### `selectRandomFromSelection(count: number, perSelection?: boolean | undefined): Promise<number>`

Replace the current selection with a single Manual selection holding `count` ids picked
at random from whatever is currently selected. `count` is clamped to the selection size.
With `perSelection` it is a per-bucket cap: up to `count` ids from each active selection,
unioned. No-op when nothing is selected. Returns the number of ids actually picked.

### `selectSpacedFromSelection(opts: { count?: number | undefined; minDistanceM?: number | undefined; }, perSelection?: boolean | undefined): Promise<{ picked: number; distanceM: number; }>`

Replace the current selection with a single Manual selection of ids picked from the
current selection, spaced apart in Rust: either `count` ids maximizing spacing, or as
many as fit at `minDistanceM`. With `perSelection` each active selection is picked from
separately and the results unioned. No-op when the pick returns nothing.

### `setActiveLocation(target: MaybeLocation | null, checkDuplicates?: boolean | undefined): Promise<void>`

Open a location in the editor (null closes it). With `checkDuplicates`, opening a spot
with 2+ locations within 2m opens the duplicate-resolution panel instead.

### `setMapExtraFields(fields: Record<string, ExtraFieldDef>): Promise<void>`

Replace the map's extra-field definitions (types/labels for `Location.extra` keys).

### `setPluginMode(pluginId: string): void`

Open a plugin's sidebar (switches the editor pane to "plugin").

### `setSelectedLocationIds(ids: SelectedIds): void`

Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want.

### `setWorkArea(area: WorkArea): void`

Transition the editor pane, enforcing state invariants:
leaving "location" clears the active location, leaving "plugin" clears the plugin id.

### `syncSelections(): Promise<void>`

Resolve the current selection list against Rust and sync the overlay.
Called after `applySelectionUpdate` sets state, or standalone when the underlying
data changed (tag recolor, commit overlay clear) but selections themselves didn't.

### `tagIdsToNames(ids: number[]): string[]`

Tag names for the given ids, skipping any that no longer resolve. Tags are staged by
name rather than id, because a staged tag may not exist yet.

### `toggleTagSelections(tagIds: number[]): void`

Toggle tag selections on/off for the given tags (used by tag-pill clicks).

### `undo(): Promise<void>`

Undo the last edit.

### `updateFilterSelection(oldKey: string, selector: Selector): Promise<void>`

Edit an existing filter (or any selection) in place by key, preserving its
position inside any AND/OR/Invert composite. Carries ghost state to the new key.

### `updateLocations(updates: Update<LocationPatch_Deserialize>[], opts?: { undoable?: boolean | undefined; } | undefined): Promise<void>`

Patch locations by id. Only include the fields you're changing; `extra` merges
per-key (null deletes a key). Undoable by default.

### `updateMapMeta(patch: MapMetaPatch_Deserialize): Promise<void> | undefined`

[`patchMapMeta`] for the map open in this window.

### `updateTags(updates: Update<TagPatch>[]): Promise<void>`

Rename or recolor tags. If a rename collides with an existing tag name
(case-insensitive), the two tags are merged — all locations are remapped
to the survivor.

### `useMapState<T>(selector: (s: MapState) => T): T`

Reactive slice of the map state. Re-renders only when the selected value's
reference changes (`Object.is`), so selectors must return state fields or
cached derivations — never construct a value per call.

### `waitForInflightPersist(): Promise<void> | null` *(unstable)*

## SelectionOps

### `addSelection(selector: Selector): (current: Selection[]) => Selection[]`

### `batch<T, S>(op: (item: T) => (state: S) => S): (items: T[]) => (state: S) => S`

Lift a single-item curried transform into one that folds over an array of items.

### `buildSelection(selector: Selector): Selection`

Create a Selection with a deterministic key and overlay color from its selector.

### `colorForKey(key: string): RGB`

### `composeSelections(dragKey: string, dropKey: string, mode: GroupType, dragParent?: string | null | undefined, dropParent?: string | null | undefined): (current: Selection[]) => Selection[]`

Drag-drop composition: merge drag into drop as a new composite, absorbing existing
children of the same type. Parents route the nested cases: same parent recomposes the
siblings, a drag out of a parent detaches first, a drop onto a child nests there.

### `composeSiblings(current: Selection[], parentKey: string, dragKey: string, dropKey: string, mode: GroupType): Selection[]`

### `composeWithChild(current: Selection[], dragKey: string, parentKey: string, childKey: string, mode: GroupType): Selection[]`

### `decomposeChild(parentKey: string, childKey: string): (current: Selection[]) => Selection[]`

Pull a child out of a composite back into the top-level list, children and all. Parent collapses
if only one child remains, and disappears if none do.

### `displayTagName(name: string): string`

Display label for a tag NAME. In tree view with `truncateTagPaths` on, collapses the
`/`-path to its shortest unique suffix; otherwise returns the name verbatim. Uniqueness
is computed over visible tags only — soft-deleted ghosts must not widen suffixes.
Memoized on the visible-tags array (stable identity between tag mutations) so list
rendering stays O(n).

### `filterIsLocalTime(test: FilterOp): boolean`

Whether a predicate reads the location's clock in its own timezone. Only a range can.

### `intersectSelections(keys?: string[] | null | undefined): (current: Selection[]) => Selection[]`

### `invertSelections(keys?: string[] | null | undefined): (current: Selection[]) => Selection[]`

Invert targeted selections. Single target toggles in-place at any depth; multiple are wrapped in Union then Invert.

### `isolateGhost(key: string): (sels: Selection[], ghosted: ReadonlySet<string>) => Partial<SelectionState>`

### `isolateGhostKeys(keys: string[], ghosted: ReadonlySet<string>, key: string): Set<string>`

Ghost keys that "solo" `key`: everything except it. Returns an empty set when `key`
is already the sole visible selection, so a repeat call un-isolates (clears all ghosts).

### `OP_LABELS: Record<"has" | "nothas" | "eq" | "neq" | "contains" | "notcontains" | "gt" | "lt" | "gte" | "lte" | "between" | "between_anyyear" | "between_anytime", string>`

### `polygonSelectionsContaining(selections: Selection[], lat: number, lng: number): string[]`

Keys of every Polygon selection whose geometry contains the point.

### `removeFromComposite(parentKey: string, childKey: string): (current: Selection[]) => Selection[]`

### `removeSelection(key: string): (current: Selection[]) => Selection[]`

Remove a selection by key. Composites unwrap their children back into the list.
Returns `current` unchanged when the key is not present (identity-safe).

### `reorderSelections(fromKey: string, toKey: string, position: "before" | "after"): (current: Selection[]) => Selection[]`

### `replaceSelection(current: Selection[], oldKey: string, selector: Selector): Selection[]`

Replace the selection identified by `oldKey` (at any depth) with one built from `selector`,
rebuilding the keys of every composite on the path so identity stays consistent. Used to
edit a filter in place without dropping it from its AND/OR group. Enforces the unique-key
invariant recursively (via {@link spliceMerging }): if a re-key collides with an existing
selection at any level, merge into it — drop this edit, keep the existing one. A selection's
key is its identity, so a duplicate key would break every key-addressed op (recolor,
reorder, drag-highlight, remove).

### `rewriteSelectionFields(from: string, to: string | null): (selections: Selection[]) => Selection[]`

### `sampleIds(ids: number[], n: number): number[]`

Pick `n` distinct ids uniformly at random from `ids` using `Math.random`.
`n` is floored and clamped to `[0, ids.length]` (so over-large counts return all ids).
Uses a partial Fisher–Yates shuffle, so the result contains no duplicates and `ids` is not mutated.

### `selectionDisplayName(sel: Selection, tagNames?: Record<number, string> | undefined): string`

Human-readable label for a selection, resolving tag names and filter ops. Each branch is one
whole message with named params -- never assembled from translated fragments, so a language
can reorder it. `tagNames` is a saved rule's tag-name side table: it names `Tag` leaves whose
id belongs to the map the rule was saved on rather than the one that is open.

### `SELECTIONS: { Intersection: SelectionDescriptor<"Intersection">; Union: SelectionDescriptor<"Union">; Invert: SelectionDescriptor<"Invert">; ... 14 more ...; TopK: SelectionDescriptor<...>; }`

### `setPolygonName(key: string, name: string): (current: Selection[]) => Selection[]`

### `setSelectionColors(entries: Selection[]): (current: Selection[]) => Selection[]`

### `toggleGhost(key: string): (_sels: Selection[], ghosted: ReadonlySet<string>) => Partial<SelectionState>`

### `toggleGhostAll(): (sels: Selection[], ghosted: ReadonlySet<string>) => Partial<SelectionState>`

### `toggleManualSelection(locationId: number): (current: Selection[]) => Selection[]`

### `UNARY_TYPES: readonly ["Invert"]`

### `unionSelections(keys?: string[] | null | undefined): (current: Selection[]) => Selection[]`

## SavedSelections

### `applySavedSelection(saved: SavedSelection): number`

Adds the rule's parts to the sidebar, resolved against the open map. Returns how many
were added.

### `deleteSavedSelection(id: string): Promise<void>`

### `getSavedSelectionIndex(): SavedSelectionInfo[]`

The rules that exist, as identity only. Empty until the index arrives -- the first
call starts the read and `saved-selections:changed` announces it.

### `isSaveable(selector: Selector): boolean`

Saveable only if the whole tree is portable: one map-local leaf anywhere would freeze
the rule to the map it was built on.

### `loadAllSavedSelections(): Promise<SavedSelection[]>`

Every rule with its body.

### `loadSavedSelections(ids: string[]): Promise<SavedSelection[]>`

Bodies for `ids`, fetching only the ones not already held.

### `MAP_LOCAL_TYPES: readonly ["Locations", "Manual", "ValidationState", "Reviewed"]`

### `saveCurrentSelections(name: string, selections: Selection[]): Promise<boolean>`

Persists the saveable selections as one rule. False when none of them are saveable.

### `savedParts(saved: SavedSelection): SavedPart[]`

A rule's parts: its top-level `Union` is the list it was saved from, anything else is
a single part.

### `savedSelector(id: string): Selector`

A saved rule as a single `Selector`, resolved against the open map. Matches nothing
until the body arrives; fetching it emits `saved-selections:changed`, so a caller that
re-reads on that event gets the real tree.

### `useSavedSelectionIndex(): SavedSelectionInfo[]`

## Settings

App settings and their option tables; the shape moves with every setting added.

### `APP_SETTINGS: PersistedStore<{ showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; showCar: boolean; showCrosshair: boolean; ... 71 more ...; pinnedCommands: PinnedEntry[]; }>` *(unstable)*

A localStorage-backed blob: its key and its defaults, declared where the shape is defined so
no call site restates the pair. Older stored shapes are handled by `store/migrations.ts`.

### `BORDER_ARCHIVE_BYTES: { readonly medium: 7460312; readonly heavy: 21514464; readonly adm1: 56891952; }`

On-disk size of each downloadable archive under `data/borders/`.

### `BORDER_DETAILS: { readonly light: "Standard (bundled)"; readonly medium: "High ({size})"; readonly heavy: "Ultra ({size})"; }`

### `CSS_VAR_SETTINGS: readonly (readonly [cssVar: string, value: (s: { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; showCar: boolean; ... 72 more ...; pinnedCommands: PinnedEntry[]; }) => string])[]`

### `DATE_TIMEZONES: { readonly location: "Location timezone"; readonly utc: "UTC"; }`

### `DEFAULTS`

#### `DEFAULTS.activeLocationColor: RGB` *(unstable)*

#### `DEFAULTS.animateTagReorder: boolean` *(unstable)*

#### `DEFAULTS.borderDetail: "light" | "medium" | "heavy"` *(unstable)*

#### `DEFAULTS.clickToGo: boolean` *(unstable)*

#### `DEFAULTS.customCss: string` *(unstable)*

#### `DEFAULTS.dateTimezone: "location" | "utc"` *(unstable)*

#### `DEFAULTS.defaultMovementMode: "moving" | "no-move" | "nmpz"` *(unstable)*

#### `DEFAULTS.discordPresence: "off" | "generic" | "full"` *(unstable)*

Discord Rich Presence: off, generic (no map name), or full (map name + count).

#### `DEFAULTS.enableSeen: boolean` *(unstable)*

#### `DEFAULTS.enableSeenThumbnails: boolean` *(unstable)*

#### `DEFAULTS.enterOpensCenter: boolean` *(unstable)*

With no location open, Enter shows a center crosshair and opens the location under it.

#### `DEFAULTS.exactDateFormat: "date" | "datetime"` *(unstable)*

#### `DEFAULTS.followActiveInReview: boolean` *(unstable)*

#### `DEFAULTS.fullscreenMap: boolean` *(unstable)*

#### `DEFAULTS.fullscreenMiniLocationScale: number` *(unstable)*

#### `DEFAULTS.fullscreenMinimapCloseDelay: number` *(unstable)*

Milliseconds the fullscreen minimap stays expanded after the pointer leaves it.

#### `DEFAULTS.fullscreenMinimapScale: number` *(unstable)*

#### `DEFAULTS.fullscreenTagbarCollapsed: boolean` *(unstable)*

Tag bar dropped down to a thin strip. Toggled from the bar itself, not Settings.

#### `DEFAULTS.geocodeProvider: "local" | "nominatim" | "google"` *(unstable)*

#### `DEFAULTS.globalCopyBindings: MapKeyBinding[]` *(unstable)*

Copy-to-map hotkeys that work in every map (assigned in the copy-to-map dialog);
a map's own binding on the same key shadows them.

#### `DEFAULTS.hideNavWithUI: boolean` *(unstable)*

Hiding the pano UI also hides navigation: link arrows, ground arrow, click-to-go X.

#### `DEFAULTS.hidePanoUI: boolean` *(unstable)*

#### `DEFAULTS.importPreviewColor: RGB` *(unstable)*

#### `DEFAULTS.labelColors: Record<string, string>` *(unstable)*

Per-label color overrides (hex), keyed by lowercased label name. Shared across all maps.

#### `DEFAULTS.language: "en" | "de" | "es" | "fr" | "ja" | "pl" | "ru" | "zh-Hans" | "en-XA"` *(unstable)*

Read once at boot; changing it relaunches the app rather than re-rendering.

#### `DEFAULTS.mapListFields: ("locationCount" | "lastOpened" | "created")[]` *(unstable)*

#### `DEFAULTS.mapPanSpeed: number` *(unstable)*

#### `DEFAULTS.markerColor: RGB` *(unstable)*

#### `DEFAULTS.nominatimApiKey: string` *(unstable)*

#### `DEFAULTS.opacityToggleMode: "full" | "previous"` *(unstable)*

What the layer opacity hotkeys restore a layer to when toggling it back on.

#### `DEFAULTS.panoDotColor: RGB` *(unstable)*

#### `DEFAULTS.panoDotScaled: boolean` *(unstable)*

#### `DEFAULTS.panoLookSpeed: number` *(unstable)*

#### `DEFAULTS.panToImported: boolean` *(unstable)*

#### `DEFAULTS.pastePadding: number` *(unstable)*

Min half-extent (degrees) a single pasted/imported point is padded to before fitBounds

#### `DEFAULTS.pinnedCommands: PinnedEntry[]` *(unstable)*

#### `DEFAULTS.polygonColor: RGB` *(unstable)*

#### `DEFAULTS.polygonColorMode: "random" | "fixed"` *(unstable)*

#### `DEFAULTS.prereleaseUpdates: boolean` *(unstable)*

Offer pre-release builds to the updater as well as full releases.

#### `DEFAULTS.previewAspectRatio: "4 / 3" | "16 / 10" | "16 / 9" | "21 / 9" | "32 / 9" | "free"` *(unstable)*

#### `DEFAULTS.remoteApi: boolean` *(unstable)*

Local REST transport for window.MMA (Settings > Advanced).

#### `DEFAULTS.remoteApiKey: string` *(unstable)*

#### `DEFAULTS.restoreSession: boolean` *(unstable)*

Reopen the maps that were open when the session last ended (main window closed).

#### `DEFAULTS.seenResolution: "medium" | "low" | "high"` *(unstable)*

#### `DEFAULTS.showCameraBadges: boolean` *(unstable)*

#### `DEFAULTS.showCar: boolean` *(unstable)*

#### `DEFAULTS.showCompass: boolean` *(unstable)*

#### `DEFAULTS.showCompassTape: boolean` *(unstable)*

#### `DEFAULTS.showCoordinateDisplay: boolean` *(unstable)*

#### `DEFAULTS.showCrosshair: boolean` *(unstable)*

#### `DEFAULTS.showFps: boolean` *(unstable)*

#### `DEFAULTS.showFullscreenButton: boolean` *(unstable)*

#### `DEFAULTS.showFullscreenDatePicker: boolean` *(unstable)*

#### `DEFAULTS.showFullscreenGeocode: boolean` *(unstable)*

#### `DEFAULTS.showFullscreenMapMeta: boolean` *(unstable)*

#### `DEFAULTS.showFullscreenMiniLocationPreview: boolean` *(unstable)*

#### `DEFAULTS.showFullscreenMinimap: boolean` *(unstable)*

#### `DEFAULTS.showFullscreenReviewBar: boolean` *(unstable)*

#### `DEFAULTS.showFullscreenTagbar: boolean` *(unstable)*

#### `DEFAULTS.showGroundArrow: boolean` *(unstable)*

#### `DEFAULTS.showJumpButtons: boolean` *(unstable)*

#### `DEFAULTS.showLinksControl: boolean` *(unstable)*

#### `DEFAULTS.showMapLinks: boolean` *(unstable)*

#### `DEFAULTS.showNavArrow: boolean` *(unstable)*

#### `DEFAULTS.showPanoMetadata: boolean` *(unstable)*

#### `DEFAULTS.showReturnToSpawn: boolean` *(unstable)*

#### `DEFAULTS.showRoadLabels: boolean` *(unstable)*

#### `DEFAULTS.showScreenshotButton: boolean` *(unstable)*

#### `DEFAULTS.showZoom: boolean` *(unstable)*

#### `DEFAULTS.slowModifier: number` *(unstable)*

#### `DEFAULTS.subdivisionDetail: "off" | "adm1"` *(unstable)*

#### `DEFAULTS.tagFolderColor: RGB` *(unstable)*

#### `DEFAULTS.tagFolderColorMode: "direct" | "firstChild"` *(unstable)*

Tree view: how a colorless folder row gets its color. `direct` uses tagFolderColor;
`firstChild` inherits the first own-colored descendant in display order,
with tagFolderColor as the fallback for colorless subtrees.

#### `DEFAULTS.tagGap: number` *(unstable)*

Gap between tag pills (px), shared by flat and tree views via `--tag-gap`.

#### `DEFAULTS.tagSortMode: TagSortMode` *(unstable)*

#### `DEFAULTS.tagSuggestionLimit: number` *(unstable)*

#### `DEFAULTS.tagViewMode: "flat" | "tree"` *(unstable)*

#### `DEFAULTS.truncateTagPaths: boolean` *(unstable)*

Tree view only: render each tag as the shortest path suffix that's still unique.

#### `DEFAULTS.units: "auto" | "metric" | "imperial"` *(unstable)*

Every distance the UI shows or accepts; stored values stay metric.

### `DISCORD_PRESENCE_MODES: { readonly off: "Off"; readonly generic: "Generic (no map name)"; readonly full: "Full (map name + count)"; }`

### `EXACT_DATE_FORMATS: { readonly date: "Date only"; readonly datetime: "Date + time"; }`

### `GEOCODE_PROVIDER_LABELS: Record<"local" | "nominatim" | "google", string>`

### `GEOCODE_PROVIDERS: { readonly local: "Local (offline)"; readonly nominatim: "Nominatim"; readonly google: "Google (from panorama)"; }`

### `getSettings(): { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; showCar: boolean; showCrosshair: boolean; ... 71 more ...; pinnedCommands: PinnedEntry[]; }` *(unstable)*

### `LANGUAGES`

Language names stay in their own language, the way every language picker does it -- a reader
looking for their own has to recognise it without already reading English.
`en-XA` is the generated pseudolocale: accented and ~40% longer, so unextracted strings and
layout overflow are visible without a translator. Offered in dev builds only.

#### `LANGUAGES.de: "Deutsch"` *(unstable)*

#### `LANGUAGES.en: "English"` *(unstable)*

#### `LANGUAGES.en-XA: "Pseudolocale"` *(unstable)*

#### `LANGUAGES.es: "Español"` *(unstable)*

#### `LANGUAGES.fr: "Français"` *(unstable)*

#### `LANGUAGES.ja: "日本語"` *(unstable)*

#### `LANGUAGES.pl: "Polski"` *(unstable)*

#### `LANGUAGES.ru: "Русский"` *(unstable)*

#### `LANGUAGES.zh-Hans: "简体中文"` *(unstable)*

### `MAP_LIST_FIELDS: { readonly locationCount: "Location count"; readonly lastOpened: "Last opened"; readonly created: "Date created"; }`

### `MOVEMENT_CYCLE: ("moving" | "no-move" | "nmpz")[]`

### `MOVEMENT_MODES: { readonly moving: "Moving"; readonly "no-move": "No Move"; readonly nmpz: "NMPZ"; }`

### `navHiddenWithUI(s: { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; showCar: boolean; showCrosshair: boolean; ... 71 more ...; pinnedCommands: PinnedEntry[]; }): boolean` *(unstable)*

True while the pano-UI toggle covers the navigation visuals too.

### `OPACITY_TOGGLE_MODES: { readonly previous: "Last used opacity"; readonly full: "Full opacity"; }`

### `panoDisplayOptions(s: { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; showCar: boolean; showCrosshair: boolean; ... 71 more ...; pinnedCommands: PinnedEntry[]; }): { ...; }` *(unstable)*

Effective StreetViewPanorama options: how the movement mode, per-control toggles,
and the hide-UI toggle compose. Sole authority for both pano creation and updates.

### `POLYGON_COLOR_MODES: { readonly random: "Random"; readonly fixed: "Fixed color"; }`

### `PREVIEW_ASPECT_RATIOS`

#### `PREVIEW_ASPECT_RATIOS.16 / 10: "16:10"` *(unstable)*

#### `PREVIEW_ASPECT_RATIOS.16 / 9: "16:9"` *(unstable)*

#### `PREVIEW_ASPECT_RATIOS.21 / 9: "21:9"` *(unstable)*

#### `PREVIEW_ASPECT_RATIOS.32 / 9: "32:9"` *(unstable)*

#### `PREVIEW_ASPECT_RATIOS.4 / 3: "4:3"` *(unstable)*

#### `PREVIEW_ASPECT_RATIOS.free: "Free"` *(unstable)*

### `PRIVATE_SETTINGS: ReadonlySet<"showCameraBadges" | "showLinksControl" | "clickToGo" | "showRoadLabels" | "defaultMovementMode" | "showCar" | "showCrosshair" | "showCompass" | "showCompassTape" | "showZoom" | ... 68 more ... | "pinnedCommands">`

### `resetSettings(): void` *(unstable)*

### `SEEN_RESOLUTIONS: { readonly low: "Low (160x90)"; readonly medium: "Medium (320x180)"; readonly high: "High (640x360)"; }`

### `setSetting<K extends keyof AppSettings>(key: K, value: { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; ... 73 more ...; pinnedCommands: PinnedEntry[]; }[K]): void` *(unstable)*

### `SUBDIVISION_DETAILS: { readonly off: "Off"; readonly adm1: "States / provinces"; }`

### `TAG_FOLDER_COLOR_MODES: { readonly direct: "Fixed color"; readonly firstChild: "Inherit first child"; }`

### `TAG_SUGGESTION_LIMITS: readonly [5, 10, 25, 50, 0]`

### `TAG_VIEW_MODES: { readonly flat: "Flat"; readonly tree: "Tree"; }`

### `UNIT_SYSTEMS: { readonly auto: "Automatic"; readonly metric: "Metric (m / km)"; readonly imperial: "Imperial (ft / mi)"; }`

Distance units. `auto` reads the system locale's region, so a US/UK machine gets miles.

### `useSetting<K extends keyof AppSettings>(key: K): { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; ... 73 more ...; pinnedCommands: PinnedEntry[]; }[K]` *(unstable)*

### `useSettings(): { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; showCar: boolean; showCrosshair: boolean; ... 71 more ...; pinnedCommands: PinnedEntry[]; }` *(unstable)*

## ImportStaging

Import dialog internals.

### `beginImportFromPath(path: string): Promise<void>` *(unstable)*

Import from a known file path. Used by file picker and drag-and-drop.

### `beginImportPaste(text: string): Promise<void>` *(unstable)*

Stage pasted text for preview. Throws if no locations are found.

### `cancelImport(): void` *(unstable)*

Discard the staged import without committing.

### `confirmImport(droppedFields: string[], tagName?: string | undefined): Promise<EditorImportResult | null>` *(unstable)*

Commit the staged import, optionally dropping fields and applying a bulk tag.

### `getImportPreviewPositions(): Float32Array<ArrayBufferLike>` *(unstable)*

### `getImportStaging(): ImportStaging | null` *(unstable)*

### `resetImportState(): void` *(unstable)*

Reset import state (called when map edit state is cleared).

## CommitDiff

Commit diff internals.

### `beginCommitDiffPreview(commit: CommitInfo): Promise<void>` *(unstable)*

Fetch a commit's delta and overlay its added/removed/modified locations on the map,
temporarily replacing the regular markers.

### `categorizeCommitDelta(delta: CommitDelta): { added: Location[]; removed: Location[]; modified: Location[]; }` *(unstable)*

Split a commit delta into added / removed / modified. An updated location appears in
both `created` (new) and `removed` (old), keyed by id.

### `diffPositions(locs: LatLngLiteral[]): Float32Array<ArrayBufferLike>` *(unstable)*

Interleave `[lng, lat]` pairs into an f32 buffer for deck.gl.

### `endCommitDiffPreview(): void` *(unstable)*

Leave commit-diff preview and restore the regular markers.

### `getCommitDiffPreview(): CommitDiffPreview | null` *(unstable)*

### `hasCommitDiff(): boolean` *(unstable)*

### `resetCommitDiffCounts(): void` *(unstable)*

Zero the cached counts (a commit just cleared the overlay).

### `resetCommitDiffState(): void` *(unstable)*

Reset diff state (called when map edit state is cleared).

### `useCommitDiff(): CommitDiff` *(unstable)*

## SelectorPick

### `createSelectorPick(initial?: SelectorPick | undefined): SelectorPickHandle`

A standalone "all locations vs current selection" switch, for features that operate on a subset.

### `selectorForPick(choice: SelectorPick): Selector`

### `useSelectorPick(initial?: SelectorPick | undefined): SelectorPickController`

Reactive selector state + live counts, owned by the calling React component. Defaults to
the current selection when one exists at mount, else all locations. Use this for plugins
whose selector lives entirely in a React sidebar; reach for `createSelectorPick` when an imperative
renderer (e.g. a deck.gl overlay) outside React also needs to read the selector.

## MapList

### `createMap(name: string, folder?: string | null | undefined): Promise<MapMeta>`

Create a new empty map and return its metadata.

### `deleteFolder(name: string): Promise<void>`

### `deleteMap(id: string): Promise<void>`

Permanently delete a map and all its data. Not undoable.

### `getMapList(): MapMeta[]`

The list of all maps (metadata only).

### `invalidateMapList(): Promise<void>`

Re-fetch the map list from the database.

### `isReservedMap(id: string | null): boolean`

A reserved map is an app fixture, not one of the user's: it carries no name, never
appears in the list, and has nothing to configure. Keyed by id, never by name -- the
name is a value the user could type.

### `moveMapToFolder(mapId: string, folder: string | null): Promise<void>`

### `openScratchMap(): Promise<void>`

Open the scratch map, created on first use. An ordinary map that the list hides and
startup wipes, so the list never needs invalidating for it.

### `reloadMapList(): Promise<void>`

### `renameFolder(from: string, to: string): Promise<void>`

### `setCachedMapList(list: MapMeta[]): void`

Set the cached map list directly (used by initStore).

### `useMapList(): MapMeta[]`

Reactive list of all maps (metadata only).

## Review

Review screen internals.

### `advance(s: ReviewSession): { session: ReviewSession; done: boolean; }` *(unstable)*

Mark the current cursor reviewed and step forward. `done` when the cursor was the
last item (status flips to "done").

### `beginReview(ids: number[], source?: Selection | undefined): Promise<void>` *(unstable)*

Start (or resume) a review over `ids`. When `source` is a real selection, the session
is keyed by it so re-reviewing that selection resumes the in-progress session.

### `cancelReview(): void` *(unstable)*

Exit the review UI but keep the session resumable (persisted as active).

### `deleteSession(id: string): Promise<void>` *(unstable)*

Delete a review session (its progress, not the locations).

### `getReviewSession(): ReviewSession | null` *(unstable)*

The active review session, or null.

### `isAtStart(s: ReviewSession): boolean` *(unstable)*

True when the cursor is on the session's first location.

### `isCurrentReviewed(s: ReviewSession): boolean` *(unstable)*

Current cursor location is in the reviewed set.

### `listSessions(status?: "active" | "done" | undefined): Promise<ReviewSession[]>` *(unstable)*

Review sessions for the open map, optionally filtered by status.

### `pruneSession(s: ReviewSession, removed: Set<number>): PruneResult` *(unstable)*

Remove `removed` ids from a session's worklist + reviewed set. The cursor only
moves if the cursor id itself was removed (advancing to the next survivor by old
position). Returns the same session reference untouched if nothing overlapped.

### `renameReview(id: string, name: string): Promise<void>` *(unstable)*

Rename a session (custom label over the auto-derived selection name). Persists immediately;
also patches the live session if it's the one being renamed.

### `resumeReview(s: ReviewSession): Promise<void>` *(unstable)*

Resume a session picked from the resume modal.

### `retreat(s: ReviewSession): ReviewSession | null` *(unstable)*

Step backward without marking anything reviewed. Null when already at the start.

### `reviewDelete(): Promise<void>` *(unstable)*

Delete the current location and advance FORWARD (like reviewNext) — to the item that
followed it, or exit the pass if it was the last one. We navigate off the doomed location
first so the shared `removeLocations` doesn't bounce us to the overview; its emitted
`location:remove` is then a no-op for our reconcile listener (already pruned).

### `reviewedHistoryIds(sessions: ReviewSession[]): number[]` *(unstable)*

Union of reviewed ids across sessions, de-duplicated. Pure (unit-tested).

### `reviewIndex(s: ReviewSession): number` *(unstable)*

Position of the session cursor within its review order.

### `reviewNext(): Promise<void>` *(unstable)*

Mark the current location reviewed and step to the next one.

### `reviewPrev(): Promise<void>` *(unstable)*

Step back to the previous location in the session.

### `selectReviewedHistory(): Promise<void>` *(unstable)*

Select every location marked reviewed across all review sessions on this map (active + done).
A snapshot; re-running refreshes it in place (deterministic key).

### `selectReviewSet(s: ReviewSession, mode: "reviewed" | "unreviewed"): Promise<void>` *(unstable)*

Add a reviewed/unreviewed overlay selection for an arbitrary session (resume modal). Mirrors
refreshProjection's selector so the key and color match an in-progress projection.

### `useReviewSession(): ReviewSession | null` *(unstable)*

Reactive active review session, or null.

## Commands

The raw Rust command boundary; any of them can change in a release.

### `cmd`

Commands

#### `cmd.appReady(): Promise<number>` *(unstable)*

Milliseconds from `run()` to the frontend's first call; logged once.

#### `cmd.borderClassify(level: string, points: [number, number][]): Promise<(string | null)[]>` *(unstable)*

Classify each `(lat, lng)` to the name of its containing feature at `level`
(subdivision names for "adm1"). `None` for points outside every feature.
Same bbox-prefiltered parallel scan as `tally_countries`, but per-point names.

#### `cmd.borderLookup(lat: number, lng: number, level: string): Promise<PolygonGeometry | null>` *(unstable)*

#### `cmd.bulkImportCancel(): Promise<null>` *(unstable)*

Drop the cached parse from `bulk_import_preview` when the user dismisses the
import dialog without confirming, instead of holding it until the next preview.

#### `cmd.bulkImportConfirm(path: string, selectedIndices: number[]): Promise<ImportedMapInfo[]>` *(unstable)*

Import the selected maps from a previously previewed file. Emits `bulk-import-progress` per map.

#### `cmd.bulkImportPreview(path: string): Promise<ImportPreviewEntry[]>` *(unstable)*

Parse a file (JSON or ZIP of JSONs) and return previews without persisting.
Results are cached in `CACHED_PARSE` so `bulk_import_confirm` can skip re-parsing.
ZIP files have each `.json` entry parsed in parallel via rayon.

#### `cmd.checkBorderFile(level: string): Promise<boolean>` *(unstable)*

#### `cmd.claimPluginUpdatePass(): Promise<boolean>` *(unstable)*

First caller per app run wins the silent update pass. Every webview boots the
plugin loader, so without this a restored editor window plus the map list run
two full passes -- double registry fetches, double downloads, and interleaved
install progress for the same plugin.

#### `cmd.discordPresenceClear(): Promise<null>` *(unstable)*

#### `cmd.discordPresenceSet(activity: PresenceActivity): Promise<null>` *(unstable)*

#### `cmd.downloadBorderFile(level: string): Promise<null>` *(unstable)*

#### `cmd.feedbackAnonymousAvailable(): Promise<boolean>` *(unstable)*

Whether the anonymous tier is available in this build.

#### `cmd.feedbackAnonymousThread(number: number, token: string): Promise<IssueThread>` *(unstable)*

State and replies for an anonymous report, relayed by the worker.

#### `cmd.feedbackLogTail(): Promise<string>` *(unstable)*

The tail of `mma.log`, scrubbed. Empty string when there is no log yet.

#### `cmd.feedbackRequestLabel(number: number): Promise<null>` *(unstable)*

Ask the worker to label an issue the user filed themselves.

GitHub drops labels sent by a reporter without push access, so a signed-in outside
contributor's report arrives bare. The worker's installation token has push access and
re-applies them. Best-effort: a report that is filed but unlabelled is not worth failing.

#### `cmd.feedbackSubmitAnonymous(title: string, body: string, installId: string): Promise<AnonIssueRef>` *(unstable)*

File an issue through the worker, without any account. The worker applies the labels
(a bot has push access, so it can) and returns the reply token.

#### `cmd.feedbackUploadAttachment(path: string, name: string): Promise<AttachmentRef>` *(unstable)*

Store an image and return the URL a report body can reference it by.

The proof of work is bound to the bytes, so it costs the same per image as a report costs
per body -- which is what keeps an open upload route from being free hosting.

#### `cmd.fieldExprError(src: string): Promise<string | null>` *(unstable)*

The parse error for `src`, or nothing when it parses. For the dialog's live check.

#### `cmd.geoguessrHasSession(): Promise<boolean>` *(unstable)*

Local-only check: is a token stored? Says nothing about its validity.

#### `cmd.geoguessrLogin(): Promise<string>` *(unstable)*

Open the GeoGuessr sign-in window and wait for a `_ncfa` cookie to appear.
Returns the signed-in nickname.

#### `cmd.geoguessrLogout(): Promise<null>` *(unstable)*

#### `cmd.geoguessrMe(): Promise<GgUser | null>` *(unstable)*

The signed-in user, or `None` when there is no session (or it was rejected).

#### `cmd.getAppDataDir(): Promise<string>` *(unstable)*

#### `cmd.getDataLocation(): Promise<DataLocation>` *(unstable)*

#### `cmd.githubCreateIssue(title: string, body: string, labels: string[]): Promise<IssueRef>` *(unstable)*

File an issue as the signed-in user.

Labels are sent even though only accounts with push access may set them: GitHub drops them
silently for everyone else rather than failing, so sending costs nothing and they land for
maintainers. Closing the gap for outside reporters is the worker's job.

#### `cmd.githubHasSession(): Promise<boolean>` *(unstable)*

Local-only check: is a token stored? Says nothing about its validity.

#### `cmd.githubIssueThread(number: number): Promise<IssueThread>` *(unstable)*

One of our issues and its comments, read as the signed-in user.

#### `cmd.githubLogout(): Promise<null>` *(unstable)*

#### `cmd.githubMe(): Promise<GhUser | null>` *(unstable)*

The signed-in user, or `None` when there is no session (or it was rejected).

#### `cmd.githubPollLogin(): Promise<GhUser>` *(unstable)*

Wait for the user to authorize the code from [`github_start_login`], then store the token.
Resolves with the signed-in account.

#### `cmd.githubStartLogin(): Promise<DeviceCodeInfo>` *(unstable)*

Begin device-flow sign-in. Returns the code to show the user; call
[`github_poll_login`] afterwards to wait for them to finish authorizing.

#### `cmd.installPlugin(id: string, gitRef: string | null): Promise<PluginManifest>` *(unstable)*

Install a plugin from the marketplace repo: its `manifest.json`, the main JS file, and
the procedure module it declares. `git_ref` pins an older build; `None` takes master.

#### `cmd.listUserPlugins(): Promise<PluginManifest[]>` *(unstable)*

Manifests of every installed plugin.

#### `cmd.openDataFolder(): Promise<null>` *(unstable)*

#### `cmd.openLogFile(): Promise<null>` *(unstable)*

#### `cmd.procedureCancel(runId: number): Promise<null>` *(unstable)*

Stop a run before its next batch. Already-applied patches stay applied.

#### `cmd.procedureQuery(entry: string, input: string, config: string | null, cancel: number | null): Promise<string>` *(unstable)*

Ask a procedure a read-only question. `input` and the result are whatever the
module's `query` export agrees with its caller; the engine only carries the bytes.
`cancel` is a token the caller may later hand to `procedure_query_cancel`.

#### `cmd.procedureQueryCancel(cancel: number): Promise<null>` *(unstable)*

Decline every request a query still has to make. The query then answers whatever
its module answers for declined requests, which the caller discards.

#### `cmd.procedureRun(providers: ProviderDecl[], force: boolean): Promise<number>` *(unstable)*

Start a procedure run. Returns immediately with the run id; the work continues
on a background thread and reports through `procedure-progress`.

#### `cmd.procedureRunRows(providers: ProviderDecl[], force: boolean, rows: Location[], cancel: number | null): Promise<RowsRun>` *(unstable)*

Run providers over rows the caller hands in and answer with the rows as they are
afterwards. Same gating as a run over the map, in a store of the rows' own,
so nothing reaches the open map. `cancel` is a token for `procedure_query_cancel`.

#### `cmd.readFile(path: string): Promise<string>` *(unstable)*

Read a file as UTF-8 text (temp files, plugin sources).

#### `cmd.remoteApiRespond(id: number, ok: boolean, payload: string): Promise<void>` *(unstable)*

Webview -> HTTP reply path: resolves the parked request for `id`.
`payload` is JSON text, not a typed value -- specta cannot export the
recursive `serde_json::Value` type (stack overflow at bindings export).

#### `cmd.remoteApiStart(key: string): Promise<string>` *(unstable)*

Start (or re-key) the remote API server. Idempotent: a running server just
picks up the new key. Returns the base URL.

#### `cmd.remoteApiStop(): Promise<null>` *(unstable)*

#### `cmd.remoteMappingClear(provider: string, mapId: string): Promise<null>` *(unstable)*

#### `cmd.remoteMappingDelete(provider: string, mapId: string, localIds: number[]): Promise<null>` *(unstable)*

#### `cmd.remoteMappingGet(provider: string, mapId: string): Promise<RemoteMappingRow[]>` *(unstable)*

#### `cmd.remoteMappingUpsert(provider: string, mapId: string, rows: RemoteMappingRow[]): Promise<null>` *(unstable)*

#### `cmd.reverseGeocode(lat: number, lng: number): Promise<GeoResult | null>` *(unstable)*

Finds the nearest city/country for a coordinate. O(log n) k-d tree lookup.
Always returns `Some` -- the GeoNames dataset covers every landmass.

#### `cmd.setDataLocation(path: string | null): Promise<null>` *(unstable)*

Set (`Some`) or clear (`None`) the data-folder override. Takes effect after relaunch
and does not move existing data.

#### `cmd.sidecarCancel(reqId: number): Promise<null>` *(unstable)*

Kill the process behind a one-shot request (no-op if it already finished).
Resident-served requests have no process of their own, so this does not
interrupt them -- the caller simply stops listening.

#### `cmd.sidecarInstall(pluginId: string, name: string, version: string): Promise<null>` *(unstable)*

Download a plugin's sidecar bundle from GitHub Releases and extract it under
`{appData}/plugins/{plugin_id}/sidecar/`. Emits `sidecar-install-progress`.

#### `cmd.sidecarInstalledVersion(pluginId: string): Promise<string | null>` *(unstable)*

Installed sidecar version for a plugin (from `sidecar/version.txt`), or `None`.

#### `cmd.sidecarRequest(pluginId: string, command: string, payload: string | null): Promise<number>` *(unstable)*

Run one unit of work on a plugin's sidecar. Commands the manifest lists under
`serve` go to the plugin's resident process; the rest get a one-shot child.
Streams `sidecar-line` (one JSON object per unit) and `sidecar-log` (stderr),
then exactly one `sidecar-done`, all keyed by the returned request id.

#### `cmd.sidecarStop(pluginId: string): Promise<null>` *(unstable)*

Stop everything a plugin has running. Called when the plugin is disabled or
uninstalled, so a resident process never outlives the plugin that wanted it.

#### `cmd.sidecarStopAll(): Promise<null>` *(unstable)*

Stop every plugin's sidecar processes. Used when the editor tears all plugins
down at once (map close), where nothing should still be running afterwards.

#### `cmd.storeAddLocations(locations: Location[]): Promise<MutationResult>` *(unstable)*

Add new locations. IDs are allocated server-side (monotonic). Records an undo entry
and clears the redo stack.

#### `cmd.storeAddLocationsToMap(targetMapId: string, locations: Location[]): Promise<CopyToMapResult>` *(unstable)*

Copy caller-supplied location data into another map. Tag ids are read against this
map's tag table, so the values may differ from any row it holds -- that is how the
editor sends the pano you are currently looking at rather than the one on disk.

#### `cmd.storeAddLocationsUploaded(sessionDir: string): Promise<MutationResult>` *(unstable)*

Add locations uploaded as chunked JSON in an upload session dir (see `store_upload_begin`),
so the frontend never serializes the whole batch at once. Otherwise identical to
[`store_add_locations`]: one atomic mutation, one undo entry, IDs in uploaded order.

#### `cmd.storeApplyFieldOp(selector: Selector, op: FieldOp, recordUndo: boolean | null): Promise<FieldOpResult>` *(unstable)*

#### `cmd.storeBounds(selector: Selector): Promise<[number, number, number, number] | null>` *(unstable)*

Bounding box `[west, south, east, north]`, or `None` when the set is empty.

#### `cmd.storeCheckoutCommit(mapId: string, commitId: string): Promise<null>` *(unstable)*

Restore a map to the state captured by a previous commit. The caller must reopen
the map afterwards (undo/redo is cleared).

#### `cmd.storeCloseMap(): Promise<null>` *(unstable)*

Close the current map: bake overlay, flush Arrow + tags + edit history to disk, then
release all in-memory state (batch, mmap, indexes, selections, undo stacks).

#### `cmd.storeCollect(selector: Selector): Promise<Rows>` *(unstable)*

Full rows. The last resort -- prefer a projection. Every row is materialized in
webview memory, so an `Everything` call costs O(map). Large answers are staged to a file
rather than pushed through the IPC channel.

#### `cmd.storeColumns(selector: Selector, fields: string[]): Promise<Columns>` *(unstable)*

Values, never rows: the projection for a scan that reads fields across a set.

#### `cmd.storeCommit(mapId: string, message: string | null): Promise<CommitResult>` *(unstable)*

Commit the map's uncommitted changes; returns the new commit id plus the
store-state delta (cleared undo/redo). `message` None auto-generates a `+a -r ~m` summary.

#### `cmd.storeCommitDiff(): Promise<[number, number, number]>` *(unstable)*

The uncommitted changes since the last commit -- the same changeset `store_commit` will record.

#### `cmd.storeCopyLocationsToMap(targetMapId: string, selector: Selector): Promise<CopyToMapResult>` *(unstable)*

Copy locations already stored in this map into another map.

#### `cmd.storeCount(selector: Selector): Promise<number>` *(unstable)*

How many locations the selector resolves to. Counts rows, never materializes them.

#### `cmd.storeCountBy(selector: Selector, field: string, key: KeySpec): Promise<[string, number][]>` *(unstable)*

Group by a derived key, returning counts only -- no member ids on the wire.

#### `cmd.storeCountryDistribution(selector: Selector, level: string): Promise<[string, number][]>` *(unstable)*

Count locations by country (offline point-in-polygon). Returns unsorted (ISO-A2, count) pairs.
`level` selects border precision, falling back to "light" if unavailable.

#### `cmd.storeCoverage(selector: Selector): Promise<[string, number][]>` *(unstable)*

How many rows hold a value for each field, key-sorted: `extra` keys and the built-in
columns a row can lack.

#### `cmd.storeCreateMap(name: string, folder: string | null): Promise<MapMeta>` *(unstable)*

Create a new empty map with default settings. Returns the full metadata
(including the generated UUID) so the frontend can navigate to it immediately.

#### `cmd.storeCreateTags(names: string[], selector: Selector): Promise<MutationResult>` *(unstable)*

Create tags by name. Deduplicates case-insensitively: if a tag with the same name
already exists, it is made visible instead of creating a duplicate.

`location_ids` assigns every resulting tag to those locations in the same mutation.
Doing both here is not a convenience: creating and assigning as two commands leaves the
tag visible at count 0 for the round trip in between, and makes the caller fetch every
location into JS just to append an id Rust already has.

#### `cmd.storeDbStats(): Promise<DbStats>` *(unstable)*

Compute aggregate database statistics (map/location/tag/commit counts,
database file size, journal mode). Tag count is summed across all maps
by parsing each map's tags JSON column.

#### `cmd.storeDeleteFolder(name: string): Promise<null>` *(unstable)*

Delete a folder by setting all its maps' folder to `NULL` (moves them to root).

#### `cmd.storeDeleteMap(id: string): Promise<null>` *(unstable)*

Delete a map and all its data: database rows and files on disk.

#### `cmd.storeDeleteSavedSelection(id: string): Promise<null>` *(unstable)*

#### `cmd.storeDeleteTags(tagIds: number[]): Promise<MutationResult>` *(unstable)*

Strip tags from all locations. Tags stay in `store.tags` with count=0 /
visible=false so undo can revive them. Returns MutationResult with `tags`.

#### `cmd.storeDuplicateGroups(distance: number): Promise<number[][]>` *(unstable)*

Transitive spatial duplicate groups (connected components, size >= 2) within `distance`
metres. Read-only; used to preview a merge. Returns groups of location IDs.

#### `cmd.storeExportBulkZip(): Promise<string>` *(unstable)*

Export every map in the database as a ZIP of JSON files. Duplicate map names get a numeric suffix.

#### `cmd.storeExportCsv(selector: Selector): Promise<string>` *(unstable)*

Export locations as a minimal lat/lng CSV file.

#### `cmd.storeExportGeojson(selector: Selector, tagsJson: string): Promise<string>` *(unstable)*

Export locations as a GeoJSON FeatureCollection of Point features.
Each feature carries its tag names in `properties.tags`.

#### `cmd.storeExportJson(opts: ExportOpts): Promise<string>` *(unstable)*

Export locations as a `{name, customCoordinates}` JSON file, including tags and field defs.

#### `cmd.storeFillRenderFile(req: RenderRequest): Promise<string>` *(unstable)*

Full render rebuild: single-pass over all alive locations, writes binary to a temp file.
Returns the file path for JS to fetch via `mma-buf://`. Only called on map open or full reset.

#### `cmd.storeFindNearby(lat: number, lng: number, radiusM: number): Promise<Location[]>` *(unstable)*

Find all locations within `radius_m` metres of (`lat`, `lng`).

#### `cmd.storeGetCommitDelta(mapId: string, commitId: string): Promise<CommitDelta>` *(unstable)*

Read a single commit's delta (created/removed locations) for the diff viewer.

#### `cmd.storeGetMap(id: string): Promise<MapMeta | null>` *(unstable)*

Fetch a single map's metadata by ID. Returns `None` if not found.

#### `cmd.storeGetSavedSelections(ids: string[]): Promise<SavedSelection[]>` *(unstable)*

#### `cmd.storeGetSummary(): Promise<SummaryResult>` *(unstable)*

#### `cmd.storeGroupBy(selector: Selector, field: string, key: KeySpec): Promise<PartitionBucket[]>` *(unstable)*

Group by a derived key, returning `{ key, ids, bin }` per group.

#### `cmd.storeImportFile(droppedFields: string[], tagName: string | null): Promise<EditorImportResult>` *(unstable)*

Commit a previously previewed editor import, optionally dropping fields and/or
applying a bulk tag to every imported location. Consumes the cached parse from
`store_import_preview`/`store_import_paste_preview`. Fields in `dropped_fields`
(e.g. `"heading"`, `"extra.countryCode"`) are zeroed/removed.

#### `cmd.storeImportLegacySavedSelections(json: string): Promise<number>` *(unstable)*

#### `cmd.storeImportPastePreview(text: string): Promise<EditorImportPreview>` *(unstable)*

Parse pasted text (JSON or CSV) and stage it for preview, exactly like
`store_import_preview` does for a file. Caches the parse for `store_import_file`.

#### `cmd.storeImportPreview(path: string): Promise<EditorImportPreview>` *(unstable)*

Parse a file and return field-level statistics + preview positions for the editor
import sidebar. Caches the parse result for `store_import_file` to consume on commit.

#### `cmd.storeImportStagedLocation(index: number): Promise<Location>` *(unstable)*

Fetch one staged (not yet imported) location by its preview index, for read-only
preview in the editor. Indexes follow the preview positions order.

#### `cmd.storeListCommits(mapId: string): Promise<CommitInfo[]>` *(unstable)*

List all commits for a map, newest first.

#### `cmd.storeListMaps(): Promise<MapMeta[]>` *(unstable)*

Return metadata for every map in the database.

#### `cmd.storeListSavedSelections(): Promise<SavedSelectionInfo[]>` *(unstable)*

#### `cmd.storeMergeDuplicates(distance: number, score: string | null): Promise<MutationResult>` *(unstable)*

Merge each duplicate group within `distance` metres into one survivor location, unioning
tags and extra fields. `score` is the map's duplicate preference expression; blank or
absent uses [`selections::DEFAULT_DUPLICATE_SCORE`]. One undoable edit.

#### `cmd.storeNearAny(lats: number[], lngs: number[], radiusM: number): Promise<boolean[]>` *(unstable)*

For each input point, whether any existing location lies within `radius_m` metres.
Bulk form so callers probing many coordinates (e.g. the map generator skipping
already-covered spots) pay one IPC round-trip, not one per point.

#### `cmd.storeOpenMap(mapId: string): Promise<StoreStatus>` *(unstable)*

Load a map's Arrow data from disk, rebuild all indexes, and return initial state
(tag counts, undo/redo availability). Must be called before any other store commands.

#### `cmd.storePruneDuplicates(selector: Selector, distance: number, score: string | null): Promise<MutationResult>` *(unstable)*

Thin duplicates among `ids` within `distance` metres, keeping the best location per
cluster. `score` is the map's duplicate preference expression, the same one a merge
ranks by. One undoable edit.

#### `cmd.storeRedo(): Promise<MutationResult>` *(unstable)*

Pop the redo stack and replay the edit forward. Pushes the entry back onto undo.

#### `cmd.storeRemoveLocations(ids: number[]): Promise<MutationResult>` *(unstable)*

Remove locations by ID. Snapshots the full location data for undo before deleting.

#### `cmd.storeRenameFolder(from: string, to: string): Promise<null>` *(unstable)*

Rename a folder across all maps that reference it.

#### `cmd.storeReorderTags(orderedIds: number[]): Promise<MutationResult>` *(unstable)*

Persist tag ordering. `ordered_ids` specifies the desired order; each tag's
`order` field is set to its index in the list.

#### `cmd.storeResetUndo(): Promise<MutationResult>` *(unstable)*

Clear both undo and redo stacks; returns the resulting store-state delta.

#### `cmd.storeResolve(selector: Selector): Promise<number[]>` *(unstable)*

Ids of every location the selector resolves to, ascending.

#### `cmd.storeResolvePick(cell: string, cellIndex: number): Promise<number | null>` *(unstable)*

Resolve a deck.gl pick result (cell key + index within cell) to a location ID.
Called on marker click to map the GPU pick back to a logical location.

#### `cmd.storeReviewCreate(session: ReviewCreate): Promise<ReviewSession>` *(unstable)*

#### `cmd.storeReviewDelete(id: string): Promise<null>` *(unstable)*

#### `cmd.storeReviewGet(mapId: string, sourceKey: string): Promise<ReviewSession | null>` *(unstable)*

#### `cmd.storeReviewList(mapId: string, status: string | null): Promise<ReviewSession[]>` *(unstable)*

#### `cmd.storeReviewUpdate(update: ReviewUpdate): Promise<null>` *(unstable)*

#### `cmd.storeSample(selector: Selector, n: number): Promise<number[]>` *(unstable)*

`n` ids drawn uniformly at random from the selected set, without replacement.

#### `cmd.storeSaveDirty(): Promise<SaveResult>` *(unstable)*

Autosave uncommitted changes to the delta sidecar. No-op when nothing changed.

#### `cmd.storeSaveExportFile(srcPath: string, destPath: string): Promise<null>` *(unstable)*

Copy a temp export file to the destination chosen via the native save dialog,
then remove the temp source. `dest_path` comes from the frontend save dialog.

#### `cmd.storeSaveSelection(name: string, selector: Selector, tagNames: { [x: number]: string; }, color: [number, number, number]): Promise<SavedSelection>` *(unstable)*

#### `cmd.storeScratchMap(): Promise<MapMeta>` *(unstable)*

Open the scratch map, creating it if this is its first use. Ordinary in every way
except that [`store_list_maps`] hides it and startup wipes it.

#### `cmd.storeSeenClear(): Promise<null>` *(unstable)*

Deletes all seen history entries.

#### `cmd.storeSeenCount(filter: SeenFilter | null): Promise<number>` *(unstable)*

Returns the total number of seen entries matching the filter (for pagination).

#### `cmd.storeSeenCountries(): Promise<string[]>` *(unstable)*

Returns all distinct country codes present in the seen table, sorted alphabetically.
Used to populate the country filter dropdown.

#### `cmd.storeSeenList(limit: number, offset: number, filter: SeenFilter | null, thumbnails: boolean): Promise<SeenEntry[]>` *(unstable)*

Returns a page of seen entries, newest first, with optional filtering.

#### `cmd.storeSeenMaps(): Promise<SeenMapInfo[]>` *(unstable)*

Returns all distinct maps that have seen entries, with resolved display names.

#### `cmd.storeSeenWrite(entry: SeenWriteEntry): Promise<null>` *(unstable)*

Record a panorama visit. Oldest entries beyond `MAX_SEEN` are evicted.

#### `cmd.storeSetActive(id: number | null): Promise<null>` *(unstable)*

Set (or clear) the active location. Fire-and-forget from JS; no re-render triggered.
JS patches the cell buffer synchronously to hide/show the active marker.

#### `cmd.storeSetMarkerColor(color: [number, number, number]): Promise<null>` *(unstable)*

Set the default marker color used by the render delta path. Fire-and-forget from JS;
the JS side recolors its cell buffers in place (no full rebuild).

#### `cmd.storeSpaced(selector: Selector, targetCount: number | null, minDistanceM: number | null): Promise<SpacedPickResult>` *(unstable)*

An evenly spaced subset: exactly one of `target_count` (thin to N, maximizing
spacing) or `min_distance_m` (keep as many as fit at that spacing).

#### `cmd.storeSyncSelections(sels: SelectionInput[]): Promise<SelectionSync>` *(unstable)*

Replace all selections, resolve bitmasks against current data, and write a binary
patch file for JS to apply to the render overlay. Returns per-selection counts.

#### `cmd.storeTouchMapOpened(mapId: string): Promise<null>` *(unstable)*

Update `last_opened_at` to the current timestamp. Used to sort the map
list by recency in the dashboard.

#### `cmd.storeUndo(): Promise<MutationResult>` *(unstable)*

Pop the undo stack and reverse the last edit. Pushes the entry onto the redo stack.

#### `cmd.storeUpdateLocations(updates: Update<LocationPatch_Deserialize>[], recordUndo: boolean | null): Promise<MutationResult>` *(unstable)*

Apply partial patches to existing locations. `record_undo` defaults to true;
set to false for ephemeral updates (e.g., plugin-driven batch modifications
that manage their own undo).

#### `cmd.storeUpdateMapMeta(id: string, patch: MapMetaPatch_Deserialize): Promise<MutationResult | null>` *(unstable)*

Apply a partial update to a map's metadata; `None` fields are left unchanged.
When extra fields change on an open map, the in-memory field registry is replaced
(so auto-registration doesn't re-discover user-defined fields) and the resulting
store-state delta is returned for the caller to apply.

#### `cmd.storeUpdateTags(updates: Update<TagPatch>[]): Promise<MutationResult>` *(unstable)*

Rename and/or recolor tags in one batch. Renaming onto an existing name (case-insensitive)
merges the two tags.

#### `cmd.storeUploadAbort(sessionDir: string): Promise<null>` *(unstable)*

Remove an abandoned upload session dir (e.g. cancelled operation).

#### `cmd.storeUploadBegin(): Promise<string>` *(unstable)*

Create a temp session dir for binary uploads from the frontend. Files are
written into it via `mma-buf://` POST, then packaged by [`store_upload_finish`].

#### `cmd.storeUploadFinish(sessionDir: string): Promise<string>` *(unstable)*

Package an upload session and remove its dir: a single file is moved out
as-is, multiple are packed into a Stored ZIP (entries like JPEG/PNG are
already compressed). Returns a temp path for [`store_save_export_file`].

#### `cmd.storeValues(selector: Selector, field: string): Promise<string[]>` *(unstable)*

Distinct values of `field` across the selected set, sorted.

#### `cmd.syncReconcile(provider: string, mapId: string, remoteMapId: string, apiKey: string | null, firstSync: FirstSyncMode | null, resolutions: [string, ResolutionSide][] | null): Promise<...>` *(unstable)*

Reconcile a linked, open map against its remote. Snapshots local state under the store lock,
drops the lock, then does all network + persistence off the async thread.

#### `cmd.uninstallPlugin(id: string): Promise<null>` *(unstable)*

Delete a plugin's directory.

#### `cmd.updateCheck(endpoint: string): Promise<UpdateAvailable | null>` *(unstable)*

Look for an update at `endpoint` (a release's `latest.json`). `None` means the announced
version is not newer than the running one, which is the plugin's own comparison.

#### `cmd.updateInstall(): Promise<null>` *(unstable)*

Download and install whatever the last [`update_check`] found. The installer replaces the
running app, so nothing after this is guaranteed to run -- the caller saves its state first.

#### `cmd.valiCancel(): Promise<void>` *(unstable)*

Cancel an in-flight vali generate or download.

#### `cmd.valiCountries(): Promise<string[]>` *(unstable)*

Country codes Vali has coverage data for, i.e. the set `vali download` iterates
when no country is given. Display names are the caller's job.

#### `cmd.valiDataStatus(): Promise<ValiCountryStatus[]>` *(unstable)*

Countries whose downloaded coverage data is older than the remote copy. Object metadata
only -- nothing is fetched. Errors while offline, which callers should read as "unknown"
rather than "up to date".

#### `cmd.valiDownload(country: string | null, full: boolean, updates: boolean): Promise<null>` *(unstable)*

Download Vali coverage data. `country` = code/continent alias/None for all.

#### `cmd.valiDownloadStale(): Promise<null>` *(unstable)*

Download exactly the countries `vali_data_status` reports as behind. No-op when nothing
is stale, so the caller can fire it without checking first.

#### `cmd.valiGenerate(definition: string): Promise<ValiLocation[]>` *(unstable)*

Generate locations from a Vali map definition (JSON/JSONC text). Missing country
data is auto-downloaded like the Vali CLI. Returns the generated locations.

#### `cmd.valiSubdivisions(country: string): Promise<string>` *(unstable)*

Subdivision weights for a country (JSON text, same shape as `vali subdivisions`).

#### `cmd.writeTempFile(name: string, content: string): Promise<string>` *(unstable)*

Write text to a named temp file (`mma_{name}`) and return its path. Lets JS hand
large payloads over by file instead of IPC serialization. `name` names a leaf, so it
cannot steer the write out of the temp directory.

## Tauri

### `dialog: { open: <T extends OpenDialogOptions>(options?: T | undefined) => Promise<OpenDialogReturn<T>>; save: (options?: SaveDialogOptions | undefined) => Promise<...>; }`

### `invoke<T>(cmd: string, args?: InvokeArgs | undefined, options?: InvokeOptions | undefined): Promise<T>`

Sends a message to the backend.

### `shell: { Command: typeof Command; }`

Tauri primitives, handed to plugins as-is.

## Registry

### `activatePlugin(id: string): void` *(unstable)*

### `activatePlugins(): void` *(unstable)*

### `autoUpdatePlugin(m: PluginManifest, latest: PluginManifest | undefined, appVersion: string): Promise<PluginManifest>` *(unstable)*

Refresh a stale install before it loads. Nothing is registered yet at startup, so an
update is just re-downloading the files the normal load then picks up; any failure
falls back to loading what's on disk. Plugins absent from the registry (hand-installed
dev plugins) and plugins with no build this app can run are never touched.

### `createPluginStorage(id: string): PluginStorage`

Persistent key-value storage namespaced to a plugin. Survives restarts.

### `deactivatePlugin(id: string): void` *(unstable)*

### `deactivatePlugins(): void` *(unstable)*

### `fetchPluginRegistry(): Promise<PluginManifest[]>` *(unstable)*

The marketplace registry, fetched once per session (startup update check and the
marketplace dialog share it). A failed fetch clears the cache so the next call retries.

### `getEnabledPlugins(): Plugin[]`

### `getPlugin(id: string): Plugin | undefined`

### `getPlugins(): Plugin[]`

### `getPluginSetting<T = unknown>(plugin: Plugin, key: string): T`

### `isBackgroundPlugin(id: string): boolean`

A plugin with no sidebar, modal, or location panel — it only contributes data
(enrichment fields) and never shows UI of its own. Unknown for plugins that
aren't loaded, so uninstalled registry entries report false.

### `isPluginCompatible(minAppVersion: string | null | undefined, appVersion: string): boolean` *(unstable)*

Update machinery.

### `isPluginEnabled(id: string): boolean`

### `isPluginUpdatable(installedVersion: string | undefined, latestVersion: string | undefined): boolean` *(unstable)*

Update machinery.

### `isReady(): boolean`

True once the MMA surface is installed and plugins are safe to call it.

### `markReady(): void` *(unstable)*

Called by the entry point once the surface is on `window`.

### `needsBuildUpdate(installedVersion: string | undefined, target: ResolvedBuild, installedSidecarVersion: string | null | undefined, latestSidecarVersion: string | undefined): boolean` *(unstable)*

Whether an install should be refreshed to `target`. A pinned build's sidecar version
lives in its own manifest, so only the latest build's sidecar can be compared before
downloading; for a pinned one the install itself reconciles it.

### `needsUpdate(installedVersion: string | undefined, latestVersion: string | undefined, installedSidecarVersion: string | null | undefined, latestSidecarVersion: string | undefined): boolean` *(unstable)*

Update machinery.

### `registerPlugin(plugin: Plugin | PluginBehavior): void`

Register a plugin. `activate` runs when a map opens; its returned cleanup runs on map close.

### `resolveBuild(entry: PluginManifest, appVersion: string): ResolvedBuild | null` *(unstable)*

The newest build of a plugin this app version can run -- the registry's latest when
compatible, else the newest pinned fallback that is. Null when no published build
supports this app at all. `builds` is ordered newest-first.

### `setPendingManifest(manifest: PluginManifest | null): void` *(unstable)*

### `setPluginEnabled(id: string, enabled: boolean): void`

### `setPluginSetting(id: string, key: string, value: unknown): void`

### `storage(id: string): PluginStorage`

Persistent key-value storage namespaced to a plugin. Survives restarts.

### `unregisterPlugin(id: string): void` *(unstable)*

### `usePluginState<T>(pluginId: string, key: string, initial: T | (() => T)): readonly [T, (action: SetStateAction<T>) => void]`

useState persisted through the plugin's namespaced store. UI state saved this
way survives sidebar unmount and app restart. Values are global, not per-map —
callers must fall back gracefully when a stored value doesn't resolve against
the current map (e.g. a field key or saved-selection id).

## Scope

### `disposePlugin(id: string): void` *(unstable)*

Run and clear every teardown a plugin registered, in reverse order.

### `on<E extends EditorEvent>(event: E, handler: EventHandler<E>): () => void`

Subscribe to an editor event. The returned unsubscribe also runs when the plugin
deactivates.

### `resolvePluginPath(path: string): string` *(unstable)*

Resolve a file path a plugin registration referred to, against the directory of the
plugin currently activating. Absolute paths, "res://" URLs, registrations outside an
activation window, and core plugins (no directory) all pass through unchanged.

### `runAsPlugin<T>(id: string, fn: () => T): T` *(unstable)*

Run `fn` attributed to plugin `id`; host registrations during it are tracked for teardown.
Plugin activation machinery, driven by the registry.

### `setPluginBaseDir(id: string, dir: string): void` *(unstable)*

Record where a plugin's files live on disk, so its registrations can resolve
paths to assets it ships. Core plugins have no directory.

### `trackDisposable(dispose: Disposable): void` *(unstable)*

Enroll a teardown callback under the currently-activating plugin. No-op outside activation.

## Externals

### `getAvailableExternals(): string[]`

Names of every module available through `mmaRequire`.

### `mmaRequire(id: string): unknown`

Get a module the app bundles (e.g. "react", "@deck.gl/core") for use inside a plugin.
Lazy modules must be loaded with `preloadModules` first.

### `preloadModules(ids: string[]): Promise<void>`

Load lazy bundled modules so `mmaRequire` can return them synchronously.

## Sidecar

### `installedVersion(pluginId: string): Promise<string | null>`

The sidecar version installed for a plugin, or null when it has none yet.

### `request<T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T> | undefined): Promise<T | null>`

Run one unit of work on a plugin's sidecar and resolve with its last emitted
object (null if it emitted none). The app owns the process: commands the manifest
lists under `serve` are answered by the plugin's resident sidecar, the rest by a
one-shot run. `payload` is handed to the sidecar as JSON.

### `sidecar: { request: <T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T> | undefined) => Promise<T | null>; installedVersion: (pluginId: string) => Promise<...>; }`

The nested `sidecar` namespace on the plugin surface.

## Ui

### `ui`

#### `ui.Button({ variant, small, type, className, ...props }: ClassAttributes<HTMLButtonElement> & ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant | undefined; small?: boolean | undefined; }): Element`

#### `ui.Checkbox({ className, ...props }: DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>): Element`

#### `ui.ColorPicker({ color, onChange, ariaLabel, }: { color: RGB; onChange: (color: RGB) => void; ariaLabel?: string | undefined; }): Element`

A color swatch that opens the picker in a popover on click.

#### `ui.DatePicker({ mode, value, onChange, anyYear, onAnyYearToggle, showAnyYear, showTime, anyTime, onAnyTimeToggle, showAnyTime, tzLocal, onTzLocalToggle, showTzLocal, onYearSelect, wallClock, }: DatePickerProps): Element`

#### `ui.Dialog({ open, onOpenChange, children, ...props }: DialogProps$1): Element`

#### `ui.DialogContent({ className, title, children, ...props }: DialogContentProps & { title: string; }): Element`

#### `ui.DialogTrigger(props: DialogTriggerProps & RefAttributes<HTMLButtonElement>): ReactNode`

The type of the component returned from {@link forwardRef}.

#### `ui.EmptyState({ icon, children }: { icon?: string | undefined; children: ReactNode; }): Element`

Centered icon + message for empty panels.

#### `ui.Field({ label, hint, row, children, }: { label: ReactNode; hint?: ReactNode; row?: boolean | undefined; children: ReactNode; }): Element`

Labelled form row (label left, control right) for sidebar sections.

#### `ui.Flag({ code, height, className, }: { code: string | null; height?: number | undefined; className?: string | undefined; }): Element | null`

Country flag from the bundled SVG set. Renders nothing for a missing or malformed code.

#### `ui.HotkeyInput({ value, onChange, }: { value: string; onChange: (combo: string) => void; }): Element`

Click-to-record key combo input. Backspace/Delete clears, Escape cancels.

#### `ui.Icon({ path, size, className, style }: IconProps): Element`

#### `ui.NSelect({ className, onWheel, ...props }: DetailedHTMLProps<SelectHTMLAttributes<HTMLSelectElement>, HTMLSelectElement>): Element`

#### `ui.Radio({ className, ...props }: DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>): Element`

#### `ui.RgbPicker({ color, onChange }: { color: RGB; onChange: (color: RGB) => void; }): Element`

The picker surface itself, debounced. Sole place the `{r,g,b}` shape react-colorful
wants exists -- every caller in the app passes and receives an [r, g, b] tuple.

#### `ui.Section({ title, defaultOpen, collapsible, addons, children, }: { title: ReactNode; defaultOpen?: boolean | undefined; collapsible?: boolean | undefined; addons?: ReactNode; children: ReactNode; }): Element`

Collapsible titled section inside a Sidebar.

#### `ui.SegmentedControl<T extends string | number>({ options, value, onChange, className, }: { options: SegmentedOption<T>[]; value: T; onChange: (value: T) => void; className?: string | undefined; }): Element`

Row of mutually exclusive option buttons (a compact radio group).

#### `ui.SelectorPicker({ ctl, className, }: { ctl: SelectorPickController; className?: string | undefined; }): Element`

#### `ui.SettingRow(props: BoolRow | ControlRow | AutoBoolRow): Element | null`

#### `ui.Sidebar({ title, onBack, actions, className, flush, children, }: { title: ReactNode; onBack?: (() => void) | undefined; actions?: ReactNode; className?: string | undefined; flush?: boolean | undefined; children: ReactNode; }): Element`

Standard right-hand sidebar chrome (title, back button, scrollable body). Use for plugin sidebars.

#### `ui.Slider({ className, ...props }: DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>): Element`

Range input whose track fills with the accent up to the current value.
Controlled only: the fill derives from the value prop.

#### `ui.SuggestInput<T>({ value, onChange, suggestions, onPick, renderItem, getKey, placeholder, containerClassName, inputClassName, listClassName, itemClassName, listStyle, autoFocus, disabled, pickOnEnter, portal, }: { value: string; onChange: (v: string) => void; suggestions: T[]; onPick: (item: T) => void; renderItem: (item: T) => ReactNode; getKey: (item: T) => string | number; ... 9 more ...; portal?: boolean | undefined; }): Element`

Autocomplete input: owns open/close state, outside-click dismissal,
Enter-picks-first, and Escape-closes. Suggestion sourcing stays at the call
site (sync filter or debounced fetch) — the dropdown shows whenever
`suggestions` is non-empty and not dismissed. Default classes render the
standard `.search-results` dropdown; override them for other skins.

#### `ui.Switch({ checked, onChange, disabled, label, }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean | undefined; label?: string | undefined; }): Element`

#### `ui.SwitchRow({ checked, onChange, label, disabled, className, children, }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean | undefined; className?: string | undefined; children?: ReactNode; }): Element`

A compact, control-left row whose whole surface toggles an immediate-effect
boolean. The Switch owns keyboard + a11y; the row forwards mouse clicks to
the same toggle. The control wrapper stops propagation so a direct switch
click does not also fire the row handler. Used by MapSettingsPanel and any
surface outside the Settings dialog (SettingRow is the Settings dialog row).

#### `ui.TagPill<E extends ElementType = "span">({ as, color, label, count, small, button, children, ...rest }: TagPillProps<E>): Element`

The one tag pill. Owns the tag color's rendering: every surface that shows a tag
goes through here, so the look changes in one place.

#### `ui.TagPillButton({ variant, className, ...props }: ClassAttributes<HTMLButtonElement> & ButtonHTMLAttributes<HTMLButtonElement> & { variant: TagPillButtonVariant; }): Element`

The leading affordance inside a TagPill: remove, apply, or open the editor.

#### `ui.TextInput({ className, ...props }: DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>): Element`

#### `ui.ToolBlock(props: ToolBlockProps): Element`

#### `ui.Tooltip({ content, side, align, children, }: { content: string; side?: Side | undefined; align?: Align | undefined; children: ReactElement<unknown, string | JSXElementConstructor<any>>; }): ReactElement<...>`

Marks its child as a tooltip trigger. Adds attributes to the existing element instead of
wrapping it, so a trigger costs no extra fibers and hovering re-renders only the single
host below -- one portal for the whole app rather than one per trigger.

#### `ui.useCloseDialog(): () => void`

## FieldDefs

### `derivedFrom(changed: Iterable<string>): Set<string>`

Every field derived from the `changed` keys, directly or through other providers: what a
row must forget when those inputs change, for enrichment to derive again. The graph is
each provider's `requires` against what it produces.

### `getAllEnrichKeys(): string[]`

### `getDefaultEnrichKeys(): string[]`

Keys enriched when enrichFields is null (the default set: all options except defaultOff ones).

### `getEnrichFieldOptions(): EnrichFieldOption[]`

### `getProviderForField(field: string): Provider | undefined`

### `getProviders(): Provider[]`

### `isFieldEnabled(enrichFields: string[] | null, key: string): boolean`

### `knownFieldDefs(...keys: string[]): Record<string, ExtraFieldDef>`

Field defs for catalog keys, for providers that write well-known SV fields.

### `registerEnrichFields(fields: EnrichFieldOption[]): void`

Offer extra fields in the enrichment UI. Unregistered when the plugin deactivates.

### `registerProvider(provider: Provider): void`

Register a provider (e.g. a plugin's sun position). Unregistered when the plugin
deactivates.

### `withoutDerivedFrom(extra: Record<string, unknown> | null, changed: Iterable<string>): Record<string, unknown> | null`

`extra` without every field derived from the `changed` keys.

## FieldDefRegistry

### `fieldLabel(key: string): string`

Display label for a field key: registered label if known, otherwise sentence-cased from camelCase/snake_case.

### `fieldValueLabel(def: ExtraFieldDef | undefined, value: unknown): string`

Display text for one *value* of a field, the counterpart to [`fieldLabel`] naming the
field itself. Enum values carry translated display names; everything else is its own
string.

### `getAllFieldDefs(): Record<string, ExtraFieldDef>`

Merged view of all field definitions across all layers.

### `getBuiltinKeys(): string[]`

All built-in field keys (excluding virtual).

### `getFieldDef(key: string): ExtraFieldDef | undefined`

Look up metadata for a single field key. Returns `undefined` if no metadata exists.

### `getKnownFieldKeys(): ReadonlySet<string>`

Keys some location on this map carries. Same reference until the user layer moves.

### `isBuiltinField(key: string): boolean`

True when `key` is a built-in Location field (stored top-level, not under `extra`).

### `isClearableField(key: string): boolean`

False for a built-in column a bulk clear cannot empty: non-null, or rewritten by the
engine on every change.

### `isListableField(key: string): boolean`

False for identity fields (lat/lng) and expression terms, which pickers must not offer.

### `isWritableField(key: string): boolean`

### `partitionKeyOptions(type: ExtraFieldType, rangeForDates: boolean): { id: string; label: string; }[]`

Dropdown options for a partition: the projection catalog plus "Range" for numbers (and
dates too when `rangeForDates`).

### `projectionsForType(type: ExtraFieldType): FieldProjection[]`

Projections valid for a field type, in display order (first = dialog default).

### `RANGE_ID: "range"`

### `registerPluginFieldDefs(defs: Record<string, ExtraFieldDef>): void`

Register field definitions from an enrichment provider (called at activation).

### `unregisterPluginFieldDefs(keys: string[]): void`

Remove plugin field definitions by key (called when a plugin is deactivated).

## Procedures

### `noWork(): BatchOutcome`

### `procedureEntry(name: string): string`

Entry point of a procedure this app bundles. Plugins ship their own paths.

### `queryProcedure<T = unknown>(entry: string, input: unknown, config?: unknown, signal?: AbortSignal | undefined): Promise<T>`

Ask a procedure a read-only question. `input` and the answer are the module's own
contract -- the engine only carries the JSON. Rejects when the module exports no
`query` or the call fails, and with the signal's reason once `signal` aborts, at
which point the engine declines the query's remaining requests. `T` is an unchecked
assertion over that contract: sound for the app's own `res://` modules, which are
pinned by tests. Validate instead of naming a `T` when the module is a plugin's.

### `resolveFieldLabels(field: string, keys: string[]): Promise<string[]>`

Display labels for a field's partition keys, from the procedure that owns the field.
A module with no `label` query -- or one answering anything but a matching array of
strings -- leaves the keys as they are.

### `runProcedure<T>(spec: ProcedureSpec<T>, selector: Selector, opts: Omit<RunOpts, "force"> & Omit<DeclOpts, "fields" | "requires"> & { ...; }): Promise<...>` *(unstable)*

Run one procedure over `selector`, on its own. The primitive: a consumer that is not
enrichment (validation, a download resolving pano ids) declares a spec and calls this,
and gets its collected answers typed by the spec.

### `runProviders(items: ProviderRun[], rows: Selector, opts?: RunOpts | undefined): Promise<ProviderOutcomes>`

Drive a set of providers through the engine as one run over `rows`: a selector, which
the engine pages out of the store and writes back into, reporting per-provider
progress this hands to the caller per provider; or locations
handed in, which run in a store of their own and come back as the providers left
them, with nothing reaching the map. Resolves once every declared provider reports
finished, or on abort.

## Seen

### `clearSeen(): Promise<void>`

Delete the entire seen history. Not undoable.

### `getSeenCount(filter?: SeenFilter | undefined): Promise<number>`

Number of seen entries matching the filter (all when omitted).

### `getSeenCountries(): Promise<string[]>`

### `getSeenEntries(limit?: number | undefined, offset?: number | undefined, filter?: SeenFilter | undefined, thumbnails?: boolean | undefined): Promise<SeenEntry[]>`

Fetch a page of the seen (visited-panorama) history.

### `getSeenMaps(): Promise<SeenMapInfo[]>`

### `seenFlush(getPov: () => LocationPOV): void`

### `seenPanoChanged(location: PendingEntryLocation, geo: GeoDisplay | null, getPov: () => LocationPOV): void`

### `seenSkipNext(panoId: string): void`

### `seenUpdateGeo(geo: GeoDisplay): void`

## PanoSingleton

The shared panorama viewer's internals.

### `applyResolved(sv: StreetViewPanorama, resolved: Pano | null, loc: Location): void` *(unstable)*

### `capturePano(): PanoCapture | null` *(unstable)*

Read the live viewer back into Location fields, the inverse of {@link applyResolved}.
Null until the viewer has a position.

### `capturePov(): LocationPOV` *(unstable)*

The live viewer's camera in the stored zoom domain. Zeroed if there is no viewer.

### `clearSingletonPano(): void` *(unstable)*

### `getPanorama(): StreetViewPanorama | null` *(unstable)*

### `loadSeenPano(entry: SeenEntry): Promise<void>` *(unstable)*

Open a seen entry's panorama in the Street View viewer.

### `singletonDiv: HTMLDivElement`

The **`HTMLDivElement`** interface provides special properties (beyond the regular HTMLElement interface it also has available to it by inheritance) for manipulating <div> elements.

[MDN Reference](https://developer.mozilla.org/docs/Web/API/HTMLDivElement)

### `singletonPano: StreetViewPanorama | null`

## Enrich

### `enrich(loc: Location, opts?: Omit<RunOpts, "onProgress"> | undefined): Promise<Location>`

One location as enrichment leaves it: every field-producing provider, narrowed to
the map's enabled keys, run over that row alone. A field the row already holds is
not derived again unless `force`, which re-derives every field the providers own.
Nothing is written; the caller holds the result. The row comes back untouched when
the map's enrichment is off.

### `enrichAll(selector: Selector, opts?: RunOpts | undefined): Promise<EnrichOutcome[]>`

Bulk enrich a selector: resolve missing pano ids, then run every field-producing
provider (metadata, exact date, timezone, subdivision) through the Rust engine.

### `enrichRuns(enrichFields: string[] | null, exclude?: string[] | undefined): ProviderRun[]`

The field-producing providers as enrichment runs them, each narrowed to the keys the
user picked. Keys the enrichment UI never offers are always produced.

### `exactDateProvider`

A procedure with a place in the dependency graph: what it produces (`fieldDefs`,
`provides`) and what it must wait for (`requires`), so `runProviders` can schedule
several together. One that declares `fieldDefs` is an enrichment provider: its fields
are selectable and `enrichAll` runs it implicitly. A consumer that just wants one
procedure run declares a `ProcedureSpec` and calls `runProcedure`.

#### `exactDateProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Selectable `extra` keys this provider produces. Omitted, the provider writes
core columns instead: it is always active, and `enrichAll` never runs it
implicitly -- only a caller naming it does.

#### `exactDateProvider.id: string`

#### `exactDateProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `exactDateProvider.procedure: ProcedureSpec<unknown>`

The procedure the Rust engine runs for this provider.

#### `exactDateProvider.provides: string[] | undefined`

Core columns this provider writes, e.g. `panoId`. They gate dependents and skip
rows that already hold them, exactly like `fieldDefs`.

#### `exactDateProvider.requires: string[] | undefined`

Fields this provider reads: the engine starts it only once every provider
producing them has finished.

### `panoResolveProvider`

A procedure with a place in the dependency graph: what it produces (`fieldDefs`,
`provides`) and what it must wait for (`requires`), so `runProviders` can schedule
several together. One that declares `fieldDefs` is an enrichment provider: its fields
are selectable and `enrichAll` runs it implicitly. A consumer that just wants one
procedure run declares a `ProcedureSpec` and calls `runProcedure`.

#### `panoResolveProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Selectable `extra` keys this provider produces. Omitted, the provider writes
core columns instead: it is always active, and `enrichAll` never runs it
implicitly -- only a caller naming it does.

#### `panoResolveProvider.id: string`

#### `panoResolveProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `panoResolveProvider.procedure: ProcedureSpec<unknown>`

The procedure the Rust engine runs for this provider.

#### `panoResolveProvider.provides: string[] | undefined`

Core columns this provider writes, e.g. `panoId`. They gate dependents and skip
rows that already hold them, exactly like `fieldDefs`.

#### `panoResolveProvider.requires: string[] | undefined`

Fields this provider reads: the engine starts it only once every provider
producing them has finished.

### `panoResolveSpec`

A unit of work for the procedure engine: which module, and how to drive it. This is
everything the engine needs and nothing about enrichment; `runProcedure` takes one
directly. Locations never reach JS: the engine pages them and applies the patches
itself. `TCollected` is the shape of one answer under the `collect` sink, as the
module defines it; the engine carries it as JSON and never checks it.

#### `panoResolveSpec.batch: BatchMode`

#### `panoResolveSpec.collects: { panoId: string; } | undefined`

Never set. Carries `TCollected` on the value so `runProcedure` can type its answers.

#### `panoResolveSpec.config: unknown`

Provider-specific settings for the module, any JSON value. The engine splices it
into the configuration it hands the procedure: `{fields, force, config}`.

#### `panoResolveSpec.entry: string`

Module entry point: absolute path, or "res://procedures/<name>.js" for app-bundled
core procedures, or a bare relative filename for user-plugin-shipped modules (resolved
against the registering plugin's directory by the plugin loader).

#### `panoResolveSpec.inflight: number | undefined`

Requests this provider may keep in flight at once, summed over its instances.
This is where a network-bound provider's throughput comes from: the engine holds
the budget, so a procedure reaches it by asking for many requests at once
(`fetchMany`), never by running more instances.

#### `panoResolveSpec.instances: number | undefined`

Procedure instances the provider may run at once. Only for a procedure that cannot
run beside itself (one sidecar process, one large model); otherwise the engine
takes one per core, which is not a throughput knob.

#### `panoResolveSpec.prepare: (() => Promise<boolean>) | undefined`

Awaited before the provider joins a run; false drops it (e.g. a dataset download failed).

#### `panoResolveSpec.rate: RateSpec | undefined`

#### `panoResolveSpec.retry: { attempts: number; on: number[]; } | undefined`

#### `panoResolveSpec.select: Selector | undefined`

Rows the engine feeds the procedure. Omitted, the driver supplies its own.

#### `panoResolveSpec.sink: Sink | undefined`

Where the answers go: `patch` (the default) writes them to the locations they
name, `collect` hands them to the caller and writes nothing. `runProcedure` can
override it, which is how a caller borrows a writing procedure for its answers
alone.

### `subdivisionProvider`

A procedure with a place in the dependency graph: what it produces (`fieldDefs`,
`provides`) and what it must wait for (`requires`), so `runProviders` can schedule
several together. One that declares `fieldDefs` is an enrichment provider: its fields
are selectable and `enrichAll` runs it implicitly. A consumer that just wants one
procedure run declares a `ProcedureSpec` and calls `runProcedure`.

#### `subdivisionProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Selectable `extra` keys this provider produces. Omitted, the provider writes
core columns instead: it is always active, and `enrichAll` never runs it
implicitly -- only a caller naming it does.

#### `subdivisionProvider.id: string`

#### `subdivisionProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `subdivisionProvider.procedure: ProcedureSpec<unknown>`

The procedure the Rust engine runs for this provider.

#### `subdivisionProvider.provides: string[] | undefined`

Core columns this provider writes, e.g. `panoId`. They gate dependents and skip
rows that already hold them, exactly like `fieldDefs`.

#### `subdivisionProvider.requires: string[] | undefined`

Fields this provider reads: the engine starts it only once every provider
producing them has finished.

### `svMetaProvider`

A procedure with a place in the dependency graph: what it produces (`fieldDefs`,
`provides`) and what it must wait for (`requires`), so `runProviders` can schedule
several together. One that declares `fieldDefs` is an enrichment provider: its fields
are selectable and `enrichAll` runs it implicitly. A consumer that just wants one
procedure run declares a `ProcedureSpec` and calls `runProcedure`.

#### `svMetaProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Selectable `extra` keys this provider produces. Omitted, the provider writes
core columns instead: it is always active, and `enrichAll` never runs it
implicitly -- only a caller naming it does.

#### `svMetaProvider.id: string`

#### `svMetaProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `svMetaProvider.procedure: ProcedureSpec<unknown>`

The procedure the Rust engine runs for this provider.

#### `svMetaProvider.provides: string[] | undefined`

Core columns this provider writes, e.g. `panoId`. They gate dependents and skip
rows that already hold them, exactly like `fieldDefs`.

#### `svMetaProvider.requires: string[] | undefined`

Fields this provider reads: the engine starts it only once every provider
producing them has finished.

### `timezoneProvider`

A procedure with a place in the dependency graph: what it produces (`fieldDefs`,
`provides`) and what it must wait for (`requires`), so `runProviders` can schedule
several together. One that declares `fieldDefs` is an enrichment provider: its fields
are selectable and `enrichAll` runs it implicitly. A consumer that just wants one
procedure run declares a `ProcedureSpec` and calls `runProcedure`.

#### `timezoneProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Selectable `extra` keys this provider produces. Omitted, the provider writes
core columns instead: it is always active, and `enrichAll` never runs it
implicitly -- only a caller naming it does.

#### `timezoneProvider.id: string`

#### `timezoneProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `timezoneProvider.procedure: ProcedureSpec<unknown>`

The procedure the Rust engine runs for this provider.

#### `timezoneProvider.provides: string[] | undefined`

Core columns this provider writes, e.g. `panoId`. They gate dependents and skip
rows that already hold them, exactly like `fieldDefs`.

#### `timezoneProvider.requires: string[] | undefined`

Fields this provider reads: the engine starts it only once every provider
producing them has finished.

## PinPano

### `bulkPinToPano(selector: Selector, opts?: (RunOpts & { useLatest?: boolean | undefined; }) | undefined): Promise<BatchOutcome>`

Pin each location in the selector to a resolved panorama (sets `panoId`), so it always
loads the same pano.

### `pinPanoProvider`

A procedure with a place in the dependency graph: what it produces (`fieldDefs`,
`provides`) and what it must wait for (`requires`), so `runProviders` can schedule
several together. One that declares `fieldDefs` is an enrichment provider: its fields
are selectable and `enrichAll` runs it implicitly. A consumer that just wants one
procedure run declares a `ProcedureSpec` and calls `runProcedure`.

#### `pinPanoProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Selectable `extra` keys this provider produces. Omitted, the provider writes
core columns instead: it is always active, and `enrichAll` never runs it
implicitly -- only a caller naming it does.

#### `pinPanoProvider.id: string`

#### `pinPanoProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `pinPanoProvider.procedure: ProcedureSpec<unknown>`

The procedure the Rust engine runs for this provider.

#### `pinPanoProvider.provides: string[] | undefined`

Core columns this provider writes, e.g. `panoId`. They gate dependents and skip
rows that already hold them, exactly like `fieldDefs`.

#### `pinPanoProvider.requires: string[] | undefined`

Fields this provider reads: the engine starts it only once every provider
producing them has finished.

## Validate

### `validateLocations(selector: Selector, opts?: BulkOpts | undefined): Promise<ValidationOutcome>`

Check that each location's Street View coverage still exists.

### `validateSpec`

A unit of work for the procedure engine: which module, and how to drive it. This is
everything the engine needs and nothing about enrichment; `runProcedure` takes one
directly. Locations never reach JS: the engine pages them and applies the patches
itself. `TCollected` is the shape of one answer under the `collect` sink, as the
module defines it; the engine carries it as JSON and never checks it.

#### `validateSpec.batch: BatchMode`

#### `validateSpec.collects: ValidationState | undefined`

Never set. Carries `TCollected` on the value so `runProcedure` can type its answers.

#### `validateSpec.config: unknown`

Provider-specific settings for the module, any JSON value. The engine splices it
into the configuration it hands the procedure: `{fields, force, config}`.

#### `validateSpec.entry: string`

Module entry point: absolute path, or "res://procedures/<name>.js" for app-bundled
core procedures, or a bare relative filename for user-plugin-shipped modules (resolved
against the registering plugin's directory by the plugin loader).

#### `validateSpec.inflight: number | undefined`

Requests this provider may keep in flight at once, summed over its instances.
This is where a network-bound provider's throughput comes from: the engine holds
the budget, so a procedure reaches it by asking for many requests at once
(`fetchMany`), never by running more instances.

#### `validateSpec.instances: number | undefined`

Procedure instances the provider may run at once. Only for a procedure that cannot
run beside itself (one sidecar process, one large model); otherwise the engine
takes one per core, which is not a throughput knob.

#### `validateSpec.prepare: (() => Promise<boolean>) | undefined`

Awaited before the provider joins a run; false drops it (e.g. a dataset download failed).

#### `validateSpec.rate: RateSpec | undefined`

#### `validateSpec.retry: { attempts: number; on: number[]; } | undefined`

#### `validateSpec.select: Selector | undefined`

Rows the engine feeds the procedure. Omitted, the driver supplies its own.

#### `validateSpec.sink: Sink | undefined`

Where the answers go: `patch` (the default) writes them to the locations they
name, `collect` hands them to the caller and writes nothing. `runProcedure` can
override it, which is how a caller borrows a writing procedure for its answers
alone.

## Query

### `panosAt(points: LatLngLiteral[], radius?: number | undefined, opts?: SearchOpts | undefined, signal?: AbortSignal | undefined): Promise<(Pano | null)[]>`

The nearest pano to each point, aligned to `points`, null where there is no coverage.
`opts.sources` narrows which collections are searched (`[PanoType.Official]` is what
`sources: ["google"]` means to the Maps JS API) and `opts.preference` picks nearest or
best. The procedure hands every point to the host at once, so how many run concurrently
stays the engine's call.

### `svMetadata(panoIds: string[], signal?: AbortSignal | undefined): Promise<(Pano | null)[]>`

Full pano metadata for arbitrarily many panos, aligned to `panoIds`. The procedure
dedupes and splits at GetMetadata's 200-per-request cap itself.

## MapState

### `addClickInterceptor(fn: ClickInterceptor): () => void`

### `fitMapToBounds(bounds: LatLngBoundsLiteral | null, padding?: number | undefined, minExtent?: number | undefined): void`

### `getMapHost(): MapHost | null`

This refers to the main editor map only.

### `setDrawInterceptor(fn: DrawInterceptor | null): void`

### `setMapHost(host: MapHost | null): void`

### `tryInterceptClick(lat: number, lng: number, shiftKey?: boolean | undefined): boolean`

### `tryInterceptDraw(rings: number[][][]): boolean`

### `waitForMapHost(): Promise<MapHost>`

Wait for the main editor map to be ready.

## SceneStore

### `clearScene(): void` *(unstable)*

Scene engine control.

### `getMarkerDefaultColor(): [number, number, number, number]`

### `getScene(): CellManager`

### `getScenePositions(): { ids: Uint32Array<ArrayBufferLike>; positions: Float32Array<ArrayBufferLike>; }`

Snapshot of every rendered location: `ids` plus interleaved `[lng, lat, ...]`, read
from the render buffers the app already keeps current. Lets an overlay that draws all
locations see the map without a store round trip.

### `loadScene(markerStyle: MarkerStyle, mc?: RGB | undefined): Promise<void>` *(unstable)*

Full (re)load from Rust for the whole world. Editor-driven on open / marker-style change.

### `recolorScene(mc: RGB): void` *(unstable)*

Repaint the default marker color and tell Rust (for future deltas). The base layers take
the colour as a constant, so this is O(1) rather than a rewrite of every marker.

### `setMarkerDefaultColor(r: number, g: number, b: number): void` *(unstable)*

Scene engine control.

### `startSceneEngine(): () => void` *(unstable)*

Scene engine control.

### `whenSceneSettled(): Promise<void>` *(unstable)*

Resolves when the most recently started full scene load has finished (or immediately if none is in flight).

## Color

### `applyAccentColor(hex: string): void`

The app accent follows the SV coverage line color.

### `colorForName(name: string): string`

Deterministic tag color from a name.

### `hexToHsl(hex: string): { h: number; s: number; l: number; }`

### `hexToRgb(hex: string): RGB`

Parse "#rrggbb" to an [r, g, b] byte tuple. Single source for hex parsing.

### `hslToHex(h: number, s: number, l: number): string`

### `hslToRgb(h: number, s: number, l: number): RGB`

### `labelColor(name: string, overrides: Record<string, string>): string`

A label's color: a user override if set, else a deterministic color from its name.

### `resolveSvColorHex(color: string): string`

SV line colors were historically Open Props ramp names ("cyan"); stored
prefs may still hold one. Hex passes through.

### `rgbCss([r, g, b]: RGB): string`

### `rgbToHex([r, g, b]: RGB): string`

### `textColorFor(bg: string): string`

## Toast

### `getToasts(): ToastEntry[]`

### `progressToast(message: string): ProgressHandle`

### `toast(message: string, duration?: number | undefined, container?: HTMLElement | undefined): void`

## UseJob

### `useJob<R = void, P = string>(fn: (ctx: JobContext<P>) => Promise<R>): Job<R, P>`

A user-triggered async job that reports progress and can be cancelled.
Cancelling aborts the signal and stops the UI immediately; nothing the job does
afterwards can write back. Unmounting cancels. `run` while running is a no-op,
so a double-clicked button cannot start two.

For work driven by changing deps rather than a click, use `useAsync`.

## Test

### `_test`

#### `_test.closeMap(): Promise<void>` *(unstable)*

#### `_test.deleteMap(id: string): Promise<void>` *(unstable)*

#### `_test.importFile(droppedFields: string[], tagName?: string | undefined): Promise<EditorImportResult>` *(unstable)*

#### `_test.importPaste(text: string): Promise<EditorImportResult[]>` *(unstable)*

#### `_test.openMap(id: string): Promise<void>` *(unstable)*

#### `_test.procedureEntry(name: string): string`

Entry point of a procedure this app bundles. Plugins ship their own paths.

#### `_test.runProcedure<T>(spec: ProcedureSpec<T>, selector: Selector, opts: Omit<RunOpts, "force"> & Omit<DeclOpts, "fields" | "requires"> & { ...; }): Promise<...>` *(unstable)*

Run one procedure over `selector`, on its own. The primitive: a consumer that is not
enrichment (validation, a download resolving pano ids) declares a spec and calls this,
and gets its collected answers typed by the spec.

#### `_test.syncSelections(): Promise<{ ids: number[]; }>` *(unstable)*

Forces a full selection re-resolve in Rust and returns the raw selected IDs.
App code reads `getMapState().selectedLocationIds` — mutations already sync
selections via MutationResult.

## Types

### `applyLocationPatch(loc: Location, patch: LocationPatch_Deserialize): Location`

Apply a LocationPatch JS-side, mirroring Rust's `overlay_update`: `extra` is a
JSON Merge Patch (RFC 7386) — keys shallow-merge, a null value deletes its key,
and a null patch clears extra entirely.

### `bboxTupleToBounds(t: [number, number, number, number] | null): LatLngBoundsLiteral | null`

### `boundsToScoreTuple(b: LatLngBoundsLiteral): [number, number, number, number]`

### `createFieldDef(type: ExtraFieldType, over?: Partial<Omit<ExtraFieldDef, "type">> | undefined): ExtraFieldDef`

A field definition with every optional attribute spelled absent.

### `createLocation(partial: Partial<Location> & LatLngLiteral): Location`

Build a Location from lat/lng plus overrides. `id` stays 0 until `addLocations`
writes the real id back into the object.

### `dropLocation(source: Location, live: PanoCapture, panoId: string | null, tags: number[]): Location`

A new Location at the viewer's live camera, carrying `source`'s flags and the given
tags. `extra` describes the pano it was fetched for, so it only survives a drop that
stayed on that pano.

### `extraPatch(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Record<string, unknown>`

The `extra` merge patch that turns `before` into `after`: changed keys carry their
new value, keys `after` lacks carry null.

### `isImportPreview(loc: Location): boolean`

### `isPinned(loc: Location): loc is Location & { panoId: string; }`

Pinned: the location always opens this exact pano.

### `isSeenPreview(loc: Location): boolean`

### `isVirtualLocation(loc: { id: number; }): boolean`

Virtual locations exist only ephemerally as the single active-location preview — never in
the map. They display like real locations but every mutate path no-ops. Identity is a unique
negative id (so id-only checks work); the kind rides in `flags` (read where you hold the
full Location).

### `isWorldBounds(b: LatLngBoundsLiteral): boolean`

### `locId(m: MaybeLocation): number`

### `sameRow(a: Location, b: Location): boolean`

The same location on the same pano: what makes one row's answer another row's.

### `scoreTupleToBounds([s, w, n, e]: [number, number, number, number]): LatLngBoundsLiteral`

## Util

### `appendTagName(pending: string[], name: string, tags: Tag[]): string[]`

Add a name to a staged list: dedup case-insensitively, normalizing to an existing tag's
canonical casing. Returns the original array unchanged if already present.

### `bestBy<T>(items: Iterable<T>, isBetter: (a: T, b: T) => boolean): T | null`

The item `isBetter` prefers over every other, or null when there are none.

### `chunk<T>(arr: readonly T[], n: number): T[][]`

### `cmpVersion(a: string, b: string): number`

Compare two semver strings (e.g. "0.6.1", "0.7.0-rc.2"). Returns >0 if a > b.
Build metadata is ignored; a pre-release sorts below the release it precedes.

### `compareNatural(a: string, b: string): number`

### `copyImageToClipboard(blob: Blob): Promise<boolean>`

Copy an image Blob to the clipboard. False when the platform refuses it.

### `downloadBlob(blob: Blob, fileName: string): void`

Trigger a browser download from an in-memory Blob.

### `errText(e: unknown): string`

Message for an unknown thrown value.

### `fovToZoom(fov: number): number`

### `isPrereleaseVersion(v: string): boolean`

True when `v` carries a semver pre-release tag, e.g. "1.0.0-beta.1".

### `isWeb(): boolean`

True when running under the web-serve bridge (a plain browser, no native shell).

### `mmaBufUrl(path: string): string`

URL that serves a local file over the `mma-buf://` protocol (binary Rust-to-JS transfers).

### `nowUnix(): number`

Current time as Unix seconds, the form Location timestamps use.

### `phaseRate(prev: PhaseRate | null, done: number, total: number, now: number): { state: PhaseRate; rate: number | null; }`

Locations/second averaged over the progress phase in flight. A done that went backward
or a total that grew means a new phase began (a hand-run resets its bar per phase;
within one, done only grows and the total only shrinks as skips are found), so the
average re-anchors there instead of carrying the previous phase's speed. Null until
the phase shows a quarter second of work.

### `schemeBase(scheme: string): string`

Base URL for a Tauri custom URI scheme. Windows WebView2 uses http://<scheme>.localhost/.

### `sortTagsByMode(tags: Tag[], mode: TagSortMode, counts: Record<number, number>): Tag[]`

### `splitVersion(v: string): [core: string, pre: string]`

`["0.7.0", "rc.2"]` for `"v0.7.0-rc.2+build"`; the pre-release part is `""` when absent.

### `tagColorFor(name: string, tags: Tag[]): string`

Color for a tag named `name`. An existing tag uses its stored color.

### `toggleInSet<T>(set: ReadonlySet<T>, value: T, on?: boolean | undefined): Set<T>`

Copy of `set` with `value` toggled, or forced on/off by `on`.

## Legacy

Shims for removed APIs.

### `fetchAllLocations(): Promise<Location[]>` *(unstable)*

### `fetchLocation(id: number): Promise<Location>` *(unstable)*

### `fetchLocationsByIds(ids: number[]): Promise<Location[]>` *(unstable)*

### `fieldCoverage(selector: Selector): Promise<[string, number][]>` *(unstable)*

### `getActiveLocation(): Location | null` *(unstable)*

### `getAllSelections(): Selection[]` *(unstable)*

### `getCurrentMap(): MapMeta | null` *(unstable)*

### `getCurrentMapId(): string | null` *(unstable)*

### `getDirtyCount(): Promise<number>` *(unstable)*

### `getGhostedSelections(): ReadonlySet<string>` *(unstable)*

### `getGoogleMap(): Map | null` *(unstable)*

### `getSelectedLocationIds(): SelectedIds` *(unstable)*

### `getSelections(): Selection[]` *(unstable)*

### `getTagCounts(): { [x: number]: number; }` *(unstable)*

### `getWorkArea(): WorkArea` *(unstable)*

### `registerEnrichmentProvider(provider: Provider): void` *(unstable)*

### `setUserFieldDefs(defs: Record<string, ExtraFieldDef>): Promise<void>` *(unstable)*

### `waitForGoogleMap(): Promise<Map | null>` *(unstable)*
