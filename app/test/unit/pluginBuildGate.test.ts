import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "../../..");
const builder = join(repository, "plugins/build-plugin.mjs");

describe("plugin build gate", () => {
	it("rejects changed artifacts without rewriting the plugin version", () => {
		const repo = mkdtempSync(join(repository, "test-plugin-gate-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=", ...args], {
				cwd: repo,
				encoding: "utf8",
				stdio: "pipe",
			});
		const manifestPath = join(repo, "manifest.json");
		try {
			mkdirSync(join(repo, "src"));
			writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
			writeFileSync(join(repo, "package.json"), '{"type":"module","private":true}\n');
			writeFileSync(manifestPath, '{"id":"fixture","name":"Fixture","version":"1.0.0"}\n');
			writeFileSync(join(repo, "src/index.ts"), "export const marker = 1;\n");
			symlinkSync(join(repository, "app/node_modules"), join(repo, "node_modules"), "junction");
			git("init", "--quiet");
			execFileSync(process.execPath, [builder, repo], { cwd: repo, stdio: "pipe" });
			git("add", ".");
			git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			);
			const manifest = readFileSync(manifestPath, "utf8");
			const before = readFileSync(join(repo, "index.js"), "utf8");
			writeFileSync(join(repo, "src/index.ts"), "export const marker = 2;\n");
			const check = spawnSync(process.execPath, [builder, repo, "--check"], {
				cwd: repo,
				encoding: "utf8",
			});
			expect(check.status).toBe(1);
			expect(check.stderr).toContain("without a plugin version bump");
			expect(readFileSync(manifestPath, "utf8")).toBe(manifest);
			expect(readFileSync(join(repo, "index.js"), "utf8")).not.toBe(before);
			const changed = JSON.parse(manifest);
			changed.version = "2.0.0";
			writeFileSync(manifestPath, JSON.stringify(changed));
			const versioned = spawnSync(process.execPath, [builder, repo, "--check"], {
				cwd: repo,
				encoding: "utf8",
			});
			expect(versioned.status, versioned.stderr).toBe(0);
			expect(JSON.parse(readFileSync(manifestPath, "utf8")).version).toBe("2.0.0");
		} finally {
			rmSync(repo, { recursive: true, force: true, maxRetries: 10 });
		}
	});

	it("rejects unknown gate options before building or installing", () => {
		const result = spawnSync(
			process.execPath,
			[join(repository, "plugins/build-all.mjs"), "--checks"],
			{ cwd: repository, encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Usage:");
	});
});
