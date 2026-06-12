import { describe, it, expect } from "vitest";
import {
	planFieldMove,
	planFieldDelete,
	planFieldSet,
	planFieldExpr,
	parseFieldExpr,
	evalFieldExpr,
	fieldValue,
	fieldPatch,
	groupByField,
	projectionsForType,
	TAG_PROJECTIONS,
	rewriteSelectionFields,
	pickPeriodEnd,
	hasTimeOfDay,
	stepFilterWindow,
	dateParts,
	partsToEpoch,
	type ProjectionCtx,
} from "@/lib/data/fieldOps";
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
		createdAt: 0,
		modifiedAt: null,
	} as Location;
}

const map = { meta: { tags: {} } } as unknown as MapData;

describe("planFieldMove", () => {
	it("renames a key (target absent)", () => {
		const out = planFieldMove([makeLoc(1, { a: 5 })], "a", "b", "from");
		expect(out).toEqual([{ id: 1, patch: { extra: { b: 5 } } }]);
	});

	it("merge: winner 'from' takes the moved value", () => {
		const out = planFieldMove([makeLoc(1, { a: 5, b: 9 })], "a", "b", "from");
		expect(out).toEqual([{ id: 1, patch: { extra: { b: 5 } } }]);
	});

	it("merge: winner 'to' keeps the existing target value", () => {
		const out = planFieldMove([makeLoc(1, { a: 5, b: 9 })], "a", "b", "to");
		expect(out).toEqual([{ id: 1, patch: { extra: { b: 9 } } }]);
	});

	it("skips locations without the source key", () => {
		expect(planFieldMove([makeLoc(1, { x: 1 })], "a", "b", "from")).toEqual([]);
	});

	it("preserves unrelated keys", () => {
		const out = planFieldMove([makeLoc(1, { a: 5, keep: 1 })], "a", "b", "from");
		expect(out[0].patch.extra).toEqual({ b: 5, keep: 1 });
	});

	it("is a no-op when from === to or to is empty", () => {
		expect(planFieldMove([makeLoc(1, { a: 5 })], "a", "a", "from")).toEqual([]);
		expect(planFieldMove([makeLoc(1, { a: 5 })], "a", "", "from")).toEqual([]);
	});
});

describe("planFieldDelete", () => {
	it("removes the key from locations that have it", () => {
		const out = planFieldDelete([makeLoc(1, { a: 5, b: 9 }), makeLoc(2, { b: 1 })], "a");
		expect(out).toEqual([{ id: 1, patch: { extra: { b: 9 } } }]);
	});
});

describe("planFieldSet", () => {
	it("sets an extra value, creating extra when absent", () => {
		const out = planFieldSet([makeLoc(1), makeLoc(2, { k: "old" })], { extra: { k: "new" } });
		expect(out).toEqual([
			{ id: 1, patch: { extra: { k: "new" } } },
			{ id: 2, patch: { extra: { k: "new" } } },
		]);
	});

	it("merges into existing extra, preserving other keys", () => {
		const out = planFieldSet([makeLoc(1, { keep: 1 })], { extra: { k: "new" } });
		expect(out).toEqual([{ id: 1, patch: { extra: { keep: 1, k: "new" } } }]);
	});

	it("skips locations whose extra value already matches", () => {
		expect(planFieldSet([makeLoc(1, { k: "v" })], { extra: { k: "v" } })).toEqual([]);
	});

	it("patches a top-level field directly", () => {
		const out = planFieldSet([makeLoc(1), makeLoc(2)], { heading: 90 });
		expect(out).toEqual([
			{ id: 1, patch: { heading: 90 } },
			{ id: 2, patch: { heading: 90 } },
		]);
	});

	it("skips top-level fields already equal", () => {
		const loc = makeLoc(1);
		(loc as Record<string, unknown>).pitch = 10;
		expect(planFieldSet([loc], { pitch: 10 })).toEqual([]);
	});
});

describe("fieldPatch", () => {
	it("nests unknown keys under extra", () => {
		expect(fieldPatch("foo", 5)).toEqual({ extra: { foo: 5 } });
	});

	it("places built-in keys at the top level", () => {
		expect(fieldPatch("heading", 90)).toEqual({ heading: 90 });
	});
});

describe("groupByField", () => {
	it("groups locations by their extra field value", () => {
		const locs = [
			makeLoc(1, { country: "FR" }),
			makeLoc(2, { country: "DE" }),
			makeLoc(3, { country: "FR" }),
		];
		const groups = groupByField(locs, "country");
		expect(groups.get("FR")).toEqual([1, 3]);
		expect(groups.get("DE")).toEqual([2]);
		expect(groups.size).toBe(2);
	});

	it("skips locations with null, undefined, or empty string values", () => {
		const locs = [
			makeLoc(1, { x: null }),
			makeLoc(2, { x: undefined }),
			makeLoc(3, { x: "" }),
			makeLoc(4, { x: "val" }),
			makeLoc(5), // no extra at all
		];
		const groups = groupByField(locs, "x");
		expect(groups.size).toBe(1);
		expect(groups.get("val")).toEqual([4]);
	});

	it("coerces non-string values to strings", () => {
		const locs = [makeLoc(1, { n: 42 }), makeLoc(2, { n: 42 })];
		const groups = groupByField(locs, "n");
		expect(groups.get("42")).toEqual([1, 2]);
	});

	it("returns an empty map when no locations have the field", () => {
		expect(groupByField([makeLoc(1, { other: "x" })], "missing").size).toBe(0);
	});

	it("groups by a key function and skips locations whose key is null", () => {
		const locs = [makeLoc(1, { n: 84 }), makeLoc(2, { n: 1237 }), makeLoc(3, { n: "junk" })];
		const groups = groupByField(locs, "n", (v) => {
			const x = Number(v);
			return Number.isFinite(x) ? String(Math.floor(x / 500) * 500) : null;
		});
		expect(groups.get("0")).toEqual([1]);
		expect(groups.get("1000")).toEqual([2]);
		expect(groups.size).toBe(2);
	});
});

describe("tag projections", () => {
	const proj = (id: string) => TAG_PROJECTIONS.find((p) => p.id === id)!;
	const dateCtx = (over: Partial<ProjectionCtx> = {}): ProjectionCtx => ({
		fieldType: "date",
		loc: makeLoc(1),
		...over,
	});

	it("projectionsForType filters by field type", () => {
		expect(projectionsForType("string").map((p) => p.id)).toEqual(["value"]);
		expect(projectionsForType("enum").map((p) => p.id)).toEqual(["value"]);
		expect(projectionsForType("number").map((p) => p.id)).toEqual(["value", "bucket"]);
		expect(projectionsForType("month").map((p) => p.id)).toEqual(["value", "year", "monthOfYear"]);
		expect(projectionsForType("date").map((p) => p.id)).toEqual([
			"year", "yearMonth", "day", "monthOfYear", "timeOfDay",
		]);
	});

	it("date projections read viewer-local digits by default", () => {
		// Round-trip through the local-frame codec so the test passes in any runner timezone.
		const ts = partsToEpoch({ y: 2019, mo: 6, d: 14, h: 13 }, false);
		expect(proj("year").key(ts, dateCtx())).toBe("2019");
		expect(proj("yearMonth").key(ts, dateCtx())).toBe("2019-07");
		expect(proj("day").key(ts, dateCtx())).toBe("2019-07-14");
		expect(proj("monthOfYear").key(ts, dateCtx())).toBe("July");
		expect(proj("timeOfDay").key(ts, dateCtx())).toBe("Afternoon");
	});

	it("time-of-day bucket boundaries", () => {
		const at = (h: number) => partsToEpoch({ y: 2020, mo: 0, d: 1, h }, false);
		expect(proj("timeOfDay").key(at(5), dateCtx())).toBe("Night");
		expect(proj("timeOfDay").key(at(6), dateCtx())).toBe("Morning");
		expect(proj("timeOfDay").key(at(12), dateCtx())).toBe("Afternoon");
		expect(proj("timeOfDay").key(at(18), dateCtx())).toBe("Evening");
	});

	it("non-numeric date values yield null", () => {
		expect(proj("year").key("garbage", dateCtx())).toBeNull();
		expect(proj("year").key(null, dateCtx())).toBeNull();
	});

	it("month field values parse from YYYY-MM strings", () => {
		const ctx = (loc = makeLoc(1)): ProjectionCtx => ({ fieldType: "month", loc });
		expect(proj("year").key("2019-07", ctx())).toBe("2019");
		expect(proj("monthOfYear").key("2019-07", ctx())).toBe("July");
		expect(proj("year").key("garbage", ctx())).toBeNull();
	});

	it("tzLocal reads digits in the location's timezone, crossing year boundaries", () => {
		// 2019-12-31T20:00:00Z is already 2020-01-01 05:00 in Tokyo (UTC+9, no DST).
		const ts = Date.UTC(2019, 11, 31, 20, 0, 0) / 1000;
		const tokyo = makeLoc(1, { timezone: "Asia/Tokyo" });
		expect(proj("year").key(ts, dateCtx({ loc: tokyo, tzLocal: true }))).toBe("2020");
		expect(proj("day").key(ts, dateCtx({ loc: tokyo, tzLocal: true }))).toBe("2020-01-01");
		expect(proj("timeOfDay").key(ts, dateCtx({ loc: tokyo, tzLocal: true }))).toBe("Night");
	});

	it("tzLocal skips locations without a resolvable timezone (matching tzLocal filters)", () => {
		const ts = Date.UTC(2019, 11, 31, 20, 0, 0) / 1000;
		expect(proj("year").key(ts, dateCtx({ tzLocal: true }))).toBeNull();
		const badTz = makeLoc(1, { timezone: "Not/AZone" });
		expect(proj("year").key(ts, dateCtx({ loc: badTz, tzLocal: true }))).toBeNull();
	});

	it("bucket snaps numbers to fixed-width bands", () => {
		const ctx = (width?: number): ProjectionCtx => ({ fieldType: "number", loc: makeLoc(1), width });
		expect(proj("bucket").key(1237, ctx(500))).toBe("1000-1500");
		expect(proj("bucket").key(84, ctx(500))).toBe("0-500");
		expect(proj("bucket").key(-10, ctx(500))).toBe("-500-0");
		expect(proj("bucket").key(1237, ctx())).toBeNull();
		expect(proj("bucket").key(1237, ctx(0))).toBeNull();
		expect(proj("bucket").key("junk", ctx(500))).toBeNull();
	});
});

describe("rewriteSelectionFields", () => {
	const filter = (field: string) =>
		buildSelection({ type: "Filter", field, op: "eq", value: 1, value2: null });

	it("rewrites a Filter field and regenerates its key", () => {
		const out = rewriteSelectionFields([filter("a")], "a", "b");
		expect(out).toHaveLength(1);
		expect((out[0].props as { field: string }).field).toBe("b");
		expect(out[0].key).toBe("filter:b:eq:1");
	});

	it("leaves unrelated filters untouched", () => {
		const f = filter("c");
		const out = rewriteSelectionFields([f], "a", "b");
		expect(out[0].key).toBe(f.key);
	});

	it("drops a Filter when the field is deleted (to = null)", () => {
		expect(rewriteSelectionFields([filter("a")], "a", null)).toEqual([]);
	});

	it("rewrites filters nested in a composite", () => {
		const union = buildSelection({ type: "Union", selections: [filter("a"), filter("c")] });
		const out = rewriteSelectionFields([union], "a", "b");
		const children = (out[0].props as { selections: { props: { field: string } }[] }).selections;
		expect(children.map((c) => c.props.field)).toEqual(["b", "c"]);
	});

	it("collapses a group to its sole survivor when a child is deleted", () => {
		const tag = buildSelection({ type: "Tag", tagId: 1 });
		const union = buildSelection({ type: "Union", selections: [filter("a"), tag] });
		const out = rewriteSelectionFields([union], "a", null);
		expect(out).toHaveLength(1);
		expect(out[0].props.type).toBe("Tag");
	});
});

describe("field expressions", () => {
	const evalOn = (src: string, loc: Location) => evalFieldExpr(parseFieldExpr(src), loc);

	it("parses and evaluates constants and arithmetic with precedence", () => {
		const loc = makeLoc(1);
		expect(evalOn("45", loc)).toBe(45);
		expect(evalOn("2 + 3 * 4", loc)).toBe(14);
		expect(evalOn("(2 + 3) * 4", loc)).toBe(20);
		expect(evalOn("-5 + 10", loc)).toBe(5);
		expect(evalOn("7 % 4", loc)).toBe(3);
	});

	it("resolves field references from extra and top-level", () => {
		const loc = { ...makeLoc(1, { sunAzimuth: 200 }), heading: 90, lat: 12.5 } as Location;
		expect(evalOn("sunAzimuth + 180", loc)).toBe(380);
		expect(evalOn("heading + 10", loc)).toBe(100);
		expect(evalOn("lat * 2", loc)).toBe(25);
	});

	it("fieldValue mirrors fieldPatch's top-level vs extra split", () => {
		const loc = { ...makeLoc(1, { foo: 7 }), heading: 33 } as Location;
		expect(fieldValue(loc, "heading")).toBe(33);
		expect(fieldValue(loc, "foo")).toBe(7);
		expect(fieldValue(loc, "missing")).toBeUndefined();
	});

	it("supports functions: mod wraps negatives, clamp bounds", () => {
		const loc = makeLoc(1, { sunAzimuth: 200 });
		expect(evalOn("mod(sunAzimuth + 180, 360)", loc)).toBe(20);
		expect(evalOn("mod(-90, 360)", loc)).toBe(270);
		expect(evalOn("clamp(500, 0, 360)", loc)).toBe(360);
		expect(evalOn("abs(-3)", loc)).toBe(3);
		expect(evalOn("min(2, 9)", loc)).toBe(2);
		expect(evalOn("max(2, 9)", loc)).toBe(9);
		expect(evalOn("round(2.6)", loc)).toBe(3);
		expect(evalOn("floor(2.6)", loc)).toBe(2);
	});

	it("returns null for missing or non-numeric fields and non-finite results", () => {
		expect(evalOn("nope + 1", makeLoc(1))).toBeNull();
		expect(evalOn("s + 1", makeLoc(1, { s: "hello" }))).toBeNull();
		expect(evalOn("1 / 0", makeLoc(1))).toBeNull();
	});

	it("throws on syntax errors, unknown functions, and wrong arity", () => {
		expect(() => parseFieldExpr("1 +")).toThrow();
		expect(() => parseFieldExpr("(1 + 2")).toThrow();
		expect(() => parseFieldExpr("1 2")).toThrow();
		expect(() => parseFieldExpr("nope(1)")).toThrow(/Unknown function/);
		expect(() => parseFieldExpr("mod(1)")).toThrow(/argument/);
		expect(() => parseFieldExpr("heading @ 2")).toThrow(/Unexpected character/);
	});

	it("planFieldExpr patches per location, skips unevaluable, drops no-ops", () => {
		const a = { ...makeLoc(1, { sunAzimuth: 200 }), heading: 0 } as Location;
		const b = makeLoc(2); // no sunAzimuth -> skipped
		const c = { ...makeLoc(3, { sunAzimuth: 160 }), heading: 340 } as Location; // already 340 -> no-op
		const { updates, skipped } = planFieldExpr(
			[a, b, c],
			"heading",
			parseFieldExpr("mod(sunAzimuth + 180, 360)"),
		);
		expect(skipped).toBe(1);
		expect(updates).toEqual([{ id: 1, patch: { heading: 20 } }]);
	});

	it("planFieldExpr writes extra fields with merge semantics", () => {
		const loc = makeLoc(1, { sunAzimuth: 90, keep: "x" });
		const { updates } = planFieldExpr([loc], "sunHalf", parseFieldExpr("sunAzimuth / 2"));
		expect(updates).toEqual([{ id: 1, patch: { extra: { sunAzimuth: 90, keep: "x", sunHalf: 45 } } }]);
	});
});

describe("pickPeriodEnd", () => {
	const localMidnight = (y: number, m: number, d: number) =>
		Math.floor(new Date(y, m, d).getTime() / 1000);

	it("day end is 23:59:59 of the same local day, every day of the year (DST-safe)", () => {
		for (let day = 1; day <= 366; day++) {
			const v = localMidnight(2024, 0, day);
			const start = new Date(v * 1000);
			const end = new Date(pickPeriodEnd(v, "day", false) * 1000);
			expect([end.getFullYear(), end.getMonth(), end.getDate()]).toEqual([
				start.getFullYear(),
				start.getMonth(),
				start.getDate(),
			]);
			expect([end.getHours(), end.getMinutes(), end.getSeconds()]).toEqual([23, 59, 59]);
		}
	});

	it("day end is idempotent", () => {
		const v = localMidnight(2024, 5, 3);
		const end = pickPeriodEnd(v, "day", false);
		expect(pickPeriodEnd(end, "day", false)).toBe(end);
	});

	it("wall-clock day end adds a fixed 24h period (no DST in the UTC frame)", () => {
		const v = Math.floor(Date.UTC(2024, 5, 3) / 1000);
		const end = pickPeriodEnd(v, "day", true);
		expect(end).toBe(v + 86399);
		expect(pickPeriodEnd(end, "day", true)).toBe(end);
	});

	it("minute end floors to the minute and adds 59s, idempotently", () => {
		const v = Math.floor(Date.UTC(2024, 5, 3, 0, 5) / 1000);
		const end = pickPeriodEnd(v, "minute", false);
		expect(end).toBe(v + 59);
		expect(pickPeriodEnd(end, "minute", false)).toBe(end);
	});
});

describe("hasTimeOfDay", () => {
	const local = (h: number, m: number, s = 0) =>
		Math.floor(new Date(2024, 5, 3, h, m, s).getTime() / 1000);

	it("midnight is day-grain; any time-of-day is minute-grain", () => {
		expect(hasTimeOfDay(local(0, 0), false)).toBe(false);
		expect(hasTimeOfDay(local(0, 5), false)).toBe(true);
		expect(hasTimeOfDay(local(23, 59, 59), false)).toBe(true);
	});

	it("wall-clock values use the UTC frame", () => {
		const v = Math.floor(Date.UTC(2024, 5, 3) / 1000);
		expect(hasTimeOfDay(v, true)).toBe(false);
		expect(hasTimeOfDay(v + 300, true)).toBe(true);
	});

	it("a day-end bound re-expands to itself (untouched edit round-trip)", () => {
		const midnight = local(0, 0);
		const end = pickPeriodEnd(midnight, "day", false);
		// not midnight -> minute grain on resubmit -> floor+59 -> unchanged
		expect(hasTimeOfDay(end, false)).toBe(true);
		expect(pickPeriodEnd(end, "minute", false)).toBe(end);
	});
});

describe("dateParts / partsToEpoch (wall-clock codec)", () => {
	it("round-trips whole-second timestamps in both frames", () => {
		for (const wallClock of [false, true]) {
			for (const v of [
				Math.floor(new Date(2024, 5, 3, 14, 5, 7).getTime() / 1000),
				Math.floor(Date.UTC(2019, 11, 31, 23, 59, 59) / 1000),
				Math.floor(new Date(2024, 0, 1).getTime() / 1000),
			]) {
				expect(partsToEpoch(dateParts(v, wallClock), wallClock)).toBe(v);
			}
		}
	});

	it("wall-clock frame reads the same digits regardless of viewer timezone semantics", () => {
		const v = Math.floor(Date.UTC(2020, 2, 1, 9, 30) / 1000);
		const p = dateParts(v, true);
		expect([p.y, p.mo, p.d, p.h, p.mi]).toEqual([2020, 2, 1, 9, 30]);
	});
});

describe("stepFilterWindow", () => {
	const dayStart = (y: number, m: number, d: number) =>
		Math.floor(new Date(y, m, d).getTime() / 1000);

	it("steps a single-day window to the next day", () => {
		const lo = dayStart(2024, 5, 3);
		const hi = pickPeriodEnd(lo, "day", false);
		expect(stepFilterWindow("date", "between", lo, hi, 1)).toEqual({
			value: dayStart(2024, 5, 4),
			value2: pickPeriodEnd(dayStart(2024, 5, 4), "day", false),
		});
	});

	it("tiles a multi-day window by its span", () => {
		const lo = dayStart(2024, 5, 1);
		const hi = pickPeriodEnd(dayStart(2024, 5, 3), "day", false); // 3-day window
		expect(stepFilterWindow("date", "between", lo, hi, 1)).toEqual({
			value: dayStart(2024, 5, 4),
			value2: pickPeriodEnd(dayStart(2024, 5, 6), "day", false),
		});
	});

	it("forward then back is identity for every day of the year (DST-safe)", () => {
		for (let day = 1; day <= 366; day++) {
			const lo = dayStart(2024, 0, day);
			const hi = pickPeriodEnd(lo, "day", false);
			const fwd = stepFilterWindow("date", "between", lo, hi, 1)!;
			const back = stepFilterWindow("date", "between", fwd.value, fwd.value2, -1);
			expect(back).toEqual({ value: lo, value2: hi });
		}
	});

	it("steps an instant (minute-grain) window by its second span", () => {
		const lo = Math.floor(Date.UTC(2024, 5, 3, 14, 5) / 1000);
		const hi = lo + 59;
		expect(stepFilterWindow("date", "between", lo, hi, 1)).toEqual({
			value: lo + 60,
			value2: hi + 60,
		});
	});

	it("steps month eq and between windows, wrapping years", () => {
		expect(stepFilterWindow("month", "eq", "2019-12", undefined, 1)).toEqual({ value: "2020-01" });
		expect(stepFilterWindow("month", "between", "2019-06", "2019-08", 1)).toEqual({
			value: "2019-09",
			value2: "2019-11",
		});
	});

	it("translates numeric windows by span", () => {
		expect(stepFilterWindow("number", "between", 0, 100, 1)).toEqual({ value: 100, value2: 200 });
	});

	it("returns null for non-window shapes", () => {
		expect(stepFilterWindow("date", "gt", dayStart(2024, 5, 3), undefined, 1)).toBeNull();
		expect(stepFilterWindow("enum", "eq", "US", undefined, 1)).toBeNull();
		expect(stepFilterWindow("date", "between_anyyear", "06-01", "06-03", 1)).toBeNull();
		expect(stepFilterWindow("string", "between", "a", "b", 1)).toBeNull();
	});
});
