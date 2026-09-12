// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SeenEntry, SeenFilter } from "@/bindings.gen";

const seen: SeenEntry[] = [];
const getSeenEntries = vi.fn(async (_limit: number, _offset: number, _filter: SeenFilter) => seen);
const getSeenCount = vi.fn(async (_filter: SeenFilter) => seen.length);

vi.mock("@/lib/seen/seen", () => ({
	getSeenEntries: (...a: [number, number, SeenFilter]) => getSeenEntries(...a),
	getSeenCount: (...a: [SeenFilter]) => getSeenCount(...a),
}));

import { roundThumbnails } from "@/plugins/localguessr/storage";

function entry(id: number, locationId: number, enteredAt: number, thumbnail: string | null) {
	return {
		id,
		panoId: `P${id}`,
		lat: 0,
		lng: 0,
		heading: 0,
		pitch: 0,
		zoom: 0,
		enteredAt,
		mapId: "m",
		locationId,
		countryCode: null,
		address: null,
		thumbnail,
	} satisfies SeenEntry;
}

describe("round thumbnails", () => {
	it("asks for the session's rounds on its map since it started", async () => {
		seen.length = 0;
		await roundThumbnails("m", 100, [1, 2]);
		expect(getSeenCount).toHaveBeenCalledWith({ mapId: "m", since: 100, locationIds: [1, 2] });
		expect(getSeenEntries).toHaveBeenCalledWith(0, 0, {
			mapId: "m",
			since: 100,
			locationIds: [1, 2],
		});
	});

	it("uses each round's first entry, which is its starting view", async () => {
		seen.splice(
			0,
			seen.length,
			entry(4, 1, 400, "walked"),
			entry(3, 2, 300, null),
			entry(2, 2, 200, "start-2"),
			entry(1, 1, 150, "start-1"),
		);
		const thumbnails = await roundThumbnails("m", 100, [1, 2]);
		expect(thumbnails.get(1)).toBe("start-1");
		expect(thumbnails.get(2)).toBe("start-2");
	});

	it("keeps a starting view that had no thumbnail rather than borrowing a later one", async () => {
		seen.splice(0, seen.length, entry(2, 1, 300, "walked"), entry(1, 1, 200, null));
		const thumbnails = await roundThumbnails("m", 100, [1]);
		expect(thumbnails.has(1)).toBe(true);
		expect(thumbnails.get(1)).toBeNull();
	});
});
