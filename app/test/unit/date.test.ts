import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
	parseTypedDate,
	MONTHS,
	compareMonthOrder,
	ymParse,
	ymFormat,
	ymFromDate,
	ymToDate,
	ymOrdinal,
	ymFromOrdinal,
} from "@/lib/util/date";
import {
	partsToEpoch,
	dateParts,
	pickPeriodEnd,
	hasTimeOfDay,
	stepFilterWindow,
} from "@/lib/util/date";

describe("MONTHS", () => {
	it("short and full names align by index", () => {
		expect(MONTHS.short).toHaveLength(12);
		expect(MONTHS.full).toHaveLength(12);
		MONTHS.full.forEach((full, i) => {
			expect(full.startsWith(MONTHS.short[i])).toBe(true);
		});
	});
});

describe("compareMonthOrder", () => {
	it("orders month names by calendar position, not alphabetically", () => {
		expect(["April", "January", "December", "August"].sort(compareMonthOrder)).toEqual([
			"January",
			"April",
			"August",
			"December",
		]);
	});
});

describe("parseTypedDate", () => {
	const date = { mode: "date" as const };
	const epoch = (y: number, mo: number, d: number, h = 0, mi = 0, wall = false) =>
		String(partsToEpoch({ y, mo, d, h, mi }, wall));

	it("parses ISO, US, and month-name full dates to the same epoch", () => {
		const expected = epoch(2019, 5, 3);
		expect(parseTypedDate("2019-06-03", date)).toBe(expected);
		expect(parseTypedDate("6/3/2019", date)).toBe(expected);
		expect(parseTypedDate("Jun 3, 2019", date)).toBe(expected);
		expect(parseTypedDate("3 june 2019", date)).toBe(expected);
	});

	it("accepts a trailing time only when withTime is set", () => {
		expect(parseTypedDate("2019-06-03 14:30", { ...date, withTime: true })).toBe(
			epoch(2019, 5, 3, 14, 30),
		);
		expect(parseTypedDate("2019-06-03 14:30", date)).toBeNull();
	});

	it("encodes wall-clock dates in the UTC frame", () => {
		expect(parseTypedDate("2019-06-03", { ...date, wallClock: true })).toBe(
			epoch(2019, 5, 3, 0, 0, true),
		);
	});

	it("rejects invalid dates and garbage", () => {
		expect(parseTypedDate("2019-13-03", date)).toBeNull();
		expect(parseTypedDate("2019-06-40", date)).toBeNull();
		expect(parseTypedDate("hello", date)).toBeNull();
		expect(parseTypedDate("", date)).toBeNull();
		expect(parseTypedDate("2019", date)).toBeNull();
	});

	it("parses month mode from ISO, slash, and name forms", () => {
		expect(parseTypedDate("2019-06", { mode: "month" })).toBe("2019-06");
		expect(parseTypedDate("06/2019", { mode: "month" })).toBe("2019-06");
		expect(parseTypedDate("Jun 2019", { mode: "month" })).toBe("2019-06");
		expect(parseTypedDate("2019 Jun", { mode: "month" })).toBe("2019-06");
		expect(parseTypedDate("Jun", { mode: "month" })).toBeNull();
	});

	it("parses anyYear month as a bare month token", () => {
		expect(parseTypedDate("Jun", { mode: "month", anyYear: true })).toBe("06");
		expect(parseTypedDate("6", { mode: "month", anyYear: true })).toBe("06");
		expect(parseTypedDate("13", { mode: "month", anyYear: true })).toBeNull();
	});

	it("parses anyYear date as month-day", () => {
		expect(parseTypedDate("06-03", { mode: "date", anyYear: true })).toBe("06-03");
		expect(parseTypedDate("6/3", { mode: "date", anyYear: true })).toBe("06-03");
		expect(parseTypedDate("Jun 3", { mode: "date", anyYear: true })).toBe("06-03");
		expect(parseTypedDate("3 Jun", { mode: "date", anyYear: true })).toBe("06-03");
	});

	it("parses anyTime as HH:MM", () => {
		expect(parseTypedDate("14:30", { mode: "date", anyTime: true })).toBe("14:30");
		expect(parseTypedDate("9", { mode: "date", anyTime: true })).toBe("09:00");
		expect(parseTypedDate("25:00", { mode: "date", anyTime: true })).toBeNull();
	});
});

describe("dateParts / partsToEpoch (property-based)", () => {
	const epochArb = fc.integer({ min: 0, max: 2 ** 31 - 1 });

	it("roundtrips arbitrary epochs in the UTC (wallClock) frame", () => {
		fc.assert(
			fc.property(epochArb, (epoch) => {
				expect(partsToEpoch(dateParts(epoch, true), true)).toBe(epoch);
			}),
		);
	});

	// Local-frame (wallClock: false) roundtrip is not tested here: DST transitions
	// make some wall-clock times ambiguous or nonexistent, so the property is only
	// true outside those hours, and that varies by the machine's timezone.

	it("dateParts stays within calendar bounds", () => {
		fc.assert(
			fc.property(epochArb, (epoch) => {
				const p = dateParts(epoch, true);
				expect(p.mo).toBeGreaterThanOrEqual(0);
				expect(p.mo).toBeLessThanOrEqual(11);
				expect(p.d).toBeGreaterThanOrEqual(1);
				expect(p.d).toBeLessThanOrEqual(31);
				expect(p.h).toBeGreaterThanOrEqual(0);
				expect(p.h).toBeLessThanOrEqual(23);
				expect(p.mi).toBeGreaterThanOrEqual(0);
				expect(p.mi).toBeLessThanOrEqual(59);
				expect(p.s).toBeGreaterThanOrEqual(0);
				expect(p.s).toBeLessThanOrEqual(59);
			}),
		);
	});
});

describe("YYYY-MM codec", () => {
	it("round-trips parse and format", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1000, max: 9999 }), fc.integer({ min: 1, max: 12 }), (y, m) => {
				const s = ymFormat(y, m);
				expect(s).toMatch(/^\d{4}-\d{2}$/);
				expect(ymParse(s)).toEqual({ y, m });
			}),
		);
	});

	it("rejects malformed input", () => {
		for (const bad of ["", "2019", "2019-", "2019-1", "19-06", "2019-00", "2019-13", "2019-6a"]) {
			expect(ymParse(bad)).toBeNull();
			expect(ymOrdinal(bad)).toBeNull();
			expect(ymToDate(bad)).toBeNull();
		}
	});

	it("orders months monotonically as ordinals", () => {
		expect(ymOrdinal("2019-01")).toBeLessThan(ymOrdinal("2019-02")!);
		expect(ymOrdinal("2019-12")).toBeLessThan(ymOrdinal("2020-01")!);
		expect(ymOrdinal("2020-06")! - ymOrdinal("2019-06")!).toBe(12);
	});

	it("round-trips through the ordinal", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1000, max: 9999 }), fc.integer({ min: 1, max: 12 }), (y, m) => {
				const s = ymFormat(y, m);
				expect(ymFromOrdinal(ymOrdinal(s)!)).toBe(s);
			}),
		);
	});

	// `new Date("2019-06")` parses as UTC; every Date this gets compared to in the app is
	// built locally. A UTC-framed parse lands on the wrong side of a month boundary in any
	// non-zero offset, so ymToDate must agree with `new Date(y, m-1)` exactly.
	it("builds dates in the local frame, not UTC", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1900, max: 2100 }), fc.integer({ min: 1, max: 12 }), (y, m) => {
				const d = ymToDate(ymFormat(y, m))!;
				expect(d.getFullYear()).toBe(y);
				expect(d.getMonth()).toBe(m - 1);
				expect(d.getDate()).toBe(1);
				expect(d.getTime()).toBe(new Date(y, m - 1).getTime());
			}),
		);
	});

	it("ymFromDate is the inverse of ymToDate", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1000, max: 9999 }), fc.integer({ min: 1, max: 12 }), (y, m) => {
				const s = ymFormat(y, m);
				expect(ymFromDate(ymToDate(s)!)).toBe(s);
			}),
		);
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
		expect(stepFilterWindow("date", { op: "between", lo, hi }, 1)).toEqual({
			op: "between",
			lo: dayStart(2024, 5, 4),
			hi: pickPeriodEnd(dayStart(2024, 5, 4), "day", false),
		});
	});

	it("tiles a multi-day window by its span", () => {
		const lo = dayStart(2024, 5, 1);
		const hi = pickPeriodEnd(dayStart(2024, 5, 3), "day", false); // 3-day window
		expect(stepFilterWindow("date", { op: "between", lo, hi }, 1)).toEqual({
			op: "between",
			lo: dayStart(2024, 5, 4),
			hi: pickPeriodEnd(dayStart(2024, 5, 6), "day", false),
		});
	});

	it("forward then back is identity for every day of the year (DST-safe)", () => {
		for (let day = 1; day <= 366; day++) {
			const lo = dayStart(2024, 0, day);
			const hi = pickPeriodEnd(lo, "day", false);
			const fwd = stepFilterWindow("date", { op: "between", lo, hi }, 1)!;
			const back = stepFilterWindow("date", fwd, -1);
			expect(back).toEqual({ op: "between", lo, hi });
		}
	});

	it("steps an instant (minute-grain) window by its second span", () => {
		const lo = Math.floor(Date.UTC(2024, 5, 3, 14, 5) / 1000);
		const hi = lo + 59;
		expect(stepFilterWindow("date", { op: "between", lo, hi }, 1)).toEqual({
			op: "between",
			lo: lo + 60,
			hi: hi + 60,
		});
	});

	it("steps month eq and between windows, wrapping years", () => {
		expect(stepFilterWindow("month", { op: "eq", value: "2019-12" }, 1)).toEqual({
			op: "eq",
			value: "2020-01",
		});
		expect(stepFilterWindow("month", { op: "between", lo: "2019-06", hi: "2019-08" }, 1)).toEqual({
			op: "between",
			lo: "2019-09",
			hi: "2019-11",
		});
	});

	it("translates numeric windows by span", () => {
		expect(stepFilterWindow("number", { op: "between", lo: 0, hi: 100 }, 1)).toEqual({
			op: "between",
			lo: 100,
			hi: 200,
		});
	});

	it("returns null for non-window shapes", () => {
		expect(stepFilterWindow("date", { op: "gt", value: dayStart(2024, 5, 3) }, 1)).toBeNull();
		expect(stepFilterWindow("enum", { op: "eq", value: "US" }, 1)).toBeNull();
		expect(
			stepFilterWindow("date", { op: "between_anyyear", lo: "06-01", hi: "06-03" }, 1),
		).toBeNull();
		expect(stepFilterWindow("string", { op: "between", lo: "a", hi: "b" }, 1)).toBeNull();
	});
});
