import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function cargoVersion(toml) {
	const section =
		toml.match(/^\s*\[package\][^\r\n]*(?:\r?\n|$)([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m)?.[1] ?? "";
	return section.match(/^\s*version\s*=\s*["']([^"']+)["']/m)?.[1] ?? "";
}

function git(repo, ...args) {
	return execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function attempt(fn) {
	try {
		return fn();
	} catch {
		return null;
	}
}

export function changedSidecarInputs(repo, base, sidecar) {
	const paths = [
		`${sidecar}/src`,
		`${sidecar}/Cargo.toml`,
		`${sidecar}/Cargo.lock`,
		`${sidecar}/build.rs`,
	];
	const tracked = git(repo, "diff", "--name-only", "-z", base, "--", ...paths);
	const untracked = git(repo, "ls-files", "--others", "--exclude-standard", "-z", "--", ...paths);
	return [...new Set((tracked + untracked).split("\0").filter(Boolean))].filter(
		(file) => !file.endsWith(".test.rs"),
	);
}

export function releaseTags(registry) {
	const tags = new Set();
	for (const plugin of registry)
		for (const entry of [plugin, ...(plugin.builds ?? [])])
			if (entry.sidecar?.version) tags.add(`${plugin.id}-v${entry.sidecar.version}`);
	return [...tags];
}

export function checkReleaseTags(registry, listRemoteTags, ci = !!process.env.CI) {
	let listed;
	try {
		listed = listRemoteTags();
	} catch (error) {
		const message = `cannot list origin tags (${error.message.split("\n")[0]})`;
		return ci ? { errors: [message], warnings: [] } : { errors: [], warnings: [message] };
	}
	const remote = new Set(
		listed
			.split("\n")
			.map((line) => line.match(/\trefs\/tags\/(.+?)(?:\^\{\})?$/)?.[1])
			.filter(Boolean),
	);
	const missing = releaseTags(registry).filter((tag) => !remote.has(tag));
	return {
		errors: missing.map((tag) => `registry.json names sidecar release ${tag}, missing on origin`),
		warnings: [],
	};
}

function main() {
	let fail = 0;
	for (const name of readdirSync(join(root, "plugins")).sort()) {
		const sidecar = `plugins/${name}/sidecar`;
		const cargo = `${sidecar}/Cargo.toml`;
		if (!existsSync(join(root, cargo))) continue;
		const current = cargoVersion(readFileSync(join(root, cargo), "utf8"));
		const problems = [];
		if (!current) problems.push(`${cargo} has no explicit package version`);
		const released = `${name}-v${current}`;
		const changed =
			current && attempt(() => git(root, "rev-parse", "--verify", "--quiet", `${released}^{commit}`))
				? changedSidecarInputs(root, released, sidecar)
				: [];
		if (changed.length)
			problems.push(`sidecar changed since ${released} but ${cargo} is still ${current}: ${changed.join(", ")}`);
		const manifest = join(root, "plugins", name, "manifest.json");
		const named =
			existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).sidecar?.version;
		if (named && named !== current)
			problems.push(`manifest.json sidecar.version ${named} but ${cargo} is ${current}`);
		if (problems.length) fail = 1;
		console.log(problems.length ? `[${name}] FAIL: ${problems.join("; ")}` : `[${name}] ok`);
	}
	const registry = JSON.parse(readFileSync(join(root, "plugins", "registry.json"), "utf8"));
	const { errors, warnings } = checkReleaseTags(registry, () =>
		execFileSync("git", ["ls-remote", "--tags", "origin"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		}),
	);
	for (const warning of warnings) console.log(`[release tags] WARN: ${warning}`);
	for (const error of errors) console.log(`[release tags] FAIL: ${error}`);
	if (errors.length) fail = 1;
	else if (!warnings.length) console.log("[release tags] ok");
	process.exitCode = fail;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
