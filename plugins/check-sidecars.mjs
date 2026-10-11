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

export function resolveBase(repo, requested = process.env.GATES_BASE) {
	if (requested && !/^0+$/.test(requested)) {
		const sha = attempt(() =>
			git(repo, "rev-parse", "--verify", "--quiet", `${requested}^{commit}`).trim(),
		);
		if (!sha) throw new Error(`GATES_BASE does not resolve to a commit: ${requested}`);
		return sha;
	}
	for (const ref of ["origin/master", "HEAD~1", "HEAD"]) {
		const sha = attempt(() =>
			git(repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).trim(),
		);
		if (sha) return sha;
	}
	throw new Error("No commit available for the sidecar version check");
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

function main() {
	const base = resolveBase(root);
	console.log(`base ${base}`);
	let fail = 0;
	for (const name of readdirSync(join(root, "plugins")).sort()) {
		const sidecar = `plugins/${name}/sidecar`;
		const cargo = `${sidecar}/Cargo.toml`;
		if (!existsSync(join(root, cargo))) continue;
		const current = cargoVersion(readFileSync(join(root, cargo), "utf8"));
		const problems = [];
		if (!current) problems.push(`${cargo} has no explicit package version`);
		const changed = changedSidecarInputs(root, base, sidecar);
		if (changed.length) {
			const before = cargoVersion(attempt(() => git(root, "show", `${base}:${cargo}`)) ?? "");
			if (current === before)
				problems.push(`sidecar changed but ${cargo} is still ${current}: ${changed.join(", ")}`);
		}
		const manifest = join(root, "plugins", name, "manifest.json");
		const named =
			existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).sidecar?.version;
		if (named && named !== current)
			problems.push(`manifest.json sidecar.version ${named} but ${cargo} is ${current}`);
		if (problems.length) fail = 1;
		console.log(problems.length ? `[${name}] FAIL: ${problems.join("; ")}` : `[${name}] ok`);
	}
	process.exitCode = fail;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
