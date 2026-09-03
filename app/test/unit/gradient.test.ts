import { createFieldDef } from "@/types";
import { describe, it, expect } from "vitest";
import {
	lerp,
	gradientColor,
	isNumericField,
	fieldScale,
	colorPartition,
} from "@/plugins/gradient/gradientMath";
import type { PartitionBucket } from "@/bindings.gen";

describe("lerp", () => {
	it("t=0 returns first color", () => {
		expect(lerp([10, 20, 30], [200, 100, 50], 0)).toEqual([10, 20, 30]);
	});

	it("t=1 returns second color", () => {
		expect(lerp([10, 20, 30], [200, 100, 50], 1)).toEqual([200, 100, 50]);
	});

	it("t=0.5 returns midpoint", () => {
		expect(lerp([0, 0, 0], [100, 100, 100], 0.5)).toEqual([50, 50, 50]);
	});

	it("t=0.25 returns quarter point", () => {
		expect(lerp([0, 0, 0], [100, 200, 40], 0.25)).toEqual([25, 50, 10]);
	});

	it("rounds to integers", () => {
		expect(lerp([0, 0, 0], [1, 1, 1], 0.5)).toEqual([1, 1, 1]);
		expect(lerp([0, 0, 0], [3, 3, 3], 0.5)).toEqual([2, 2, 2]);
	});

	it("identical colors return same", () => {
		expect(lerp([42, 99, 200], [42, 99, 200], 0.7)).toEqual([42, 99, 200]);
	});

	it("handles negative channel interpolation", () => {
		expect(lerp([200, 200, 200], [0, 0, 0], 0.5)).toEqual([100, 100, 100]);
	});
});

describe("gradientColor", () => {
	const twoStops: [number, number, number][] = [
		[0, 0, 0],
		[255, 255, 255],
	];

	const threeStops: [number, number, number][] = [
		[255, 0, 0],
		[0, 255, 0],
		[0, 0, 255],
	];

	it("t=0 returns first stop", () => {
		expect(gradientColor(twoStops, 0)).toEqual([0, 0, 0]);
	});

	it("t=1 returns last stop", () => {
		expect(gradientColor(twoStops, 1)).toEqual([255, 255, 255]);
	});

	it("t<0 clamps to first stop", () => {
		expect(gradientColor(twoStops, -0.5)).toEqual([0, 0, 0]);
	});

	it("t>1 clamps to last stop", () => {
		expect(gradientColor(twoStops, 1.5)).toEqual([255, 255, 255]);
	});

	it("t=0.5 with 2 stops returns midpoint", () => {
		expect(gradientColor(twoStops, 0.5)).toEqual([128, 128, 128]);
	});

	it("3 stops: t=0 first, t=0.5 second, t=1 third", () => {
		expect(gradientColor(threeStops, 0)).toEqual([255, 0, 0]);
		expect(gradientColor(threeStops, 0.5)).toEqual([0, 255, 0]);
		expect(gradientColor(threeStops, 1)).toEqual([0, 0, 255]);
	});

	it("3 stops: t=0.25 midpoint of first two", () => {
		expect(gradientColor(threeStops, 0.25)).toEqual([128, 128, 0]);
	});

	it("5 stops at segment boundaries", () => {
		const fiveStops: [number, number, number][] = [
			[10, 0, 0],
			[20, 0, 0],
			[30, 0, 0],
			[40, 0, 0],
			[50, 0, 0],
		];
		expect(gradientColor(fiveStops, 0)).toEqual([10, 0, 0]);
		expect(gradientColor(fiveStops, 0.25)).toEqual([20, 0, 0]);
		expect(gradientColor(fiveStops, 0.5)).toEqual([30, 0, 0]);
		expect(gradientColor(fiveStops, 0.75)).toEqual([40, 0, 0]);
		expect(gradientColor(fiveStops, 1)).toEqual([50, 0, 0]);
	});

	it("single stop returns it for any t", () => {
		const oneStop: [number, number, number][] = [[42, 42, 42]];
		expect(gradientColor(oneStop, 0)).toEqual([42, 42, 42]);
		expect(gradientColor(oneStop, 1)).toEqual([42, 42, 42]);
	});
});

describe("isNumericField", () => {
	it("undefined returns false", () => {
		expect(isNumericField(undefined)).toBe(false);
	});

	it("number type returns true", () => {
		expect(isNumericField(createFieldDef("number"))).toBe(true);
	});

	it("date type returns true", () => {
		expect(isNumericField(createFieldDef("date"))).toBe(true);
	});

	it("string type returns false", () => {
		expect(isNumericField(createFieldDef("string"))).toBe(false);
	});

	it("enum type returns false", () => {
		expect(isNumericField(createFieldDef("enum"))).toBe(false);
	});

	it("month type returns false", () => {
		expect(isNumericField(createFieldDef("month"))).toBe(false);
	});
});

describe("fieldScale", () => {
	it("maps months to an ordinal month count (proportional to time)", () => {
		const jan2010 = fieldScale("2010-01", "month")!;
		const jan2011 = fieldScale("2011-01", "month")!;
		const jul2010 = fieldScale("2010-07", "month")!;
		expect(jan2011 - jan2010).toBe(12);
		expect(jul2010 - jan2010).toBe(6);
	});

	it("parses numeric strings to their value", () => {
		expect(fieldScale("80", "string")).toBe(80);
		expect(fieldScale("300", "string")).toBe(300);
	});

	it("returns null for non-numeric categories", () => {
		expect(fieldScale("gen4", "enum")).toBeNull();
		expect(fieldScale("", "string")).toBeNull();
		expect(fieldScale("2010-XX", "month")).toBeNull();
	});
});

describe("colorPartition", () => {
	const stops: [number, number, number][] = [
		[0, 0, 0],
		[255, 255, 255],
	];
	const numericBins: PartitionBucket[] = [
		{ key: "0–50", ids: [1, 2], bin: [0, 50] },
		{ key: "50–100", ids: [3], bin: [50, 100] },
	];

	it("skips the empty bins the pivot keeps, so no selection selects nothing", () => {
		const withGap: PartitionBucket[] = [
			{ key: "0–50", ids: [1, 2], bin: [0, 50] },
			{ key: "50–100", ids: [], bin: [50, 100] },
			{ key: "100–150", ids: [3], bin: [100, 150] },
		];
		const sels = colorPartition(withGap, {
			fieldKey: "altitude",
			fieldType: "number",
			stops,
			narrowed: false,
			ordinal: true,
			eqFilter: false,
		});
		expect(sels).toHaveLength(2);
		expect(sels[0].color).toEqual([0, 0, 0]);
		expect(sels[1].color).toEqual([255, 255, 255]);
	});

	it("whole-map numeric bins emit live Filter `between` selections", () => {
		const sels = colorPartition(numericBins, {
			fieldKey: "altitude",
			fieldType: "number",
			stops,
			narrowed: false,
			ordinal: true,
			eqFilter: false,
		});
		expect(sels.every((s) => s.selector.type === "Filter")).toBe(true);
		expect(sels.every((s) => s.key.startsWith("filter:altitude:between:"))).toBe(true);
	});

	it("narrowed numeric bins emit static Locations selections keyed by their id list", () => {
		const sels = colorPartition(numericBins, {
			fieldKey: "altitude",
			fieldType: "number",
			stops,
			narrowed: true,
			ordinal: true,
			eqFilter: false,
		});
		expect(sels.every((s) => s.selector.type === "Locations")).toBe(true);
		const ids = sels.flatMap((s) => (s.selector.type === "Locations" ? s.selector.locations : []));
		expect(ids.sort()).toEqual([1, 2, 3]);
		const first = sels[0];
		if (first.selector.type === "Locations") {
			expect(first.key).toBe(first.selector.locations.join(","));
			// carries the group key as its name, so it isn't a generic "Selection"
			expect(first.selector.name).toBe("0–50");
		}
	});

	it("whole-map value groups emit live Filter `eq` selections", () => {
		const groups: PartitionBucket[] = [
			{ key: "a", ids: [1, 3], bin: null },
			{ key: "b", ids: [2], bin: null },
		];
		const sels = colorPartition(groups, {
			fieldKey: "tag",
			fieldType: "string",
			stops,
			narrowed: false,
			ordinal: false,
			eqFilter: true,
		});
		expect(sels.every((s) => s.selector.type === "Filter")).toBe(true);
		expect(sels.map((s) => s.key)).toEqual(["filter:tag:eq:a", "filter:tag:eq:b"]);
	});

	it("whole-map projection groups (no eqFilter, no bin) fall back to static Locations", () => {
		const groups: PartitionBucket[] = [
			{ key: "2020-01-01", ids: [1, 2], bin: null },
			{ key: "2020-01-02", ids: [3], bin: null },
		];
		const sels = colorPartition(groups, {
			fieldKey: "datetime",
			fieldType: "date",
			stops,
			narrowed: false,
			ordinal: false,
			eqFilter: false,
		});
		expect(sels.every((s) => s.selector.type === "Locations")).toBe(true);
	});

	it("empty groups yield no selections", () => {
		expect(
			colorPartition([], {
				fieldKey: "x",
				fieldType: "number",
				stops,
				narrowed: true,
				ordinal: true,
				eqFilter: false,
			}),
		).toEqual([]);
	});
});
