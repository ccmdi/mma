import { useEffect, useRef, createContext, useContext, isValidElement, type ReactNode } from "react";
import { Icon } from "@/components/primitives/Icon";
import { mdiClose, mdiChevronLeft, mdiChevronRight } from "@mdi/js";
import { MANUAL_IMG_DIMS } from "@/components/dialogs/manual-img-dims.gen";
import "@/components/dialogs/manual.css";

// --- Reusable content primitives ---

function Kbd({ children }: { children: ReactNode }) {
	return <kbd className="manual-kbd">{children}</kbd>;
}

function Note({ children }: { children: ReactNode }) {
	return <div className="manual-note">{children}</div>;
}

// Images are fetched from GitHub at runtime so the manual ships without bundling
// screenshots. If the file is missing or the user is offline, the <img> hides
// itself and only the caption remains, keeping the layout clean.
const MANUAL_IMG_BASE = "https://raw.githubusercontent.com/ccmdi/mma/master/img/manual/";

function Img({ name, caption }: { name: string; caption: string }) {
	const dim = MANUAL_IMG_DIMS[name];
	return (
		<figure className="manual-figure">
			<img
				key={name}
				className="manual-figure__img"
				src={MANUAL_IMG_BASE + name}
				alt={caption}
				loading="lazy"
				width={dim?.w}
				height={dim?.h}
				style={dim ? { aspectRatio: `${dim.w} / ${dim.h}` } : undefined}
				onError={(e) => {
					(e.currentTarget as HTMLImageElement).style.display = "none";
				}}
			/>
			<figcaption className="manual-figure__caption">{caption}</figcaption>
		</figure>
	);
}

// Navigation injected by the Manual component so cross-references can jump chapters.
const ManualNav = createContext<(id: string) => void>(() => {});

// A clickable cross-reference to another chapter. Renders that chapter's current
// title (single source of truth, so references never drift from renamed chapters).
function ChapterLink({ id }: { id: string }) {
	const go = useContext(ManualNav);
	const title = CHAPTERS.find((c) => c.id === id)?.title ?? id;
	return (
		<button type="button" className="manual-xref" onClick={() => go(id)}>
			{title}
		</button>
	);
}

interface Chapter {
	id: string;
	title: string;
	body: ReactNode;
}

const CHAPTERS: Chapter[] = [
	// ===================================================================
	// PART I - GETTING STARTED
	// ===================================================================
	{
		id: "introduction",
		title: "Introduction",
		body: (
			<>
				<p>
					MMA is a local-first desktop editor for building{" "}
					GeoGuessr
					maps. It is a clone and extension of{" "}
					<a href="https://map-making.app" target="_blank" rel="noopener noreferrer">
						map-making.app
					</a>{" "}
					by ReAnna. It keeps the original's editing model and UI, then adds capabilities that only
					make sense when everything runs on your own machine.
				</p>
				<h2>What's different?</h2>
				<ul>
					<li>
						<strong>No account, no server.</strong> Every map lives on your computer.
					</li>
					<li>
						<strong>Built for large maps.</strong> Maps with millions of locations open and edit
						smoothly.
					</li>
					<li>
						<strong>Commit-based saving.</strong> Instead of a single "save", MMA records{" "}
						<strong>commits</strong> with diffs and a browsable version history you can revert to.
					</li>
					<li>
						<strong>Editor-state restore.</strong> Uncommitted changes are kept automatically, so
						you can close a map and pick up where you left off.
					</li>
					<li>
						<strong>Composable selections.</strong> Build selections from rules and combine them
						with intersection, union, and invert.
					</li>
					<li>
						<strong>Filters.</strong> Select by metadata: country, image date, camera type, or any
						field.
					</li>
					<li>
						<strong>Bulk operations.</strong> Apply one change to a whole selection at once, such as
						setting a field, pinning to a pano, or running enrichment.
					</li>
					<li>
						<strong>Metadata enrichment.</strong> Pull altitude, country, camera type, and capture
						dates onto your locations.
					</li>
					<li>
						<strong>Plugin system.</strong> Extend the editor with extra panels and tools, including
						a built-in coverage generator.
					</li>
					<li>
						<strong>Seen history.</strong> A record of every panorama you have viewed, across all
						maps.
					</li>
					<li>
						<strong>Power-user touches.</strong> Rebindable hotkeys and custom CSS.
					</li>
				</ul>
				<h2>Terms</h2>
				<ul>
					<li>
						<strong>Location.</strong> One Street View spot on a map: coordinates, a point of view
						(heading, pitch, zoom), an optional pinned panorama, tags, and metadata.
					</li>
					<li>
						<strong>Tag.</strong> A colored on/off label you attach to locations to categorize them.
					</li>
					<li>
						<strong>Selection.</strong> A named subset of locations, drawn on the map in its own
						color, built from rules you can combine.
					</li>
					<li>
						<strong>Commit.</strong> A saved version of the whole map. Commits chain together into a
						version history.
					</li>
					<li>
						<strong>Panorama.</strong> A single Street View image sphere. Each location resolves to
						one pano.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "first-run",
		title: "Getting started",
		body: (
			<>
				<p>
					MMA stores everything in a single application data folder. You never have to manage files
					by hand, but it helps to know where they are.
				</p>
				<h2>The data folder</h2>
				<ul>
					<li>
						<strong>Windows:</strong> <code>%APPDATA%\app.map-making.local</code>
					</li>
					<li>
						<strong>Linux:</strong> <code>~/.local/share/app.map-making.local</code>
					</li>
					<li>
						<strong>macOS:</strong> <code>~/Library/Application Support/app.map-making.local</code>
					</li>
				</ul>
				<p>
					Open it directly from{" "}
					<strong>Settings &rarr; Advanced &rarr; Database &rarr; Open data folder</strong>. It
					holds your maps, tags, version history, the seen history, logs, and any installed plugins.
				</p>
				<Note>
					This is a work in progress and data loss can <em>rarely</em> happen. Keep backups. The
					recommended backup is the <strong>Export</strong> (all maps as a ZIP) button on the home
					screen. See <ChapterLink id="bulk-backup" />.
				</Note>
				<h2>Logs</h2>
				<p>
					A unified log file (<code>mma.log</code>) is written inside the data folder under{" "}
					<code>logs/</code>. It is the first thing to grab when reporting a bug.
				</p>
			</>
		),
	},
	{
		id: "map-list",
		title: "Map list/home screen",
		body: (
			<>
				<p>
					When no map is open you see the home screen. The left column, <strong>Your Maps</strong>,
					lists every map with a header showing the total map and location counts. The right column
					holds a <strong>Getting Started</strong> notice and the link to the{" "}
					<strong>Manual</strong>.
				</p>
				<Img
					name="map-list.png"
					caption="The home screen: searchable, sortable map list with folders."
				/>
				<h2>The search / create bar</h2>
				<ul>
					<li>
						<strong>Search maps.</strong> Type to filter the list by map name or label as you type.
						Press <Kbd>Esc</Kbd> to clear.
					</li>
					<li>
						<strong>Sort.</strong> Order maps by <strong>Name</strong>, <strong>Last opened</strong>
						, <strong>Date created</strong>, or <strong>Location count</strong>.
					</li>
					<li>
						<strong>New folder.</strong> Type a name, then press the folder button to create a
						folder.
					</li>
					<li>
						<strong>New map.</strong> Type a name, then press the <strong>+</strong> button to
						create a map. If the search box has text and nothing matches, pressing <Kbd>Enter</Kbd>{" "}
						creates a map with that name and opens it.
					</li>
				</ul>
				<h2>Map rows</h2>
				<ul>
					<li>
						<strong>Open.</strong> Click a map's name to open it in its own editor window.
					</li>
					<li>
						<strong>Drag handle.</strong> Drag a map by its handle onto a folder to move it; drag it
						to the root to move it out.
					</li>
					<li>
						<strong>Edit.</strong> The pencil renames the map and edits its <strong>labels</strong>{" "}
						(free-text keywords shown on the row and searchable).
					</li>
					<li>
						<strong>Delete.</strong> The trash icon deletes the map after a confirmation.
					</li>
					<li>
						<strong>Row fields.</strong> Each row can show location count, last opened, and date
						created. Choose which appear in{" "}
						<strong>Settings &rarr; Advanced &rarr; Map List</strong>.
					</li>
				</ul>
				<h2>Folders</h2>
				<p>
					Folders are collapsible and show their map and location totals. Deleting a folder moves
					its maps back to the root rather than deleting them.
				</p>
			</>
		),
	},
	{
		id: "importing-existing",
		title: "Importing your existing maps",
		body: (
			<>
				<p>
					If you already use map-making.app, you can bring your maps across in bulk. On the web app,
					use its <strong>Download data</strong> option to get a ZIP of all your maps. Then in MMA,
					use the <strong>Import</strong> icon in the bottom-right corner of the home screen.
				</p>
				<h2>The bulk import flow</h2>
				<ol>
					<li>
						Click the <strong>Import</strong> icon (bottom-right of the home screen).
					</li>
					<li>Choose a ZIP (a whole archive) or a single JSON file.</li>
					<li>
						MMA scans it and opens the <strong>Import Maps</strong> preview, listing each map with
						its location count, tag count, and folder.
					</li>
					<li>
						Pick which maps to bring in with <strong>All</strong>, <strong>None</strong>, or{" "}
						<strong>New only</strong>, or tick individual rows. Maps that match an existing map by
						name and location count are flagged <strong>duplicate</strong> and deselected by
						default.
					</li>
					<li>
						Expand the warnings section if any appear, then press <strong>Import N maps</strong>. A
						progress indicator runs while maps import.
					</li>
				</ol>
				<p>
					The neighbouring <strong>Export</strong> icon writes a single ZIP of every map, which is
					also the recommended backup. See <ChapterLink id="bulk-backup" />.
				</p>
			</>
		),
	},
	// ===================================================================
	// PART II - THE EDITOR
	// ===================================================================
	{
		id: "editor-layout",
		title: "Editor layout & the map",
		body: (
			<>
				<p>
					Opening a map launches the editor: a resizable split between the <strong>map</strong> and
					the <strong>sidebar</strong>. Drag the divider between them to rebalance the panes (its
					position is remembered).
				</p>
				<Img
					name="editor-layout.png"
					caption="The editor: map on one side, sidebar with Tags, Selections, and Tools."
				/>
				<h2>The sidebar</h2>
				<p>With no location open, the sidebar shows three sections:</p>
				<ul>
					<li>
						<strong>Tags.</strong> Create, color, and assign labels.
					</li>
					<li>
						<strong>Selections.</strong> Pick subsets of locations and combine them.
					</li>
					<li>
						<strong>Tools.</strong> The plugin toolbar, the <strong>Commands...</strong> button (the
						command palette), the duplicate finder, and the filter builder.
					</li>
				</ul>
				<p>
					Clicking a location's marker swaps the sidebar for the location editor (covered later).
				</p>
				<h2>Basemap and layers</h2>
				<p>
					The basemap dropdown (top-left of the map) chooses the base imagery and toggles layers:
				</p>
				<ul>
					<li>
						<strong>Basemap.</strong> <strong>Map</strong>, <strong>Satellite</strong>, or{" "}
						<strong>OSM</strong> (OpenStreetMap).
					</li>
					<li>
						<strong>Layers.</strong> <strong>Terrain</strong>, <strong>Labels</strong>, and{" "}
						<strong>Panoramas</strong> (individual Street View dots, requires close zoom). The base
						Street View layer is always on.
					</li>
					<li>
						<strong>Street View coverage.</strong> <strong>Show lines</strong> filtered to{" "}
						<strong>Official</strong>, <strong>Unofficial</strong>, or <strong>All</strong>; a color
						swatch for the lines; <strong>Make the lines thinner</strong>; and{" "}
						<strong>Use blobby layer while zoomed out</strong>.
					</li>
					<li>
						<strong>Settings.</strong> <strong>Emphasise country borders</strong> and{" "}
						<strong>Emphasise subdivision borders</strong>.
					</li>
					<li>
						<strong>Map style.</strong> <strong>Default</strong>, <strong>Dark mode</strong>, any
						custom styles you add, and a <strong>Manage map styles</strong> link.
					</li>
				</ul>
				<h2>Navigating the map</h2>
				<ul>
					<li>
						<strong>Pan / zoom.</strong> Mouse drag and wheel, or the keyboard: <Kbd>W</Kbd>
						<Kbd>A</Kbd>
						<Kbd>S</Kbd>
						<Kbd>D</Kbd> to pan and <Kbd>Shift</Kbd>+<Kbd>W</Kbd> / <Kbd>Shift</Kbd>+<Kbd>S</Kbd> to
						zoom. Hold <Kbd>Alt</Kbd> for slow, fine movement. All of these are rebindable.
					</li>
					<li>
						<strong>Place search.</strong> The search control geocodes a place name and fits the map
						to it. The provider is local (offline) by default and can be switched to Nominatim in
						Settings.
					</li>
					<li>
						<strong>Marker visibility.</strong> A toggle cycles markers between opaque, transparent,
						and hidden so you can inspect coverage underneath.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "bottom-bar",
		title: "The bottom bar",
		body: (
			<>
				<p>The bar along the bottom holds the core map actions and status.</p>
				<Img
					name="bottom-bar.png"
					caption="The bottom bar: location count, Commit with diff, undo/redo, Seen, History, Import, Export."
				/>
				<ul>
					<li>
						<strong>Location count.</strong> The total number of locations on the map.
					</li>
					<li>
						<strong>Commit.</strong> Saves the current working changes as a version. The button is
						disabled when there is nothing to commit. When there are pending changes, a diff appears
						beside it: <strong>+added</strong>, <strong>-removed</strong>,{" "}
						<strong>&plusmn;modified</strong>.
					</li>
					<li>
						<strong>Undo</strong> / <strong>Redo</strong>. Step backward and forward through your
						edits (<Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> / <Kbd>Ctrl</Kbd>+<Kbd>Y</Kbd>).
					</li>
					<li>
						<strong>Seen.</strong> Opens your pano visit history. See <ChapterLink id="seen" />.
					</li>
					<li>
						<strong>History.</strong> Opens the commit history for this map. See{" "}
						<ChapterLink id="version-history" />.
					</li>
					<li>
						<strong>Import file.</strong> Brings locations into the current map. See{" "}
						<ChapterLink id="importing-into-map" />.
					</li>
					<li>
						<strong>Export.</strong> Writes the map (or selection) out. See <ChapterLink id="exporting-map" />
						.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "map-context-menu",
		title: "Map context menu",
		body: (
			<>
				<p>Right-clicking the map opens a context menu with location-independent tools.</p>
				<ul>
					<li>
						<strong>Start measurement / End measurement.</strong> Begins a distance measurement
						anchored at the clicked point, or ends an in-progress measurement. See{" "}
						<ChapterLink id="measurement" />.
					</li>
					<li>
						<strong>Copy coordinates.</strong> Copies the clicked point as <code>lat, lng</code> to
						the clipboard.
					</li>
					<li>
						<strong>Set latitude/longitude anchors.</strong> Draws a crosshair of latitude and
						longitude reference lines through the clicked point, useful for aligning locations.
					</li>
					<li>
						<strong>Clear latitude/longitude anchors.</strong> Removes those reference lines.
					</li>
				</ul>
			</>
		),
	},
	// ===================================================================
	// PART III - LOCATIONS
	// ===================================================================
	{
		id: "adding-locations",
		title: "Adding locations",
		body: (
			<>
				<h2>Click the map</h2>
				<p>
					Click an empty spot and MMA does not blindly drop a pin. It looks up the nearest Street
					View coverage, snaps to it, and creates the location at the corrected coordinates with the
					matching panorama. The candidate it keeps follows your per-map rules (official vs
					unofficial, camera quality, direction). See <ChapterLink id="loading-flags" /> for what
					gets pinned.
				</p>
				<h2>Crosshair at center</h2>
				<p>
					Hold <Kbd>Enter</Kbd> to show a crosshair at the map center, then release to create a
					location there. It can be a bit janky, but is supported if you want to go mouseless.
				</p>
				<h2>Paste coordinates or a URL</h2>
				<ul>
					<li>
						<strong>Paste a Google Maps URL</strong> to drop a location at that point.
					</li>
					<li>
						<strong>Paste multiple lines of coordinates</strong> to import them all at once.
					</li>
				</ul>
				<Note>
					The <strong>Min search radius</strong> per-map setting controls how far the snap looks for
					coverage. In particularly dense areas, decreasing it can help find the exact pano you are
					clicking at.
				</Note>
			</>
		),
	},
	{
		id: "location-editor",
		title: "Location editor & pano viewer",
		body: (
			<>
				<p>
					Having a marker selected opens the location editor, which fills the sidebar with a live
					Street View panorama for that location.
				</p>
				<Img
					name="location-editor.png"
					caption="The location editor: live panorama, date picker, Save/Close/Delete, and the tag bar."
				/>
				<h2>Framing and saving</h2>
				<p>
					Pan and look around to frame the view you want, then press <strong>Save</strong> (or{" "}
					<Kbd>Enter</Kbd>). Save captures the current heading, pitch, zoom, panorama, and the
					location's coordinates, plus any tag changes.
				</p>
				<ul>
					<li>
						<strong>Save.</strong> Stores the framing and closes (or, in review mode, advances to
						the next location).
					</li>
					<li>
						<strong>Close.</strong> Closes without saving (<Kbd>Esc</Kbd>).
					</li>
					<li>
						<strong>Delete.</strong> Removes the location (<Kbd>Delete</Kbd>).
					</li>
				</ul>
				<h2>Panned vs unpanned</h2>
				<p>
					A location is <strong>unpanned</strong> until you have framed and saved a point of view;
					its heading is effectively zero. Saving a view makes it <strong>panned</strong>. The{" "}
					<strong>Unpanned</strong> selection finds everything still needing a view, which is useful
					by way of the "review" feature.
				</p>
				<h2>Country and address</h2>
				<p>
					The editor shows a flag and an address for the current pano, geocoded from its coordinates
					using your chosen geocoding provider.
				</p>
			</>
		),
	},
	{
		id: "pano-controls",
		title: "Pano controls & movement",
		body: (
			<>
				<p>
					Overlay controls sit on top of the panorama. Every control can be shown or hidden in{" "}
					<strong>Settings</strong>.
				</p>
				<Img
					name="pano-controls.png"
					caption="The panorama overlay: compass, zoom, return-to-spawn, jump, coordinates, and map links."
				/>
				<h2>Orientation and movement</h2>
				<ul>
					<li>
						<strong>Compass.</strong> A wind rose that rotates with your heading; click it to point
						north. An optional heading tape is also available. Point north with <Kbd>N</Kbd>, spin
						180 with <Kbd>T</Kbd>.
					</li>
					<li>
						<strong>Zoom.</strong> Zoom the panorama in and out (<Kbd>+</Kbd> / <Kbd>-</Kbd>).
					</li>
					<li>
						<strong>Return to spawn.</strong> Snaps the pano back to the location's saved
						coordinates and clears any per-location pano pin (<Kbd>R</Kbd>).
					</li>
					<li>
						<strong>Jump forward / backward.</strong> Hops roughly 100m along the road (
						<Kbd>{"}"}</Kbd> / <Kbd>{"{"}</Kbd>).
					</li>
					<li>
						<strong>Follow road.</strong> Walks along linked panos in the direction you face (
						<Kbd>G</Kbd>).
					</li>
				</ul>
				<h2>Reference and links</h2>
				<ul>
					<li>
						<strong>Coordinate / zoom display.</strong> Shows the current pano's coordinates and
						zoom.
					</li>
					<li>
						<strong>Map links.</strong> Open in Google Maps and copy a Street View link (
						<Kbd>Ctrl</Kbd>+<Kbd>C</Kbd>; long URL with <Kbd>Ctrl</Kbd>+<Kbd>Alt</Kbd>+<Kbd>C</Kbd>
						).
					</li>
				</ul>
				<h2>Display options</h2>
				<ul>
					<li>
						<strong>Fullscreen.</strong> Expands the panorama and shows a <strong>minimap</strong>{" "}
						and a <strong>tag bar</strong> (each toggleable) (<Kbd>F</Kbd>).
					</li>
					<li>
						<strong>Hide car.</strong> Masks the capture vehicle (<Kbd>Ctrl</Kbd>+<Kbd>H</Kbd>).
					</li>
					<li>
						<strong>Crosshair.</strong> A center crosshair for precise framing (<Kbd>X</Kbd>).
					</li>
					<li>
						<strong>Toggle pano UI.</strong> Hides the overlay controls for a clean view (
						<Kbd>H</Kbd>).
					</li>
					<li>
						<strong>Preview aspect ratio.</strong> The panorama pane can be shaped to a fixed aspect
						ratio (4:3, 16:10, 16:9, or 21:9) to match how the map will be played. Set it in{" "}
						<strong>Settings &rarr; Street View</strong>.
					</li>
				</ul>
				<h2>Movement modes and speed</h2>
				<ul>
					<li>
						<strong>Movement mode.</strong> The default is set in Settings: <strong>Moving</strong>{" "}
						(walk and look freely), <strong>No Move</strong> (look only, no walking), or{" "}
						<strong>NMPZ</strong> (no move, pan, or zoom).
					</li>
					<li>
						<strong>Look &amp; pan speed.</strong> Keyboard look speed and map pan speed are
						adjustable in <strong>Settings &rarr; Controls</strong>. Hold <Kbd>Alt</Kbd> for the
						slow modifier.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "coverage-dates",
		title: "Coverage dates & camera types",
		body: (
			<>
				<p>
					Many places have several Street View captures over time. The date picker in the location
					editor lists every available capture date for the current spot.
				</p>
				<h2>Picking a date</h2>
				<ul>
					<li>
						<strong>Date picker.</strong> Choose any available capture to load that specific
						coverage. Cycle through dates with <Kbd>[</Kbd> and <Kbd>]</Kbd>.
					</li>
					<li>
						<strong>Camera badges.</strong> Each date can show a badge for its camera generation.
						Toggle badges in <strong>Settings &rarr; Street View &rarr; Date Picker</strong>.
					</li>
				</ul>
				<p>
					For more information on camera generations, see{" "}
					<a
						href="https://www.plonkit.net/beginners-guide#:~:text=Camera%20Generation"
						target="_blank"
						rel="noopener noreferrer"
					>
						this guide
					</a>
					.
				</p>
				<h2>Pinning a date</h2>
				<p>
					Choosing a specific date pins that pano to the location (it sets{" "}
					<strong>Load as pano ID</strong>, see the next chapter). Use{" "}
					<strong>Return to spawn</strong> to clear the pin and fall back to the default coverage at
					the coordinates.
				</p>
			</>
		),
	},
	{
		id: "loading-flags",
		title: "Loading mode & flags",
		body: (
			<>
				<h2>Load by coordinates vs by pano ID</h2>
				<p>A location can resolve its panorama in one of two ways:</p>
				<ul>
					<li>
						<strong>By coordinates.</strong> The game finds whatever the default coverage is at that
						point. This is the lighter option and is correct when the default coverage is the one
						you want.
					</li>
					<li>
						<strong>By pano ID (Load as pano ID).</strong> The location is locked to a specific
						panorama. Required whenever you want a particular date, an unofficial pano, or any
						coverage that is not what the coordinates alone would resolve to.
					</li>
				</ul>
				<p>
					MMA sets <strong>Load as pano ID</strong> automatically when you pick a specific date, or
					when it detects that the chosen pano is not the default at those coordinates. The per-map{" "}
					<strong>Use Pano ID locations by default</strong> setting forces it on for newly created
					locations.
				</p>
				<Note>
					The <strong>Has Pano ID</strong> and <strong>No Pano ID</strong> selections let you find
					locations by how they load, which is handy for auditing a map before export.
				</Note>
			</>
		),
	},
	{
		id: "reviewing",
		title: "Reviewing, duplicating & deleting",
		body: (
			<>
				<h2>Review mode</h2>
				<p>
					Review mode walks you through a set of locations one at a time in the panorama viewer,
					tracking which ones you have already looked at. Start it from a selection's menu (
					<strong>Review selection</strong>), from the duplicate finder, or with{" "}
					<strong>Review selected locations</strong> in the overview's selection bar.
				</p>
				<ul>
					<li>
						<strong>Next / Previous.</strong> <Kbd>Ctrl</Kbd>+<Kbd>Right</Kbd> and <Kbd>Ctrl</Kbd>+
						<Kbd>Left</Kbd>. <strong>Save</strong> also advances to the next location and marks the
						current one reviewed.
					</li>
					<li>
						<strong>Delete.</strong> Removes the current location and moves on.
					</li>
					<li>
						<strong>Exit review.</strong> The X in the review header leaves review mode without
						discarding your progress. The header shows your position (<strong>3 / 50</strong>) and
						how many you have reviewed so far.
					</li>
				</ul>
				<p>
					Clicking another location's marker while a review is active jumps the cursor there if it
					is in the worklist; clicking off-list is a harmless peek that leaves your place untouched.
				</p>
				<h2>Resuming a review</h2>
				<p>
					Reviews are saved sessions, so you can stop partway and come back later. Re-running{" "}
					<strong>Review selection</strong> on the same selection resumes its in-progress session
					rather than starting over. The <strong>Reviews...</strong> button in the overview's
					selection bar opens the session list.
				</p>
				<Img
					name="review-sessions.png"
					caption="The review sessions dialog: in-progress and completed reviews with progress bars."
				/>
				<ul>
					<li>
						<strong>In progress / Completed.</strong> Two tabs split active sessions from finished
						ones.
					</li>
					<li>
						<strong>Resume.</strong> Re-enters an in-progress session at the location you left off.
					</li>
					<li>
						<strong>Select reviewed / Select unreviewed.</strong> The two circle buttons turn a
						session's reviewed (or not-yet-reviewed) locations into a selection you can act on,
						without re-entering review mode.
					</li>
					<li>
						<strong>Delete.</strong> Discards the session.
					</li>
				</ul>
				<p>
					While a review is active, two overlay selections mirror its progress on the map:{" "}
					<strong>reviewed</strong> and <strong>unreviewed</strong>, so you can see at a glance
					what is left.
				</p>
				<h2>Duplicating a location</h2>
				<p>
					Press <Kbd>C</Kbd> in the location editor to duplicate the current location, then reframe
					the copy. Useful for capturing the same spot from multiple angles.
				</p>
				<h2>Deleting</h2>
				<ul>
					<li>
						<strong>Single.</strong> The <strong>Delete</strong> button or <Kbd>Delete</Kbd> in the
						editor.
					</li>
					<li>
						<strong>In bulk.</strong> Select locations, then press <Kbd>Delete</Kbd> on the map, use{" "}
						<strong>Delete selected locations</strong> in the overview's selection bar, or run it
						from the command palette.
					</li>
				</ul>
				<h2>Viewport lock</h2>
				<p>
					Press <Kbd>V</Kbd> to lock the camera orientation relative to the road. Can be relevant
					for driving-direction specific camera artifacts.
				</p>
			</>
		),
	},
	// ===================================================================
	// PART IV - ORGANIZING
	// ===================================================================
	{
		id: "tags",
		title: "Tags",
		body: (
			<>
				<p>
					Tags are colored on/off labels you attach to locations. They are boolean: a location
					either carries a tag or it does not.
				</p>
				<h2>Creating and assigning</h2>
				<ol>
					<li>Create a tag from the Tags section; it gets a name and a color.</li>
					<li>
						Assign tags while editing a location, using the tag bar at the bottom of the editor
						(type to add, click suggestions, X to remove).
					</li>
					<li>
						<strong>Quicktags.</strong> While editing a location, number keys <Kbd>1</Kbd> through{" "}
						<Kbd>9</Kbd> toggle the first nine visible tags by position. These keys are rebindable.
					</li>
					<li>
						Click a tag pill in the Tags section to select every location carrying it; shift-click
						to extend a range.
					</li>
				</ol>
				<h2>Colors, order, and visibility</h2>
				<ul>
					<li>
						<strong>Color.</strong> Each tag has a color used for its markers, set with a color
						picker.
					</li>
					<li>
						<strong>Order &amp; sort.</strong> Drag tags to reorder, or sort by name or count.
					</li>
					<li>
						<strong>Visibility.</strong> Hide a tag to declutter the map. A tag automatically
						becomes hidden when no location carries it.
					</li>
				</ul>
				<h2>Tree grouping</h2>
				<p>
					With <strong>tree</strong> view enabled (
					<strong>Settings &rarr; Street View &rarr; Tags</strong>), tags whose names contain{" "}
					<code>/</code> are grouped hierarchically, e.g. <code>Europe/France</code> nests under{" "}
					<code>Europe</code>. Parents show partial-selection indicators and inherit color.
				</p>
				<h2>Tag tools</h2>
				<ul>
					<li>
						<strong>Apply metadata as tags.</strong> Pick a metadata field and MMA creates one tag
						per distinct value, assigning each location the tag for its value (command palette). For
						example, applying <strong>countryCode</strong> turns a map into per-country tags in one
						step. Date and month fields offer a grouping choice (year, year-month, exact day, month
						of year, time of day), with an optional location-timezone frame; number fields can be
						bucketed by a fixed width (e.g. altitude in 500m bands).
					</li>
					<li>
						<strong>Find and replace in tag names.</strong> Bulk-rename across tags (command
						palette).
					</li>
					<li>
						<strong>Download tag counts as CSV.</strong> Export per-tag counts (command palette).
					</li>
				</ul>
			</>
		),
	},
	{
		id: "selections",
		title: "Selections",
		body: (
			<>
				<p>
					A selection is a named subset of your locations, drawn on the map in its own color. The
					Selections section lists active selections with their match counts. Selections re-evaluate
					against the live map, so they stay correct as you edit.
				</p>
				<Img
					name="selections.png"
					caption="The Selections section: each rule drawn in its own color, with a per-selection menu."
				/>
				<h2>Selection types</h2>
				<ul>
					<li>
						<strong>Tag</strong> and <strong>Untagged.</strong> Locations carrying a given tag, or
						carrying none.
					</li>
					<li>
						<strong>Unpanned.</strong> Locations not yet framed and saved.
					</li>
					<li>
						<strong>Has Pano ID</strong> / <strong>No Pano ID.</strong> By how they load (pinned to
						a pano vs resolved by coordinates).
					</li>
					<li>
						<strong>Polygon.</strong> An area you draw as a polygon, rectangle, or freehand shape. 
						Polygon selections can be configured to include informational locations.
					</li>
					<li>
						<strong>Duplicates.</strong> Locations within a chosen distance of each other.
					</li>
					<li>
						<strong>Validation state.</strong> Locations classified by the validator (see{" "}
						<ChapterLink id="validation" />).
					</li>
					<li>
						<strong>Filter.</strong> A query over metadata fields (see <ChapterLink id="filters" />).
					</li>
					<li>
						<strong>Manual.</strong> Individual locations you toggle by <Kbd>Ctrl</Kbd>-clicking
						markers.
					</li>
					<li>
						<strong>Everything.</strong> All locations (<Kbd>Ctrl</Kbd>+<Kbd>A</Kbd>).
					</li>
				</ul>
				<h2>Acting on a selection</h2>
				<p>The menu on each selection row (the dots button) offers:</p>
				<ul>
					<li>
						<strong>Invert selection.</strong> Everything except this selection.
					</li>
					<li>
						<strong>Ghost selection.</strong> Dim it on the map without removing it (top-level
						selections).
					</li>
					<li>
						<strong>Edit filter.</strong> Re-open the filter form (Filter selections only).
					</li>
					<li>
						<strong>Review selection.</strong> Step through its locations in the panorama viewer.
					</li>
					<li>
						<strong>Save as tag.</strong> Snapshot just this selection into a new tag, without
						disturbing the rest of your selection setup.
					</li>
					<li>
						<strong>Change color.</strong> Recolor the selection (any non-Tag selection; Tag
						selections use the tag's color).
					</li>
					<li>
						<strong>Download GeoJSON</strong> and <strong>Rename.</strong> For polygon selections.
					</li>
					<li>
						<strong>Deselect.</strong> Remove the selection.
					</li>
				</ul>
				<p>
					<strong>Delete selected locations</strong> also lives in the command palette. To tag the
					whole selection at once, use <strong>Bulk add tags</strong>.
				</p>
				<h2>Picking a random subset</h2>
				<p>
					<strong>Pick random locations from selection</strong> (command palette) takes a count and
					replaces the current selection with that many locations chosen at random from it. If you
					ask for more than the selection holds, it is clamped to the whole selection. Handy for
					sampling a large map down to a manageable set to review or export.
				</p>
			</>
		),
	},
	{
		id: "selection-algebra",
		title: "Selection algebra",
		body: (
			<>
				<p>
					Selections are composable. You can combine and negate them to express complex queries
					without writing any code.
				</p>
				<Img
					name="selection-algebra.png"
					caption="Combining selections: intersection (AND), union (OR), and invert (NOT)."
				/>
				<h2>Operations</h2>
				<ul>
					<li>
						<strong>Intersection (AND).</strong> Locations matching both. Command:{" "}
						<strong>Intersect (AND) selections</strong>.
					</li>
					<li>
						<strong>Union (OR).</strong> Locations matching either. Command:{" "}
						<strong>Union (OR) selections</strong>.
					</li>
					<li>
						<strong>Invert (NOT).</strong> Everything except a selection. Command:{" "}
						<strong>Invert selection</strong>, or per-row from the selection menu.
					</li>
				</ul>
				<h2>Drag to combine</h2>
				<p>
					Drag one selection row onto another to combine them directly in the sidebar, building
					nested expressions whose children are shown indented under the result.
				</p>
				<h2>Example</h2>
				<p>
					To find locations tagged <code>France</code> <em>and</em> inside a polygon you drew, but{" "}
					<em>not</em> already panned: add the Tag, Polygon, and Unpanned selections, intersect Tag
					with Polygon, then intersect that with the inverted Unpanned.
				</p>
			</>
		),
	},
	{
		id: "filters",
		title: "Filters",
		body: (
			<>
				<p>
					A <strong>Filter</strong> selection queries a field on each location and selects the
					matches. Build one in the Tools section (filter builder) or edit one from a selection's
					menu.
				</p>
				<h2>Fields you can query</h2>
				<ul>
					<li>
						<strong>Built-in fields.</strong> <strong>Created</strong> and <strong>Modified</strong>{" "}
						timestamps.
					</li>
					<li>
						<strong>Metadata fields.</strong> Any field present on the map, such as{" "}
						<strong>countryCode</strong>, <strong>cameraType</strong>, <strong>panoType</strong>,{" "}
						<strong>altitude</strong>, <strong>imageDate</strong>, exact date, timezone, and any
						custom fields you have added.
					</li>
				</ul>
				<h2>Operators</h2>
				<ul>
					<li>
						<strong>= / !=</strong> equals and not equals.
					</li>
					<li>
						<strong>&gt; / &lt; / &gt;= / &lt;=</strong> numeric and date comparisons.
					</li>
					<li>
						<strong>between</strong> a range, with <strong>between (any year)</strong> and{" "}
						<strong>between (any date)</strong> variants for date and month fields, so you can
						match, for example, "any year, June to August".
					</li>
					<li>
						<strong>has / does not have</strong> presence of a value.
					</li>
				</ul>
				<p>
					Enum fields (such as camera type) offer only the equality operators and a value list. Date
					and month fields use a date picker, including any-year mode for season-style filters.
				</p>
				<Note>
					Filters operate on stored metadata. Run enrichment first so the fields you want to filter
					on exist. See <ChapterLink id="enrichment" />.
				</Note>
			</>
		),
	},
	{
		id: "saved-selections",
		title: "Saved selections",
		body: (
			<>
				<p>
					Selection rules can be saved and reused across maps via the command palette. They are
					stored with your app settings, not tied to a single map.
				</p>
				<ul>
					<li>
						<strong>Save current selections...</strong> Names the active selection set and stores
						it.
					</li>
					<li>
						<strong>Apply saved selection...</strong> Re-applies a stored set to the current map.
					</li>
				</ul>
				<h2>Portability</h2>
				<p>
					Because saved selections move between maps, tag rules are stored by tag <em>name</em>{" "}
					(matched case-insensitively on apply). Selection types that cannot be made portable are
					excluded from saving: <strong>Manual</strong>, explicit ID lists, and{" "}
					<strong>Validation state</strong>. Polygons, filters, untagged/unpanned/pano-id rules,
					duplicates, and composites all carry over.
				</p>
			</>
		),
	},
	{
		id: "bulk-operations",
		title: "Bulk operations",
		body: (
			<>
				<p>
					Bulk operations apply an action to many locations at once. Open them from the command
					palette (<strong>Bulk Operations</strong> group) or the relevant tool. Each opens a runner
					where you choose a <strong>scope</strong> and watch progress.
				</p>
				<h2>Scope</h2>
				<p>
					Every bulk operation runs against either <strong>All locations</strong> or the{" "}
					<strong>Current selection</strong>. If you have an active selection, scope defaults to it.
				</p>
				<h2>The operations</h2>
				<ul>
					<li>
						<strong>Validate locations.</strong> Checks coverage and classifies problems. See{" "}
						<ChapterLink id="validation" />.
					</li>
					<li>
						<strong>Enrich metadata fields.</strong> Fetches metadata for the chosen fields. See{" "}
						<ChapterLink id="enrichment" />.
					</li>
					<li>
						<strong>Set metadata field value.</strong> Writes a chosen value into a field across the
						scope. Besides custom metadata fields, the picker also offers the built-in camera fields{" "}
						<strong>Heading</strong>, <strong>Pitch</strong>, and <strong>Zoom</strong>, so you can
						set a fixed point of view across many locations at once.
					</li>
					<li>
						<strong>Pan headings along road.</strong> Sets each location's heading to face along the
						road, choosing <strong>forwards</strong> or <strong>backwards</strong>.
					</li>
					<li>
						<strong>Clear metadata fields.</strong> Removes chosen fields from the scope.
					</li>
					<li>
						<strong>Pin locations to pano ID.</strong> Resolves and pins a specific panorama to each
						location (sets <strong>Load as pano ID</strong>).
					</li>
				</ul>
			</>
		),
	},
	{
		id: "managing-fields",
		title: "Managing metadata fields",
		body: (
			<>
				<p>
					Open <strong>Manage metadata fields</strong> from the map settings dropdown. It lists
					every metadata field known to the map and lets you edit its definition.
				</p>
				<h2>What you can edit</h2>
				<ul>
					<li>
						<strong>Field key.</strong> Rename a field. Renaming to an existing field's key{" "}
						<strong>merges</strong> them; on conflict you choose which field's values win. Both
						rename and merge report how many locations are affected and cannot be undone.
					</li>
					<li>
						<strong>Label.</strong> The display name shown in pickers and filters.
					</li>
					<li>
						<strong>Type.</strong> <strong>Text</strong>, <strong>Number</strong>,{" "}
						<strong>Date/time</strong>, <strong>Month (YYYY-MM)</strong>, or <strong>Enum</strong>.
					</li>
					<li>
						<strong>Compare as.</strong> How the field is compared during disambiguation:{" "}
						<strong>Auto</strong>, <strong>Numeric</strong>, <strong>Circular</strong> (with a wrap
						period such as 360 for degrees or 24 for hours), or <strong>Categorical</strong>.
					</li>
					<li>
						<strong>Delete.</strong> Removes the field and clears its values from every location.
						This cannot be undone.
					</li>
				</ul>
				<p>
					Fields with no data are marked <strong>(no data)</strong>. Press <strong>Save</strong> to
					commit definition changes.
				</p>
			</>
		),
	},
	// ===================================================================
	// PART V - SAVING & HISTORY
	// ===================================================================
	{
		id: "autosave",
		title: "Autosave & editor-state restore",
		body: (
			<>
				<p>
					Your working changes are persisted to disk automatically, shortly after you stop editing.
					Nothing you do is lost if you close the app.
				</p>
				<ul>
					<li>
						<strong>Autosave.</strong> Writes your uncommitted changes in the background. This is
						not a commit, it is a safety net.
					</li>
					<li>
						<strong>Editor-state restore.</strong> Reopen a map and your uncommitted changes are
						still there, exactly as you left them.
					</li>
				</ul>
				<Note>
					Autosave keeps your edits safe, but it does not create a version. Use{" "}
					<strong>Commit</strong> to mark milestones you can return to. See the next chapter.
				</Note>
			</>
		),
	},
	{
		id: "commits",
		title: "Commits & diffs",
		body: (
			<>
				<p>
					A <strong>Commit</strong> bakes the current working changes into a permanent version. It
					is the durable checkpoint, distinct from the always-on autosave.
				</p>
				<ul>
					<li>
						<strong>The Commit button.</strong> In the bottom bar. Disabled when there is nothing to
						commit (<Kbd>Ctrl</Kbd>+<Kbd>S</Kbd>).
					</li>
					<li>
						<strong>The pending diff.</strong> Beside the button: <strong>+added</strong>,{" "}
						<strong>-removed</strong>, and <strong>&plusmn;modified</strong> counts since the last
						commit.
					</li>
				</ul>
				<Note>
					Undo/redo operates on individual edits within your session. Commits are the browsable,
					durable checkpoints. Use undo for "oops", use commits for milestones.
				</Note>
			</>
		),
	},
	{
		id: "version-history",
		title: "Version history & reverting",
		body: (
			<>
				<p>
					The <strong>History</strong> button opens the commit list for the map. Commits form a
					chain, each recording the change from the previous one.
				</p>
				<h2>The commit table</h2>
				<ul>
					<li>
						<strong>Columns.</strong> Date, a short hash, the change diff (+added / -removed /
						&plusmn;modified) or message, and the resulting location count.
					</li>
					<li>
						<strong>Expand a row.</strong> Click it to see the added, removed, and modified
						locations in that commit (with their IDs and coordinates).
					</li>
					<li>
						<strong>Restore.</strong> The restore button (with a confirm step) returns the map to
						that commit's state.
					</li>
				</ul>
				<p>
					If the map has no commits yet, the dialog prompts you to press Commit to create the first.
				</p>
			</>
		),
	},
	// ===================================================================
	// PART VI - STREET VIEW DATA
	// ===================================================================
	{
		id: "enrichment",
		title: "Metadata enrichment",
		body: (
			<>
				<p>
					Enrichment fetches extra information about each location's panorama and stores it on the
					location. This metadata is extremely powerful, as it can store{" "}
					<strong>non-boolean data</strong>, unlike tags.
				</p>
				<h2>Available fields (by default)</h2>
				<ul>
					<li>
						<strong>Altitude.</strong> Elevation of the pano.
					</li>
					<li>
						<strong>Country code.</strong> ISO country of the coverage.
					</li>
					<li>
						<strong>Camera type.</strong> The generation/quality: gen1, gen2, gen4, tripod, or
						badcam.
					</li>
					<li>
						<strong>Pano type.</strong> Official, unknown, or user-uploaded.
					</li>
					<li>
						<strong>Image date.</strong> The year-month of capture.
					</li>
				</ul>
				<h2>Running enrichment</h2>
				<ul>
					<li>
						<strong>In bulk.</strong> Run <strong>Enrich metadata fields</strong> from the command
						palette, choosing a scope. The runner skips locations that are already enriched unless
						you force a refresh.
					</li>
					<li>
						<strong>Automatically on view.</strong> Enable{" "}
						<strong>Enrich locations with metadata</strong> in the map settings dropdown to enrich
						each location as you open it in the viewer. The gear beside it picks which fields to
						fetch.
					</li>
				</ul>
				<p>Enrichment fields can be added from other plugins or settings within the application.</p>
			</>
		),
	},
	{
		id: "exact-dates",
		title: "Exact dates & timezones",
		body: (
			<>
				<p>
					Beyond the coarse year-month image date, MMA can resolve the{" "}
					<strong>exact capture timestamp</strong> of a panorama. This is an optional enrichment
					field because it is significantly slower (it makes many requests per location), so it is
					off by default.
				</p>
				<h2>Enabling it</h2>
				<p>
					Turn on the exact-date field in the enrichment field picker (the gear next to{" "}
					<strong>Enrich locations with metadata</strong>), then enrich. When viewing a location
					with auto-enrich on, the exact date resolves in the background.
				</p>
				<h2>Display format and timezone</h2>
				<p>
					In <strong>Settings &rarr; Street View &rarr; Date Picker</strong>:
				</p>
				<ul>
					<li>
						<strong>Exact date format.</strong> <strong>Date only</strong> or{" "}
						<strong>Date + time</strong>.
					</li>
					<li>
						<strong>Exact date timezone.</strong> <strong>Location timezone</strong> (the pano's
						local time) or <strong>UTC</strong>.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "validation",
		title: "Validation",
		body: (
			<>
				<p>
					Validation checks whether each location still has valid Street View coverage and
					classifies any problems. Run it via <strong>Validate locations</strong> in the command
					palette (a bulk operation with a scope).
				</p>
				<h2>Problem categories</h2>
				<ul>
					<li>
						<strong>Valid location.</strong> No issues.
					</li>
					<li>
						<strong>Newer coverage available.</strong> The pinned pano has a more recent version in
						the timeline.
					</li>
					<li>
						<strong>Coverage updated since last view.</strong> A coordinate-based location now
						resolves to a different, newer pano.
					</li>
					<li>
						<strong>Not found.</strong> No coverage at the coordinates or pano ID.
					</li>
					<li>
						<strong>Pano ID broke.</strong> The pinned pano ID no longer resolves.
					</li>
					<li>
						<strong>Unofficial.</strong> Resolves to user-uploaded coverage.
					</li>
					<li>
						<strong>Badcam, but good coverage available.</strong> The current coverage is a
						low-quality camera, but a better one exists in the timeline.
					</li>
				</ul>
				<p>
					Results become a <strong>Validation state</strong> selection you can act on, for example
					review every "Pano ID broke" location and re-pin it.
				</p>
			</>
		),
	},
	{
		id: "seen",
		title: "Seen history",
		body: (
			<>
				<p>
					When enabled, MMA records every panorama you actually look at, across all maps, into a
					"seen" history. It is useful for going back to locations you have previously viewed.
				</p>
				<h2>Recording</h2>
				<p>
					Recording is controlled in <strong>Settings &rarr; Advanced &rarr; Seen</strong>. Turn{" "}
					<strong>Log viewed panos</strong> on or off, optionally <strong>Save thumbnails</strong>,
					and choose the <strong>thumbnail resolution</strong> (Low 160x90, Medium 320x180, High
					640x360) to trade storage for clarity.
				</p>
				<h2>Browsing</h2>
				<p>
					The <strong>Seen</strong> button in the bottom bar opens the history with thumbnails, a
					flag, and the address or coordinates of each visit. Filter by:
				</p>
				<ul>
					<li>
						<strong>Country.</strong> A dropdown of countries seen.
					</li>
					<li>
						<strong>Map.</strong> A dropdown of maps.
					</li>
					<li>
						<strong>Address search.</strong> A text box that matches the stored address.
					</li>
				</ul>
				<p>
					The history is paginated and capped at the most recent 10,000 entries, pruning the oldest
					as new ones arrive.
				</p>
			</>
		),
	},
	// ===================================================================
	// PART VII - SCORING
	// ===================================================================
	{
		id: "scoring",
		title: "Scoring & score bounds",
		body: (
			<>
				<p>
					GeoGuessr scores a guess from the distance to the true location and the size of the
					playable area. A map's <strong>score bounds</strong> define that area, which sets how
					harshly distance is penalized. Edit them in the <strong>Scoring</strong> section of the
					map settings dropdown.
				</p>
				<Img
					name="score-bounds.png"
					caption="The Scoring section: automatic, world, or fixed bounds, with the resolved error distance."
				/>
				<h2>The three modes</h2>
				<ul>
					<li>
						<strong>Automatic based on locations.</strong> Derived from the bounding box of your
						locations and updated as you add or remove them.
					</li>
					<li>
						<strong>World map (ACW).</strong> The whole-world curve, like a worldwide map.
					</li>
					<li>
						<strong>Fixed bounds.</strong> An explicit box you enter as south, west, north, and east
						coordinates.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "measurement",
		title: "Measurement tool & 5K radius",
		body: (
			<>
				<h2>Measuring distance</h2>
				<p>
					Right-click the map and choose <strong>Start measurement</strong> to draw a line and read
					its length. MMA also converts that distance into the GeoGuessr score it would earn under
					the current score bounds, so you can sanity-check difficulty. Choose{" "}
					<strong>End measurement</strong> from the menu to finish.
				</p>
				<h2>The 5K radius (perfect-score circle)</h2>
				<p>
					A guess within <strong>25 meters</strong> of the target earns the perfect{" "}
					<strong>5000</strong>. Enable <strong>Display 5K radius</strong> in the map settings
					dropdown to draw this perfect-score circle around locations.
				</p>
			</>
		),
	},
	// ===================================================================
	// PART VIII - SETTINGS & CUSTOMIZATION
	// ===================================================================
	{
		id: "settings-overview",
		title: "App settings vs per-map settings",
		body: (
			<>
				<p>MMA has two distinct layers of settings. Knowing which is which avoids confusion.</p>
				<Img
					name="settings.png"
					caption="App settings, organized into Controls, Street View, and Advanced tabs."
				/>
				<h2>App settings (global)</h2>
				<p>
					Opened from the gear icon (bottom-right). These apply everywhere and are stored on your
					machine. They are organized into three tabs: <strong>Controls</strong>,{" "}
					<strong>Street View</strong>, and <strong>Advanced</strong>. Covered in the next chapters.
				</p>
				<h2>Per-map settings</h2>
				<p>
					Opened from the <strong>Map settings</strong> dropdown above the map. These belong to the
					current map only:
				</p>
				<ul>
					<li>
						<strong>Selecting new locations.</strong> Point view along the road and a{" "}
						<strong>Direction</strong> preference (forwards, backwards, most
						northern/eastern/southern/ western, or random); prefer official over unofficial; prefer
						higher quality over newer images; disallow unofficial; use Pano ID locations by default;
						and a <strong>Min search radius</strong> slider.
					</li>
					<li>
						<strong>Map behaviour.</strong> Show location previews on hover; enrich locations with
						metadata (and pick fields).
					</li>
					<li>
						<strong>Scoring.</strong> The score bounds editor.
					</li>
					<li>
						<strong>Generation.</strong> A tag automatically applied to generated locations.
					</li>
					<li>
						<strong>Display.</strong> Marker style (Pin, Circle, Camera direction arrow) and{" "}
						<strong>Display 5K radius</strong>.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "controls-hotkeys",
		title: "Controls & hotkeys",
		body: (
			<>
				<p>
					The <strong>Controls</strong> tab holds keyboard rebinding and movement speeds.
				</p>
				<h2>Rebinding keys</h2>
				<ul>
					<li>
						<strong>Click to rebind.</strong> Click a shortcut's current binding, then press the new
						key combination. Press <Kbd>Backspace</Kbd> or <Kbd>Delete</Kbd> while recording to
						clear it, or <Kbd>Esc</Kbd> to cancel.
					</li>
					<li>
						<strong>Filter.</strong> A search box narrows the (long) shortcut list.
					</li>
					<li>
						<strong>Reset.</strong> Each customized binding shows a <strong>Reset</strong> button;
						there is also <strong>Reset all to defaults</strong>.
					</li>
				</ul>
				<h2>Conflict resolution</h2>
				<p>
					If you assign a combination already in use, MMA shows what it is bound to and offers to{" "}
					<strong>Reassign</strong> (which clears it from the other action). Conflicting rows are
					flagged with a warning you can click to jump to the other action. Some combinations are
					blocked: for example, a combination using <Kbd>Alt</Kbd> cannot shadow a navigation
					action, because <Kbd>Alt</Kbd> is the slow modifier.
				</p>
				<h2>Movement speeds</h2>
				<ul>
					<li>
						<strong>Pan speed.</strong> How fast the map pans with the keyboard.
					</li>
					<li>
						<strong>Pano look speed.</strong> How fast the panorama camera turns with the keyboard.
					</li>
					<li>
						<strong>Alt slow-down.</strong> The divisor applied while you hold <Kbd>Alt</Kbd> for
						fine control.
					</li>
					<li>
						<strong>Pan to imported locations.</strong> Whether the map jumps to newly imported
						locations.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "database",
		title: "Database management",
		body: (
			<>
				<p>
					<strong>Settings &rarr; Advanced &rarr; Database</strong> exposes two power-user tools.
				</p>
				<ul>
					<li>
						<strong>Open data folder.</strong> Opens your application data folder in the OS file
						browser.
					</li>
					<li>
						<strong>Database management.</strong> A direct view of the underlying tables for cleanup.
					</li>
				</ul>
				<Note>
					Database management edits your data directly and can break a map. Back up first (Export
					all maps as ZIP) and only use it if you know what you are doing.
				</Note>
				<p>
					A separate <strong>Stats for nerds</strong> overlay (toggle with <Kbd>Ctrl</Kbd>+
					<Kbd>Shift</Kbd>+<Kbd>D</Kbd>) shows version, counts, storage size, and runtime
					diagnostics. Useful for debugging.
				</p>
			</>
		),
	},
	// ===================================================================
	// PART IX - EXTENDING
	// ===================================================================
	{
		id: "plugin-system",
		title: "Plugins",
		body: (
			<>
				<p>
					Plugins extend MMA with new tools and panels. A plugin can add a <strong>sidebar</strong>{" "}
					panel, a full-screen <strong>modal</strong>, or a <strong>location panel</strong> embedded
					in the location editor, and it has full access to the app's data and Street View tools.
				</p>
				<Img
					name="plugin-marketplace.png"
					caption="The plugin marketplace: Core (built-in) and Additional (downloadable) tabs."
				/>
				<h2>The marketplace</h2>
				<p>Open it from the puzzle-piece icon in the bottom-right corner. It has two tabs:</p>
				<ul>
					<li>
						<strong>Core.</strong> The plugins built into MMA. Each card has an{" "}
						<strong>Enable</strong>/<strong>Disable</strong> button.
					</li>
					<li>
						<strong>Additional.</strong> Downloadable plugins from the online registry, with{" "}
						<strong>Install</strong>, <strong>Enable</strong>/<strong>Disable</strong>, and an
						uninstall (trash) button.
					</li>
				</ul>
				<p>
					Enabled plugins activate automatically whenever a map is open, and the enabled set is
					remembered between sessions.
				</p>
			</>
		),
	},
	{
		id: "builtin-plugins",
		title: "Built-in plugins",
		body: (
			<>
				<p>The Core tab includes:</p>
				<ul>
					<li>
						<strong>Map generator.</strong> Generates Street View locations from coverage inside
						regions you draw, with extensive quality filters (camera generation, date ranges,
						official vs unofficial, minimum spacing, and more). It can follow linked panoramas to
						spread coverage.
					</li>
					<li>
						<strong>Vali.</strong> Generates locations from pre-built coverage data using the
						external Vali tool, streaming progress as it runs.
					</li>
					<li>
						<strong>Distribution.</strong> A live bar chart of how your locations are spread across
						countries, with flags and counts. It resolves countries offline from coordinates, so it
						works with zero enrichment; a <strong>Coordinates</strong> / <strong>Metadata</strong>{" "}
						toggle switches between coordinate-based counts and your enriched <code>countryCode</code>{" "}
						field when one is present.
					</li>
					<li>
						<strong>Disambiguate.</strong> Ranks metadata fields by how strongly they separate your
						active selections, helping you find what distinguishes one group from another.
					</li>
					<li>
						<strong>Gradient.</strong> Colors locations by a field value using gradient buckets.
					</li>
					<li>
						<strong>Pivot Table.</strong> Cross-tabulates selections against location metadata.
					</li>
					<li>
						<strong>JSON editor.</strong> Shows the active location as editable raw JSON inside the
						location editor, with tag names resolved for readability.
					</li>
				</ul>
				<p>
					A couple of cards are marked <strong>coming soon</strong> and cannot yet be enabled.
				</p>
				<Img
					name="generator.png"
					caption="The Map generator: draw regions, set coverage filters, and generate."
				/>
				<Img
					name="distribution.png"
					caption="The Distribution plugin: locations per country as a bar chart."
				/>
			</>
		),
	},
	{
		id: "installing-plugins",
		title: "Installing user plugins",
		body: (
			<>
				<h2>From the marketplace</h2>
				<p>
					On the <strong>Additional</strong> tab, press <strong>Install</strong> on a registry
					plugin. It downloads into your plugins folder, enables itself, and activates on the open
					map. Use the trash button to uninstall.
				</p>
				<h2>Manually</h2>
				<p>
					Plugins live in a <code>plugins/</code> subfolder of your application data folder, one
					folder per plugin. To install one by hand:
				</p>
				<ol>
					<li>Copy the plugin's folder into your plugins directory.</li>
					<li>Reopen a map in MMA.</li>
					<li>Enable it in the marketplace.</li>
				</ol>
				<p>
					Each plugin folder contains a <code>manifest.json</code> (its identity: id, name,
					description, icon, version, entry file) and the entry JavaScript file.
				</p>
			</>
		),
	},
	// ===================================================================
	// PART X - IMPORT / EXPORT
	// ===================================================================
	{
		id: "importing-into-map",
		title: "Importing into a map",
		body: (
			<>
				<p>
					The <strong>Import file</strong> button in the bottom bar brings locations into the
					current map. You can also <strong>drag a JSON or CSV file</strong> straight onto the
					editor window; a "Drop file to import" overlay appears while you hover. Either way an
					import panel opens in the sidebar showing a preview before anything is committed.
				</p>
				<h2>The import panel</h2>
				<ul>
					<li>
						<strong>Location count.</strong> How many locations the file contains.
					</li>
					<li>
						<strong>Tags in file.</strong> The tags detected in the file.
					</li>
					<li>
						<strong>Fields.</strong> Every metadata field found, each with its value count and a
						checkbox. Untick a field to drop it on import; your choices are remembered.
					</li>
					<li>
						<strong>Tag all imported locations.</strong> Apply one tag to everything you import.
					</li>
					<li>
						<strong>Warnings.</strong> Any problems detected during parsing.
					</li>
				</ul>
				<h2>Formats and field names</h2>
				<p>
					MMA auto-detects <strong>JSON</strong> vs <strong>CSV</strong> and tolerates common
					field-name variants (for example latitude/lat, longitude/lng/lon, pano/panoId), so files
					from various tools usually import without manual mapping. Press <strong>Import</strong> to
					commit, or <strong>Discard</strong> to cancel.
				</p>
			</>
		),
	},
	{
		id: "exporting-map",
		title: "Exporting a map",
		body: (
			<>
				<p>
					The <strong>Export</strong> button writes locations out. You choose the scope, a format,
					and options.
				</p>
				<h2>Scope</h2>
				<ul>
					<li>
						<strong>Export everything.</strong> The whole map.
					</li>
					<li>
						<strong>Export selection.</strong> Only the current selection (disabled when nothing is
						selected).
					</li>
				</ul>
				<h2>Options</h2>
				<ul>
					<li>
						<strong>File name.</strong> The output file name.
					</li>
					<li>
						<strong>Save zoom levels.</strong> Include each location's zoom.
					</li>
					<li>
						<strong>Save MMA data.</strong> Include MMA-specific data such as tags. Turning it off
						makes the file smaller, which helps when uploading very large maps to GeoGuessr.
					</li>
					<li>
						<strong>Bypass GeoGuessr auto-panning for locations with 0 heading.</strong> Keeps your
						deliberately unpanned locations unpanned in the game.
					</li>
				</ul>
				<h2>Formats</h2>
				<ul>
					<li>
						<strong>JSON (recommended).</strong> Copy to clipboard or download.
					</li>
					<li>
						<strong>CSV.</strong> Copy or download. CSV does not retain camera orientation or pano
						IDs.
					</li>
					<li>
						<strong>GeoJSON.</strong> Download, for use in non-GeoGuessr mapping tools.
					</li>
				</ul>
				<p>
					Download opens a native <strong>Save as</strong> dialog so you choose exactly where the
					file lands, and a notification confirms when the export is written.
				</p>
			</>
		),
	},
	{
		id: "bulk-backup",
		title: "Bulk backup & restore",
		body: (
			<>
				<p>
					From the home screen, two icons in the bottom-right corner handle whole-library transfer.
				</p>
				<ul>
					<li>
						<strong>Export.</strong> Writes a single ZIP of every map (named with today's date).
						This is the recommended backup.
					</li>
					<li>
						<strong>Import.</strong> Restores from such a ZIP, or imports a single JSON, with the
						same preview and duplicate-detection flow described in{" "}
						<ChapterLink id="importing-existing" />.
					</li>
				</ul>
				<Note>
					Make a backup before risky operations (database management, bulk deletes, large imports).
					Restoring is just a re-import of the ZIP.
				</Note>
			</>
		),
	},
];

// --- Full-text search ---

// Flatten a chapter's JSX body into plain text so it can be searched, keeping the
// chapter content as the single source of truth (no separate hand-maintained index).
function extractText(node: ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join(" ");
	if (isValidElement(node)) {
		const props = node.props as { id?: string; caption?: string; children?: ReactNode };
		// These two render their text from props, not children.
		if (node.type === ChapterLink) return CHAPTERS.find((c) => c.id === props.id)?.title ?? props.id ?? "";
		if (node.type === Img) return props.caption ?? "";
		return extractText(props.children);
	}
	return "";
}

interface ChapterText {
	id: string;
	title: string;
	text: string;
}

let searchIndex: ChapterText[] | null = null;

function getSearchIndex(): ChapterText[] {
	if (!searchIndex) {
		searchIndex = CHAPTERS.map((c) => ({
			id: c.id,
			title: c.title,
			text: extractText(c.body).replace(/\s+/g, " ").trim(),
		}));
	}
	return searchIndex;
}

export interface ManualHit {
	id: string;
	title: string;
	snippet: string;
}

// A short excerpt of `text` centered on the earliest matched term.
function makeSnippet(text: string, lowerText: string, terms: string[]): string {
	let pos = -1;
	for (const t of terms) {
		const i = lowerText.indexOf(t);
		if (i !== -1 && (pos === -1 || i < pos)) pos = i;
	}
	if (pos === -1) return text.slice(0, 120).trim() + (text.length > 120 ? "…" : "");
	const start = Math.max(0, pos - 50);
	const end = Math.min(text.length, pos + 90);
	let s = text.slice(start, end).trim();
	if (start > 0) s = "…" + s;
	if (end < text.length) s = s + "…";
	return s;
}

// Search every chapter's title and body. All whitespace-separated terms must be
// present. Title matches rank above body-only matches. Returns up to `limit` hits.
// Co-located with the chapter content it indexes (single source of truth); the
// non-component export is intentional, hence the Fast Refresh opt-out.
// eslint-disable-next-line react-refresh/only-export-components
export function searchManual(query: string, limit = 8): ManualHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const terms = q.split(/\s+/);
	const scored: { hit: ManualHit; score: number }[] = [];
	for (const ch of getSearchIndex()) {
		const titleLc = ch.title.toLowerCase();
		const textLc = ch.text.toLowerCase();
		const haystack = titleLc + " " + textLc;
		if (!terms.every((t) => haystack.includes(t))) continue;
		const titleHit = titleLc.includes(q);
		const score = (titleHit ? 0 : 100) + (textLc.includes(q) ? 0 : 10);
		scored.push({ hit: { id: ch.id, title: ch.title, snippet: makeSnippet(ch.text, textLc, terms) }, score });
	}
	scored.sort((a, b) => a.score - b.score);
	return scored.slice(0, limit).map((s) => s.hit);
}

// --- Manual view ---

export function Manual({
	chapterId,
	onNavigate,
	onClose,
}: {
	chapterId: string;
	onNavigate: (id: string) => void;
	onClose: () => void;
}) {
	const found = CHAPTERS.findIndex((c) => c.id === chapterId);
	const index = found >= 0 ? found : 0;
	const contentRef = useRef<HTMLDivElement>(null);
	const chapter = CHAPTERS[index];

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		contentRef.current?.scrollTo(0, 0);
	}, [chapterId]);

	const go = (i: number) => {
		if (i >= 0 && i < CHAPTERS.length) onNavigate(CHAPTERS[i].id);
	};

	return (
		<ManualNav.Provider value={onNavigate}>
		<div className="manual">
			<aside className="manual__sidebar">
				<div className="manual__sidebar-head">
					<span className="manual__title">Manual</span>
					<button className="icon-button" onClick={onClose} aria-label="Close manual">
						<Icon path={mdiClose} />
					</button>
				</div>
				<nav className="manual__toc">
					<ol>
						{CHAPTERS.map((c, i) => (
							<li key={c.id}>
								<button
									className={i === index ? "manual__toc-link is-active" : "manual__toc-link"}
									onClick={() => go(i)}
								>
									{c.title}
								</button>
							</li>
						))}
					</ol>
				</nav>
			</aside>
			<main className="manual__main" ref={contentRef}>
				<article className="manual__content">
					<h1>{chapter.title}</h1>
					{chapter.body}
				</article>
				<nav className="manual__nav">
					{index > 0 && (
						<button className="manual__nav-btn" onClick={() => go(index - 1)}>
							<Icon path={mdiChevronLeft} size={18} />
							{CHAPTERS[index - 1].title}
						</button>
					)}
					{index < CHAPTERS.length - 1 && (
						<button
							className="manual__nav-btn manual__nav-btn--next"
							onClick={() => go(index + 1)}
						>
							{CHAPTERS[index + 1].title}
							<Icon path={mdiChevronRight} size={18} />
						</button>
					)}
				</nav>
			</main>
		</div>
		</ManualNav.Provider>
	);
}
