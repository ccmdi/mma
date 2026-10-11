// Build every plugin via the shared build script, then regenerate registry.json.
// Run: node plugins/build-all.mjs [--install]  (--install stops after installing every package's deps)
import { execSync, execFileSync } from "node:child_process";
import { allOpts } from "./build-plugin.mjs";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (
	args.some((arg) => !["--install", "--check", "--check-deps", "--list-outputs"].includes(arg)) ||
	args.length > 1
) {
	throw new Error(
		"Usage: node plugins/build-all.mjs [--install|--check|--check-deps|--list-outputs]",
	);
}
const check = args.includes("--check");
const checkDeps = args.includes("--check-deps");
const pluginsDir = dirname(fileURLToPath(import.meta.url));

const dirs = readdirSync(pluginsDir)
	.map((name) => join(pluginsDir, name))
	.filter((dir) => statSync(dir).isDirectory());
const plugins = dirs.filter(
	(dir) =>
		existsSync(join(dir, "manifest.json")) &&
		(existsSync(join(dir, "src/index.tsx")) || existsSync(join(dir, "src/index.ts"))),
);

if (args.includes("--list-outputs")) {
	console.log(
		[
			...plugins.flatMap((dir) => allOpts(dir).map((opts) => opts.outfile)),
			join(pluginsDir, "registry.json"),
		].join("\n"),
	);
	process.exit(0);
}

for (const dir of dirs) {
	if (existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules"))) {
		const name = dir.slice(pluginsDir.length + 1);
		if (check || checkDeps)
			throw new Error(
				`[${name}] dependencies missing; run node plugins/build-all.mjs --install before checking gates`,
			);
		const cmd = existsSync(join(dir, "package-lock.json")) ? "npm ci" : "npm install";
		console.log(`[${name}] ${cmd}`);
		execSync(cmd, { cwd: dir, stdio: "inherit" });
	}
}

if (args.includes("--install") || checkDeps) process.exit(0);

console.log("\nBuilding plugins...");
try {
	execFileSync(process.execPath, ["build-plugin.mjs", ...(check ? ["--check"] : [])], {
		cwd: pluginsDir,
		stdio: "inherit",
	});
} catch {
	process.exit(1);
}

// Regenerate the registry from manifests.
console.log("\n[registry] regenerating...");
try {
	execFileSync(process.execPath, ["generate-registry.js"], { cwd: pluginsDir, stdio: "inherit" });
} catch {
	process.exit(1);
}

console.log(`\nBuilt ${plugins.length} plugin${plugins.length !== 1 ? "s" : ""}.`);
