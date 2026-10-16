import { describe, it, expect } from "vitest";
import type { PatchOp } from "@/bindings.gen";
import { applyPatch, touches } from "@/lib/util/jsonPatch";

// RFC 6902 Appendix A.
const cases: [string, unknown, PatchOp[], unknown][] = [
	[
		"A.1 adding an object member",
		{ foo: "bar" },
		[{ op: "add", path: "/baz", value: "qux" }],
		{ baz: "qux", foo: "bar" },
	],
	[
		"A.2 adding an array element",
		{ foo: ["bar", "baz"] },
		[{ op: "add", path: "/foo/1", value: "qux" }],
		{ foo: ["bar", "qux", "baz"] },
	],
	[
		"A.3 removing an object member",
		{ baz: "qux", foo: "bar" },
		[{ op: "remove", path: "/baz" }],
		{ foo: "bar" },
	],
	[
		"A.4 removing an array element",
		{ foo: ["bar", "qux", "baz"] },
		[{ op: "remove", path: "/foo/1" }],
		{ foo: ["bar", "baz"] },
	],
	[
		"A.5 replacing a value",
		{ baz: "qux", foo: "bar" },
		[{ op: "replace", path: "/baz", value: "boo" }],
		{ baz: "boo", foo: "bar" },
	],
	[
		"A.6 moving a value",
		{ foo: { bar: "baz", waldo: "fred" }, qux: { corge: "grault" } },
		[{ op: "move", from: "/foo/waldo", path: "/qux/thud" }],
		{ foo: { bar: "baz" }, qux: { corge: "grault", thud: "fred" } },
	],
	[
		"A.7 moving an array element",
		{ foo: ["all", "grass", "cows", "eat"] },
		[{ op: "move", from: "/foo/1", path: "/foo/3" }],
		{ foo: ["all", "cows", "eat", "grass"] },
	],
	[
		"A.8 testing a value",
		{ baz: "qux", foo: ["a", 2, "c"] },
		[
			{ op: "test", path: "/baz", value: "qux" },
			{ op: "test", path: "/foo/1", value: 2 },
		],
		{ baz: "qux", foo: ["a", 2, "c"] },
	],
	[
		"A.10 adding a nested member object",
		{ foo: "bar" },
		[{ op: "add", path: "/child", value: { grandchild: {} } }],
		{ foo: "bar", child: { grandchild: {} } },
	],
	[
		"A.14 ~ escape ordering",
		{ "/": 9, "~1": 10 },
		[{ op: "test", path: "/~01", value: 10 }],
		{ "/": 9, "~1": 10 },
	],
	[
		"A.16 adding an array value",
		{ foo: ["bar"] },
		[{ op: "add", path: "/foo/-", value: ["abc", "def"] }],
		{ foo: ["bar", ["abc", "def"]] },
	],
];

const failing: [string, unknown, PatchOp[]][] = [
	["A.9 testing a value: error", { baz: "qux" }, [{ op: "test", path: "/baz", value: "bar" }]],
	[
		"A.12 adding to a nonexistent target",
		{ foo: "bar" },
		[{ op: "add", path: "/baz/bat", value: "qux" }],
	],
	[
		"A.15 comparing strings and numbers",
		{ "/": 9, "~1": 10 },
		[{ op: "test", path: "/~01", value: "10" }],
	],
	["removing what is not there", { foo: 1 }, [{ op: "remove", path: "/bar" }]],
	["replacing what is not there", { foo: 1 }, [{ op: "replace", path: "/bar", value: 2 }]],
	["moving a value into itself", { a: { b: 1 } }, [{ op: "move", from: "/a", path: "/a/b" }]],
];

describe("JSON Patch", () => {
	it.each(cases)("%s", (_, doc, patch, expected) => {
		expect(applyPatch(doc, patch)).toEqual(expected);
	});

	it.each(failing)("%s fails and leaves the document as it was", (_, doc, patch) => {
		const before = structuredClone(doc);
		expect(() => applyPatch(doc, patch)).toThrow();
		expect(doc).toEqual(before);
	});

	it("keeps nulls inside a value and replaces it whole", () => {
		const doc = { rows: { a: { polygon: { extra: [[0, 0]], name: "x" } } } };
		const next = applyPatch(doc, [
			{ op: "add", path: "/rows/a", value: { polygon: { extra: null } } },
		]);
		expect(next.rows.a).toEqual({ polygon: { extra: null } });
	});

	it("copies only the containers on the way to what it changes", () => {
		const doc = { held: { a: [1] }, moved: { b: 1 } };
		const next = applyPatch(doc, [{ op: "replace", path: "/moved/b", value: 2 }]);
		expect(next.held).toBe(doc.held);
		expect(next.moved).not.toBe(doc.moved);
		expect(doc.moved.b).toBe(1);
	});

	it("replaces the whole document at the empty path", () => {
		expect(applyPatch({ a: 1 }, [{ op: "replace", path: "", value: [1] }])).toEqual([1]);
	});

	it("tells whether a patch touches a pointer, its parts, or what holds it", () => {
		const patch: PatchOp[] = [{ op: "remove", path: "/fieldValues/tags/7" }];
		expect(touches(patch, "/fieldValues/tags")).toBe(true);
		expect(touches(patch, "/fieldValues")).toBe(true);
		expect(touches(patch, "/fieldValues/tags/7")).toBe(true);
		expect(touches(patch, "/fieldValues/tagsx")).toBe(false);
		expect(touches([{ op: "replace", path: "/fieldValues", value: {} }], "/fieldValues/tags")).toBe(
			true,
		);
	});
});
