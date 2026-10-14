import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { API } from "@typescript/native/unstable/sync";
import { checkProject } from "../../scripts/check-browser-compat.mjs";
import { startCompiler } from "../../scripts/native-ts.mjs";

let directory: string, filename: string, config: string, api: API;
beforeAll(() => {
	directory = mkdtempSync(path.join(tmpdir(), "mma-browser-compat-"));
	filename = path.join(directory, "case.ts");
	config = path.join(directory, "tsconfig.json");
	writeFileSync(filename, "export {};");
	writeFileSync(
		config,
		JSON.stringify({
			compilerOptions: {
				target: "es2023",
				lib: ["ESNext", "DOM"],
				strict: true,
				noEmit: true,
				module: "esnext",
				moduleDetection: "force",
				moduleResolution: "bundler",
			},
			include: ["case.ts"],
		}),
	);
});
afterAll(() => {
	api?.close();
	if (
		directory &&
		path.dirname(directory) === path.resolve(tmpdir()) &&
		path.basename(directory).startsWith("mma-browser-compat-")
	)
		rmSync(directory, { recursive: true, force: true });
});
function check(code: string) {
	writeFileSync(filename, code);
	api?.close();
	api = startCompiler({ cwd: directory });
	const snapshot = api.updateSnapshot({ openProjects: [config] });
	try {
		const project = snapshot.getProject(config);
		if (!project) throw new Error("Missing compatibility test project");
		return checkProject(project, [filename]);
	} finally {
		snapshot.dispose();
	}
}

const valid = [
	"const a = new Set([1]); export const x = a.union(a);",
	"const a = new Set([1]); export const x = a.intersection(a);",
	"const a = new Set([1]); export const x = a.isSubsetOf(a);",
	'export const x = RegExp.escape("x");',
	"export const x = Object.groupBy([1], (n) => n);",
	"export const x = Promise.withResolvers();",
	'export const x = new Intl.DurationFormat("en");',
	"const a: ReadonlySet<string> = new Set(); export const x = a.intersection(a);",
	"export const x = Iterator.from([1]);",
	'export const x = JSON.rawJSON("1");',
	"export const x = [1].values().take(1).toArray();",
	"export const x = [1].values().map((n) => n);",
	"class P { take(n: number) { return n; } toArray() { return [1]; } }\nexport const x = [new P().take(1), new P().toArray()];",
	"const Temporal = { now: () => 1 }; export const x = Temporal.now();",
	'export const x = URL.parse("https://x.test");',
	"export const x = AbortSignal.any([]);",
	'export const x = new CompressionStream("gzip");',
];
const invalid = [
	{
		code: "export const x = Temporal.Now.instant();",
		name: "Temporal",
	},
	{
		code: "export const x = new URLPattern({});",
		name: "URLPattern",
	},
	{
		code: "export const x = new Blob([]).bytes();",
		name: "Blob.bytes",
	},
];

describe("native browser compatibility", () => {
	it.each(valid)("accepts %s", (code) => {
		expect(check(code)).toEqual([]);
	});
	it.each(invalid)("rejects $name", ({ code, name }) => {
		expect(check(code).map((d) => d.name)).toEqual([name]);
	});
	it.each([
		{ code: "class Own { bytes() { return 1; } } new Own().bytes();", names: [] },
		{ code: "const URLPattern = class {}; new URLPattern();", names: [] },
		{ code: "const Temporal = {}; export const x = { Temporal };", names: [] },
		{ code: "const x = { Temporal: 1, URLPattern: 2 }; export { x };", names: [] },
		{ code: "class Derived extends Blob {} new Derived().bytes();", names: ["Blob.bytes"] },
		{ code: "declare const blob: Blob | null; blob?.bytes();", names: ["Blob.bytes"] },
		{
			code: "declare const blob: Blob | { bytes(): number }; blob.bytes();",
			names: ["Blob.bytes"],
		},
		{ code: "export const x = { Temporal };", names: ["Temporal"] },
	])("resolves receiver and scope: $code", ({ code, names }) => {
		expect(check(code).map((d) => d.name)).toEqual(names);
	});
	it("honors a reasoned suppression", () => {
		expect(
			check("// browser-compat-disable-next-line -- feature detected\nnew Blob([]).bytes();"),
		).toEqual([]);
	});
	it("honors a block comment suppression", () => {
		expect(
			check("/* browser-compat-disable-next-line -- feature detected */\nnew Blob([]).bytes();"),
		).toEqual([]);
	});
	it("requires a suppression reason", () => {
		const diagnostics = check("// browser-compat-disable-next-line\nnew Blob([]).bytes();");
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics[0].message).toContain("requires a reason");
		expect(diagnostics[1].name).toBe("Blob.bytes");
	});
	it("rejects unused suppressions", () => {
		expect(
			check("// browser-compat-disable-next-line -- feature detected\nnew Blob([]);")[0].message,
		).toContain("Unused");
	});
	it("does not treat string contents as comments", () => {
		expect(
			check(
				"const text = `\n// browser-compat-disable-next-line -- fake\n`; new Blob([]).bytes();",
			).map((d) => d.name),
		).toEqual(["Blob.bytes"]);
	});
	it("fails if an input file is missing from the project", () => {
		const snapshot = api.updateSnapshot();
		try {
			expect(() =>
				checkProject(snapshot.getProject(config)!, [path.join(directory, "missing.ts")]),
			).toThrow("is missing");
		} finally {
			snapshot.dispose();
		}
	});
});
