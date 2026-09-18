import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareTypes, prepare } from "../../../plugins/check-legacy.mjs";

// The type half of the plugin API promise: check-legacy.mjs fails the build when a stable
// exported declaration loses a member, gets one renamed, or narrows one between the support
// floor and HEAD. Additions and `@unstable` members stay free.
function compare(
	oldDts: string,
	newDts: string,
): { missing: string[]; broken: { name: string }[] } {
	const dir = mkdtempSync(join(tmpdir(), "mma-legacy-"));
	try {
		writeFileSync(join(dir, "old.d.ts"), oldDts);
		writeFileSync(join(dir, "new.d.ts"), newDts);
		return compareTypes(join(dir, "old.d.ts"), join(dir, "new.d.ts"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const names = (r: { broken: { name: string }[] }) => r.broken.map((b) => b.name);

describe("check-legacy sees the exported type surface", () => {
	it("passes when nothing changed", () => {
		const dts = `export interface Foo { a: string; b: number; }`;
		expect(compare(dts, dts)).toEqual({ missing: [], broken: [] });
	});

	it("fails when a stable member is removed", () => {
		const r = compare(
			`export interface Foo { a: string; b: number; }`,
			`export interface Foo { a: string; }`,
		);
		expect(names(r)).toEqual(["Foo"]);
	});

	it("passes when an @unstable member is removed", () => {
		const r = compare(
			`export interface Foo {\n\ta: string;\n\t/** @unstable */\n\tb: number;\n}`,
			`export interface Foo { a: string; }`,
		);
		expect(r).toEqual({ missing: [], broken: [] });
	});

	it("passes when an @unstable member of one half of an intersection is removed", () => {
		const r = compare(
			`export interface Ui {
	a: string;
	/** @unstable */
	b: number;
}
export type State = Ui & { c: boolean };`,
			`export interface Ui { a: string; }
export type State = Ui & { c: boolean };`,
		);
		expect(r).toEqual({ missing: [], broken: [] });
	});

	it("passes when a member is added", () => {
		const r = compare(
			`export interface Foo { a: string; }`,
			`export interface Foo { a: string; b: number; c?: boolean; }`,
		);
		expect(r).toEqual({ missing: [], broken: [] });
	});

	it("fails when a field on a stable interface is renamed", () => {
		const r = compare(
			`export interface Outcome { success: boolean; }`,
			`export interface Outcome { succeeded: boolean; }`,
		);
		expect(names(r)).toEqual(["Outcome"]);
	});

	it("fails when a stable exported declaration is gone", () => {
		const r = compare(
			`export interface Foo { a: string; }\nexport type Bar = string;`,
			`export type Bar = string;`,
		);
		expect(r.missing).toEqual(["Foo"]);
	});

	it("passes when a member type widens, fails when it narrows", () => {
		const narrow = `export interface Foo { a: string; }`;
		const wide = `export interface Foo { a: string | number; }`;
		expect(compare(narrow, wide)).toEqual({ missing: [], broken: [] });
		expect(names(compare(wide, narrow))).toEqual(["Foo"]);
	});

	it("passes when a member becomes optional", () => {
		const r = compare(
			`export interface Foo { a: string; }`,
			`export interface Foo { a?: string; }`,
		);
		expect(r).toEqual({ missing: [], broken: [] });
	});

	it("passes when a const tuple gains an entry, fails when it loses one", () => {
		const two = `declare const F: readonly [{ readonly key: "a" }, { readonly key: "b" }];
export { F };`;
		const three = `declare const F: readonly [{ readonly key: "a" }, { readonly key: "b" }, { readonly key: "c" }];
export { F };`;
		expect(compare(two, three)).toEqual({ missing: [], broken: [] });
		expect(names(compare(three, two))).toEqual(["F"]);
	});

	it("fails when an exported function narrows its return", () => {
		const r = compare(
			`export declare function f(x: string): string;`,
			`export declare function f(x: string): "literal";`,
		);
		expect(names(r)).toEqual(["f"]);
	});

	// Every rule holds at every depth: a nested member is judged exactly like a top-level one.
	const U = "\n/** @unstable */\n";
	it.each([
		[
			"top-level addition",
			`export interface A { a: string }`,
			`export interface A { a: string; b: string }`,
			[],
		],
		[
			"nested addition",
			`export interface A { cmd: { a(): void } }`,
			`export interface A { cmd: { a(): void; b(): void } }`,
			[],
		],
		[
			"deep addition",
			`export interface A { x: { y: { a: string } } }`,
			`export interface A { x: { y: { a: string; b: number } } }`,
			[],
		],
		[
			"nested stable removal",
			`export interface A { cmd: { a(): void; b(): void } }`,
			`export interface A { cmd: { a(): void } }`,
			["A"],
		],
		[
			"deep stable removal",
			`export interface A { x: { y: { a: string; b: number } } }`,
			`export interface A { x: { y: { a: string } } }`,
			["A"],
		],
		[
			"nested stable narrowing",
			`export interface A { cmd: { a: string | number } }`,
			`export interface A { cmd: { a: string } }`,
			["A"],
		],
		[
			"nested stable widening",
			`export interface A { cmd: { a: string } }`,
			`export interface A { cmd: { a: string | number } }`,
			[],
		],
		[
			"nested unstable removal",
			`export interface A { cmd: { a(): void; ${U} b(): void } }`,
			`export interface A { cmd: { a(): void } }`,
			[],
		],
		[
			"nested unstable narrowing",
			`export interface A { cmd: { a: string; ${U} b: string | number } }`,
			`export interface A { cmd: { a: string; b: string } }`,
			[],
		],
		[
			"anything under an unstable parent",
			`export interface A { ${U} cmd: { x: { a: string | number; b: string } } }`,
			`export interface A { cmd: { x: { a: string } } }`,
			[],
		],
		[
			"nested tuple append",
			`export interface A { consts: { C: readonly ["a"] } }`,
			`export interface A { consts: { C: readonly ["a", "b"] } }`,
			[],
		],
		[
			"nested tuple loss",
			`export interface A { consts: { C: readonly ["a", "b"] } }`,
			`export interface A { consts: { C: readonly ["a"] } }`,
			["A"],
		],
		[
			"nested member unstable at the declaration it points at",
			`${U} declare const P: string | number;
declare const c_P: typeof P;
export interface A { consts: { P: typeof c_P } }`,
			`${U} declare const P: string;
declare const c_P: typeof P;
export interface A { consts: { P: typeof c_P } }`,
			[],
		],
		[
			"recursive type addition",
			`export interface N { v: string; next?: N }`,
			`export interface N { v: string; w?: number; next?: N }`,
			[],
		],
		[
			"recursive type narrowing",
			`export interface N { v: string | number; next?: N }`,
			`export interface N { v: string; next?: N }`,
			["N"],
		],
	])("%s", (_case, before, after, broken) => {
		expect(names(compare(before, after))).toEqual(broken);
	});

	it("the SDK compares clean against itself, so no promised type is nominal", () => {
		const typesDir = join(__dirname, "../../../plugins/types");
		const sdk = prepare(readFileSync(join(typesDir, "mma.d.ts"), "utf-8"));
		const [a, b] = [join(typesDir, ".self-a.d.ts"), join(typesDir, ".self-b.d.ts")];
		try {
			writeFileSync(a, sdk);
			writeFileSync(b, sdk);
			expect(compareTypes(a, b)).toEqual({ missing: [], broken: [] });
		} finally {
			rmSync(a, { force: true });
			rmSync(b, { force: true });
		}
	});
});
