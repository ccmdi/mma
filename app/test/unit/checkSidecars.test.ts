import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cargoVersion, changedSidecarInputs } from "../../../plugins/check-sidecars.mjs";

describe("sidecar version policy", () => {
	it("takes the package version, excluding dependency and metadata versions", () => {
		expect(
			cargoVersion(
				'[dependencies.ort]\nversion = "2.0.0"\n[package]\nname = "x"\nversion = "0.5.0"\n[package.metadata]\nversion = "8"\n',
			),
		).toBe("0.5.0");
		expect(cargoVersion('[package]\nname = "x"\n[dependencies.ort]\nversion = "2.0.0"\n')).toBe("");
		expect(cargoVersion('[dependencies]\nserde = { version = "1" }\n')).toBe("");
		expect(cargoVersion("[package]\r\nversion = '1.2.3' # release\r\n")).toBe("1.2.3");
	});

	it("checks staged, unstaged, untracked, deleted and dependency inputs while excluding dedicated tests", () => {
		const repo = mkdtempSync(join(tmpdir(), "mma-sidecar-policy-"));
		const sidecar = "plugins/example/sidecar";
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=", ...args], {
				cwd: repo,
				encoding: "utf8",
			});
		const write = (file: string, text: string) => writeFileSync(join(repo, sidecar, file), text);
		try {
			mkdirSync(join(repo, sidecar, "src"), { recursive: true });
			write("Cargo.toml", '[package]\nname = "example"\nversion = "1.0.0"\n');
			write("src/main.rs", "fn main() {}\n");
			write("src/deleted.rs", "pub fn old() {}\n");
			write("src/main.test.rs", "#[test] fn old_test() {}\n");
			git("init", "--quiet");
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
			const base = "example-v1.0.0";
			git("tag", base);
			write("src/main.test.rs", "#[test] fn better_test() {}\n");
			expect(changedSidecarInputs(repo, base, sidecar)).toEqual([]);
			write("src/main.rs", "fn main() { panic!(); }\n");
			expect(changedSidecarInputs(repo, base, sidecar)).toEqual([`${sidecar}/src/main.rs`]);
			git("add", `${sidecar}/src/main.rs`);
			write("Cargo.lock", "new dependency lock\n");
			write("build.rs", "fn main() {}\n");
			write("src/new.rs", "pub fn added() {}\n");
			rmSync(join(repo, sidecar, "src/deleted.rs"));
			expect(changedSidecarInputs(repo, base, sidecar).sort()).toEqual(
				[
					`${sidecar}/src/main.rs`,
					`${sidecar}/src/deleted.rs`,
					`${sidecar}/src/new.rs`,
					`${sidecar}/Cargo.lock`,
					`${sidecar}/build.rs`,
				].sort(),
			);
			write("src/new.test.rs", "#[test] fn extra() {}\n");
			expect(changedSidecarInputs(repo, base, sidecar)).not.toContain(`${sidecar}/src/new.test.rs`);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
