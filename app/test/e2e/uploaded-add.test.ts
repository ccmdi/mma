import { cmd } from "@/lib/commands";
import { withApi, useMap, createTag } from "./helpers";

// Batches over 5000 route through the chunked upload session instead of one invoke.
// Everything below the threshold still takes the direct IPC path.
const CHUNKED = 6000;

describe("Staged (chunked) location adds", () => {
	useMap("E2E StagedAdd");
	let tagId: number;

	before(async () => {
		tagId = (await createTag("staged")).id;
	});

	it("echoes real ids back onto the passed array, in order", async () => {
		const r = await withApi(
			async (api, n: number, tag: number) => {
				const before = api.getMapState().locationCount;
				const locs = Array.from({ length: n }, (_, i) =>
					api.createLocation({ lat: (i % 170) - 85, lng: (i % 350) - 175, tags: [tag] }),
				);
				await api.addLocations(locs);
				const ids = locs.map((l) => l.id);
				const stored = await api.fetchLocations({
					type: "Locations",
					locations: [ids[0], ids[n - 1]],
					name: null,
				});
				return {
					before,
					after: api.getMapState().locationCount,
					ids,
					firstLat: locs[0].lat,
					lastLat: locs[n - 1].lat,
					storedLats: stored.map((l) => l.lat),
				};
			},
			CHUNKED,
			tagId,
		);

		expect(r.after).toBe(r.before + CHUNKED);
		expect(r.ids.every((id) => id > 0)).toBe(true);
		expect(new Set(r.ids).size).toBe(CHUNKED);
		// Ids are allocated in staged order, so they run contiguously.
		expect(r.ids[CHUNKED - 1] - r.ids[0]).toBe(CHUNKED - 1);
		// The id written back at each index must address the location built at that index.
		expect(r.storedLats).toEqual([r.firstLat, r.lastLat]);
	});

	it("commits as one undoable mutation with correct tag counts", async () => {
		const r = await withApi(async (api, tag: number) => {
			const counts = api.getMapState().tagCounts;
			const before = { count: api.getMapState().locationCount, tag: counts?.[tag] ?? 0 };
			await api.undo();
			const after = {
				count: api.getMapState().locationCount,
				tag: api.getMapState().tagCounts?.[tag] ?? 0,
			};
			await api.redo();
			const redone = {
				count: api.getMapState().locationCount,
				tag: api.getMapState().tagCounts?.[tag] ?? 0,
			};
			return { before, after, redone };
		}, tagId);

		// One undo entry for the whole staged batch, not one per chunk.
		expect(r.after.count).toBe(r.before.count - CHUNKED);
		expect(r.after.tag).toBe(r.before.tag - CHUNKED);
		expect(r.redone).toEqual(r.before);
	});

	it("leaves the store untouched when the staged batch cannot be committed", async () => {
		const r = await withApi(async (api) => {
			const before = api.getMapState().locationCount;
			// A session dir that was never opened: the commit must fail before any mutation.
			let threw = false;
			try {
				await api.cmd.storeAddLocationsUploaded("C:/not/a/session");
			} catch {
				threw = true;
			}
			return { before, threw, after: api.getMapState().locationCount };
		});

		expect(r.threw).toBe(true);
		expect(r.after).toBe(r.before);
	});
});
