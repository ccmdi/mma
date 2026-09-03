// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { panoDates } from "@/components/editor/location/panoDate";
import { createLocation } from "@/types";
import type { Pano } from "@/types";
import type { Location } from "@/bindings.gen";

const ref = (pano: string, date: string): Pano["time"][number] => ({ pano, date });
const on = (pano: string) => ({ pano }) as unknown as Pano;
const floating: Location = createLocation({ lat: 0, lng: 0 });
const pinned: Location = { ...floating, flags: 1 };

describe("panoDates", () => {
	it("default is the pano the position resolves to, not the one on screen", () => {
		const dates = [ref("a", "2020-06-15"), ref("b", "2021-03-01")];
		// Floating on "a" (an older capture) with Google's default at this spot being "b".
		const s = panoDates(on("a"), dates, "b", floating);
		expect(s.isDefault).toBe(true);
		expect(s.defaultEntry?.pano).toBe("b");
		expect(s.currentEntry?.pano).toBe("b");
		expect(s.triggerPanoId).toBe("b");
		expect(s.displayDate).toEqual(new Date(2021, 2, 1));
		expect(s.yearMonth).toBe("2021-03");
	});

	it("a pinned draft chooses the pano on screen and the default stays what it was", () => {
		const dates = [ref("a", "2020-06-15"), ref("b", "2021-03-01")];
		const s = panoDates(on("a"), dates, "b", pinned);
		expect(s.isDefault).toBe(false);
		expect(s.defaultEntry?.pano).toBe("b");
		expect(s.currentEntry?.pano).toBe("a");
		expect(s.triggerPanoId).toBe("a");
		expect(s.yearMonth).toBe("2020-06");
	});

	it("sorts entries ascending by date", () => {
		const dates = [ref("new", "2022-01-01"), ref("old", "2018-01-01")];
		const s = panoDates(null, dates, null, floating);
		expect(s.sorted.map((d) => d.pano)).toEqual(["old", "new"]);
	});

	it("with no entries, the pano on screen still triggers but has no date to show", () => {
		const s = panoDates(on("snap"), [], "snap", floating);
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
