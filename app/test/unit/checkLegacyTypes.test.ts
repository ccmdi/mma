import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepare } from "../../../plugins/check-legacy.mjs";
import { compareAll, type CompareJob, type CompareResult } from "./fixtures/legacyCompare";

// The type half of the plugin API promise: check-legacy.mjs fails the build when a stable
// exported declaration loses a member, gets one renamed, or narrows one between the support
// floor and HEAD. Additions and `@unstable` members stay free.

const U = "\n/** @unstable */\n";
const typesDir = join(__dirname, "../../../plugins/types");
const sdk = prepare(readFileSync(join(typesDir, "mma.d.ts"), "utf-8"));

interface Case extends CompareJob {
	name: string;
	missing?: string[];
	broken?: string[];
}

const CASES: Case[] = [
	{
		name: "passes when nothing changed",
		before: `export interface Foo { a: string; b: number; }`,
		after: `export interface Foo { a: string; b: number; }`,
	},
	{
		name: "fails when a stable member is removed",
		before: `export interface Foo { a: string; b: number; }`,
		after: `export interface Foo { a: string; }`,
		broken: ["Foo"],
	},
	{
		name: "passes when an @unstable member is removed",
		before: `export interface Foo {\n\ta: string;\n\t/** @unstable */\n\tb: number;\n}`,
		after: `export interface Foo { a: string; }`,
	},
	{
		name: "passes when an @unstable member of one half of an intersection is removed",
		before: `export interface Ui {
	a: string;
	/** @unstable */
	b: number;
}
export type State = Ui & { c: boolean };`,
		after: `export interface Ui { a: string; }
export type State = Ui & { c: boolean };`,
	},
	{
		name: "passes when a member is added",
		before: `export interface Foo { a: string; }`,
		after: `export interface Foo { a: string; b: number; c?: boolean; }`,
	},
	{
		name: "fails when a field on a stable interface is renamed",
		before: `export interface Outcome { success: boolean; }`,
		after: `export interface Outcome { succeeded: boolean; }`,
		broken: ["Outcome"],
	},
	{
		name: "fails when a stable exported declaration is gone",
		before: `export interface Foo { a: string; }\nexport type Bar = string;`,
		after: `export type Bar = string;`,
		missing: ["Foo"],
	},
	{
		name: "passes when a member type widens",
		before: `export interface Foo { a: string; }`,
		after: `export interface Foo { a: string | number; }`,
	},
	{
		name: "fails when a member type narrows",
		before: `export interface Foo { a: string | number; }`,
		after: `export interface Foo { a: string; }`,
		broken: ["Foo"],
	},
	{
		name: "passes when a member becomes optional",
		before: `export interface Foo { a: string; }`,
		after: `export interface Foo { a?: string; }`,
	},
	{
		name: "passes when a const tuple gains an entry",
		before: `declare const F: readonly [{ readonly key: "a" }, { readonly key: "b" }];
export { F };`,
		after: `declare const F: readonly [{ readonly key: "a" }, { readonly key: "b" }, { readonly key: "c" }];
export { F };`,
	},
	{
		name: "fails when a const tuple loses an entry",
		before: `declare const F: readonly [{ readonly key: "a" }, { readonly key: "b" }, { readonly key: "c" }];
export { F };`,
		after: `declare const F: readonly [{ readonly key: "a" }, { readonly key: "b" }];
export { F };`,
		broken: ["F"],
	},
	{
		name: "fails when an exported function narrows its return",
		before: `export declare function f(x: string): string;`,
		after: `export declare function f(x: string): "literal";`,
		broken: ["f"],
	},

	// Every rule holds at every depth: a nested member is judged exactly like a top-level one.
	{
		name: "top-level addition",
		before: `export interface A { a: string }`,
		after: `export interface A { a: string; b: string }`,
	},
	{
		name: "nested addition",
		before: `export interface A { cmd: { a(): void } }`,
		after: `export interface A { cmd: { a(): void; b(): void } }`,
	},
	{
		name: "deep addition",
		before: `export interface A { x: { y: { a: string } } }`,
		after: `export interface A { x: { y: { a: string; b: number } } }`,
	},
	{
		name: "nested stable removal",
		before: `export interface A { cmd: { a(): void; b(): void } }`,
		after: `export interface A { cmd: { a(): void } }`,
		broken: ["A"],
	},
	{
		name: "deep stable removal",
		before: `export interface A { x: { y: { a: string; b: number } } }`,
		after: `export interface A { x: { y: { a: string } } }`,
		broken: ["A"],
	},
	{
		name: "nested stable narrowing",
		before: `export interface A { cmd: { a: string | number } }`,
		after: `export interface A { cmd: { a: string } }`,
		broken: ["A"],
	},
	{
		name: "nested stable widening",
		before: `export interface A { cmd: { a: string } }`,
		after: `export interface A { cmd: { a: string | number } }`,
	},
	{
		name: "nested unstable removal",
		before: `export interface A { cmd: { a(): void; ${U} b(): void } }`,
		after: `export interface A { cmd: { a(): void } }`,
	},
	{
		name: "nested unstable narrowing",
		before: `export interface A { cmd: { a: string; ${U} b: string | number } }`,
		after: `export interface A { cmd: { a: string; b: string } }`,
	},
	{
		name: "anything under an unstable parent",
		before: `export interface A { ${U} cmd: { x: { a: string | number; b: string } } }`,
		after: `export interface A { cmd: { x: { a: string } } }`,
	},
	{
		name: "nested tuple append",
		before: `export interface A { consts: { C: readonly ["a"] } }`,
		after: `export interface A { consts: { C: readonly ["a", "b"] } }`,
	},
	{
		name: "nested tuple loss",
		before: `export interface A { consts: { C: readonly ["a", "b"] } }`,
		after: `export interface A { consts: { C: readonly ["a"] } }`,
		broken: ["A"],
	},
	{
		name: "nested member unstable at the declaration it points at",
		before: `${U} declare const P: string | number;
declare const c_P: typeof P;
export interface A { consts: { P: typeof c_P } }`,
		after: `${U} declare const P: string;
declare const c_P: typeof P;
export interface A { consts: { P: typeof c_P } }`,
	},
	{
		name: "recursive type addition",
		before: `export interface N { v: string; next?: N }`,
		after: `export interface N { v: string; w?: number; next?: N }`,
	},
	{
		name: "recursive type narrowing",
		before: `export interface N { v: string | number; next?: N }`,
		after: `export interface N { v: string; next?: N }`,
		broken: ["N"],
	},

	{
		name: "the SDK compares clean against itself, so no promised type is nominal",
		before: sdk,
		after: sdk,
		dir: typesDir,
	},
];

describe("check-legacy sees the exported type surface", () => {
	let results: CompareResult[];
	beforeAll(async () => {
		results = await compareAll(CASES);
	}, 300_000);

	it.each(CASES.map((c, i) => [c.name, c, i] as const))("%s", (_name, c, i) => {
		expect(results[i]).toEqual({ missing: c.missing ?? [], broken: c.broken ?? [] });
	});
});
