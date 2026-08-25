// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { derivePanoDateState } from "@/components/editor/location/panoDate";
import { ymToDate } from "@/lib/util/date";
import type { Pano } from "@/types";

const ref = (pano: string, date: string): Pano["time"][number] => ({ pano, date });
/** The pano the viewer is showing: an id plus, optionally, its capture month. */
const cp = (pano: string | null, imageDate?: string) => {
	if (!pano) return null;
	const [y, m] = (imageDate ?? "").split("-");
	return {
		pano,
		date: imageDate ? { year: Number(y), month: Number(m), day: 1 } : null,
	} as unknown as Pano;
};

describe("derivePanoDateState", () => {
	it("default mode selects the default entry and derives its yearMonth", () => {
		const dates = [ref("a", "2020-06-15"), ref("b", "2021-03-01")];
		const s = derivePanoDateState(dates, null, cp("a"), "b");
		expect(s.isDefault).toBe(true);
		// defaultEntry (defaultPanoId="b") wins over the currently-resolved pano "a"
		expect(s.currentEntry?.pano).toBe("b");
		expect(s.triggerPanoId).toBe("b");
		expect(s.displayDate).toEqual(new Date(2021, 2, 1));
		expect(s.yearMonth).toBe("2021-03");
	});

	it("a selected pano overrides the default", () => {
		const dates = [ref("a", "2020-06-15"), ref("b", "2021-03-01")];
		const s = derivePanoDateState(dates, "a", cp("b"), "b");
		expect(s.isDefault).toBe(false);
		expect(s.currentEntry?.pano).toBe("a");
		expect(s.triggerPanoId).toBe("a");
		expect(s.yearMonth).toBe("2020-06");
	});

	it("sorts entries ascending by date", () => {
		const dates = [ref("new", "2022-01-01"), ref("old", "2018-01-01")];
		const s = derivePanoDateState(dates, null, null, null);
		expect(s.sorted.map((d) => d.pano)).toEqual(["old", "new"]);
	});

	it("with no entries, falls back to the current pano id + imageDate", () => {
		const s = derivePanoDateState([], null, cp("snap", "2019-07"), null);
		expect(s.sorted).toEqual([]);
		expect(s.currentEntry).toBeUndefined();
		expect(s.triggerPanoId).toBe("snap");
		expect(s.displayDate).toEqual(ymToDate("2019-07"));
		expect(s.yearMonth).toBe("2019-07");
	});

	it("with nothing resolvable, triggerPanoId falls back to defaultPanoId and the date is null", () => {
		const s = derivePanoDateState([], null, null, "fallback");
		expect(s.triggerPanoId).toBe("fallback");
		expect(s.displayDate).toBeNull();
		expect(s.yearMonth).toBeNull();
	});
});
