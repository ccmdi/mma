// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
	derivePanoDateState,
	dedupePanoReferencesByDay,
	providerEntriesToPanoDates,
} from "@/components/editor/location/panoDate";
import { parsePanoDate, type PanoReference } from "@/lib/sv/lookup";
import { panoDayFmt } from "@/lib/util/format";

const ref = (pano: string, date: Date): PanoReference => ({ pano, date });
const cp = (pano: string | null, imageDate?: string) =>
	({ location: pano ? { pano } : null, imageDate }) as unknown as Parameters<
		typeof derivePanoDateState
	>[2];

describe("derivePanoDateState", () => {
	it("default mode selects the default entry and derives its yearMonth", () => {
		const dates = [ref("a", new Date(2020, 5, 15)), ref("b", new Date(2021, 2, 1))];
		const s = derivePanoDateState(dates, null, cp("a"), "b");
		expect(s.isDefault).toBe(true);
		// defaultEntry (defaultPanoId="b") wins over the currently-resolved pano "a"
		expect(s.currentEntry?.pano).toBe("b");
		expect(s.triggerPanoId).toBe("b");
		expect(s.displayDate).toEqual(new Date(2021, 2, 1));
		expect(s.yearMonth).toBe("2021-03");
	});

	it("a selected pano overrides the default", () => {
		const dates = [ref("a", new Date(2020, 5, 15)), ref("b", new Date(2021, 2, 1))];
		const s = derivePanoDateState(dates, "a", cp("b"), "b");
		expect(s.isDefault).toBe(false);
		expect(s.currentEntry?.pano).toBe("a");
		expect(s.triggerPanoId).toBe("a");
		expect(s.yearMonth).toBe("2020-06");
	});

	it("sorts entries ascending by date", () => {
		const dates = [ref("new", new Date(2022, 0, 1)), ref("old", new Date(2018, 0, 1))];
		const s = derivePanoDateState(dates, null, null, null);
		expect(s.sorted.map((d) => d.pano)).toEqual(["old", "new"]);
	});

	it("keeps the currently viewed pano in the Specific list even when it is default", () => {
		const dates = [
			ref("spawn", new Date(2021, 2, 1)),
			ref("hist", new Date(2020, 5, 15)),
		];
		const atSpawn = derivePanoDateState(dates, "spawn", cp("spawn"), "spawn");
		expect(atSpawn.sorted.map((d) => d.pano)).toEqual(["hist", "spawn"]);
		expect(atSpawn.isDefault).toBe(false);
		expect(atSpawn.currentEntry?.pano).toBe("spawn");

		// Browsing historical: default/spawn also appears under Specific.
		const atHist = derivePanoDateState(dates, "hist", cp("hist"), "spawn");
		expect(atHist.sorted.map((d) => d.pano)).toEqual(["hist", "spawn"]);
		expect(atHist.currentEntry?.pano).toBe("hist");
		expect(atHist.displayDate).toEqual(new Date(2020, 5, 15));
	});

	it("with no entries, falls back to the current pano id + imageDate", () => {
		const s = derivePanoDateState([], null, cp("snap", "2019-07"), null);
		expect(s.sorted).toEqual([]);
		expect(s.currentEntry).toBeUndefined();
		expect(s.triggerPanoId).toBe("snap");
		expect(s.displayDate).toEqual(parsePanoDate("2019-07"));
		expect(s.yearMonth).toBe("2019-07");
	});

	it("with nothing resolvable, triggerPanoId falls back to defaultPanoId and the date is null", () => {
		const s = derivePanoDateState([], null, null, "fallback");
		expect(s.triggerPanoId).toBe("fallback");
		expect(s.displayDate).toBeNull();
		expect(s.yearMonth).toBeNull();
	});
});

describe("dedupePanoReferencesByDay", () => {
	it("collapses duplicate displayed days and prefers the current pano", () => {
		const day = new Date(2021, 5, 15, 10);
		const sameDayLater = new Date(2021, 5, 15, 18);
		const refs: PanoReference[] = [
			{ pano: "spawn", date: day },
			{ pano: "current", date: sameDayLater },
			{ pano: "older", date: new Date(2020, 0, 1) },
		];
		const out = dedupePanoReferencesByDay(refs, "current");
		expect(out.map((e) => e.pano)).toEqual(["older", "current"]);
		expect(panoDayFmt.format(out[1]!.date)).toBe(panoDayFmt.format(day));
	});

	it("maps provider entries through the same day filter", () => {
		const day = new Date(2021, 5, 15, 10).getTime();
		const sameDayLater = new Date(2021, 5, 15, 18).getTime();
		const out = providerEntriesToPanoDates(
			[
				{ pano: "spawn", timestamp: day },
				{ pano: "current", timestamp: sameDayLater },
			],
			"current",
		);
		expect(out).toEqual([{ pano: "current", date: new Date(sameDayLater) }]);
	});
});
