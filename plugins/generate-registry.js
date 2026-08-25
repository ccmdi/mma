const fs = require("fs");
const path = require("path");

const pluginsDir = __dirname;
const out = path.join(pluginsDir, "registry.json");
const SKIP = new Set(["sample", "types"]);
const REQUIRED = ["id", "name", "main"];

const entries = [];
const seenIds = new Map();
let hasError = false;

for (const name of fs.readdirSync(pluginsDir)) {
	if (SKIP.has(name)) continue;
	const dir = path.join(pluginsDir, name);
	if (!fs.statSync(dir).isDirectory()) continue;
	const manifestPath = path.join(dir, "manifest.json");
	if (!fs.existsSync(manifestPath)) continue;

	const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	const id = raw.id || name;

	for (const field of REQUIRED) {
		if (!raw[field]) {
			console.error(`ERROR: plugins/${name}/manifest.json missing required field "${field}"`);
			hasError = true;
		}
	}

	if (seenIds.has(id)) {
		console.error(`ERROR: duplicate plugin id "${id}" in plugins/${name}/ and plugins/${seenIds.get(id)}/`);
		hasError = true;
	}
	seenIds.set(id, name);

	for (const file of [raw.main || "index.js", raw.procedure].filter(Boolean)) {
		if (!fs.existsSync(path.join(dir, file))) {
			console.error(`ERROR: plugins/${name}/${file} not found (build the plugin first)`);
			hasError = true;
		}
	}

	const entry = {
		id,
		name: raw.name,
		description: raw.description || "",
		icon: raw.icon || "",
		version: raw.version || "0.0.0",
		main: raw.main || "index.js",
	};
	// The installer downloads the procedure module alongside `main`.
	if (raw.procedure) entry.procedure = raw.procedure;
	if (raw.comingSoon) entry.comingSoon = true;
	if (raw.experimental) entry.experimental = true;
	if (raw.minAppVersion) entry.minAppVersion = raw.minAppVersion;
	if (raw.sidecar) entry.sidecar = { name: raw.sidecar.name, version: raw.sidecar.version };
	entries.push(entry);
}

if (hasError) {
	process.exit(1);
}

entries.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(out, JSON.stringify(entries, null, "\t") + "\n");
console.log(`Generated plugins/registry.json (${entries.length} plugin${entries.length !== 1 ? "s" : ""})`);
