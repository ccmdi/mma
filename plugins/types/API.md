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
- [Jobs](#jobs)
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

Add locations to the map. Real ids are assigned and written back into the passed
objects - build with `createLocation` (id 0) and read `loc.id` after. Undoable.
Emits `location:add`.

### `addSelections(selectors: Selector[]): Promise<void>`

Add selectors to the active selection list.

### `addTagToLocations(tagId: number, locationIds: number[]): Promise<void>`

Add a tag to locations (skips ones that already have it). Undoable.

### `applyFieldOp(selector: Selector, op: FieldOp, recordUndo: boolean): Promise<FieldOpResult>`

Apply a field operation across all locations matching `selector`. Emits `location:invalidate`.

### `applySelectionUpdate(op: (sels: Selection[], ghosted: ReadonlySet<string>) => Selection[] | Partial<SelectionState>): Promise<void>`

Apply a selection transform function and re-resolve the selection.
The function receives the current selections and ghosted set, and returns either
a new `Selection[]` or a `SelectionPatch`. No-op when nothing changed.

### `cancelAutosave(): void` *(unstable)*

Cancel any pending autosave timer.

### `checkoutCommit(commitId: string): Promise<void>`

Restore the map to a previous commit's state and reopen it. Clears undo/redo.

### `closeDuplicates(): void` *(unstable)*

Close the duplicate-resolution panel and return to the overview.

### `closeMap(): Promise<void>`

Close the open map, saving unsaved changes first.

### `commitMap(message?: string | undefined): Promise<string>`

Commit all pending changes to the map's version history. Clears the undo stack.

### `countBy(selector: Selector, field: string, key: KeySpec): Promise<[string, number][]>`

Group by a derived key and count.

### `countIn(selector: Selector): Promise<number>`

How many locations the selector resolves to.

### `coverage(selector: Selector): Promise<[string, number][]>`

How many locations hold a value for each field, key-sorted.

### `createTags(names: string[], selector?: Selector | undefined): Promise<Tag[]>`

Get-or-create tags by name. Existing tags are returned as-is; new names get
auto-generated colors. Pass `selector` to assign the tags to those locations
atomically. Emits `tag:add`.

### `currentSelection(): Selector`

The live selection as a `Selector`: the union of the active selection nodes.

### `deleteField(key: string): Promise<void>`

Delete extra-field `key` from every location, its definition, and references.

### `deleteTags(tagIds: number[]): Promise<void>`

Delete tags and strip them from all locations. Undoable. Emits `tag:remove`.

### `discardOpenMap(): void` *(unstable)*

Drop the open map without persisting anything

### `duplicateLocation(id: number): Promise<number | null>`

Clone a location in place and return the new id, or null if it doesn't exist. Undoable.

### `emitBitmask(bytes: number[]): void` *(unstable)*

Decode a selection bitmask and emit it to the render pipeline.

### `exitPluginMode(): void`

Close the plugin sidebar and return to the overview.

### `fetchBounds(selector: Selector): Promise<[number, number, number, number] | null>`

Bounding box `[west, south, east, north]`, or null when the selector is empty.

### `fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]>`

One column per field over the selected set. `null` where a location
lacks the field; `"tags"` returns a column of tag-id arrays.

### `fetchLocations(selector: Selector): Promise<Location[]>`

Fetch full location rows matching a selector. Missing ids are skipped.

Every row lands in memory, so an unscoped call on a large map is expensive.
Prefer a narrower selector or a projection (`fetchColumns`, `countBy`) when possible.

### `fieldValues(selector: Selector, field: string): Promise<string[]>`

Distinct values of `field`, sorted.

### `flushSave(): Promise<void>` *(unstable)*

Save any unsaved changes now instead of waiting for the autosave timer.

### `getActiveSelections(): Selection[]`

Active (non-ghosted) selections, the default for any operational logic.

### `getMapState(): Readonly<MapState>`

Imperative snapshot of the map state.

### `getSelectedTagIds(): ReadonlySet<number>`

Tag ids that currently have a top-level Tag selection active.

### `getSelectedTagIdsDeep(): readonly number[]`

Tag ids of every Tag leaf in the active selection tree, in list order.
Includes composite children, excludes ghosted selections; ids may repeat.

### `getTag(id: number): Tag | undefined`

Raw by-id tag lookup — includes soft-deleted ghosts so stale references
(e.g. a selection whose tag just died) still resolve to a name.

### `getVisibleTags(): Tag[]`

Tags that exist from the user's point of view. Raw `tags` also holds soft-deleted ghosts (count=0, visible=false) - almost nothing outside the undo machinery should enumerate those.

### `holdAutosave(): () => void` *(unstable)*

Defer autosave until the returned release function runs. Useful for batches that land many mutations.

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

Run a mutation, apply its result to the map, and schedule a save.

### `openDuplicateLocation(loc: Location): void` *(unstable)*

Open one location from the duplicate-resolution panel in the editor.

### `openMap(id: string): Promise<void>`

Open a map in this window, closing any currently open map first.

### `openStagedLocation(index: number): Promise<void>` *(unstable)*

Open a staged-import location read-only, "as if" it were active. The location becomes
virtual (negative id; ImportPreview flag) so identity and mutate-guards derive from it.

### `partition(field: string, key: KeySpec, selector: Selector): Promise<PartitionBucket[]>`

Group the selected location set by a derived key. Numeric bins arrive in bound order;
other keys are sorted naturally.

### `patchMapMeta(id: string, patch: MapMetaPatch_Deserialize): Promise<void>`

Patch any map's metadata by id and persist it. Updates the open map's state when it is that map.

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

Rename extra-field `from` to `to` across all locations, its definition, and selections.
When a location already holds `to`, `winner` decides which value survives.

### `reorderTags(orderedIds: number[]): Promise<void>`

Persist a new tag display order.

### `resetSelections(): Promise<void>`

Clear all selections.

### `resolveIds(selector: Selector): Promise<number[]>`

Ids of every location the selector resolves to.

### `resolveLocation(m: MaybeLocation): Promise<Location | null>`

Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found.

### `sampleFrom(selector: Selector, n: number): Promise<number[]>`

`n` ids drawn uniformly at random, without replacement.

### `scheduleAutoCommit(mapId: string, importedCount: number): void` *(unstable)*

Background auto-commit after an import with autoCommit set.

### `scheduleSave(): void` *(unstable)*

Schedule a debounced autosave. Mutations call this automatically.

### `selectRandomFromSelection(count: number, perSelection?: boolean | undefined): Promise<number>`

Replace the current selection with up to `count` ids picked at random.
With `perSelection`, picks up to `count` from each active selection separately.
Returns the number of ids actually picked (0 when nothing is selected).

### `selectSpacedFromSelection(opts: { count?: number | undefined; minDistanceM?: number | undefined; }, perSelection?: boolean | undefined): Promise<{ picked: number; distanceM: number; }>`

Replace the current selection with spatially spaced ids - either `count` ids maximizing
spacing, or as many as fit at `minDistanceM`. With `perSelection`, each active selection
is picked from separately. Returns the count picked and the minimum distance achieved.

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

Re-resolve all selections against the current map data and update the overlay.
Use when the underlying data changed but the selections themselves did not.

### `tagIdsToNames(ids: number[]): string[]`

Tag names for the given ids, skipping any that no longer resolve.

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

Wait for any in-progress save to finish.

## SelectionOps

### `addSelection(selector: Selector): (current: Selection[]) => Selection[]`

Append a new selection built from `selector`, deduplicating by key.

### `batch<T, S>(op: (item: T) => (state: S) => S): (items: T[]) => (state: S) => S`

Lift a single-item curried transform into one that folds over an array of items.

### `buildSelection(selector: Selector): Selection`

Create a Selection with a deterministic key and color from its selector.

### `childSelections(selector: Selector): Selection[]`

Every child selection a selector wraps, whatever shape it wraps them in.

### `colorForKey(key: string): RGB`

Deterministic color derived from a selection key string.

### `composeSelections(dragKey: string, dropKey: string, mode: GroupType, dragParent?: string | null | undefined, dropParent?: string | null | undefined): (current: Selection[]) => Selection[]`

Merge the dragged selection into the drop target as a composite, absorbing existing
children of the same type. Handles nested cases across parent groups.

### `composeSiblings(current: Selection[], parentKey: string, dragKey: string, dropKey: string, mode: GroupType): Selection[]`

Compose two siblings inside the same parent group into a nested composite.

### `composeWithChild(current: Selection[], dragKey: string, parentKey: string, childKey: string, mode: GroupType): Selection[]`

Compose a top-level selection with a child inside a parent group.

### `decomposeChild(parentKey: string, childKey: string): (current: Selection[]) => Selection[]`

Pull a child out of a composite back into the top-level list, children and all. Parent collapses
if only one child remains, and disappears if none do.

### `displayTagName(name: string): string`

Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
the `/`-path to its shortest unique suffix; otherwise returns the name verbatim.

### `filterIsLocalTime(test: FilterOp): boolean`

Whether a predicate reads the location's clock in its own timezone. Only a range can.

### `intersectSelections(keys?: string[] | null | undefined): (current: Selection[]) => Selection[]`

Merge the targeted selections (or all, when `keys` is null) into a single Intersection.

### `invertSelections(keys?: string[] | null | undefined): (current: Selection[]) => Selection[]`

Invert targeted selections. Single target toggles in-place at any depth; multiple are wrapped in Union then Invert.

### `isolateGhost(key: string): (sels: Selection[], ghosted: ReadonlySet<string>) => Partial<SelectionState>`

Solo one selection by ghosting all others. Repeat to clear all ghosts.

### `isolateGhostKeys(keys: string[], ghosted: ReadonlySet<string>, key: string): Set<string>`

Ghost keys that "solo" `key`: everything except it. Returns an empty set when `key`
is already the sole visible selection, so a repeat call un-isolates (clears all ghosts).

### `OP_LABELS: Record<"has" | "nothas" | "eq" | "neq" | "contains" | "notcontains" | "gt" | "lt" | "gte" | "lte" | "between" | "between_anyyear" | "between_anytime", string>`

### `polygonSelectionsContaining(selections: Selection[], lat: number, lng: number): string[]`

Keys of every Polygon selection whose geometry contains the point.

### `removeFromComposite(parentKey: string, childKey: string): (current: Selection[]) => Selection[]`

Remove a child from a composite, ungrouping any nested group's children into the parent.

### `removeSelection(key: string): (current: Selection[]) => Selection[]`

Remove a selection by key. Composites unwrap their children back into the list.

### `reorderSelections(fromKey: string, toKey: string, position: "before" | "after"): (current: Selection[]) => Selection[]`

Move selection `fromKey` before or after `toKey` in the list.

### `replaceSelection(current: Selection[], oldKey: string, selector: Selector): Selection[]`

Replace the selection at `oldKey` (at any depth) with one built from `selector`. If the new
key collides with an existing selection, the existing one wins and the replacement is dropped.

### `rewriteSelectionFields(from: string, to: string | null): (selections: Selection[]) => Selection[]`

Rename or remove a field across all Filter selections. When `to` is null, filters on that field are dropped.

### `sampleIds(ids: number[], n: number): number[]`

Pick `n` distinct ids uniformly at random from `ids` using `Math.random`.
`n` is floored and clamped to `[0, ids.length]` (so over-large counts return all ids).
Uses a partial Fisher–Yates shuffle, so the result contains no duplicates and `ids` is not mutated.

### `selectionDisplayName(sel: Selection, tagNames?: Record<number, string> | undefined): string`

Human-readable label for a selection. Pass `tagNames` to resolve tags by saved name
rather than the open map's tags (used by saved selection rules).

### `SELECTIONS: { Intersection: SelectionDescriptor<"Intersection">; Union: SelectionDescriptor<"Union">; Invert: SelectionDescriptor<"Invert">; ... 14 more ...; Ranked: SelectionDescriptor<...>; }`

Per-type descriptor for each selector variant: key derivation, display label, and optional color/location overrides.

### `setPolygonName(key: string, name: string): (current: Selection[]) => Selection[]`

Rename a Polygon selection's display name.

### `setSelectionColors(entries: Selection[]): (current: Selection[]) => Selection[]`

Update the colors of selections by matching keys from `entries`.

### `toggleGhost(key: string): (_sels: Selection[], ghosted: ReadonlySet<string>) => Partial<SelectionState>`

Toggle one selection's ghosted (dimmed) state.

### `toggleGhostAll(): (sels: Selection[], ghosted: ReadonlySet<string>) => Partial<SelectionState>`

Ghost all selections, or clear all ghosts if every selection is already ghosted.

### `toggleManualSelection(locationId: number): (current: Selection[]) => Selection[]`

Add or remove a location from the Manual selection, creating it if needed.

### `UNARY_TYPES: readonly ["Invert"]`

### `unionSelections(keys?: string[] | null | undefined): (current: Selection[]) => Selection[]`

Merge the targeted selections (or all, when `keys` is null) into a single Union.

### `withChildren(selector: Selector, children: Selection[]): Selector`

`selector` with its children replaced, keeping the shape it wraps them in.

## SavedSelections

### `applySavedSelection(saved: SavedSelection): number`

Adds the rule's parts to the sidebar, resolved against the open map. Returns how many
were added.

### `deleteSavedSelection(id: string): Promise<void>`

Permanently delete a saved selection rule.

### `getSavedSelectionIndex(): SavedSelectionInfo[]`

The rules that exist, as identity only. Empty until the index arrives -- the first
call starts the read and `saved-selections:changed` announces it.

### `isSaveable(selector: Selector): boolean`

Whether the selector tree contains only portable types (no map-local leaves).

### `loadAllSavedSelections(): Promise<SavedSelection[]>`

Every rule with its body.

### `loadSavedSelections(ids: string[]): Promise<SavedSelection[]>`

Load the full rule bodies for the given `ids`.

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

React hook: the saved selection index, re-rendering on changes.

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

Default values for every app setting.

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

Initial color mode for newly drawn polygon selections. Recoloring by hand overrides either mode.

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

The current app settings snapshot.

### `LANGUAGES`

Supported languages, labeled in their own script. `en-XA` is a dev-only pseudolocale.

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

Effective StreetViewPanorama display options derived from the current settings.

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

Reset all settings to defaults, preserving global copy bindings.

### `SEEN_RESOLUTIONS: { readonly low: "Low (160x90)"; readonly medium: "Medium (320x180)"; readonly high: "High (640x360)"; }`

### `setSetting<K extends keyof AppSettings>(key: K, value: { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; ... 73 more ...; pinnedCommands: PinnedEntry[]; }[K]): void` *(unstable)*

Update one setting and persist. Emits `settings:changed`.

### `SUBDIVISION_DETAILS: { readonly off: "Off"; readonly adm1: "States / provinces"; }`

### `TAG_FOLDER_COLOR_MODES: { readonly direct: "Fixed color"; readonly firstChild: "Inherit first child"; }`

### `TAG_SUGGESTION_LIMITS: readonly [5, 10, 25, 50, 0]`

### `TAG_VIEW_MODES: { readonly flat: "Flat"; readonly tree: "Tree"; }`

### `UNIT_SYSTEMS: { readonly auto: "Automatic"; readonly metric: "Metric (m / km)"; readonly imperial: "Imperial (ft / mi)"; }`

Distance units. `auto` reads the system locale's region, so a US/UK machine gets miles.

### `useSetting<K extends keyof AppSettings>(key: K): { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; ... 73 more ...; pinnedCommands: PinnedEntry[]; }[K]` *(unstable)*

React hook: one setting value, re-rendering only when that key changes.

### `useSettings(): { showCameraBadges: boolean; showLinksControl: boolean; clickToGo: boolean; showRoadLabels: boolean; defaultMovementMode: "moving" | "no-move" | "nmpz"; showCar: boolean; showCrosshair: boolean; ... 71 more ...; pinnedCommands: PinnedEntry[]; }` *(unstable)*

React hook: all settings, re-rendering on any change.

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

The preview marker positions for the staged import.

### `getImportStaging(): ImportStaging | null` *(unstable)*

The current staged import, or null if none.

### `resetImportState(): void` *(unstable)*

Clear staged import state.

## CommitDiff

Commit diff internals.

### `beginCommitDiffPreview(commit: CommitInfo): Promise<void>` *(unstable)*

Fetch a commit's delta and overlay its added/removed/modified locations on the map,
temporarily replacing the regular markers.

### `categorizeCommitDelta(delta: CommitDelta): { added: Location[]; removed: Location[]; modified: Location[]; }` *(unstable)*

Split a commit delta into added / removed / modified. An updated location appears in
both `created` (new) and `removed` (old), keyed by id.

### `diffPositions(locs: LatLngLiteral[]): Float32Array<ArrayBufferLike>` *(unstable)*

Pack `[lng, lat]` pairs into an interleaved Float32Array.

### `endCommitDiffPreview(): void` *(unstable)*

Leave commit-diff preview and restore the regular markers.

### `getCommitDiffPreview(): CommitDiffPreview | null` *(unstable)*

The current commit-diff preview, or null when not previewing.

### `hasCommitDiff(): boolean` *(unstable)*

Whether there are uncommitted changes (adds, removes, or modifications).

### `resetCommitDiffCounts(): void` *(unstable)*

Reset the uncommitted-change counts to zero.

### `resetCommitDiffState(): void` *(unstable)*

Clear commit-diff preview state.

### `useCommitDiff(): CommitDiff` *(unstable)*

React hook: the uncommitted add/remove/modify counts, kept in sync with the store.

## SelectorPick

### `createSelectorPick(initial?: SelectorPick | undefined): SelectorPickHandle`

A standalone "all locations vs current selection" switch, for features that operate on a subset.

### `selectorForPick(choice: SelectorPick): Selector`

Convert a picker choice into the corresponding `Selector`.

### `useSelectorPick(initial?: SelectorPick | undefined): SelectorPickController`

React hook: selector state with live counts. Defaults to the current selection when one
exists, else all locations. Use `createSelectorPick` when non-React code also reads the selector.

## MapList

### `createMap(name: string, folder?: string | null | undefined): Promise<MapMeta>`

Create a new empty map and return its metadata.

### `deleteFolder(name: string): Promise<void>`

Delete a folder. Maps in it become unfoldered.

### `deleteMap(id: string): Promise<void>`

Permanently delete a map and all its data. Not undoable.

### `getMapList(): MapMeta[]`

The list of all maps (metadata only).

### `invalidateMapList(): Promise<void>`

Refresh the map list and notify other windows of the change.

### `isReservedMap(id: string | null): boolean`

Whether `id` belongs to an app fixture rather than a user-created map.

### `moveMapToFolder(mapId: string, folder: string | null): Promise<void>`

Move a map into a folder, or to the root when `folder` is null.

### `openScratchMap(): Promise<void>`

Open the scratch map, creating it on first use.

### `reloadMapList(): Promise<void>`

Refresh the map list from disk.

### `renameFolder(from: string, to: string): Promise<void>`

Rename a folder, moving all its maps to the new name.

### `setCachedMapList(list: MapMeta[]): void`

Set the map list directly without a disk read.

### `useMapList(): MapMeta[]`

Reactive list of all maps (metadata only).

## Review

Review screen internals.

### `advance(s: ReviewSession): { session: ReviewSession; done: boolean; }` *(unstable)*

Mark the current cursor reviewed and step forward. `done` is true when the
session has no remaining items.

### `beginReview(ids: number[], source?: Selection | undefined): Promise<void>` *(unstable)*

Start or resume a review over `ids`. When `source` is a selection, re-reviewing
that selection resumes any in-progress session for it.

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

Remove `removed` ids from a session's worklist and reviewed set. Advances the
cursor when the cursor id itself was removed.

### `renameReview(id: string, name: string): Promise<void>` *(unstable)*

Rename a review session.

### `resumeReview(s: ReviewSession): Promise<void>` *(unstable)*

Resume a session picked from the resume modal.

### `retreat(s: ReviewSession): ReviewSession | null` *(unstable)*

Step backward without marking anything reviewed. Null when already at the start.

### `reviewDelete(): Promise<void>` *(unstable)*

Delete the current location and advance to the next one. Exits the pass if it
was the last item. Emits `location:remove`.

### `reviewedHistoryIds(sessions: ReviewSession[]): number[]` *(unstable)*

Union of reviewed ids across sessions, de-duplicated. Pure (unit-tested).

### `reviewIndex(s: ReviewSession): number` *(unstable)*

Position of the session cursor within its review order.

### `reviewNext(): Promise<void>` *(unstable)*

Mark the current location reviewed and step to the next one.

### `reviewPrev(): Promise<void>` *(unstable)*

Step back to the previous location in the session.

### `selectReviewedHistory(): Promise<void>` *(unstable)*

Select every location marked reviewed across all sessions on this map.

### `selectReviewSet(s: ReviewSession, mode: "reviewed" | "unreviewed"): Promise<void>` *(unstable)*

Add a reviewed or unreviewed overlay selection for a session.

### `useReviewSession(): ReviewSession | null` *(unstable)*

Reactive active review session, or null.

## Commands

The raw command layer under the app-level API; any of them can change in a release.

### `cmd`

Commands

#### `cmd.appReady(): Promise<number>` *(unstable)*

Milliseconds from `run()` to the frontend's first call; logged once.

#### `cmd.borderClassify(level: string, points: [number, number][]): Promise<(string | null)[]>` *(unstable)*

Classify each `(lat, lng)` to the name of its containing border feature at
`level` (subdivision names for "adm1"). `None` for points outside every feature.

#### `cmd.borderLookup(lat: number, lng: number, level: string): Promise<PolygonGeometry | null>` *(unstable)*

Return the border polygon containing (`lat`, `lng`) at the given detail
`level`, or `None` if the point falls outside every feature.

#### `cmd.bulkImportCancel(): Promise<null>` *(unstable)*

Discard the previewed import without importing. Call when the user cancels the
import dialog.

#### `cmd.bulkImportConfirm(path: string, selectedIndices: number[]): Promise<ImportedMapInfo[]>` *(unstable)*

Import the maps at `selected_indices` from a previously previewed file.
Emits `bulk-import-progress` per map.

#### `cmd.bulkImportPreview(path: string): Promise<ImportPreviewEntry[]>` *(unstable)*

Parse a file (JSON or ZIP of JSONs) and return a preview of each map found,
without persisting anything. Call [`bulk_import_confirm`] to import the maps.

#### `cmd.checkBorderFile(level: string): Promise<boolean>` *(unstable)*

Whether the border dataset for `level` is available on disk.

#### `cmd.claimPluginUpdatePass(): Promise<boolean>` *(unstable)*

First caller per app run wins the silent update pass. Every webview boots the
plugin loader, so without this a restored editor window plus the map list run
two full passes -- double registry fetches, double downloads, and interleaved
install progress for the same plugin.

#### `cmd.discordPresenceClear(): Promise<null>` *(unstable)*

Clear the Discord Rich Presence activity. No-op when Discord is not running.

#### `cmd.discordPresenceSet(activity: PresenceActivity): Promise<null>` *(unstable)*

Set the Discord Rich Presence activity. No-op when Discord is not running.

#### `cmd.downloadBorderFile(level: string): Promise<null>` *(unstable)*

Download the border dataset for `level` from the repository.

#### `cmd.feedbackAnonymousAvailable(): Promise<boolean>` *(unstable)*

Whether the anonymous tier is available in this build.

#### `cmd.feedbackAnonymousThread(number: number, token: string): Promise<IssueThread>` *(unstable)*

Fetch the current state and replies for an anonymous report.

#### `cmd.feedbackLogTail(): Promise<string>` *(unstable)*

The tail of `mma.log`, scrubbed. Empty string when there is no log yet.

#### `cmd.feedbackRequestLabel(number: number): Promise<null>` *(unstable)*

Request that standard labels be applied to a report the user filed. Best-effort:
a failure here does not affect the report itself.

#### `cmd.feedbackSubmitAnonymous(title: string, body: string, installId: string): Promise<AnonIssueRef>` *(unstable)*

File a bug report anonymously (no account required). Returns a reference the
caller can use to check for replies via [`feedback_anonymous_thread`].

#### `cmd.feedbackUploadAttachment(path: string, name: string): Promise<AttachmentRef>` *(unstable)*

Upload an image attachment for a bug report and return its URL.

#### `cmd.fieldExprError(src: string): Promise<string | null>` *(unstable)*

The parse error for `src`, or nothing when it parses. For the dialog's live check.

#### `cmd.geoguessrHasSession(): Promise<boolean>` *(unstable)*

Local-only check: is a token stored? Says nothing about its validity.

#### `cmd.geoguessrLogin(): Promise<string>` *(unstable)*

Open the GeoGuessr sign-in window and wait for authentication to complete.
Returns the signed-in nickname.

#### `cmd.geoguessrLogout(): Promise<null>` *(unstable)*

Sign out of GeoGuessr and clear the stored session.

#### `cmd.geoguessrMe(): Promise<GgUser | null>` *(unstable)*

The signed-in user, or `None` when there is no session (or it was rejected).

#### `cmd.getAppDataDir(): Promise<string>` *(unstable)*

Return the app's data directory path.

#### `cmd.getDataLocation(): Promise<DataLocation>` *(unstable)*

Return the current and default data-folder paths, and whether a custom override is active.

#### `cmd.githubCreateIssue(title: string, body: string, labels: string[]): Promise<IssueRef>` *(unstable)*

File a bug report as the signed-in GitHub user.

#### `cmd.githubHasSession(): Promise<boolean>` *(unstable)*

Local-only check: is a token stored? Says nothing about its validity.

#### `cmd.githubIssueThread(number: number): Promise<IssueThread>` *(unstable)*

Fetch a report's current state and comments as the signed-in GitHub user.

#### `cmd.githubLogout(): Promise<null>` *(unstable)*

Sign out of GitHub and clear the stored session.

#### `cmd.githubMe(): Promise<GhUser | null>` *(unstable)*

The signed-in user, or `None` when there is no session (or it was rejected).

#### `cmd.githubPollLogin(): Promise<GhUser>` *(unstable)*

Wait for the user to authorize the code from [`github_start_login`].
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

Open the app's data folder in the OS file explorer.

#### `cmd.openLogFile(): Promise<null>` *(unstable)*

Open the app's log file in the OS default handler.

#### `cmd.parseMapsUrl(input: string): Promise<ParsedLocation | null>` *(unstable)*

The location a pasted Maps URL names, short links resolved.

#### `cmd.procedureCancel(runId: number): Promise<null>` *(unstable)*

Stop a run before its next batch. Already-applied patches stay applied.

#### `cmd.procedureQuery(entry: string, input: string, config: string | null, cancel: number | null): Promise<string>` *(unstable)*

Run a procedure's read-only `query` export. `input` and the result are defined
by the procedure module. `cancel` is a token for [`procedure_query_cancel`].

#### `cmd.procedureQueryCancel(cancel: number): Promise<null>` *(unstable)*

Cancel a running procedure query by its `cancel` token.

#### `cmd.procedureRun(providers: ProviderDecl[], force: boolean): Promise<number>` *(unstable)*

Start a procedure run over the open map's locations. Returns immediately with
the run id. Emits `procedure-progress` and `procedure-result` as work completes.

#### `cmd.procedureRunRows(providers: ProviderDecl[], force: boolean, rows: Location[], cancel: number | null): Promise<RowsRun>` *(unstable)*

Run providers over caller-supplied `rows` and return them as modified. Does not
affect the open map. `cancel` is a token for [`procedure_query_cancel`].

#### `cmd.readFile(path: string): Promise<string>` *(unstable)*

Read a file as UTF-8 text (temp files, plugin sources).

#### `cmd.remoteApiRespond(id: number, ok: boolean, payload: string): Promise<void>` *(unstable)*

Deliver the result for remote API request `id`. `payload` is JSON text.

#### `cmd.remoteApiStart(key: string): Promise<string>` *(unstable)*

Start (or re-key) the remote API server. Idempotent: a running server just
picks up the new key. Returns the base URL.

#### `cmd.remoteApiStop(): Promise<null>` *(unstable)*

Stop the remote API server.

#### `cmd.remoteMappingClear(provider: string, mapId: string): Promise<null>` *(unstable)*

Drop all mapping rows for a linked map (unlink).

#### `cmd.remoteMappingDelete(provider: string, mapId: string, localIds: number[]): Promise<null>` *(unstable)*

Remove specific mapping rows by `local_ids` for a linked map.

#### `cmd.remoteMappingGet(provider: string, mapId: string): Promise<RemoteMappingRow[]>` *(unstable)*

Get all local-to-remote id mapping rows for a linked map.

#### `cmd.remoteMappingUpsert(provider: string, mapId: string, rows: RemoteMappingRow[]): Promise<null>` *(unstable)*

Insert or update local-to-remote id mapping rows for a linked map.

#### `cmd.revealWindow(maximized: boolean): Promise<void>` *(unstable)*

Reveal with the native open animation: a true first show() (DWM plays its pop-in),
then maximize back-to-back while the shell is still blank. The show must come first:
maximize on a hidden window reveals it without setting tao's visible flag, and the
window gets re-hidden a frame later.

#### `cmd.reverseGeocode(lat: number, lng: number): Promise<GeoResult | null>` *(unstable)*

Return the nearest city, administrative region, and country for a coordinate.
Always returns `Some` - the dataset covers every landmass.

#### `cmd.setDataLocation(path: string | null): Promise<null>` *(unstable)*

Set or clear the data-folder override. Takes effect after relaunch and does not
move existing data.

#### `cmd.sidecarCancel(reqId: number): Promise<null>` *(unstable)*

Cancel a running sidecar request. No-op if the request already finished.

#### `cmd.sidecarInstall(pluginId: string, name: string, version: string): Promise<null>` *(unstable)*

Download a plugin's sidecar bundle from GitHub Releases and extract it under
`{appData}/plugins/{plugin_id}/sidecar/`. Emits `sidecar-install-progress`.

#### `cmd.sidecarInstalledVersion(pluginId: string): Promise<string | null>` *(unstable)*

Installed sidecar version for a plugin, or `None` if not installed.

#### `cmd.sidecarRequest(pluginId: string, command: string, payload: string | null): Promise<number>` *(unstable)*

Run one unit of work on a plugin's sidecar. Commands the manifest lists under
`serve` go to the plugin's resident process; the rest get a one-shot child.
Streams `sidecar-line` (one JSON object per unit) and `sidecar-log` (stderr),
then exactly one `sidecar-done`, all keyed by the returned request id.

#### `cmd.sidecarStop(pluginId: string): Promise<null>` *(unstable)*

Stop all sidecar processes for a plugin.

#### `cmd.sidecarStopAll(): Promise<null>` *(unstable)*

Stop all sidecar processes across every plugin.

#### `cmd.storeAddLocations(locations: Location[]): Promise<MutationResult>` *(unstable)*

Add new locations, allocating sequential IDs. Undoable.

#### `cmd.storeAddLocationsToMap(targetMapId: string, locations: Location[]): Promise<CopyToMapResult>` *(unstable)*

Add caller-supplied locations to another map. Tags are matched by name against this
map's tag table.

#### `cmd.storeAddLocationsUploaded(sessionDir: string): Promise<MutationResult>` *(unstable)*

Add locations from a chunked upload session (see `store_upload_begin`).
Same behavior as `store_add_locations`: one atomic mutation, undoable.

#### `cmd.storeApplyFieldOp(selector: Selector, op: FieldOp, recordUndo: boolean | null): Promise<FieldOpResult>` *(unstable)*

Apply a field operation to every location matched by `selector`.

#### `cmd.storeBounds(selector: Selector): Promise<[number, number, number, number] | null>` *(unstable)*

Bounding box `[west, south, east, north]`, or `None` when the set is empty.

#### `cmd.storeCheckoutCommit(mapId: string, commitId: string): Promise<null>` *(unstable)*

Restore a map to the state captured by a previous commit. The caller must reopen
the map afterwards (undo/redo is cleared).

#### `cmd.storeCloseMap(): Promise<null>` *(unstable)*

Close the open map, saving unsaved changes first.

#### `cmd.storeCollect(selector: Selector): Promise<Rows>` *(unstable)*

Collect all matched locations as full rows. Prefer a projection (`store_columns`,
`store_values`) when only specific fields are needed.

#### `cmd.storeColumns(selector: Selector, fields: string[]): Promise<Columns>` *(unstable)*

Read specific fields across matched locations, returned as one column per field.

#### `cmd.storeCommit(mapId: string, message: string | null): Promise<CommitResult>` *(unstable)*

Commit the map's uncommitted changes. Returns the new commit ID. `message`
defaults to a generated `+a -r ~m` summary. Clears undo/redo.

#### `cmd.storeCommitDiff(): Promise<[number, number, number]>` *(unstable)*

Return the uncommitted change counts (added, removed, modified) since the last commit.

#### `cmd.storeCopyLocationsToMap(targetMapId: string, selector: Selector): Promise<CopyToMapResult>` *(unstable)*

Copy locations already stored in this map into another map.

#### `cmd.storeCount(selector: Selector): Promise<number>` *(unstable)*

Count how many locations the selector matches.

#### `cmd.storeCountBy(selector: Selector, field: string, key: KeySpec): Promise<[string, number][]>` *(unstable)*

Group locations by a derived key, returning counts only (no member ids).

#### `cmd.storeCountryDistribution(selector: Selector, level: string): Promise<[string, number][]>` *(unstable)*

Count locations by country using offline point-in-polygon. Returns (ISO-A2, count) pairs.
`level` selects border precision, falling back to "light" if unavailable.

#### `cmd.storeCoverage(selector: Selector): Promise<[string, number][]>` *(unstable)*

How many rows hold a value for each field, key-sorted: `extra` keys and the built-in
columns a row can lack.

#### `cmd.storeCreateMap(name: string, folder: string | null): Promise<MapMeta>` *(unstable)*

Create a new empty map with default settings. Returns the full metadata.

#### `cmd.storeCreateTags(names: string[], selector: Selector): Promise<MutationResult>` *(unstable)*

Create tags by name and assign them to the locations matched by `selector`.
Deduplicates case-insensitively: if a tag with the same name already exists, it is reused.

#### `cmd.storeDbStats(): Promise<DbStats>` *(unstable)*

Return aggregate database statistics: counts, file size, and configuration.

#### `cmd.storeDeleteFolder(name: string): Promise<null>` *(unstable)*

Delete a folder, moving its maps to the root level.

#### `cmd.storeDeleteMap(id: string): Promise<null>` *(unstable)*

Delete a map and all its data permanently.

#### `cmd.storeDeleteSavedSelection(id: string): Promise<null>` *(unstable)*

Delete a saved selection rule by `id`.

#### `cmd.storeDeleteTags(tagIds: number[]): Promise<MutationResult>` *(unstable)*

Remove tags and strip them from all locations that carry them. Undoable.

#### `cmd.storeDuplicateGroups(distance: number): Promise<number[][]>` *(unstable)*

Find groups of locations within `distance` metres of each other (transitive).
Returns groups of IDs, each with at least two members.

#### `cmd.storeExportBulkZip(): Promise<string>` *(unstable)*

Export every map as a ZIP of JSON files. Duplicate map names get a numeric suffix.
Emits `bulk-export-progress` per map.

#### `cmd.storeExportCsv(selector: Selector): Promise<string>` *(unstable)*

Export locations as a minimal lat/lng CSV file.

#### `cmd.storeExportGeojson(selector: Selector, tagsJson: string): Promise<string>` *(unstable)*

Export locations as a GeoJSON FeatureCollection of Point features.
Each feature carries its tag names in `properties.tags`.

#### `cmd.storeExportJson(opts: ExportOpts): Promise<string>` *(unstable)*

Export locations as a `{name, customCoordinates}` JSON file, including tags and field defs.

#### `cmd.storeFillRenderFile(req: RenderRequest): Promise<string>` *(unstable)*

Rebuild all marker render data from scratch and return the file path to fetch it from.

#### `cmd.storeFindNearby(lat: number, lng: number, radiusM: number): Promise<Location[]>` *(unstable)*

Find all locations within `radius_m` metres of (`lat`, `lng`).

#### `cmd.storeGetCommitDelta(mapId: string, commitId: string): Promise<CommitDelta>` *(unstable)*

Read a single commit's delta (created and removed locations).

#### `cmd.storeGetMap(id: string): Promise<MapMeta | null>` *(unstable)*

Fetch a single map's metadata by ID. Returns `None` if not found.

#### `cmd.storeGetSavedSelections(ids: string[]): Promise<SavedSelection[]>` *(unstable)*

Fetch the full saved selection rules for the given `ids`, including their selector trees.

#### `cmd.storeGetSummary(): Promise<SummaryResult>` *(unstable)*

Return the map's current location count, store version, and unsaved-change count.

#### `cmd.storeGroupBy(selector: Selector, field: string, key: KeySpec): Promise<PartitionBucket[]>` *(unstable)*

Group by a derived key, returning `{ key, ids, bin }` per group.

#### `cmd.storeImportFile(droppedFields: string[], tagName: string | null): Promise<EditorImportResult>` *(unstable)*

Commit a previously previewed editor import into the open map, optionally
dropping fields in `dropped_fields` (e.g. `"heading"`, `"extra.countryCode"`)
and/or applying `tag_name` to every imported location.

#### `cmd.storeImportLegacySavedSelections(json: string): Promise<number>` *(unstable)*

Import saved selections from the pre-0.10 localStorage format. No-op when
rules already exist. Returns the number of rules imported.

#### `cmd.storeImportPastePreview(text: string): Promise<EditorImportPreview>` *(unstable)*

Parse pasted text (JSON or CSV) and stage it for preview. Works like
[`store_import_preview`] but reads from a string instead of a file.

#### `cmd.storeImportPreview(path: string): Promise<EditorImportPreview>` *(unstable)*

Parse a file and return field-level statistics and preview positions for the
editor import dialog. Call [`store_import_file`] to commit the import.

#### `cmd.storeImportStagedLocation(index: number): Promise<Location>` *(unstable)*

Return one staged (not yet imported) location by its preview `index`, for
read-only preview in the editor.

#### `cmd.storeListCommits(mapId: string): Promise<CommitInfo[]>` *(unstable)*

List all commits for a map, newest first.

#### `cmd.storeListMaps(): Promise<MapMeta[]>` *(unstable)*

Return metadata for every map in the database.

#### `cmd.storeListSavedSelections(): Promise<SavedSelectionInfo[]>` *(unstable)*

List every saved selection rule (name, color, date), without their selector trees.

#### `cmd.storeMergeDuplicates(distance: number, score: string | null): Promise<MutationResult>` *(unstable)*

Merge each duplicate group within `distance` metres into one location, unioning tags
and extra fields. `score` ranks which location survives; blank uses the default ranking.
Undoable.

#### `cmd.storeNearAny(lats: number[], lngs: number[], radiusM: number): Promise<boolean[]>` *(unstable)*

For each input point, whether any existing location lies within `radius_m` metres.
Batch form for probing many coordinates at once.

#### `cmd.storeOpenMap(mapId: string): Promise<StoreStatus>` *(unstable)*

Open a map and return its initial state (tag counts, undo/redo availability).
Must be called before any other store commands.

#### `cmd.storePruneDuplicates(selector: Selector, distance: number, score: string | null): Promise<MutationResult>` *(unstable)*

Remove duplicate locations within `distance` metres of each other, keeping the
best-scored survivor per cluster. Undoable.

#### `cmd.storeRedo(): Promise<MutationResult>` *(unstable)*

Redo the last undone edit.

#### `cmd.storeRemoveLocations(ids: number[]): Promise<MutationResult>` *(unstable)*

Remove locations by ID. Undoable.

#### `cmd.storeRenameFolder(from: string, to: string): Promise<null>` *(unstable)*

Rename a folder across all maps that reference it.

#### `cmd.storeReorderTags(orderedIds: number[]): Promise<MutationResult>` *(unstable)*

Set the display order of tags. Each tag's position is its index in `ordered_ids`.

#### `cmd.storeResolve(selector: Selector): Promise<number[]>` *(unstable)*

Ids of every location the selector resolves to, ascending.

#### `cmd.storeResolvePick(cell: string, cellIndex: number): Promise<number | null>` *(unstable)*

Resolve a marker pick (cell key + index within cell) to a location ID.

#### `cmd.storeReviewCreate(session: ReviewCreate): Promise<ReviewSession>` *(unstable)*

Create a new review session from a frozen worklist of location IDs.

#### `cmd.storeReviewDelete(id: string): Promise<null>` *(unstable)*

Delete a review session.

#### `cmd.storeReviewGet(mapId: string, sourceKey: string): Promise<ReviewSession | null>` *(unstable)*

Look up the most recent active review session for a map and source key.

#### `cmd.storeReviewList(mapId: string, status: string | null): Promise<ReviewSession[]>` *(unstable)*

List review sessions for a map, newest first. Optionally filter by `status`.

#### `cmd.storeReviewUpdate(update: ReviewUpdate): Promise<null>` *(unstable)*

Apply a partial update to a review session.

#### `cmd.storeSample(selector: Selector, n: number): Promise<number[]>` *(unstable)*

`n` ids drawn uniformly at random from the selected set, without replacement.

#### `cmd.storeSaveDirty(): Promise<SaveResult>` *(unstable)*

Save uncommitted changes to disk. No-op when nothing has changed.

#### `cmd.storeSaveExportFile(srcPath: string, destPath: string): Promise<null>` *(unstable)*

Move a temp export file to `dest_path` and remove the temp source.

#### `cmd.storeSaveSelection(name: string, selector: Selector, tagNames: { [x: number]: string; }, color: [number, number, number]): Promise<SavedSelection>` *(unstable)*

Save a new selection rule.

#### `cmd.storeScratchMap(): Promise<MapMeta>` *(unstable)*

Open the scratch map, creating it if this is its first use. Ordinary in every way
except that [`store_list_maps`] hides it and startup wipes it.

#### `cmd.storeSeenClear(): Promise<null>` *(unstable)*

Deletes all seen history entries.

#### `cmd.storeSeenCount(filter: SeenFilter | null): Promise<number>` *(unstable)*

Returns the total number of seen entries matching the filter (for pagination).

#### `cmd.storeSeenCountries(): Promise<string[]>` *(unstable)*

Return all distinct country codes in the seen history, sorted alphabetically.

#### `cmd.storeSeenList(limit: number, offset: number, filter: SeenFilter | null, thumbnails: boolean): Promise<SeenEntry[]>` *(unstable)*

Returns a page of seen entries, newest first, with optional filtering.

#### `cmd.storeSeenMaps(): Promise<SeenMapInfo[]>` *(unstable)*

Returns all distinct maps that have seen entries, with resolved display names.

#### `cmd.storeSeenWrite(entry: SeenWriteEntry): Promise<null>` *(unstable)*

Record a panorama visit. The history is capped; oldest entries are evicted when full.

#### `cmd.storeSetActive(id: number | null): Promise<null>` *(unstable)*

Set (or clear) the active location.

#### `cmd.storeSetMarkerColor(color: [number, number, number]): Promise<null>` *(unstable)*

Set the default marker color for new render updates.

#### `cmd.storeSpaced(selector: Selector, targetCount: number | null, minDistanceM: number | null): Promise<SpacedPickResult>` *(unstable)*

An evenly spaced subset: exactly one of `target_count` (thin to N, maximizing
spacing) or `min_distance_m` (keep as many as fit at that spacing).

#### `cmd.storeSyncSelections(sels: SelectionInput[]): Promise<SelectionSync>` *(unstable)*

Replace all active selections and resolve them against current data. Returns
per-selection counts and a bitmask for the marker overlay.

#### `cmd.storeTouchMapOpened(mapId: string): Promise<null>` *(unstable)*

Update `last_opened_at` to the current timestamp. Used to sort the map
list by recency in the dashboard.

#### `cmd.storeUndo(): Promise<MutationResult>` *(unstable)*

Undo the last edit.

#### `cmd.storeUpdateLocations(updates: Update<LocationPatch_Deserialize>[], recordUndo: boolean | null): Promise<MutationResult>` *(unstable)*

Apply partial patches to existing locations. `record_undo` defaults to true;
set to false for ephemeral updates (e.g., plugin-driven batch modifications
that manage their own undo).

#### `cmd.storeUpdateMapMeta(id: string, patch: MapMetaPatch_Deserialize): Promise<MutationResult | null>` *(unstable)*

Apply a partial update to a map's metadata. `None` fields are left unchanged.
Returns a mutation result when the open map's field definitions changed.

#### `cmd.storeUpdateTags(updates: Update<TagPatch>[]): Promise<MutationResult>` *(unstable)*

Rename and/or recolor tags in one batch. Renaming onto an existing name (case-insensitive)
merges the two tags.

#### `cmd.storeUploadAbort(sessionDir: string): Promise<null>` *(unstable)*

Remove an abandoned upload session dir (e.g. cancelled operation).

#### `cmd.storeUploadBegin(): Promise<string>` *(unstable)*

Create a temp session directory for binary uploads. Files written into it are
packaged by [`store_upload_finish`].

#### `cmd.storeUploadFinish(sessionDir: string): Promise<string>` *(unstable)*

Package an upload session's files into a single output and remove the session
directory. Returns a temp path for [`store_save_export_file`].

#### `cmd.storeValues(selector: Selector, field: string): Promise<string[]>` *(unstable)*

Distinct values of `field` across the selected set, sorted.

#### `cmd.syncReconcile(provider: string, mapId: string, remoteMapId: string, apiKey: string | null, firstSync: FirstSyncMode | null, resolutions: [string, ResolutionSide][] | null): Promise<...>` *(unstable)*

Reconcile a linked map against its remote, pushing local changes and pulling
remote ones. Returns the creates, updates, and deletes for each side to apply.

#### `cmd.timezoneAt(lat: number, lng: number): Promise<string | null>` *(unstable)*

IANA timezone at a coordinate, or `None` outside the valid range.

#### `cmd.uninstallPlugin(id: string): Promise<null>` *(unstable)*

Delete a plugin's directory.

#### `cmd.updateCheck(endpoint: string): Promise<UpdateAvailable | null>` *(unstable)*

Check for an update at `endpoint` (a release's `latest.json`). Returns `None`
when the announced version is not newer than the running one.

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

Generate locations from a Vali map definition (JSON text). Missing country
data is auto-downloaded like the Vali CLI. Returns the generated locations.

#### `cmd.valiSubdivisions(country: string): Promise<string>` *(unstable)*

Subdivision weights for a country (JSON text, same shape as `vali subdivisions`).

#### `cmd.writeTempFile(name: string, content: string): Promise<string>` *(unstable)*

Write text to a temp file and return its path. `name` is a leaf filename
(cannot contain path separators).

## Tauri

### `dialog: { open: <T extends OpenDialogOptions>(options?: T | undefined) => Promise<OpenDialogReturn<T>>; save: (options?: SaveDialogOptions | undefined) => Promise<...>; }`

### `invoke<T>(cmd: string, args?: InvokeArgs | undefined, options?: InvokeOptions | undefined): Promise<T>`

Sends a message to the backend.

### `shell: { Command: typeof Command; }`

Tauri primitives, handed to plugins as-is.

## Registry

### `activatePlugin(id: string): void` *(unstable)*

Activate a single plugin by id.

### `activatePlugins(): void` *(unstable)*

Activate all enabled plugins. Called when a map opens.

### `autoUpdatePlugin(m: PluginManifest, latest: PluginManifest | undefined, appVersion: string): Promise<PluginManifest>` *(unstable)*

Auto-update a plugin to the newest compatible build before loading it. Falls back
to what is on disk on failure.

### `createPluginStorage(id: string): PluginStorage`

Persistent key-value storage namespaced to a plugin. Survives restarts.

### `deactivatePlugin(id: string): void` *(unstable)*

Deactivate a single plugin and stop its sidecar.

### `deactivatePlugins(): void` *(unstable)*

Deactivate all plugins and stop their sidecars. Called when a map closes.

### `fetchPluginRegistry(): Promise<PluginManifest[]>` *(unstable)*

Fetch the marketplace plugin registry (cached for the session).

### `getEnabledPlugins(): Plugin[]`

All registered plugins the user has enabled.

### `getPlugin(id: string): Plugin | undefined`

Look up a registered plugin by id.

### `getPlugins(): Plugin[]`

All registered plugins, sorted by name.

### `getPluginSetting<T = unknown>(plugin: Plugin, key: string): T`

Read a plugin's declared setting value, falling back to the setting's default.

### `isBackgroundPlugin(id: string): boolean`

True when the plugin contributes data only and has no UI surfaces.

### `isPluginCompatible(minAppVersion: string | null | undefined, appVersion: string): boolean` *(unstable)*

True when `appVersion` meets the plugin's minimum version requirement.

### `isPluginEnabled(id: string): boolean`

True when the plugin is enabled by the user.

### `isPluginUpdatable(installedVersion: string | undefined, latestVersion: string | undefined): boolean` *(unstable)*

True when a newer version is published and the installed version is known.

### `isReady(): boolean`

True once the MMA surface is installed and plugins are safe to call it.

### `markReady(): void` *(unstable)*

Mark the plugin surface as ready.

### `needsBuildUpdate(installedVersion: string | undefined, target: ResolvedBuild, installedSidecarVersion: string | null | undefined, latestSidecarVersion: string | undefined): boolean` *(unstable)*

True when the installed plugin should be refreshed to `target`.

### `needsUpdate(installedVersion: string | undefined, latestVersion: string | undefined, installedSidecarVersion: string | null | undefined, latestSidecarVersion: string | undefined): boolean` *(unstable)*

True when either the plugin or its sidecar has a newer published version.

### `registerPlugin(plugin: Plugin | PluginBehavior): void`

Register a plugin. `activate` runs when a map opens; its returned cleanup runs on map close.

### `resolveBuild(entry: PluginManifest, appVersion: string): ResolvedBuild | null` *(unstable)*

The newest build of a plugin this app version can run. Falls back through older
pinned builds when the latest is incompatible. Null when none fit.

### `setPendingManifest(manifest: PluginManifest | null): void` *(unstable)*

Set the manifest used to fill identity fields on the next `registerPlugin` call.

### `setPluginEnabled(id: string, enabled: boolean): void`

Enable or disable a plugin.

### `setPluginSetting(id: string, key: string, value: unknown): void`

Write a plugin's declared setting value.

### `storage(id: string): PluginStorage`

Persistent key-value storage namespaced to a plugin. Survives restarts.

### `unregisterPlugin(id: string): void` *(unstable)*

Remove a plugin from the registry.

### `usePluginState<T>(pluginId: string, key: string, initial: T | (() => T)): readonly [T, (action: SetStateAction<T>) => void]`

React state hook backed by the plugin's persistent store. Survives sidebar
unmount and app restart. Values are global, not per-map.

## Scope

### `disposePlugin(id: string): void` *(unstable)*

Run all teardowns a plugin registered (in reverse order) and clear them.

### `on<E extends EditorEvent>(event: E, handler: EventHandler<E>): () => void`

Subscribe to an editor event, automatically unsubscribed on plugin deactivation.

### `resolvePluginPath(path: string): string` *(unstable)*

Resolve a relative path against the current plugin's base directory. Absolute
paths and `res://` URLs pass through unchanged.

### `runAsPlugin<T>(id: string, fn: () => T): T` *(unstable)*

Run `fn` as plugin `id`. Registrations made during `fn` are tracked for teardown.

### `setPluginBaseDir(id: string, dir: string): void` *(unstable)*

Set the base directory for a plugin's assets on disk.

### `trackDisposable(dispose: Disposable): void` *(unstable)*

Enroll a teardown callback under the current plugin. No-op outside activation.

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

Send a command to a plugin's sidecar and resolve with its last emitted JSON
object (null if it emitted none). `payload` is sent as JSON.

### `sidecar: { request: <T>(pluginId: string, command: string, payload?: unknown, opts?: SidecarOptions<T> | undefined) => Promise<T | null>; installedVersion: (pluginId: string) => Promise<...>; }`

The nested `sidecar` namespace on the plugin surface.

## Ui

### `ui`

#### `ui.Button({ variant, small, type, className, ...props }: ClassAttributes<HTMLButtonElement> & ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant | undefined; small?: boolean | undefined; }): Element`

#### `ui.Checkbox({ className, ...props }: DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>): Element`

#### `ui.ColorPicker({ color, onChange, ariaLabel, }: { color: RGB; onChange: (color: RGB) => void; ariaLabel?: string | undefined; }): Element`

A color swatch that opens the picker in a popover on click.

#### `ui.DatePicker({ mode, value, onChange, anyYear, onAnyYearToggle, showAnyYear, showTime, anyTime, onAnyTimeToggle, showAnyTime, tzLocal, onTzLocalToggle, showTzLocal, onYearSelect, wallClock, }: DatePickerProps): Element`

#### `ui.Dialog({ open, onOpenChange, children, ...props }: Omit<Props<unknown>, "onOpenChange"> & { onOpenChange?: ((open: boolean) => void) | undefined; }): Element`

#### `ui.DialogContent({ className, title, initialFocus, children, ...props }: DialogPopupProps & RefAttributes<HTMLDivElement> & { title: string; }): Element`

#### `ui.DialogTrigger<Payload>(componentProps: DialogTriggerProps<Payload> & RefAttributes<HTMLElement>): Element`

A button that opens the dialog.
Renders a `<button>` element.

Documentation: [Base UI Dialog](https://base-ui.com/react/components/dialog)

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

Every field transitively derived from the `changed` keys via the provider graph.

### `getAllEnrichKeys(): string[]`

All enrichment field keys (core and plugin-registered).

### `getDefaultEnrichKeys(): string[]`

Keys enriched when enrichFields is null (the default set: all options except defaultOff ones).

### `getEnrichFieldOptions(): EnrichFieldOption[]`

All enrichment field options (core and plugin-registered).

### `getProviderForField(field: string): Provider | undefined`

The provider that produces a given extra field, if any.

### `getProviders(): Provider[]`

All registered providers.

### `isFieldEnabled(enrichFields: string[] | null, key: string): boolean`

True when `key` is in the given enrichment set (or in the default set when null).

### `knownFieldDefs(...keys: string[]): Record<string, ExtraFieldDef>`

Build field definitions for well-known keys (e.g. `"altitude"`, `"countryCode"`).

### `registerEnrichFields(fields: EnrichFieldOption[]): void`

Offer extra fields in the enrichment UI. Unregistered when the plugin deactivates.

### `registerProvider(provider: Provider): void`

Register a provider (e.g. a plugin's sun position). Unregistered when the plugin
deactivates.

### `withoutDerivedFrom(extra: Record<string, unknown> | null, changed: Iterable<string>): Record<string, unknown> | null`

Remove fields transitively derived from `changed` from an `extra` record.

## FieldDefRegistry

### `fieldLabel(key: string): string`

Display label for a field key, falling back to a sentence-cased version of the key.

### `fieldValueLabel(def: ExtraFieldDef | undefined, value: unknown): string`

Display label for a field value. Enum values use their translated display name.

### `getAllFieldDefs(): Record<string, ExtraFieldDef>`

Merged view of all field definitions across all layers.

### `getBuiltinKeys(): string[]`

All built-in field keys (excluding virtual).

### `getFieldDef(key: string): ExtraFieldDef | undefined`

Look up metadata for a field key. Returns `undefined` if no layer declares it.

### `getKnownFieldKeys(): ReadonlySet<string>`

Keys some location on this map carries. Same reference until the user layer moves.

### `isBuiltinField(key: string): boolean`

True when `key` is a built-in Location field (stored top-level, not under `extra`).

### `isClearableField(key: string): boolean`

True when the field can be bulk-cleared.

### `isListableField(key: string): boolean`

True when the field should appear in field pickers.

### `isWritableField(key: string): boolean`

### `partitionKeyOptions(type: ExtraFieldType, rangeForDates: boolean): { id: string; label: string; }[]`

Partition-key dropdown options for a field type.

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

Ask a procedure a read-only question. Rejects when the procedure exports no `query`,
when the call fails, or when `signal` aborts.

### `resolveFieldLabels(field: string, keys: string[]): Promise<string[]>`

Display labels for a field's partition keys. Falls back to the keys themselves when
the field's procedure has no `label` query or returns a non-matching array.

### `runProcedure<T>(spec: ProcedureSpec<T>, selector: Selector, opts: Omit<RunOpts, "force"> & Omit<DeclOpts, "fields" | "requires"> & { ...; }): Promise<...>` *(unstable)*

Run a single procedure over `selector` and return its typed results.

### `runProviders(items: ProviderRun[], rows: Selector, opts?: RunOpts | undefined): Promise<ProviderOutcomes>`

Run a set of providers over `rows`. When `rows` is a Selector, matching locations
are processed in place and results are written back. When `rows` is a Location array,
locations are processed independently and returned as modified copies. Resolves once
every provider finishes, or on abort.

## Seen

### `clearSeen(): Promise<void>`

Delete the entire seen history. Not undoable.

### `getSeenCount(filter?: SeenFilter | undefined): Promise<number>`

Number of seen entries matching the filter (all when omitted).

### `getSeenCountries(): Promise<string[]>`

Distinct country codes that appear in the seen history.

### `getSeenEntries(limit?: number | undefined, offset?: number | undefined, filter?: SeenFilter | undefined, thumbnails?: boolean | undefined): Promise<SeenEntry[]>`

Fetch a page of the seen (visited-panorama) history.

### `getSeenMaps(): Promise<SeenMapInfo[]>`

Maps that have seen-history entries.

### `seenFlush(getPov: () => LocationPOV): void`

Write the pending seen entry to disk, if any.

### `seenPanoChanged(location: PendingEntryLocation, geo: GeoDisplay | null, getPov: () => LocationPOV): void`

Record a panorama change for the seen history. Flushes the previous entry and stages the new one.

### `seenSkipNext(panoId: string): void`

Suppress the next seen-history entry for `panoId`.

### `seenUpdateGeo(geo: GeoDisplay): void`

Update the pending seen entry's geocode info (country, address).

## PanoSingleton

The shared panorama viewer's internals.

### `applyResolved(sv: StreetViewPanorama, resolved: Pano | null, loc: Location): void` *(unstable)*

Point the viewer at a resolved panorama for `loc`, setting its position, POV, and zoom.

### `capturePano(): PanoCapture | null` *(unstable)*

Read the live viewer back into Location fields, the inverse of {@link applyResolved}.
Null until the viewer has a position.

### `capturePov(): LocationPOV` *(unstable)*

The live viewer's camera in the stored zoom domain. Zeroed if there is no viewer.

### `clearSingletonPano(): void` *(unstable)*

Hide and release the singleton panorama, emptying its container.

### `getPanorama(): StreetViewPanorama | null` *(unstable)*

Return the singleton Street View panorama, creating it on first call.

### `loadSeenPano(entry: SeenEntry): Promise<void>` *(unstable)*

Open a seen entry's panorama in the Street View viewer.

### `singletonDiv: HTMLDivElement`

The **`HTMLDivElement`** interface provides special properties (beyond the regular HTMLElement interface it also has available to it by inheritance) for manipulating <div> elements.

[MDN Reference](https://developer.mozilla.org/docs/Web/API/HTMLDivElement)

### `singletonPano: StreetViewPanorama | null`

## Enrich

### `enrich(loc: Location, opts?: Omit<RunOpts, "onProgress"> | undefined): Promise<Location>`

Enrich a single location with the map's enabled metadata fields. Existing fields are
kept unless `force` re-derives all of them. Returns the enriched location without
writing it. Returns the location unchanged when enrichment is disabled.

### `enrichAll(selector: Selector, opts?: RunOpts | undefined): Promise<EnrichOutcome[]>`

Bulk-enrich a selector: resolve missing pano ids, then run every field-producing
provider (metadata, exact date, timezone, subdivision).

### `enrichRuns(enrichFields: string[] | null, exclude?: string[] | undefined): ProviderRun[]`

Build the provider run list for enrichment, narrowed to `enrichFields`. Fields not
offered in the enrichment settings are always included.

### `exactDateProvider`

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

#### `exactDateProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Extra-field keys this provider produces.

#### `exactDateProvider.id: string`

#### `exactDateProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `exactDateProvider.procedure: ProcedureSpec<unknown>`

The procedure that computes this provider's fields.

#### `exactDateProvider.provides: string[] | undefined`

Core columns this provider writes (e.g. `panoId`).

#### `exactDateProvider.requires: string[] | undefined`

Fields this provider reads; it runs after their producers finish.

### `panoResolveProvider`

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

#### `panoResolveProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Extra-field keys this provider produces.

#### `panoResolveProvider.id: string`

#### `panoResolveProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `panoResolveProvider.procedure: ProcedureSpec<unknown>`

The procedure that computes this provider's fields.

#### `panoResolveProvider.provides: string[] | undefined`

Core columns this provider writes (e.g. `panoId`).

#### `panoResolveProvider.requires: string[] | undefined`

Fields this provider reads; it runs after their producers finish.

### `panoResolveSpec`

A unit of work for the procedure engine: which module to run, and how.

#### `panoResolveSpec.batch: BatchMode`

#### `panoResolveSpec.collects: { panoId: string; } | undefined`

Phantom field carrying the `TCollected` type. Never set at runtime.

#### `panoResolveSpec.config: unknown`

Provider-specific configuration passed to the procedure module.

#### `panoResolveSpec.entry: string`

Module entry point: absolute path, `res://procedures/<name>.js` for built-in
procedures, or a relative filename (resolved against the plugin's directory).

#### `panoResolveSpec.inflight: number | undefined`

Maximum concurrent in-flight requests across all instances.

#### `panoResolveSpec.instances: number | undefined`

Maximum concurrent procedure instances.

#### `panoResolveSpec.prepare: (() => Promise<boolean>) | undefined`

Awaited before the provider joins a run; returning false excludes it.

#### `panoResolveSpec.rate: RateSpec | undefined`

#### `panoResolveSpec.retry: { attempts: number; on: number[]; } | undefined`

Overrides the engine's transient-status retry default. Omit unless this endpoint
answers a retryable condition with a status the default does not cover.

#### `panoResolveSpec.select: Selector | undefined`

Rows the engine feeds the procedure. Omitted, the driver supplies its own.

#### `panoResolveSpec.sink: Sink | undefined`

Where answers go: `patch` writes to locations (default), `collect` returns them
to the caller.

### `subdivisionProvider`

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

#### `subdivisionProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Extra-field keys this provider produces.

#### `subdivisionProvider.id: string`

#### `subdivisionProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `subdivisionProvider.procedure: ProcedureSpec<unknown>`

The procedure that computes this provider's fields.

#### `subdivisionProvider.provides: string[] | undefined`

Core columns this provider writes (e.g. `panoId`).

#### `subdivisionProvider.requires: string[] | undefined`

Fields this provider reads; it runs after their producers finish.

### `svMetaProvider`

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

#### `svMetaProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Extra-field keys this provider produces.

#### `svMetaProvider.id: string`

#### `svMetaProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `svMetaProvider.procedure: ProcedureSpec<unknown>`

The procedure that computes this provider's fields.

#### `svMetaProvider.provides: string[] | undefined`

Core columns this provider writes (e.g. `panoId`).

#### `svMetaProvider.requires: string[] | undefined`

Fields this provider reads; it runs after their producers finish.

### `timezoneProvider`

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

#### `timezoneProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Extra-field keys this provider produces.

#### `timezoneProvider.id: string`

#### `timezoneProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `timezoneProvider.procedure: ProcedureSpec<unknown>`

The procedure that computes this provider's fields.

#### `timezoneProvider.provides: string[] | undefined`

Core columns this provider writes (e.g. `panoId`).

#### `timezoneProvider.requires: string[] | undefined`

Fields this provider reads; it runs after their producers finish.

## PinPano

### `bulkPinToPano(selector: Selector, opts?: (RunOpts & { useLatest?: boolean | undefined; }) | undefined): Promise<BatchOutcome>`

Pin each location in the selector to a resolved panorama (sets `panoId`), so it always
loads the same pano.

### `pinPanoProvider`

A named procedure with dependency-graph placement. Providers that declare
`fieldDefs` are enrichment providers whose fields appear in the enrichment UI.

#### `pinPanoProvider.fieldDefs: Record<string, ExtraFieldDef> | undefined`

Extra-field keys this provider produces.

#### `pinPanoProvider.id: string`

#### `pinPanoProvider.label: string | undefined`

Bulk progress label for slow providers; omit for instant ones.

#### `pinPanoProvider.procedure: ProcedureSpec<unknown>`

The procedure that computes this provider's fields.

#### `pinPanoProvider.provides: string[] | undefined`

Core columns this provider writes (e.g. `panoId`).

#### `pinPanoProvider.requires: string[] | undefined`

Fields this provider reads; it runs after their producers finish.

## Validate

### `validateLocations(selector: Selector, opts?: BulkOpts | undefined): Promise<ValidationOutcome>`

Check that each location's Street View coverage still exists.

### `validateSpec`

A unit of work for the procedure engine: which module to run, and how.

#### `validateSpec.batch: BatchMode`

#### `validateSpec.collects: ValidationState | undefined`

Phantom field carrying the `TCollected` type. Never set at runtime.

#### `validateSpec.config: unknown`

Provider-specific configuration passed to the procedure module.

#### `validateSpec.entry: string`

Module entry point: absolute path, `res://procedures/<name>.js` for built-in
procedures, or a relative filename (resolved against the plugin's directory).

#### `validateSpec.inflight: number | undefined`

Maximum concurrent in-flight requests across all instances.

#### `validateSpec.instances: number | undefined`

Maximum concurrent procedure instances.

#### `validateSpec.prepare: (() => Promise<boolean>) | undefined`

Awaited before the provider joins a run; returning false excludes it.

#### `validateSpec.rate: RateSpec | undefined`

#### `validateSpec.retry: { attempts: number; on: number[]; } | undefined`

Overrides the engine's transient-status retry default. Omit unless this endpoint
answers a retryable condition with a status the default does not cover.

#### `validateSpec.select: Selector | undefined`

Rows the engine feeds the procedure. Omitted, the driver supplies its own.

#### `validateSpec.sink: Sink | undefined`

Where answers go: `patch` writes to locations (default), `collect` returns them
to the caller.

## Query

### `panosAt(points: LatLngLiteral[], radius?: number | undefined, opts?: SearchOpts | undefined, signal?: AbortSignal | undefined): Promise<(Pano | null)[]>`

The nearest pano to each point, aligned to `points`, null where there is no coverage.
`opts.sources` narrows which collections are searched and `opts.preference` picks
nearest or best.

### `svMetadata(panoIds: string[], signal?: AbortSignal | undefined): Promise<(Pano | null)[]>`

Full pano metadata for one or more panos, aligned to `panoIds`. Duplicates are
deduped and large batches are split automatically.

## MapState

### `addClickInterceptor(fn: ClickInterceptor): () => void`

Register a map-click interceptor. Returns a removal function. The most recently
added interceptor that returns true consumes the click.

### `fitMapToBounds(bounds: LatLngBoundsLiteral | null, padding?: number | undefined, minExtent?: number | undefined): void`

Fit the editor map's viewport to `bounds`. A `minExtent` prevents over-zoom on tiny areas.

### `getMapHost(): MapHost | null`

Return the main editor map host, or null if not mounted.

### `setDrawInterceptor(fn: DrawInterceptor | null): void`

Set the callback for completed polygon draws. Null clears it.

### `setMapHost(host: MapHost | null): void`

Set or clear the main editor map host.

### `tryInterceptClick(lat: number, lng: number, shiftKey?: boolean | undefined): boolean`

Run registered click interceptors (newest first). True if one consumed the click.

### `tryInterceptDraw(rings: number[][][]): boolean`

Pass completed polygon rings to the draw interceptor. True if it consumed them.

### `waitForMapHost(): Promise<MapHost>`

Wait for the main editor map to be ready.

## SceneStore

### `clearScene(): void` *(unstable)*

Clear all marker data from the scene.

### `getMarkerDefaultColor(): [number, number, number, number]`

Current default marker color as RGBA.

### `getScene(): CellManager`

The shared scene that all map surfaces render from.

### `getScenePositions(): { ids: Uint32Array<ArrayBufferLike>; positions: Float32Array<ArrayBufferLike>; }`

Snapshot of every rendered location's id and position (`[lng, lat, ...]`).

### `loadScene(markerStyle: MarkerStyle, mc?: RGB | undefined): Promise<void>` *(unstable)*

Rebuild the full scene for all locations.

### `recolorScene(mc: RGB): void` *(unstable)*

Change the default marker color and repaint.

### `setMarkerDefaultColor(r: number, g: number, b: number): void` *(unstable)*

Set the default marker color (RGB bytes).

### `startSceneEngine(): () => void` *(unstable)*

Start listening for deltas, selections, and active-location changes. Returns a stop function.

### `whenSceneSettled(): Promise<void>` *(unstable)*

Resolves when the most recently started full scene load has finished (or immediately if none is in flight).

## Color

### `applyAccentColor(hex: string): void`

Set the app's `--accent` and `--on-accent` CSS custom properties from a hex color.

### `colorForName(name: string): string`

Deterministic tag color from a name.

### `hexToHsl(hex: string): { h: number; s: number; l: number; }`

Convert "#rrggbb" to {h, s, l} (degrees, percent, percent).

### `hexToRgb(hex: string): RGB`

Parse "#rrggbb" to an [r, g, b] byte tuple.

### `hslToHex(h: number, s: number, l: number): string`

Convert HSL (degrees, percent, percent) to "#rrggbb".

### `hslToRgb(h: number, s: number, l: number): RGB`

Convert HSL (h in degrees, s and l in 0-1) to an RGB byte tuple.

### `labelColor(name: string, overrides: Record<string, string>): string`

A label's color: a user override if set, else a deterministic color from its name.

### `resolveSvColorHex(color: string): string`

Resolve an SV coverage color to hex. Accepts "#rrggbb" or a CSS custom-property
ramp name (legacy stored format).

### `rgbCss([r, g, b]: RGB): string`

Format an RGB tuple as a CSS `rgb(r, g, b)` string.

### `rgbToHex([r, g, b]: RGB): string`

Convert an RGB byte tuple to "#rrggbb".

### `textColorFor(bg: string): string`

Return "#000" or "#fff" for readable text on the given hex background.

## Toast

### `getToasts(): ToastEntry[]`

Current list of visible toasts.

### `toast(message: string, duration?: number | undefined, container?: HTMLElement | undefined): void`

Show a brief toast notification. Optionally scoped to a `container` element.

## Jobs

### `cancelJobs(scope: JobScope): void` *(unstable)*

Cancel every live job of `scope` that can be cancelled. Owners observe their own
abort and end their jobs; entries without a cancel are removed outright.

### `confirmMapExit(kind: MapExitKind): Promise<boolean>` *(unstable)*

Gate a user action that would end every map-scoped job. Resolves true immediately when
none are live; otherwise raises the confirm dialog, and true means the jobs were
cancelled and the action should proceed.

### `getExitRequest(): { kind: MapExitKind; } | null` *(unstable)*

The pending map-exit confirmation, for the dialog.

### `getJobs(): JobEntry[]` *(unstable)*

Live jobs, for the tray. Reference changes on every update.

### `registerJob(label: string, opts?: JobOpts | undefined): JobHandle` *(unstable)*

Register a long-running operation with the global job tray. The caller owns the
work; the registry owns only its presentation and the cancel/reveal controls.

### `resolveMapExit(ok: boolean): void` *(unstable)*

Answer the pending map-exit confirmation.

### `runJob<R>(label: string, fn: (ctx: JobRunContext) => Promise<R>, opts?: Omit<JobOpts, "cancel"> | undefined): Promise<R | null>` *(unstable)*

Sugar for promise-shaped work: registers a job wired to an AbortController, reports
through the handle, and ends the job however `fn` settles. Cancelling resolves null;
a real failure toasts and rethrows.

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

Close the current map and return to the map list.

#### `_test.deleteMap(id: string): Promise<void>` *(unstable)*

Delete a map by id.

#### `_test.importFile(droppedFields: string[], tagName?: string | undefined): Promise<EditorImportResult>` *(unstable)*

Import a previewed file, optionally assigning a tag.

#### `_test.importPaste(text: string): Promise<EditorImportResult[]>` *(unstable)*

Import locations from pasted text and commit them to the map.

#### `_test.openMap(id: string): Promise<void>` *(unstable)*

Open a map by id and navigate to it.

#### `_test.procedureEntry(name: string): string`

Entry point of a procedure this app bundles. Plugins ship their own paths.

#### `_test.runProcedure<T>(spec: ProcedureSpec<T>, selector: Selector, opts: Omit<RunOpts, "force"> & Omit<DeclOpts, "fields" | "requires"> & { ...; }): Promise<...>` *(unstable)*

Run a single procedure over `selector` and return its typed results.

#### `_test.syncSelections(): Promise<{ ids: number[]; }>` *(unstable)*

Force a full selection re-resolve and return the selected IDs.

## Types

### `applyLocationPatch(loc: Location, patch: LocationPatch_Deserialize): Location`

Apply a LocationPatch to a location. `extra` follows JSON Merge Patch (RFC 7386):
keys shallow-merge, a null value deletes its key, and a null patch clears extra.

### `bboxTupleToBounds(t: [number, number, number, number] | null): LatLngBoundsLiteral | null`

Convert a [west, south, east, north] bbox tuple to Bounds, or null.

### `boundsToScoreTuple(b: LatLngBoundsLiteral): [number, number, number, number]`

Convert a Bounds object to a [south, west, north, east] tuple.

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

True when the location is an import preview (not yet committed).

### `isPinned(loc: Location): loc is Location & { panoId: string; }`

Pinned: the location always opens this exact pano.

### `isSeenPreview(loc: Location): boolean`

True when the location is a seen-history overlay preview.

### `isVirtualLocation(loc: { id: number; }): boolean`

True for virtual (preview-only) locations, which have negative ids and are not
part of the map.

### `isWorldBounds(b: LatLngBoundsLiteral): boolean`

True when bounds span the entire world.

### `locId(m: MaybeLocation): number`

Extract the id from a MaybeLocation.

### `sameRow(a: Location, b: Location): boolean`

The same location on the same pano: what makes one row's answer another row's.

### `scoreTupleToBounds([s, w, n, e]: [number, number, number, number]): LatLngBoundsLiteral`

Convert a [south, west, north, east] tuple to a Bounds object.

## Util

### `appendTagName(pending: string[], name: string, tags: Tag[]): string[]`

Add a name to a staged list: dedup case-insensitively, normalizing to an existing tag's
canonical casing. Returns the original array unchanged if already present.

### `bestBy<T>(items: Iterable<T>, isBetter: (a: T, b: T) => boolean): T | null`

The item `isBetter` prefers over every other, or null when there are none.

### `chunk<T>(arr: readonly T[], n: number): T[][]`

Split `arr` into sub-arrays of at most `n` elements.

### `cmpVersion(a: string, b: string): number`

Compare two semver strings (e.g. "0.6.1", "0.7.0-rc.2"). Returns >0 if a > b.
Build metadata is ignored; a pre-release sorts below the release it precedes.

### `compareNatural(a: string, b: string): number`

Compare strings with natural (numeric-aware) ordering.

### `copyImageToClipboard(blob: Blob): Promise<boolean>`

Copy an image Blob to the clipboard. False when the platform refuses it.

### `downloadBlob(blob: Blob, fileName: string): void`

Trigger a browser download from an in-memory Blob.

### `errText(e: unknown): string`

Message for an unknown thrown value.

### `isPrereleaseVersion(v: string): boolean`

True when `v` carries a semver pre-release tag, e.g. "1.0.0-beta.1".

### `isWeb(): boolean`

True when running under the web-serve bridge (a plain browser, no native shell).

### `mmaBufUrl(path: string): string`

URL that serves a local file over the `mma-buf://` protocol.

### `nowUnix(): number`

Current time as Unix seconds, the form Location timestamps use.

### `phaseRate(prev: PhaseRate | null, done: number, total: number, now: number): { state: PhaseRate; rate: number | null; }`

Compute a locations/second rate for the current progress phase. Re-anchors when a
new phase is detected (done went backward or total grew). Null until a quarter second
of work has elapsed.

### `schemeBase(scheme: string): string`

Base URL for a custom URI scheme, platform-adjusted.

### `sortTagsByMode(tags: Tag[], mode: TagSortMode, counts: Record<number, number>): Tag[]`

Sort tags by the chosen mode: name, location count, or manual order.

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
