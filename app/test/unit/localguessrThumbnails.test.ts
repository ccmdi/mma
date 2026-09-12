// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SeenEntry, SeenFilter } from "@/bindings.gen";

const seen: SeenEntry[] = [];
const getSeenEntries = vi.fn(async (_limit: number, _offset: number, _filter: SeenFilter) => seen);
const getSeenCount = vi.fn(async (_filter: SeenFilter) => seen.length);

vi.mock("@/lib/seen/seen", () => ({
	getSeenEntries: (...a: [number, number, SeenFilter]) => getSeenEntries(...a),
	getSeenCount: (...a: [SeenFilter]) => getSeenCount(...a),
}));

import { startingThumbnails } from "@/plugins/localguessr/storage";

let nextId = 0;
function entry(locationId: number, enteredAt: number, thumbnail: string | null): SeenEntry {
	nextId++;
	return {
		id: nextId,
		panoId: `P${nextId}`,
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
	};
}

function newestFirst(...entries: SeenEntry[]) {
	seen.splice(0, seen.length, ...entries.sort((a, b) => b.enteredAt - a.enteredAt));
}

beforeEach(() => {
	getSeenEntries.mockClear();
	getSeenCount.mockClear();
});

describe("starting thumbnails", () => {
	it("asks once, from the earliest start, for every distinct location", async () => {
		newestFirst();
		await startingThumbnails("m", [
			{ locationId: 5, startedAt: 300 },
			{ locationId: 9, startedAt: 100 },
			{ locationId: 5, startedAt: 200 },
		]);
		const filter = { mapId: "m", since: 100, locationIds: [5, 9] };
		expect(getSeenCount).toHaveBeenCalledOnce();
		expect(getSeenCount).toHaveBeenCalledWith(filter);
		expect(getSeenEntries).toHaveBeenCalledOnce();
		expect(getSeenEntries).toHaveBeenCalledWith(0, 0, filter);
	});

	it("does not ask at all without rounds", async () => {
		expect(await startingThumbnails("m", [])).toEqual([]);
		expect(getSeenEntries).not.toHaveBeenCalled();
	});

	it("gives each round the first entry at or after its own start", async () => {
		newestFirst(
			entry(5, 100, "5-monday"),
			entry(9, 300, "9-wednesday"),
			entry(5, 400, "5-thursday"),
			entry(9, 500, "9-friday"),
			entry(9, 600, "9-walked"),
		);
		expect(
			await startingThumbnails("m", [
				{ locationId: 5, startedAt: 100 },
				{ locationId: 9, startedAt: 500 },
				{ locationId: 5, startedAt: 350 },
			]),
		).toEqual(["5-monday", "9-friday", "5-thursday"]);
	});

	it("keeps a starting view that had no thumbnail rather than borrowing a later one", async () => {
		newestFirst(entry(1, 200, null), entry(1, 300, "walked"));
		expect(await startingThumbnails("m", [{ locationId: 1, startedAt: 100 }])).toEqual([null]);
	});

	it("leaves a round with no entry since its start empty", async () => {
		newestFirst(entry(1, 50, "before"));
		expect(await startingThumbnails("m", [{ locationId: 1, startedAt: 100 }])).toEqual([null]);
	});
});
