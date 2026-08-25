// Shared build script for all MMA plugins.
//
// Usage:
//   node plugins/build-plugin.mjs plugins/heatmap          # build one plugin
//   node plugins/build-plugin.mjs plugins/heatmap --watch   # watch mode
//   node plugins/build-plugin.mjs                           # build all plugins
//
// Auto-detects the UI entry point (src/index.tsx > src/index.ts) and applies JSX config
// only when needed. A plugin whose manifest names a `procedure` also gets that module
// bundled from src/procedure.ts, and both artifacts take part in version-bump detection.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const pluginsDir = dirname(fileURLToPath(import.meta.url));
const mmaExternals = createRequire(import.meta.url)("./mma-externals.js");

export function resolveEsbuild(pluginDir) {
	return createRequire(join(pluginDir, "package.json"))("esbuild");
}

export function readManifest(pluginDir) {
	const path = join(pluginDir, "manifest.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function bumpPatch(pluginDir) {
	const manifestPath = join(pluginDir, "manifest.json");
	const manifest = readManifest(pluginDir);
	if (!manifest?.version) return;
	const parts = manifest.version.split(".");
	parts[2] = String((parseInt(parts[2], 10) || 0) + 1);
	manifest.version = parts.join(".");
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

/** An artifact's bytes at HEAD, or null when the commit does not track it. */
function committedBytes(file) {
	try {
		return execSync(`git show HEAD:./${basename(file)}`, {
			cwd: dirname(file),
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

/** True once manifest.json has already been bumped for the current working change. */
function bumpedSinceHead(pluginDir) {
	const manifestPath = join(pluginDir, "manifest.json");
	const head = committedBytes(manifestPath);
	if (!head || !existsSync(manifestPath)) return false;
	return (
		JSON.parse(head.toString()).version !==
		JSON.parse(readFileSync(manifestPath, "utf8")).version
	);
}

export function uiOpts(pluginDir) {
	const tsx = existsSync(join(pluginDir, "src/index.tsx"));
	const entry = tsx ? "src/index.tsx" : "src/index.ts";
	if (!existsSync(join(pluginDir, entry))) {
		throw new Error(`No entry point found in ${pluginDir} (tried src/index.tsx, src/index.ts)`);
	}

	const opts = {
		entryPoints: [join(pluginDir, entry)],
		bundle: true,
		format: "esm",
		outfile: join(pluginDir, "index.js"),
		absWorkingDir: pluginsDir,
		plugins: [mmaExternals()],
	};

	if (tsx) {
		opts.jsx = "automatic";
		opts.jsxImportSource = "react";
	}

	return opts;
}

/** Build options for the enrichment procedure the manifest names, or null without one. */
export function procedureOpts(pluginDir) {
	const file = readManifest(pluginDir)?.procedure;
	if (!file) return null;
	const entry = join(pluginDir, "src/procedure.ts");
	if (!existsSync(entry)) {
		throw new Error(`${pluginDir} declares a procedure but has no src/procedure.ts`);
	}
	return {
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		outfile: resolve(pluginDir, file),
		// The guest is QuickJS: no node, no browser, no package conditions to match on.
		platform: "neutral",
		mainFields: ["module", "main"],
		target: "es2022",
		absWorkingDir: pluginsDir,
		logLevel: "warning",
	};
}

/** Every esbuild target a plugin has: its UI bundle, plus its procedure when it ships one. */
export function allOpts(pluginDir) {
	return [uiOpts(pluginDir), procedureOpts(pluginDir)].filter(Boolean);
}

function discoverPlugins() {
	return readdirSync(pluginsDir)
		.map((name) => join(pluginsDir, name))
		.filter(
			(dir) =>
				statSync(dir).isDirectory() &&
				(existsSync(join(dir, "src/index.tsx")) || existsSync(join(dir, "src/index.ts"))) &&
				existsSync(join(dir, "manifest.json")),
		)
		.sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const watch = args.includes("--watch");
	const dirs = args.filter((a) => !a.startsWith("--"));

	const targets = dirs.length > 0 ? dirs.map((d) => resolve(d)) : discoverPlugins();

	if (watch) {
		for (const dir of targets) {
			const name = dir.slice(pluginsDir.length + 1);
			const { context } = resolveEsbuild(dir);
			for (const opts of allOpts(dir)) await (await context(opts)).watch();
			console.log(`[${name}] watching`);
		}
	} else {
		const results = await Promise.allSettled(
			targets.map(async (dir) => {
				const name = dir.slice(pluginsDir.length + 1);
				const opts = allOpts(dir);
				// Against HEAD, not a pre-build snapshot: the invariant is that a working
				// artifact differing from the committed one carries a version bump, which is
				// what CI checks.
				const committed = opts.map((o) => committedBytes(o.outfile));
				const { build } = resolveEsbuild(dir);
				for (const o of opts) await build(o);
				// Bump once per change: only when an artifact differs from the commit and
				// the version has not already been bumped for it, so a repeat build stays
				// idempotent (CI fails if the committed build artifacts differ).
				const changed = opts.some(
					(o, i) => committed[i] === null || !committed[i].equals(readFileSync(o.outfile)),
				);
				if (changed && !bumpedSinceHead(dir)) bumpPatch(dir);
				return name;
			}),
		);

		let failed = 0;
		for (const r of results) {
			if (r.status === "fulfilled") {
				console.log(`[${r.value}] ok`);
			} else {
				failed++;
				console.error(r.reason.message || r.reason);
			}
		}
		if (failed) process.exit(1);
	}
}
