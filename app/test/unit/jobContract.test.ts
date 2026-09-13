import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(__dirname, "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) sourceFiles(path, out);
		else if (/\.tsx?$/.test(entry.name)) out.push(path);
	}
	return out;
}

/** The argument text of every call to `fn`. */
function callArguments(text: string, fn: string): string[] {
	const calls: string[] = [];
	for (const match of text.matchAll(new RegExp(`\\b${fn}\\(`, "g"))) {
		const start = match.index + match[0].length;
		let depth = 1;
		let i = start;
		for (; i < text.length && depth > 0; i++) {
			if (text[i] === "(") depth++;
			else if (text[i] === ")") depth--;
		}
		calls.push(text.slice(start, i - 1));
	}
	return calls;
}

const appPath = (path: string) => relative(APP, path).replace(/\\/g, "/");

const CONTRACT_CALL = /describeJobContract\(\s*"[^"]*",\s*"([^"]+)"/g;

describe("the job contract", () => {
	// A job with a cancel button is a promise that cancelling stops it. Registering one without
	// running it through describeJobContract is how a run that outlives its Stop ships.
	it("holds every module that registers a cancellable job", () => {
		const registering = sourceFiles(join(APP, "src"))
			.filter((file) => {
				const text = readFileSync(file, "utf8");
				return (
					callArguments(text, "registerJob").some((args) => /\bcancel\b/.test(args)) ||
					callArguments(text, "runJob").length > 0
				);
			})
			.map(appPath)
			.sort();

		const contracted = sourceFiles(join(APP, "test/unit")).flatMap((file) =>
			[...readFileSync(file, "utf8").matchAll(CONTRACT_CALL)].map((m) => m[1]),
		);

		expect(registering.length).toBeGreaterThan(0);
		expect(registering).toEqual([...new Set(contracted)].sort());
	});
});
