// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SeenEntry, SeenFilter } from "@/bindings.gen";

const seen: SeenEntry[] = [];
const listSeen = vi.fn(async (limit: number, offset: number, _filter: SeenFilter) => ({
	entries: seen.slice(offset, offset + limit),
	total: seen.length,
}));

vi.mock("@/lib/seen/seen", () => ({
	Seen: {
		list: (...a: [number, number, SeenFilter]) => listSeen(...a),
	},
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
	listSeen.mockClear();
});

describe("starting thumbnails", () => {
	it("asks from the earliest start, for every distinct location", async () => {
		newestFirst();
		await startingThumbnails("m", [
			{ locationId: 5, startedAt: 300 },
			{ locationId: 9, startedAt: 100 },
			{ locationId: 5, startedAt: 200 },
		]);
		const filter = { mapId: "m", since: 100, locationIds: [5, 9] };
		expect(listSeen.mock.calls).toEqual([
			[0, 0, filter],
			[0, 0, filter],
		]);
	});

	it("does not ask at all without rounds", async () => {
		expect(await startingThumbnails("m", [])).toEqual([]);
		expect(listSeen).not.toHaveBeenCalled();
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
