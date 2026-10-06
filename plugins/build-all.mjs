// Build every plugin via the shared build script, then regenerate registry.json.
// Run: node plugins/build-all.mjs [--install]  (--install stops after installing every package's deps)
import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginsDir = dirname(fileURLToPath(import.meta.url));

const dirs = readdirSync(pluginsDir)
	.map((name) => join(pluginsDir, name))
	.filter((dir) => statSync(dir).isDirectory());
const plugins = dirs.filter(
	(dir) =>
		existsSync(join(dir, "manifest.json")) &&
		(existsSync(join(dir, "src/index.tsx")) || existsSync(join(dir, "src/index.ts"))),
);

for (const dir of dirs) {
	if (existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules"))) {
		const name = dir.slice(pluginsDir.length + 1);
		const cmd = existsSync(join(dir, "package-lock.json")) ? "npm ci" : "npm install";
		console.log(`[${name}] ${cmd}`);
		execSync(cmd, { cwd: dir, stdio: "inherit" });
	}
}

if (process.argv.includes("--install")) process.exit(0);

console.log("\nBuilding plugins...");
try {
	execSync("node build-plugin.mjs", { cwd: pluginsDir, stdio: "inherit" });
} catch {
	process.exit(1);
}

// Regenerate the registry from manifests.
console.log("\n[registry] regenerating...");
try {
	execSync("node generate-registry.js", { cwd: pluginsDir, stdio: "inherit" });
} catch {
	process.exit(1);
}

console.log(`\nBuilt ${plugins.length} plugin${plugins.length !== 1 ? "s" : ""}.`);
