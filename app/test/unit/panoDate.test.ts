// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { panoDates } from "@/components/editor/location/panoDate";
import { createLocation } from "@/types";
import type { Pano } from "@/bindings.gen";
import type { Location } from "@/bindings.gen";

const ref = (panoId: string, date: string): Pano["time"][number] => ({ panoId, date });
const on = (id: string, time: Pano["time"] = []) => ({ id, time }) as unknown as Pano;
const floating: Location = createLocation({ lat: 0, lng: 0 });
const pinned: Location = { ...floating, flags: 1, panoId: "a" };

describe("panoDates", () => {
	it("default is the pano the position resolves to, not the one on screen", () => {
		const dates = [ref("a", "2020-06-15"), ref("b", "2021-03-01")];
		// Floating on "a" (an older capture) with Google's default at this spot being "b".
		const s = panoDates(on("a"), dates, on("b", dates), floating);
		expect(s.isDefault).toBe(true);
		expect(s.defaultEntry?.panoId).toBe("b");
		expect(s.currentEntry?.panoId).toBe("b");
		expect(s.triggerPanoId).toBe("b");
		expect(s.displayDate).toEqual(new Date(2021, 2, 1));
		expect(s.yearMonth).toBe("2021-03");
	});

	it("a pinned draft chooses the pano on screen and the default stays what it was", () => {
		const dates = [ref("a", "2020-06-15"), ref("b", "2021-03-01")];
		const s = panoDates(on("a"), dates, on("b", dates), pinned);
		expect(s.isDefault).toBe(false);
		expect(s.defaultEntry?.panoId).toBe("b");
		expect(s.currentEntry?.panoId).toBe("a");
		expect(s.triggerPanoId).toBe("a");
		expect(s.yearMonth).toBe("2020-06");
	});

	it("dates the default from its own stack when it is not in the draft's timeline", () => {
		// A republished area: the default resolves to a new graph whose entries never
		// appear in the pinned pano's stack, yet the Default row still shows its date.
		const dates = [ref("a", "2020-06-15")];
		const s = panoDates(on("a"), dates, on("b", [ref("b", "2024-05-01")]), pinned);
		expect(s.defaultEntry?.panoId).toBe("b");
		expect(s.defaultEntry?.date).toBe("2024-05-01");
		expect(s.sorted.map((d) => d.panoId)).toEqual(["a"]);
	});

	it("sorts entries ascending by date", () => {
		const dates = [ref("new", "2022-01-01"), ref("old", "2018-01-01")];
		const s = panoDates(null, dates, null, floating);
		expect(s.sorted.map((d) => d.panoId)).toEqual(["old", "new"]);
	});

	it("with no entries, the pano on screen still triggers but has no date to show", () => {
		const s = panoDates(on("snap"), [], on("snap"), floating);
		expect(s.sorted).toEqual([]);
		expect(s.currentEntry).toBeUndefined();
		expect(s.triggerPanoId).toBe("snap");
		expect(s.displayDate).toBeNull();
		expect(s.yearMonth).toBeNull();
	});

	it("with nothing on screen there is no trigger and no date", () => {
		const s = panoDates(null, null, null, null);
		expect(s.triggerPanoId).toBeNull();
		expect(s.displayDate).toBeNull();
		expect(s.yearMonth).toBeNull();
	});
});
