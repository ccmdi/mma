const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const pluginsDir = __dirname;
const repoRoot = path.join(__dirname, "..");
const out = path.join(pluginsDir, "registry.json");
const SKIP = new Set(["sample", "types"]);
const REQUIRED = ["id", "name", "main"];

const entries = [];
const seenIds = new Map();
let hasError = false;

const git = (args) =>
	execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trim();
const gitOk = (args) => {
	try {
		return git(args);
	} catch {
		return null;
	}
};

/** Read a plugin manifest as of a commit. Null when it did not exist there. */
function manifestAt(ref, dirPath) {
	const raw = gitOk(["show", `${ref}:${dirPath}/manifest.json`]);
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

const minAppOf = (m) => m?.minAppVersion || null;

/** Older builds this plugin can fall back to on an app too old for the latest one.
 *
 *  Git history is the publish log: every version bump is a commit that changed the
 *  manifest. For each distinct `minAppVersion` the plugin has ever declared, pin the
 *  newest commit that still declared it -- that is the last build an app under the
 *  current floor can run. Only floor changes produce an entry; versions in between are
 *  covered by a newer build with the same floor. */
function historyBuilds(dirPath, currentMinApp, currentVersion) {
	const commits = (
		gitOk(["log", "--follow", "--format=%H", "--", `${dirPath}/manifest.json`]) || ""
	)
		.split("\n")
		.filter(Boolean);
	if (!commits.length) return [];

	const builds = [];
	const seenFloors = new Set([currentMinApp]);

	// Newest -> oldest. commits[i - 1] is the commit that changed the floor away.
	for (let i = 0; i < commits.length; i++) {
		const m = manifestAt(commits[i], dirPath);
		if (!m) continue;
		const floor = minAppOf(m);
		if (seenFloors.has(floor)) continue;
		seenFloors.add(floor);

		// Build files can be rebuilt without touching the manifest, so pin the newest
		// commit that touched the plugin while this floor was still current.
		const newer = commits[i - 1];
		const ref =
			(newer && gitOk(["log", "-1", "--format=%H", `${newer}^`, "--", dirPath])) || commits[i];

		const pinned = manifestAt(ref, dirPath) || m;
		if (minAppOf(pinned) !== floor) {
			console.error(
				`ERROR: ${dirPath} ref ${ref.slice(0, 8)} declares minAppVersion ${minAppOf(pinned)}, expected ${floor}`,
			);
			hasError = true;
			continue;
		}
		// Raising the floor without bumping the version leaves two different builds
		// sharing one version number, so there is no older build to name.
		if (pinned.version === currentVersion) {
			console.warn(
				`WARN: ${dirPath} raised minAppVersion to ${currentMinApp} without bumping v${currentVersion} -- no fallback build can be offered`,
			);
			continue;
		}

		const main = pinned.main || "index.js";
		const missing = [main, pinned.procedure]
			.filter(Boolean)
			.filter((f) => gitOk(["cat-file", "-e", `${ref}:${dirPath}/${f}`]) === null);
		if (missing.length) {
			console.error(
				`ERROR: ${dirPath} v${pinned.version} pinned at ${ref.slice(0, 8)} is missing ${missing.join(", ")}`,
			);
			hasError = true;
			continue;
		}

		// Only what picking a build needs. The rest comes from the manifest at `ref`,
		// which the installer fetches first anyway.
		const build = { version: pinned.version, ref };
		if (floor) build.minAppVersion = floor;
		builds.push(build);
	}
	return builds;
}

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

	const builds = historyBuilds(`plugins/${name}`, raw.minAppVersion || null, entry.version);
	if (builds.length) entry.builds = builds;

	entries.push(entry);
}

if (hasError) {
	process.exit(1);
}

entries.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(out, JSON.stringify(entries, null, "\t") + "\n");
console.log(`Generated plugins/registry.json (${entries.length} plugin${entries.length !== 1 ? "s" : ""})`);
