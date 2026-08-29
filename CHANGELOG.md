## v0.10.1 - 2026-08-28
- Distance unit setting: metric, imperial, or automatic from your system locale. Applies everywhere a distance is shown or typed: the measure bar, map overview, score bounds, merge distance, generator spacing, LocalGuessr results
- Scratch map: a throwaway map for the session, opened from the map list toolbar and wiped on the next launch
- Duplicate preference: a per-map formula in map settings decides which location survives a merge, defaulting to the most tags
- Map settings dialog now holds name, description, labels and duplicate preference in one place
- Faster store operations: pivots and field lookups on a selection up to 300x faster, bulk adds and map open about 1.3x faster, and proximity checks and commits are 2-3x faster
- Score bounds moved from the layers popup into map settings
- Enrichment dialog splits into an Enrich tab and a Fields tab
- Apply-as-tags names come from a template, so Camera/{value} files them in a folder
- Hotkeys to open settings (Mod+,) and plugins (Mod+Shift+P)
- Settings opens with search focused, and search also matches section paths and dropdown option values
- Launching the app a second time focuses the running window instead of starting a second copy that could clobber its saves
- Numeric pivots keep their empty bins, so gaps in the data stay visible
- Fixed the map not zooming while a drawing tool was active
- Fixed tags and folders not being draggable back to the top level
- Fixed the LocalGuessr minimap and the fullscreen mini map opening while a mouse button was held
- Fixed dialogs shifting and flashing as they open
- Fixed a tooltip reopening on its button after closing a dialog
- Fixed a failed plugin update leaving the plugin unloaded instead of running the old version
- Fixed enum field values showing untranslated in the bulk operation dialog

## v0.10.0 - 2026-08-26
- **Enrichment can now reliably scale to millions of locations**
- Enrichment now uses significantly less memory
- Enrichment is somewhat faster in general, and much faster for larger scale
- 100-300x faster undo/redo
- Pano ID is available as a filter field
- Setting to skip the commit message prompt
- Fixed the window freezing periodically while Discord presence was on
- Fixed a blank flash when a window opens
- Fixed renaming a polygon using native prompt
- Fixed sidebar segmented controls squashing their labels
- Fixed the sync sidebar's inputs missing their styling

## v0.9.2 - 2026-08-20
- Copy-to-map hotkeys can be made global instead of per-map
- Plugins installed from the marketplace update themselves at startup
- Installed border data refreshes itself when the source data changes
- Redesigned doclink assign dialog, with a tag pane that matches the sidebar tag tree
- LocalGuessr: dashed result line and shadow halos on the guess map
- LocalGuessr: pressing N a second time zooms all the way out
- Report dialog remembers what you attach, per report type, and suggestions no longer attach diagnostics by default
- "Pick evenly spaced locations from selection" is now "Thin selection by minimum distance"
- Reorder tags from the keyboard with alt+arrow
- Fixed unofficial panoramas failing to load
- Fixed patches of the panorama drawing in the wrong colours when toggling hide car in LocalGuessr
- Fixed GitHub sign-in not refreshing
- Fixed hiding a map layer wiping the opacity you had set for it
- Fixed Enter planting a location when it was meant to activate the focused control
- Fixed focus not returning to where it was after closing a dialog
- Fixed the hotkey field capturing keys as soon as it was focused
- Fixed the tag sort buttons being untranslated
- Fixed unparseable date text being discarded without saying so
- Fixed LocalGuessr allowing point north in NMPZ
- Fixed LocalGuessr discarding a resumable run when the sidebar opened
- Redrawn app icon

## v0.9.1 - 2026-08-19
- Option to tag locations that have no value for the field when applying metadata as tags
- Fixed map list search skipping maps inside collapsed folders
- Fixed the map generator's search visualization not covering polygons added when a running job is resumed
- Fixed a brief rendering glitch when toggling hide car in LocalGuessr
- Fixed the LocalGuessr compass and compass tape ignoring the compass settings
- Fixed a truncated map file opening as an empty map instead of reporting the problem
- Fixed a corrupted map file crashing the app on open
- Fixed unsaved changes being silently discarded when their file could not be read
- Fixed unsaved edits being lost if the app or machine stopped mid-save
- Fixed field type detection accepting impossible dates like "9999-99"

## v0.9.0 - 2026-08-18
- **LocalGuessr: play your maps in-app like GeoGuessr, with movement modes, timers, and cross-game streaks**
- **Report bugs and suggest ideas from inside the app, under your GitHub account or anonymously**
- Reports can carry screenshots and opt-in diagnostics, with a preview of what gets sent
- Filed reports show their status and replies in Settings
- Full translations in German, Spanish, French, Japanese, Polish, Russian, and Chinese (Simplified)
- Download Vali coverage data per country from inside the app
- Out-of-date Vali data is flagged, with a one-click update for stale countries
- Vali engine updated to upstream 3.2.1
- Write a commit message when committing, shown in version history
- Edit an enum field's values from the enrichment dialog
- Random and spaced pickers can cap picks per selection
- Custom heatmap gradient editor
- Street View screenshots copy to the clipboard
- Cleaner state and province borders data source
- The map layers panel opens on dropdown click instead of hover
- Reorganized settings page
- Generator searches in grow strategy keep exploring from found locations instead of stopping early
- Settings and hotkey changes apply immediately in other open windows
- Faster metadata enrichment on large batches
- Fixed imported fields with accented names sometimes splitting into two fields
- Fixed a failed autosave silently dropping pending tag changes
- Fixed inconsistent undo behavior for bulk tag changes
- Fixed duplicate detection missing matches near cell boundaries
- Fixed selections missing locations near the poles and the antimeridian
- Fixed dropdown menus rendering behind map controls
- Fixed bound hotkeys also triggering browser shortcuts
- Fixed unassigned hotkey slots not being clickable
- Fixed Street View coverage opacity not applying in the minimap

## v0.8.3 - 2026-08-06
- Location actions in the map right-click menu (copy link, copy pano ID, download, copy to map, duplicate, delete)
- Select the country or subdivision under the cursor from the right-click menu
- Rebuilt measure tool that works on every map style
- Street View screenshot button
- Collapsible fullscreen tag bar
- Hotkey to cycle movement mode
- Finer fullscreen minimap sizing and a close-delay setting
- Layers remember their last opacity when toggled
- Locations without a saved zoom open fully zoomed out
- Faster selections, duplicate detection, and field filters on large maps
- Faster exact date lookup
- Faster vision search
- Fixed looking around with hotkeys resetting panorama zoom
- Fixed trekker coverage not being available via filter
- Fixed polygon selections and generator regions breaking at the antimeridian
- Fixed the Duplicates selection missing some members of duplicate chains
- Fixed overlapping selections painting in the wrong order
- Fixed identical polygon selections stacking instead of deduplicating
- Fixed the bulk import tag not applying unless Enter was pressed
- Fixed the panorama UI toggle not hiding navigation arrows
- Fixed stale tag counts and filter fields after checking out a commit
- Fixed tags with locations missing from the tag list after reopening a map
- Fixed exact date search reporting no result when a lookup failed mid-search
- Fixed hover panels closing while dragging inside them
- Fixed hotkeys not responding after using the date picker

## v0.8.2 - 2026-07-25
- New setting for the color of newly drawn polygons
- Overlapping selections draw one marker per location instead of stacking duplicates
- Faster marker rendering and selection updates on large maps
- Plugin cards explain their labels on hover
- Fixed pulling a nested group out of a composite duplicating its children
- Fixed lag when hovering long suggestion lists
- Fixed GPU memory churn from the search coverage overlay

## v0.8.1 - 2026-07-22
- **Sync maps with map-making.app and GeoGuessr**
- First sync offers merge or mirror when both sides already have locations
- Sync connections show provider icons, your account avatar, and a link to open the remote map in the browser
- New subdivision enrichment field
- Review bar and geocoding info in fullscreen
- Fullscreen tag palette opens on hover
- Plugin installs and updates that require a newer app version are blocked instead of breaking
- Movement mode now applies to keyboard controls
- Fixed tooltips overlapping during handoff and arrow color seams
- Fixed a clipped tag delete outline and a stray scrollbar in the location preview

## v0.8.0 - 2026-07-19
- **Doclinks: link tags to sections of a Google Doc, with an in-app document reader**
- **UI overhaul: refreshed dialogs, buttons, checkboxes, and consistent styling app-wide**
- Fullscreen map mode with a floating, draggable Street View preview
- Saved selections can now be used anywhere a selection is picked, including as a heatmap source
- Drag tags and folders into folders, and ctrl+drag to move a block of selected tags together
- Tag folder color setting: fixed color or inherit from the first child
- Declare empty tag folders
- Whole-layer marker opacity control, with hotkeys to toggle Street View/marker opacity
- New corner status tray for update, plugin, settings, and bulk-action buttons
- Map list label filter syntax with clickable label chips
- New dark and multi-provider vector basemap styles
- Live render stats in Stats for Nerds
- Export dialog settings are now remembered per map
- Local REST transport for the MMA API
- Heatmap plugin: multiple simultaneous layers and more gradient options
- Fixed doc links tooltip claiming an undo option that doesn't exist
- Fixed the pano date count badge losing its text color
- Fixed the generator plugin's "set caps" prompt using a native popup instead of an in-app dialog
- Fixed the map context menu appearing behind other panels
- Fixed the min-distance picker missing a meters label
- Fixed Street View coverage dots stuttering while panning
- Fixed saved selections breaking when a referenced field was renamed
- Fixed tag renames needlessly resyncing selections
- Fixed dragging a tag over an invalid folder leaving a move armed
- Fixed imports keeping raw tag order values instead of rebasing them
- Fixed the app losing your open map session after an update install and relaunch
- Fixed changing the generator plugin's target not applying to an already-running job
- Fixed month groupings sorting alphabetically instead of by calendar order
- Fixed Street View tiles being throttled unnecessarily on the vector basemap

## v0.7.6 - 2026-07-13
- Opt-in Discord Rich Presence, with a privacy level setting
- Fixed metadata fields occasionally being lost when several enrichment steps wrote to a location at once
- Fixed Street View coverage dots lagging the map after panning across large areas
- Fixed the plugin sidebar staying visible outside plugin views

## v0.7.5 - 2026-07-12
- Close an in-progress polygon by clicking its first vertex
- Polygon drawing now works the same on every map style

## v0.7.4 - 2026-07-12
- New vector basemap and a redesigned thumbnail basemap picker
- Legacy map style now works with terrain and satellite, with labels drawn above Street View coverage
- New map styles: Arctic, Ember, Forest, Noir, Dusk
- Map settings toggles to hide POIs, transit, highways, and road labels
- Bulk panorama download
- Command to pick an evenly spaced subset of a selection
- Pivot plugin: percentage modes, value shading, smarter bucketing, ctrl-click column selection
- Gradient plugin: reverse toggle and steadier layout
- Plugin sidebars remember their state between visits
- Enrichment and field management unified into a single dialog in the editor header
- Animated tag reordering, with improved drag UX
- Faster large-file imports, and the map no longer stalls while an import auto-commits
- Cleaned up settings, status bar, and map-type menus
- Fixed one failing location aborting bulk validation
- Fixed mouse wheel not scrolling dropdowns inside dialogs
- Fixed clicks while measuring opening locations instead
- Fixed Enter in the map list opening a loosely-matching map
- Fixed pasting a single location zooming all the way in
- Fixed overlapping zoom buttons in the panorama viewer

## v0.7.3 - 2026-07-05
- Bulk operations now show throughput (items/sec) and elapsed time
- Copyright plugin is more accurate
- Plugin sidecar downloads are now verified against release checksums
- Fixed deleted metadata fields reappearing after saving
- Fixed unofficial panoramas failing to load
- Fixed metadata field labels showing incorrect capitalization
- Fixed plugin sidecar processes not always shutting down on exit

## v0.7.2 — 2026-07-03
- Fixed sidecar plugins opening a console window on Windows

## v0.7.1 — 2026-07-03
- Poisson disk, blue line coverage, and BFS kernel sampling modes for the map generator
- Vali generate and download can now be cancelled mid-operation
- Welcome dialog on first launch with links to the manual and Discord
- Discord and manual shortcut buttons on the map list screen
- App is now referred to as "Map Making App" in the UI
- Fixed plugin type declarations exporting mangled names
- Fixed map list scrollbar visible behind the manual

## v0.7.0 — 2026-07-03
- **Vali generation is now 5x faster, runs directly in the sidebar, and requires no additional installation**
- **New Vision plugin: search your locations by describing what they look like, or find ones that look alike**
- **New Copyright Year plugin: read the copyright year Google stamps on Street View imagery**
- Plugins with companion tools now download and update them straight from the plugin manager
- More built-in map style presets
- Setting to choose a default color for markers
- Map generator option to skip locations you already have
- iNaturalist plugin can auto-sort observations by taxonomy
- Setting to reopen your previously open maps on next launch
- Tag aliases in the tag tree
- Searchable aliases for command palette commands
- Support for typing directly into date pickers
- Unknown field names now display with sentence-case labels
- Faster nearby and radius location lookups
- Inverting a nested selection now works at any depth in the selection tree
- Fixed plugin manager UI flash for "Additional" tab
- Fixed the map not zooming out fully on wide windows
- Fixed the map generator's coverage search being offset

## v0.6.8 — 2026-06-29
- Choose where your map data is stored on disk
- Tag names are shortened to their shortest unique path in tree view
- Fixed country and subdivision selection failing when its border data wasn't downloaded yet
- Fixed a rendering glitch when opening dropdowns in Settings

## v0.6.7 — 2026-06-28
- Vastly improved support for tag folders
- Renaming a tag folder now cascades to all the tags within it
- Alt+click a tag in the tree to isolate just that one, ignoring its sub-tags
- Adjustable spacing between tags in the tag list
- Minimap now stays available in fullscreen and follows the panorama outside the viewport
- Date picker now available in fullscreen
- Colorable map list labels
- Import folder assignments from the web app via .mmafolders files
- Fixed the expanded minimap pushing its controls off-screen when the window is maximized
- Fixed 0m duplicate checks freezing on large maps
- Fixed progress bars and live updates not working in the web version
- Fixed copying a location to a map open in another window not updating that map's tag counts
- Fixed manual reviews unexpectedly resuming
- Fixed the panorama view shifting when entering fullscreen
- Fixed memory not being freed when a bulk import is cancelled

## v0.6.6 — 2026-06-26
- Variable marker size slider
- iNaturalist plugin
- "Use latest panorama" option in bulk pin-to-pano
- Option for Google panorama as reverse geocode provider
- Street View thumbnail embedded in copied pano share links
- Progress bars for long-running operations
- Select multiple files at once in bulk import
- Close map shortcut
- Faster imports on large files
- Fixed arrow markers rendering with a gap in their shape
- Fixed tooltips staying open when hovering over them
- Fixed country and state codes being lost during import
- Fixed bulk export changing field order
- Fixed checkboxes in bulk import not responding to clicks
- Fixed review session buttons invisible on white background
- Fixed pinned command forms not sorted by pinned order
- Fixed scrollbar causing layout shift
- Fixed F11 fullscreen not working in the web version
- Fixed zip import not working in the web version

## v0.6.5 — 2026-06-24
- Coverage dates enrichment field with array type filtering
- Faster imports
- Tooltips migrated to Radix
- Map generator shows a summary of active settings
- Improved description search layout in map generator
- Long tag names truncate by width
- Fixed keyboard shortcuts not working while a slider has focus
- Fixed folder renames not working for empty folders
- Fixed tag autocomplete scrollbar showing incorrectly
- Fixed release notes text justification

## v0.6.4 — 2026-06-23
- Bound panorama dots to evict, preventing performance degradation over time
- Add icons to remaining selection commands

## v0.6.3 — 2026-06-23
- Redesigned map overview UI
- Add command to open a different map without leaving the window
- Toggleable overlay showing all seen locations on the map
- Quickly copy a location to another map
- Folders in the map list remember their collapsed state
- Select uncommitted locations
- Select reviewed locations across every review session at once
- Rename review sessions, and single-selection reviews are now named after their selection
- Redesigned review sessions window with dates
- Optional cursor overlay showing the click search radius
- Filter by the top or bottom K values of a field
- Filter by heading, pitch, and zoom
- "Filter by metadata" now applies when you press Enter
- Enrichment status is now field-aware
- Locations now show created and modified timestamps in the editor
- Extra field keys are now sorted alphabetically
- Improved metadata details UI
- New selection dropdown styling and saved selection dialogs
- Pinned command context menu and default pinned commands
- Free-aspect-ratio split view with smoother resizing
- Edit generator regions while a job is running, with buffered finds flushed on pause or stop
- Improved Street View pano dot rendering
- Faster bulk metadata operations
- Fixed seen-matching using location IDs instead of pano IDs
- Fixed edge cases where exact date matching did not run when the setting was enabled
- Fixed a location's date being wrong after moving within a panorama, if the location had a cached datetime
- Fixed deleted maps showing up in the seen filter dropdown
- Fixed modified time not updating on location edits
- Fixed undo back to the original state marking a location as uncommitted
- Fixed map overview losing its state when switching work areas
- Fixed validation handling of the load-as-pano-ID flag

## v0.6.2 — 2026-06-20

- Select admin-1 subdivisions on the map
- Customizable pano dot color and size
- Filter locations by tag count
- Alt-click to isolate a ghosted selection
- Add partition primitives to gradient plugin, "apply metadata as tags"
- Tag suggestion limit setting
- Plugin update mechanism in the marketplace + slightly better marketplace UI
- Fix map generator plugin UI
- "What's new" panel marks versions you haven't updated to yet
- Fixed arrows facing the wrong direction on the map
- Fixed Shift-modified hotkeys not firing
- Fixed date-based gradients and tag partitions ignoring time zone
- Fixed the fullscreen tag bar losing focus
- Fixed unsaved tags persisting when staging a location's tags
- Fixed the weather plugin not reporting progress

## v0.6.1 — 2026-06-18

- Minimap now mirrors the editor map
- "What's new" panel in the map list, with per-version history
- Added search-coverage overlay while generating
- Color a subset of locations by gradient, bucketed within that subset
- Allow deleting a map from inside the editor
- Toggle a selection's ghost state from its row
- Hold-and-click hotkey to delete the polygon under the cursor
- Copy-link modifiers: hold Shift to copy without tags, Alt for the long URL
- Allow pasting a location into the search box
- Text-match dropdown when bulk-adding a tag
- Arrow-key navigation through autocomplete suggestions
- Window title now shows the open map
- Tag order is kept when exporting and re-importing JSON
- Autocomplete and quicktags follow your tag sort order
- Optimized request concurrency/throughput
- Map generator can search within descriptions and filter by number of links
- Map generator gained a fixed output zoom and a speed setting
- Map generator applies settings changes mid-run
- Fixed the map generator losing its session when switching views
- Fixed edits to a selection to become an existing selection replacing it instead of merging into it
- Fixed inaccurate counts on ghosted selections
- Fixed the fullscreen minimap and tag bar ignoring the hide-UI hotkey
- Fixed a rendering issue on Linux

## v0.6.0 — 2026-06-12

- Per-map hotkeys: assign keys to tags and to copying the active location to other maps
- Select-only mode toggle - map clicks never add locations
- Paste lists of Google Maps URLs to import
- Staged import locations preview on the map before being added, with a configurable marker color
- Apply metadata as tags can group dates by year, month, or day, and bucket numbers
- Filter exact dates in the location's own timezone
- A date pick in filters now means the whole day, with a clear-time button on the picker
- Step date and number window filters period-by-period from the selection row
- Copy buttons between min and max filter values
- Bulk set-field accepts expressions, e.g. mod(heading + 180, 360)
- Prune duplicates on a duplicates selection
- Legacy map style
- Tags reorder live while dragging
- Save-as-tag pre-fills the selection name
- Hotkey to fully zoom out the panorama
- Better trekker coverage detection
- Faster commits on large maps
- Faster selection syncing and tag list on maps with many tags
- Fixed a possible crash when committing after undoing edits
- Fixed selection colors breaking with more than 255 selections
- Fixed pasted URLs with a panorama not loading by pano ID
- Fixed deleting many tags at once being slow
- Fixed generator region count inputs clipping long values
- Fixed the shortcut filter box scrolling away in the settings list
- Fixed the map list stretching awkwardly on long names

## v0.5.3 — 2026-06-09

- Customizable active marker color
- Map follows along while reviewing locations
- Adjustable marker opacity, merged into the Street View opacity slider
- Fixed single-coordinate paste (+ more supported formats)
- Large imports now commit automatically, with a warning first
- Date picker now shows local time instead of UTC
- Importing GeoJSON now creates one selection instead of one per polygon part
- Vali plugin now matches the app theme
- Faster selections on large maps
- Faster large imports
- Fixed imported locations not appearing for users with non-Latin characters in their username
- Fixed a stray blue highlight and focus ring on the Street View panorama
- Fixed picking a location with the keyboard

## v0.5.2 — 2026-06-06

- Overhauled review system with review sessions, select reviewed/unreviewed, and review bar
- Pick N random locations from the current selection
- Drag-and-drop file import
- Delete key removes selected locations from the overview
- Bulk "Set heading" operation
- Bulk Set field now supports camera fields (heading, pitch, zoom)
- Apply metadata field as tags
- Save selection as tag moved to per-selection context menu
- Native save dialog for export
- Export notification on completion
- Preview aspect ratio presets (16:9, 21:9, etc.)
- Heatmap plugin remembers settings between sessions
- Offline country distribution
- Faster startup via lazy-loaded deck.gl
- More flexible editor split on small screens
- Fixed polygon selections across the antimeridian
- Fixed generator not stopping in-flight Street View requests on pause
- Fixed editor occasionally racing map open on slow loads
- Fixed country distribution accuracy with border point-in-polygon

## v0.5.1 — 2026-06-03

- New weather plugin
- New selection disambiguation plugin that ranks metadata fields by how much they differ between groups
- Merge duplicate locations command
- Score bounds editor settings
- Import staging sidebar with an on-map preview of locations before importing
- Full-resolution panorama download fix
- GeoGuessr-style map scale in fullscreen
- Bulk metadata field management: rename, merge, delete, and set values
- Ghost selections command - ephemeralize selections
- "Edit filter" - inline dropdowns for individual filters
- Rebindable quick-tag hotkeys
- Tag tree multi-select and drag-to-reorder fixes
- Save a selection as a tag, or delete a selection's locations; as commands
- Pano uploader name as new enrichment field
- Commit diff overlay in version history upon clicking a commit
- Configurable heatmap color gradient with presets, scopeable to the active selection
- Gradient coloring now sorts values naturally and maps colors proportionally
- Numeric bucketing in pivot tables
- "Center toward nearest road" hotkey
- Quick-copy the full Street View URL
- Clear button in the map list search field
- Press Enter in the map list to open the first match or create a new map
- Resolve hotkey conflicts inline while recording a binding
- Added a user manual
- Faster selections and tag filtering on large maps
- Fixed hotkeys not firing while the Street View panorama was focused
- Fixed re-adding a location from the Seen list after it had been deleted
- Fixed validation incorrectly flagging tripod panoramas
- Fixed manual navigation buttons showing fallback text instead of being hidden
- Fixed enrichment fields from multiple providers overwriting each other
- Fixed stale date/timezone not clearing
- Fixed the update pill opening settings instead of updating in place
- Fixed overly aggressive Alt hotkey conflict detection

## v0.5.0 — 2026-05-29

**Plugins & marketplace**
- **Plugin marketplace** with two tabs — Core (bundled) and Additional (fetched from GitHub). Install/uninstall downloads or deletes plugin files in app data; enable/disable is separate, so you can deactivate a plugin without removing it. Manually-installed plugins show up too.
- **Shared modules** — plugins can now import app-bundled libraries (React, deck.gl, luma.gl) instead of bundling their own copies.
- New **heatmap** plugin
- New **gradient coloring** plugin — colors markers by any field. Numeric/date fields get range buckets, categorical fields get one color per value.
- New **pivot table analytics** plugin — cross-tabulates your selection (active, saved, or all) against any field or tags.
- New **sun position** plugin — computes sun azimuth and altitude for each location from its coordinates and capture time.

**Editor**
- **Multi-window editing** — open maps in separate windows.
- **Time-of-day filtering** in the date picker — date fields get an optional time input, and a new "Any date" mode lets you filter purely by time of day.
- **Country select improvements** faster, and offers downloadable higher-accuracy border datasets — High (~10MB) and Ultra (~46MB), selectable under Street View settings.
- **Fit bounds on paste** — optionally reframe the map to the locations you just pasted.
- **Minimum search radius** map setting (10–500m slider) controlling the floor for Street View lookups.
- **Driving-direction enrichment** — new metadata field for the capture-time driving direction.

**Performance**
- Much faster selections on large maps — selecting everything on a 1M-location map is now near-instant (~435ms → ~16ms).

**Fixes**
- Fixed the auto-updater 404 and missing macOS update signatures in the release workflow.
- Fixed road/link heading reading the wrong protobuf field
- Fixed several date picker bugs: bare month parsing, value conversion when toggling any-year/any-time, persistence across navigation, and a year grid (2007–now).
- Fixed a plugin activation race (plugins now wait for the map to be ready), gave the toolbar a deterministic order, fixed a marketplace double-click, and hardened plugin install against path traversal.
- Replaced native confirm() dialogs in Version History and the Seen dialog with inline click-to-confirm
- Fixed the fullscreen tag bar: visible input text color, spellcheck off, and an input-filtered palette.
- Narrowed the Alt keybinding block so it only catches genuine navigation conflicts instead of all Alt combos.
- Hid the scrollbar in the map overview.

## v0.4.0 — 2026-05-26

- Fixed same-name tags not merging
- Fixed autocomplete showing invisible tags
- Heading tape compass in the editor
- Custom date picker UI with year-agnostic filtering
- Zoom to selection bounds hotkey (Shift+E)
- Find and replace in tag names command
- Country select promoted from plugin to core feature
- Hover-to-expand tag palette in fullscreen mode
- Update-available indicator on startup
- Cancel in-flight POV tweens before starting new ones
- Fixed selection color flash when adding locations
- Fixed deleted locations remaining in review queue
- Fixed cross-type equality in selection filters
- Fixed hotkey binding UI accepting Alt and Ctrl+/- combos
- Fixed date picker layout instability
- Fixed radius override for forward/backward hotkeys
- Fixed main window not focusing when closing editor window

## v0.3.3 — 2026-05-24

- Bulk operation improvements: scope toggle (all vs. selected) + clear metadata fields
- Option for hierarchical tag tree -- tags with / in their name display as collapsible folders
- Enrichment field selection moved to a modal
- Auto-tag generated locations via per-map setting
- Shift-click range select for tags (replaces shift-drag)
- Tag color changes now update selection colors immediately
- Search bar in hotkey settings
- "Zoom reset" hotkey
- "Zoom to bounds" hotkey
- Selecting multiple tags at once is faster
- Fixed crash on first launch when app data directory doesn't exist

## v0.3.2 — 2026-05-23

- Memory-mapped Arrow IPC - large memory savings and minor performance wins
- Added same-location router UI
- Added "copy coordinates" from right-click context menu on the map
- Faster selection resolution
- *Slighty* faster active location switching
- Typed IPC bindings: every Rust command has auto-generated TypeScript types via specta (no manual invokes for the plugin API)
- Fixed tags not merging by name on import
- Date picker now correctly shows image date + nearby official dates in lat/lng fallback paths
- Fixed "Select Everything" resetting selections
- Fixed marker pickability
- opensv minified (smaller binary)
- Various bug fixes and internal refactors

## v0.3.1 — 2026-05-17

- **Saved selections system**: bookmark and reuse selections
- **Plugin API**
- Hotkey-command linking: all commands in the command palette now support hotkey settings
- Street View trail
- Shift+drag select tags
- Bulk delete tags
- Selections are now shared with the map and map generator plugin
- Various bug fixes

## v0.3.0 — 2026-05-15

## What's new
- **The entire data engine has been rewritten from scratch**. Maps with millions of locations now open, render, and respond to clicks without freezing.
- All marker styles (pin, arrow, circle) are now rendered on the GPU with custom shaders. Improves performance.
- Overhauled map list to be sortable and filterable. Includes labels and opening times, among other things.
- Location addresses are now by default resolved offline, with Nominatim as a legacy setting.
- Lock the Street View camera direction with a hotkey while navigating.
- Numerous bug fixes

**This is a breaking release. For this early version, updating requires backing up your existing data and deleting the app's user data folder to start from scratch.**

## v0.2.0 — 2026-05-09

Initial release.
