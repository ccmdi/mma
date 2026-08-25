// Bundle every app-shipped enrichment procedure under app/procedures/ into one ES module
// each, loaded by the QuickJS host as res://procedures/<name>.js.
//
//   npm run build:procedures            # all of them
//   node scripts/build-procedures.mjs timezone svMeta
import { build } from "esbuild";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const proceduresDir = join(appDir, "procedures");
const outDir = join(appDir, "src-tauri", "procedures");
if (!existsSync(proceduresDir)) process.exit(0);

// A procedure runs in QuickJS: no DOM, no Tauri IPC, no app singletons. Its bundle may
// reach only pure leaves of the app, named here as roots. Most stray imports fail the
// build outright (the store and viewer graphs pull node builtins through deck.gl), but the
// Tauri client bundles clean and only throws when called, so the graph is checked directly.
const ALLOWED = [
	"procedures/",
	"src/lib/sv/",
	"src/lib/proto/",
	"src/lib/geo/",
	"src/lib/util/",
	"src/lib/data/procedureHost.ts",
	"src/types/",
	"src/bindings.gen.ts",
	"node_modules/",
];
// Dependencies a procedure may not carry even through an allowed root.
const FORBIDDEN = ["@tauri-apps/", "node_modules/react", "node_modules/@deck.gl", "node_modules/@loaders.gl"];

/** Inputs of the finished bundle that no procedure may reach. */
function forbidden(metafile) {
	return Object.keys(metafile.inputs).filter((p) => {
		const norm = p.replaceAll("\\", "/");
		return !ALLOWED.some((ok) => norm.startsWith(ok)) || FORBIDDEN.some((bad) => norm.includes(bad));
	});
}

const wanted = process.argv.slice(2);
const dirs = readdirSync(proceduresDir)
	.filter(
		(name) =>
			(wanted.length === 0 || wanted.includes(name)) &&
			statSync(join(proceduresDir, name)).isDirectory(),
	)
	.sort();

for (const name of dirs) {
	const dir = join(proceduresDir, name);
	const entry = join(dir, "index.ts");
	if (!existsSync(entry)) throw new Error(`${dir}: no index.ts`);
	const result = await build({
		entryPoints: [entry],
		outfile: join(outDir, `${name}.js`),
		bundle: true,
		format: "esm",
		// The guest is QuickJS: no node, no browser, no package conditions to match on.
		platform: "neutral",
		mainFields: ["module", "main"],
		target: "es2022",
		alias: { "@": join(appDir, "src") },
		absWorkingDir: appDir,
		logLevel: "warning",
		metafile: true,
	});
	const bad = forbidden(result.metafile);
	if (bad.length > 0) {
		throw new Error(
			`${name}: procedure bundle reaches ${bad.join(", ")}. Move whatever it needs into a ` +
				`module with no app or Tauri imports, and import it from there.`,
		);
	}
	console.log(`[${name}] ok`);
}
