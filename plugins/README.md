# MMA Plugins

Plugins extend MMA with custom functionality: new tools, integrations with external scripts, custom UI panels, and more.

## Plugin directory

User plugins live in your app data folder:

```
Windows:  %APPDATA%/app.map-making.local/plugins/<plugin-id>/
Linux:    ~/.local/share/app.map-making.local/plugins/<plugin-id>/
macOS:    ~/Library/Application Support/app.map-making.local/plugins/<plugin-id>/
```

## Creating a plugin

Grab the plugin scaffold directly into your plugins directory:

```bash
mkdir %APPDATA%/app.map-making.local/plugins
cd %APPDATA%/app.map-making.local/plugins
npx degit ccmdi/mma/plugins
cd sample
npm install
npm run build
```

Reopen a map in MMA and enable it in the marketplace. Edit `src/index.ts` and rebuild to iterate.

### Dev mode

For a faster edit-reload loop, use the dev script instead of manual builds + copies:

```bash
node plugins/dev.mjs plugins/my-plugin              # JS watch + auto-sync to appdata
node plugins/dev.mjs plugins/my-plugin --sidecar     # also watches the sidecar binary
```

This watches your source, rebuilds on change, and copies `index.js`, `manifest.json`, and (with `--sidecar`) the debug binary into the appdata plugin folder. Reopen a map to pick up changes.

For sidecar plugins, run `cargo build` in `plugins/<id>/sidecar/` in a separate terminal - the dev script polls for binary changes and copies them over.

Each plugin is a folder containing at minimum:
- `manifest.json` — plugin identity
- `index.js` (or whatever `main` points to) — plugin behavior

## manifest.json

The manifest is the plugin's identity:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "What it does",
  "icon": "M20.5,11H19V7...",
  "version": "1.0.0",
  "main": "index.js"
}
```

- `id` — unique identifier (kebab-case recommended, defaults to folder name)
- `name` — display name shown in the plugin marketplace
- `description` — short description (optional)
- `icon` — MDI SVG path string (get one from [pictogrammers.com/library/mdi](https://pictogrammers.com/library/mdi/), or `npm install -D @mdi/js` and import the constant)
- `main` — entry point JS file, loaded as an ES module (defaults to `index.js`)

## Writing a plugin

Your entry point is an ES module that calls `MMA.registerPlugin()`:

```js
MMA.registerPlugin({
  activate() {
    // Called when the plugin activates (map opens + plugin enabled)
    // Use MMA.* to interact with the editor
    return () => {
      // Optional cleanup — called on deactivate
    };
  },
});
```

## The MMA API

The global `MMA` object is the single API surface. It provides:

- Map & location CRUD
- Tag management
- Selection queries
- Event subscription
- Shell command spawning
- File dialogs
- Raw Tauri IPC for advanced use

See [`plugins/types/mma.d.ts`](types/mma.d.ts) for the full API surface.
## UI plugins

Plugins can provide React components for richer UI:

```js
MMA.registerPlugin({
  activate() {},
  sidebar: MySidebarComponent,
  modal: MyModalComponent,
  locationPanel: MyPanelComponent,
});
```

Component props:
- `sidebar` receives `{ onClose: () => void }`
- `modal` receives `{ onClose: () => void }`
- `locationPanel` receives no props

## Shared modules

The plugin template's build config automatically deduplicates libraries the app already bundles (React, deck.gl, luma.gl). Just write normal imports -- the build handles the rest. Libraries the app doesn't have get bundled into your plugin automatically.

## Distribution

To install a plugin:

1. Copy the plugin folder into your plugins directory
2. Reopen a map in MMA
3. Enable the plugin in the marketplace (gear icon)

To share: zip the folder and distribute however you like (GitHub, Discord, etc.).

### Optional type dependencies

Depending on what your plugin uses, you may need additional type packages:

| You use | Install |
|---|---|
| `icon` field (MDI icons) | `npm install -D @mdi/js` — or just copy the SVG path string from [pictogrammers.com/library/mdi](https://pictogrammers.com/library/mdi/) |
| `MMA.getGoogleMap()` | `npm install -D @types/google.maps` |
| UI components (`sidebar`, `modal`, `locationPanel`) | `npm install -D react @types/react` |
| `MMA.shell.Command` / `MMA.dialog.*` | Types are included — no extra install needed |
