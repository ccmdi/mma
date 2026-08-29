// Typecheck every plugin twice: against today's SDK, and against the SDK as it was at
// the app version the plugin claims as its floor (manifest `minAppVersion`). The floor
// check is what catches a plugin reaching for an API newer than the version it says it
// supports. Run: node plugins/check-floors.mjs
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginsDir = dirname(fileURLToPath(import.meta.url));
const typesDir = join(pluginsDir, "types");
const sdkDts = join(typesDir, "mma.d.ts");
const tsc = join(typesDir, "node_modules/typescript/lib/tsc.js");

if (!existsSync(join(typesDir, "node_modules"))) {
	console.log("[types] npm ci");
	execSync("npm ci", { cwd: typesDir, stdio: "inherit" });
}

const plugins = readdirSync(pluginsDir)
	.map((name) => join(pluginsDir, name))
	.filter((dir) => existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "tsconfig.json")));

/** `mma.d.ts` as committed at tag `v<version>`, or null when no such tag exists. */
function sdkAt(version) {
	const r = spawnSync("git", ["show", `v${version}:plugins/types/mma.d.ts`], { cwd: pluginsDir });
	return r.status === 0 ? r.stdout : null;
}

function typecheck(dir) {
	const r = spawnSync(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.json"], {
		cwd: dir,
		encoding: "utf8",
	});
	return r.status === 0 ? null : r.stdout + r.stderr;
}

const current = readFileSync(sdkDts);
const restore = () => writeFileSync(sdkDts, current);
process.on("SIGINT", () => {
	restore();
	process.exit(130);
});

let fail = 0;
try {
	for (const dir of plugins) {
		const name = dir.slice(pluginsDir.length + 1);
		const floor = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).minAppVersion;
		if (!floor) {
			console.log(`[${name}] FAIL: manifest.json has no minAppVersion`);
			fail = 1;
			continue;
		}

		restore();
		let errors = typecheck(dir);
		if (errors) {
			console.log(`[${name}] FAIL against the current SDK\n${errors}`);
			fail = 1;
			continue;
		}

		const old = sdkAt(floor);
		if (!old) {
			console.log(`[${name}] ok (floor ${floor} is unreleased, checked against the current SDK only)`);
			continue;
		}
		writeFileSync(sdkDts, old);
		errors = typecheck(dir);
		if (errors) {
			console.log(`[${name}] FAIL against the SDK at v${floor}: raise minAppVersion or drop the newer API\n${errors}`);
			fail = 1;
			continue;
		}
		console.log(`[${name}] ok (floor ${floor})`);
	}
} finally {
	restore();
}
process.exit(fail);
