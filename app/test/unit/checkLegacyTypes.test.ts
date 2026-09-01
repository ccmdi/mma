import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareTypes } from "../../../plugins/check-legacy.mjs";

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
});
