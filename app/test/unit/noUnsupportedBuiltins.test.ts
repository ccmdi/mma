import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "vitest";
import rule from "../../eslint-rules/no-unsupported-builtins.js";

RuleTester.describe = describe;
RuleTester.it = it;

// The rule resolves receivers through the type checker, so cases have to belong to a real
// TS project. test/fixtures/compat/case.ts exists only to be that anchor.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/compat");
const filename = path.join(root, "case.ts");

const tester = new RuleTester({
	languageOptions: {
		parser: tseslint.parser as never,
		parserOptions: {
			project: "./tsconfig.json",
			tsconfigRootDir: root,
			// CI=true flips typescript-estree into single-run mode, whose one-shot program
			// can't track the RuleTester re-parsing case.ts with different code per case.
			disallowAutomaticSingleRunInference: true,
		},
	},
});

// Pinned against FLOOR = { safari: 18.4, chrome: 140 }. If the floor moves these move too.
tester.run("no-unsupported-builtins", rule as never, {
	valid: [
		// At or below the floor.
		{ code: "const a = new Set([1]); export const x = a.union(a);", filename },
		{ code: "const a = new Set([1]); export const x = a.intersection(a);", filename },
		{ code: "const a = new Set([1]); export const x = a.isSubsetOf(a);", filename },
		{ code: 'export const x = RegExp.escape("x");', filename },
		{ code: "export const x = Object.groupBy([1], (n) => n);", filename },
		{ code: "export const x = Promise.withResolvers();", filename },
		{ code: 'export const x = new Intl.DurationFormat("en");', filename },
		// A ReadonlySet reaches the same Set methods under a different interface name.
		{
			code: "const a: ReadonlySet<string> = new Set(); export const x = a.intersection(a);",
			filename,
		},
		// Iterator helpers, resolved through ArrayIterator -> IteratorObject -> Iterator.
		{ code: "export const x = Iterator.from([1]);", filename },
		{ code: 'export const x = JSON.rawJSON("1");', filename },
		{ code: "export const x = [1].values().take(1).toArray();", filename },
		{ code: "export const x = [1].values().map((n) => n);", filename },
		// Our own methods, however named. This is what type resolution buys over name matching.
		{
			code: "class P { take(n: number) { return n; } toArray() { return [1]; } }\nexport const x = [new P().take(1), new P().toArray()];",
			filename,
		},
		// A local binding shadowing a blocked global.
		{ code: "const Temporal = { now: () => 1 }; export const x = Temporal.now();", filename },
		// Web APIs (bcd.api) that clear the floor.
		{ code: 'export const x = URL.parse("https://x.test");', filename },
		{ code: "export const x = AbortSignal.any([]);", filename },
		{ code: 'export const x = new CompressionStream("gzip");', filename },
	],
	invalid: [
		{
			code: "export const x = Temporal.Now.instant();",
			filename,
			errors: [{ messageId: "unsupported" }],
		},
		// Web APIs (bcd.api) below the floor.
		{
			code: "export const x = new URLPattern({});",
			filename,
			errors: [{ messageId: "unsupported" }],
		},
		{
			code: "export const x = new Blob([]).bytes();",
			filename,
			errors: [{ messageId: "unsupported" }],
		},
	],
});
