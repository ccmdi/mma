import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import generator from "../generate.js";
import * as native from "../../../app/scripts/native-ts.mjs";

const sdk = (members) => `export interface MMA { ${members.map((m) => `${m}: number;`).join(" ")} }\n`;

test("a member's release reads the same before and after the version is tagged", (t) => {
	const root = mkdtempSync(join(tmpdir(), "mma-first-releases-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	const write = (version, members) => {
		writeFileSync(join(root, "app", "package.json"), JSON.stringify({ version }));
		writeFileSync(join(root, "plugins", "types", "mma.d.ts"), sdk(members));
	};
	const release = (tag) => {
		git("add", ".");
		git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", tag);
		git("tag", tag);
	};
	mkdirSync(join(root, "app"));
	mkdirSync(join(root, "plugins", "types"), { recursive: true });
	git("init", "-q");
	write("0.1.0", ["old"]);
	release("v0.1.0");

	const current = sdk(["old", "added"]);
	assert.deepEqual(generator.firstReleases(native, current, root), new Map([["old", "v0.1.0"]]));

	write("0.2.0", ["old", "added"]);
	const untagged = generator.firstReleases(native, current, root);
	assert.deepEqual(untagged, new Map([["old", "v0.1.0"], ["added", "v0.2.0"]]));
	release("v0.2.0");
	assert.deepEqual(generator.firstReleases(native, current, root), untagged);
});
