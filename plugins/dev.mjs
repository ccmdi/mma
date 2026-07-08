// Dev mode for a plugin: builds JS in watch mode and syncs output files
// (index.js, manifest.json, sidecar binary) to the appdata plugin directory.
//
// Usage:
//   node plugins/dev.mjs plugins/vision              # JS watch + sync
//   node plugins/dev.mjs plugins/vision --sidecar     # also watch sidecar binary
//
// The sidecar binary is expected at plugins/<id>/sidecar/target/debug/<name>.exe
// (or without .exe on unix). Build it yourself with `cargo build` in the sidecar
// dir; this script just watches the output and copies it when it changes.

import { existsSync, readFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const IS_WIN = process.platform === "win32";
const pluginsDir = dirname(fileURLToPath(import.meta.url));
const mmaExternals = createRequire(import.meta.url)("./mma-externals.js");

function appDataPluginDir(pluginId) {
	const base = IS_WIN
		? join(process.env.APPDATA, "app.map-making.local")
		: process.platform === "darwin"
			? join(process.env.HOME, "Library", "Application Support", "app.map-making.local")
			: join(process.env.HOME, ".local", "share", "app.map-making.local");
	return join(base, "plugins", pluginId);
}

function syncFile(src, dest, label) {
	if (!existsSync(src)) return;
	const destDir = dirname(dest);
	mkdirSync(destDir, { recursive: true });
	copyFileSync(src, dest);
	console.log(`[dev] synced ${label}`);
}

// --- Parse args ---
const args = process.argv.slice(2);
const watchSidecar = args.includes("--sidecar");
const dirs = args.filter((a) => !a.startsWith("--"));

if (dirs.length !== 1) {
	console.error("Usage: node plugins/dev.mjs plugins/<id> [--sidecar]");
	process.exit(1);
}

const pluginDir = resolve(dirs[0]);
const manifestPath = join(pluginDir, "manifest.json");
if (!existsSync(manifestPath)) {
	console.error(`No manifest.json in ${pluginDir}`);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pluginId = manifest.id || pluginDir.split(/[\\/]/).pop();
const destDir = appDataPluginDir(pluginId);
mkdirSync(destDir, { recursive: true });

console.log(`[dev] plugin: ${pluginId}`);
console.log(`[dev] source: ${pluginDir}`);
console.log(`[dev] target: ${destDir}`);

// --- Sync manifest ---
syncFile(manifestPath, join(destDir, "manifest.json"), "manifest.json");

// --- JS watch build (esbuild) ---
const tsx = existsSync(join(pluginDir, "src/index.tsx"));
const entry = tsx ? "src/index.tsx" : "src/index.ts";
if (!existsSync(join(pluginDir, entry))) {
	console.error(`No entry point found (tried src/index.tsx, src/index.ts)`);
	process.exit(1);
}

const { context } = createRequire(join(pluginDir, "package.json"))("esbuild");

const outfile = join(pluginDir, "index.js");
const opts = {
	entryPoints: [join(pluginDir, entry)],
	bundle: true,
	format: "esm",
	outfile,
	absWorkingDir: pluginsDir,
	plugins: [
		mmaExternals(),
		{
			name: "sync-on-build",
			setup(build) {
				build.onEnd((result) => {
					if (result.errors.length === 0) {
						syncFile(outfile, join(destDir, "index.js"), "index.js");
						syncFile(manifestPath, join(destDir, "manifest.json"), "manifest.json");
					}
				});
			},
		},
	],
};
if (tsx) {
	opts.jsx = "automatic";
	opts.jsxImportSource = "react";
}

const ctx = await context(opts);
await ctx.watch();
console.log("[dev] JS watching");

// --- Sidecar binary watch ---
if (watchSidecar && manifest.sidecar) {
	const sidecarName = manifest.sidecar.name;
	const ext = IS_WIN ? ".exe" : "";
	const binaryPath = join(pluginDir, "sidecar", "target", "debug", `${sidecarName}${ext}`);
	const sidecarDestDir = join(destDir, "sidecar");

	console.log(`[dev] sidecar: watching ${binaryPath}`);

	let lastMtime = 0;
	if (existsSync(binaryPath)) {
		lastMtime = statSync(binaryPath).mtimeMs;
		syncFile(binaryPath, join(sidecarDestDir, `${sidecarName}${ext}`), `sidecar/${sidecarName}${ext}`);
	}

	setInterval(() => {
		if (!existsSync(binaryPath)) return;
		const mtime = statSync(binaryPath).mtimeMs;
		if (mtime > lastMtime) {
			lastMtime = mtime;
			syncFile(binaryPath, join(sidecarDestDir, `${sidecarName}${ext}`), `sidecar/${sidecarName}${ext}`);
		}
	}, 1000);
}

// Keep alive
process.on("SIGINT", () => {
	ctx.dispose();
	process.exit(0);
});
