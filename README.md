# Map Making App

A local-first desktop alternative to [map-making.app](https://map-making.app).

![preview](img/preview.png)

## Features

- Offline/local-first
- Much faster for large maps; handles millions of locations
- Configurable hotkeys
- Composable & saveable selections
- Map generator/vali/autotag built-in
- Version history with commits
- Editor state saves automatically - pick up where you left off
- Extra fields on locations - arbitrary metadata
- "Seen locations" history - find locations you've looked at before
- Concurrent and manageable reviews
- Plugin system

## Installation

Open [the latest release](https://github.com/ccmdi/mma/releases/latest) and download the installer for your platform.

### macOS / Linux

On macOS, you will likely need to run:
```zsh
xattr -dr com.apple.quarantine "/Applications/Map Making App.app"
```

On both Mac & Linux, framerate and rendering stability can be an issue. If you encounter these problems, you can [run the app in a browser](#run-in-a-browser).

### From source

```bash
git clone --recurse-submodules https://github.com/ccmdi/mma
cd mma/app && npm install && npx tauri build
```

Requires Node 24 and a Rust toolchain.

### Run in a browser

Serve the app locally and open it in any browser:

```bash
cd app && npm install && npm run build
cargo run --manifest-path src-tauri/Cargo.toml --features web-serve -- --serve
```

Then open the printed `http://127.0.0.1:1430`.

## More

- [Migrations](scripts/migrations/README.md) - bring your data over from map-making.app
- [Plugins](plugins/README.md) - extend the editor
- [Contributing](CONTRIBUTING.md) - build from source, run tests, open a PR
