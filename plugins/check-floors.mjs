// Typecheck every plugin twice: against today's SDK, and against the SDK as it was at
// the app version the plugin claims as its floor (manifest `minAppVersion`). The floor
// check is what catches a plugin reaching for an API newer than the version it says it
// supports. Older SDKs are served from git in memory, so the checkout is never touched.
// Run: node plugins/check-floors.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginsDir = dirname(fileURLToPath(import.meta.url));
const typesDir = join(pluginsDir, "types");
const appRequire = createRequire(join(pluginsDir, "../app/package.json"));
const { API, DiagnosticCategory } = await import(
	pathToFileURL(appRequire.resolve("@typescript/native/unstable/sync")).href
);

/** Declaration files older SDKs referenced from `mma.d.ts` that the current SDK no longer ships. */
const RETIRED_SDK_FILES = ["google-maps.d.ts"];

const fileKey = (file) =>
	process.platform === "win32" ? file.replaceAll("\\", "/").toLowerCase() : file;

/** The SDK's declaration files at tag `v<version>`, or null when no such tag exists. A null entry is a file that release did not ship. */
function sdkAt(version) {
	const show = (file) =>
		spawnSync("git", ["show", `v${version}:plugins/types/${file}`], {
			cwd: pluginsDir,
			encoding: "utf8",
		});
	const main = show("mma.d.ts");
	if (main.status !== 0) return null;
	const files = new Map([[fileKey(join(typesDir, "mma.d.ts")), main.stdout]]);
	for (const file of RETIRED_SDK_FILES) {
		const r = show(file);
		files.set(fileKey(join(typesDir, file)), r.status === 0 ? r.stdout : null);
	}
	return files;
}

function errorsOf(program, config) {
	return [
		...program.getConfigFileParsingDiagnostics(),
		...program.getProgramDiagnostics(),
		...program.getGlobalDiagnostics(),
		...program.getSyntacticDiagnostics(),
		...program.getSemanticDiagnostics(),
	]
		.filter((d) => d.category === DiagnosticCategory.Error)
		.map((d) => {
			if (!d.fileName) return `${config}: TS${d.code}: ${d.text}`;
			const at = program.getSourceFile(d.fileName)?.getLineAndCharacterOfPosition(d.pos);
			const where = at ? `:${at.line + 1}:${at.character + 1}` : "";
			return `${relative(pluginsDir, d.fileName)}${where}: TS${d.code}: ${d.text}`;
		})
		.join("\n");
}

/** Errors per plugin dir, typechecked in one compiler against `sdk`, or the checked-out SDK when omitted. */
function typecheck(dirs, sdk) {
	const fs = sdk && {
		readFile: (file) => sdk.get(fileKey(file)),
		fileExists: (file) => (sdk.has(fileKey(file)) ? sdk.get(fileKey(file)) !== null : undefined),
	};
	const api = new API({ cwd: pluginsDir, fs });
	try {
		const configs = dirs.map((dir) => join(dir, "tsconfig.json"));
		const snapshot = api.updateSnapshot({ openProjects: configs });
		try {
			return new Map(
				dirs.map((dir, i) => {
					const project = snapshot.getProject(configs[i]);
					if (!project) throw new Error(`Could not load ${configs[i]}`);
					return [dir, errorsOf(project.program, configs[i])];
				}),
			);
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}

const plugins = readdirSync(pluginsDir)
	.map((name) => join(pluginsDir, name))
	.filter(
		(dir) => existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "tsconfig.json")),
	);

let fail = 0;
const byFloor = new Map();
for (const dir of plugins) {
	const floor = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).minAppVersion;
	if (!floor) {
		console.log(`[${basename(dir)}] FAIL: manifest.json has no minAppVersion`);
		fail = 1;
		continue;
	}
	byFloor.set(floor, [...(byFloor.get(floor) ?? []), dir]);
}

const current = byFloor.size ? typecheck([...byFloor.values()].flat()) : new Map();
for (const [floor, dirs] of byFloor) {
	const sdk = sdkAt(floor);
	const passing = dirs.filter((dir) => !current.get(dir));
	const old = sdk && passing.length ? typecheck(passing, sdk) : new Map();
	for (const dir of dirs) {
		const name = basename(dir);
		if (current.get(dir)) {
			console.log(`[${name}] FAIL against the current SDK\n${current.get(dir)}`);
			fail = 1;
		} else if (old.get(dir)) {
			console.log(
				`[${name}] FAIL against the SDK at v${floor}: raise minAppVersion or drop the newer API\n${old.get(dir)}`,
			);
			fail = 1;
		} else if (!sdk) {
			console.log(
				`[${name}] ok (floor ${floor} is unreleased, checked against the current SDK only)`,
			);
		} else {
			console.log(`[${name}] ok (floor ${floor})`);
		}
	}
}
process.exitCode = fail;
