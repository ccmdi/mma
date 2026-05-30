import { describe, it, expect } from "vitest";
import {
	planFieldMove,
	planFieldDelete,
	planFieldSet,
	rewriteSelectionFields,
} from "@/lib/data/fieldOps.add";
import { buildSelection } from "@/store/selections";
import type { Location, MapData } from "@/types";

function makeLoc(id: number, extra?: Record<string, unknown>): Location {
	return {
		id,
		lat: 0,
		lng: 0,
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId: null,
		flags: 0,
		tags: [],
		extra,
		createdAt: "",
		modifiedAt: null,
	} as Location;
}

const map = { meta: { tags: {} } } as unknown as MapData;

describe("planFieldMove", () => {
	it("renames a key (target absent)", () => {
		const out = planFieldMove([makeLoc(1, { a: 5 })], "a", "b", "from");
		expect(out).toEqual([{ id: 1, extra: { b: 5 } }]);
	});

	it("merge: winner 'from' takes the moved value", () => {
		const out = planFieldMove([makeLoc(1, { a: 5, b: 9 })], "a", "b", "from");
		expect(out).toEqual([{ id: 1, extra: { b: 5 } }]);
	});

	it("merge: winner 'to' keeps the existing target value", () => {
		const out = planFieldMove([makeLoc(1, { a: 5, b: 9 })], "a", "b", "to");
		expect(out).toEqual([{ id: 1, extra: { b: 9 } }]);
	});

	it("skips locations without the source key", () => {
		expect(planFieldMove([makeLoc(1, { x: 1 })], "a", "b", "from")).toEqual([]);
	});

	it("preserves unrelated keys", () => {
		const out = planFieldMove([makeLoc(1, { a: 5, keep: 1 })], "a", "b", "from");
		expect(out[0].extra).toEqual({ b: 5, keep: 1 });
	});

	it("is a no-op when from === to or to is empty", () => {
		expect(planFieldMove([makeLoc(1, { a: 5 })], "a", "a", "from")).toEqual([]);
		expect(planFieldMove([makeLoc(1, { a: 5 })], "a", "", "from")).toEqual([]);
	});
});

describe("planFieldDelete", () => {
	it("removes the key from locations that have it", () => {
		const out = planFieldDelete([makeLoc(1, { a: 5, b: 9 }), makeLoc(2, { b: 1 })], "a");
		expect(out).toEqual([{ id: 1, extra: { b: 9 } }]);
	});
});

describe("planFieldSet", () => {
	it("sets the value, creating extra when absent", () => {
		const out = planFieldSet([makeLoc(1), makeLoc(2, { k: "old" })], "k", "new");
		expect(out).toEqual([
			{ id: 1, extra: { k: "new" } },
			{ id: 2, extra: { k: "new" } },
		]);
	});

	it("skips locations already equal", () => {
		expect(planFieldSet([makeLoc(1, { k: "v" })], "k", "v")).toEqual([]);
	});
});

describe("rewriteSelectionFields", () => {
	const filter = (field: string) =>
		buildSelection(map, { type: "Filter", field, op: "eq", value: 1, value2: null });

	it("rewrites a Filter field and regenerates its key", () => {
		const out = rewriteSelectionFields(map, [filter("a")], "a", "b");
		expect(out).toHaveLength(1);
		expect((out[0].props as { field: string }).field).toBe("b");
		expect(out[0].key).toBe("filter:b:eq:1");
	});

	it("leaves unrelated filters untouched", () => {
		const f = filter("c");
		const out = rewriteSelectionFields(map, [f], "a", "b");
		expect(out[0].key).toBe(f.key);
	});

	it("drops a Filter when the field is deleted (to = null)", () => {
		expect(rewriteSelectionFields(map, [filter("a")], "a", null)).toEqual([]);
	});

	it("rewrites filters nested in a composite", () => {
		const union = buildSelection(map, { type: "Union", selections: [filter("a"), filter("c")] });
		const out = rewriteSelectionFields(map, [union], "a", "b");
		const children = (out[0].props as { selections: { props: { field: string } }[] }).selections;
		expect(children.map((c) => c.props.field)).toEqual(["b", "c"]);
	});

	it("collapses a group to its sole survivor when a child is deleted", () => {
		const tag = buildSelection(map, { type: "Tag", tagId: 1 });
		const union = buildSelection(map, { type: "Union", selections: [filter("a"), tag] });
		const out = rewriteSelectionFields(map, [union], "a", null);
		expect(out).toHaveLength(1);
		expect(out[0].props.type).toBe("Tag");
	});
});
