import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	openMap,
	addLocs,
	getAllLocs,
	getLoc,
	getLocOrNull,
	getLocCount,
	createLocation,
	randomLatLng,
	randomHeading,
	createTag,
	withApi,
} from "./helpers";
import type { Location } from "@/types";

// =============================================================================
// 1. Delta recovery (crash simulation)
// =============================================================================

describe("Delta recovery", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("un-baked delta is recovered on reopen", async () => {
		mapId = await createAndOpenMap("Stress DeltaRecovery");

		const result = await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 20; i++) {
				locs.push(api.createLocation({
					lat: 10 + i * 0.01,
					lng: 20 + i * 0.01,
					heading: i * 18,
					zoom: 1,
					panoId: i % 3 === 0 ? `delta_pano_${i}` : null,
					flags: i % 2,
				}));
			}
			await api.addLocations(locs);
			return { ids: locs.map((l) => l.id) };
		});
		const originalIds: number[] = result.ids;

		// Flush writes the delta but does NOT bake (no close)
		await flushAndWait();

		// Close and reopen -- should merge delta
		await closeMap();
		await openMap(mapId);

		const count = await getLocCount();
		expect(count).toBe(20);

		// Spot-check a few locations survived with correct data
		const loc0 = await getLoc(originalIds[0]);
		expect(loc0).toBeTruthy();
		expect(loc0.lat).toBeCloseTo(10, 2);
		expect(loc0.panoId).toBe("delta_pano_0");
		expect(loc0.flags).toBe(0);

		const loc3 = await getLoc(originalIds[3]);
		expect(loc3).toBeTruthy();
		expect(loc3.panoId).toBe("delta_pano_3");
		expect(loc3.flags).toBe(1);

		const loc7 = await getLoc(originalIds[7]);
		expect(loc7).toBeTruthy();
		expect(loc7.heading).toBeCloseTo(7 * 18, 0);
		expect(loc7.panoId).toBeNull();
	});
});

// =============================================================================
// 2. Bake with mixed overlay (add + update + remove)
// =============================================================================

describe("Bake with mixed overlay", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress MixedOverlay");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("add/update/remove then close/reopen produces correct state", async () => {
		// Add 50 locations with deterministic data
		const result = await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 50; i++) {
				locs.push(api.createLocation({
					lat: i,
					lng: i * 2,
					heading: i,
					zoom: 1,
					panoId: `mix_${i}`,
				}));
			}
			await api.addLocations(locs);
			const ids = locs.map((l) => l.id);

			// Update 10 (indices 0-9): change heading and lat
			for (let i = 0; i < 10; i++) {
				await api.updateLocation(ids[i], { heading: 999, lat: 100 + i });
			}

			// Remove 5 (indices 45-49)
			const removeIds = ids.slice(45);
			await api.removeLocations(new Set(removeIds));

			return { ids, removeIds };
		});

		// Close triggers bake, then reopen
		await closeMap();
		await openMap(mapId);

		const count = await getLocCount();
		expect(count).toBe(45);

		// Updated locations have new values
		const upd0 = await getLoc(result.ids[0]);
		expect(upd0.heading).toBe(999);
		expect(upd0.lat).toBeCloseTo(100, 0);
		expect(upd0.panoId).toBe("mix_0"); // untouched field

		const upd9 = await getLoc(result.ids[9]);
		expect(upd9.heading).toBe(999);
		expect(upd9.lat).toBeCloseTo(109, 0);

		// Removed locations are gone
		for (const rmId of result.removeIds) {
			const loc = await getLocOrNull(rmId);
			expect(loc).toBeFalsy();
		}

		// Untouched locations are unchanged
		const unch20 = await getLoc(result.ids[20]);
		expect(unch20.heading).toBe(20);
		expect(unch20.lat).toBeCloseTo(20, 0);
		expect(unch20.panoId).toBe("mix_20");

		const unch44 = await getLoc(result.ids[44]);
		expect(unch44.heading).toBe(44);
		expect(unch44.panoId).toBe("mix_44");
	});
});

// =============================================================================
// 3. Multiple save/close/reopen cycles
// =============================================================================

describe("Multiple save/close/reopen cycles", () => {
	let mapId: string;
	let batch1Ids: number[];
	let batch2Ids: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress MultiCycle");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("cycle 1: add 50, close, reopen", async () => {
		const locs = [];
		for (let i = 0; i < 50; i++) locs.push(createLocation({ lat: i, lng: i }));
		batch1Ids = await addLocs(locs);

		await closeMap();
		await openMap(mapId);

		const count = await getLocCount();
		expect(count).toBe(50);
	});

	it("cycle 2: add 30 more, close, reopen", async () => {
		const locs = [];
		for (let i = 0; i < 30; i++) locs.push(createLocation({ lat: 100 + i, lng: 100 + i }));
		batch2Ids = await addLocs(locs);

		await closeMap();
		await openMap(mapId);

		const count = await getLocCount();
		expect(count).toBe(80);

		// Verify both batches' data
		const b1sample = await getLoc(batch1Ids[0]);
		expect(b1sample).toBeTruthy();
		expect(b1sample.lat).toBeCloseTo(0, 0);

		const b2sample = await getLoc(batch2Ids[0]);
		expect(b2sample).toBeTruthy();
		expect(b2sample.lat).toBeCloseTo(100, 0);
	});

	it("cycle 3: remove 10, close, reopen", async () => {
		const toRemove = batch1Ids.slice(0, 10);
		await withApi((api, ids) => api.removeLocations(new Set(ids)), toRemove);

		await closeMap();
		await openMap(mapId);

		const count = await getLocCount();
		expect(count).toBe(70);

		// Removed are gone
		const removed = await getLocOrNull(toRemove[0]);
		expect(removed).toBeFalsy();

		// Kept are intact
		const kept = await getLoc(batch1Ids[10]);
		expect(kept).toBeTruthy();
	});
});

// =============================================================================
// 4. Repeated updates to same location
// =============================================================================

describe("Repeated updates to same location", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress RepeatedUpdate");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("only the final heading value persists after close/reopen", async () => {
		const ids = await addLocs([createLocation({ lat: 10, lng: 20 })]);
		const locId = ids[0];

		const headings = [45, 90, 135, 270, 315];
		for (const h of headings) {
			await withApi((api, id, heading) => api.updateLocation(id, { heading }), locId, h);
		}

		// Verify in-memory
		let loc = await getLoc(locId);
		expect(loc.heading).toBe(315);

		// Close/reopen
		await closeMap();
		await openMap(mapId);

		loc = await getLoc(locId);
		expect(loc.heading).toBe(315);
		expect(loc.lat).toBeCloseTo(10, 0);
		expect(loc.lng).toBeCloseTo(20, 0);
	});
});

// =============================================================================
// 5. alive_count accuracy through mutations + undo/redo
// =============================================================================

describe("alive_count accuracy", () => {
	let mapId: string;
	let allIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress AliveCount");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("add 100 -> count=100", async () => {
		const locs = [];
		for (let i = 0; i < 100; i++) locs.push(createLocation({ lat: i, lng: i }));
		allIds = await addLocs(locs);

		const count = await getLocCount();
		expect(count).toBe(100);
	});

	it("remove 30 -> count=70", async () => {
		const toRemove = allIds.slice(0, 30);
		await withApi((api, ids) => api.removeLocations(new Set(ids)), toRemove);

		const count = await getLocCount();
		expect(count).toBe(70);
	});

	it("undo remove -> count=100", async () => {
		await withApi((api) => api.undo());

		const count = await getLocCount();
		expect(count).toBe(100);
	});

	it("redo remove -> count=70", async () => {
		await withApi((api) => api.redo());

		const count = await getLocCount();
		expect(count).toBe(70);
	});

	it("add 10 more -> count=80", async () => {
		const locs = [];
		for (let i = 0; i < 10; i++) locs.push(createLocation({ lat: 200 + i, lng: 200 + i }));
		await addLocs(locs);

		const count = await getLocCount();
		expect(count).toBe(80);
	});

	it("close -> reopen -> count=80", async () => {
		await closeMap();
		await openMap(mapId);

		const count = await getLocCount();
		expect(count).toBe(80);
	});
});

// =============================================================================
// 6. Tag count accuracy through mutations + undo
// =============================================================================

describe("Tag count accuracy", () => {
	let mapId: string;
	let tagId: number;
	let taggedIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress TagCount");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("50 locs with tag -> tagCount=50", async () => {
		const tag = await createTag("CountTag");
		tagId = tag.id;

		const locs = [];
		for (let i = 0; i < 50; i++) locs.push(createLocation({ lat: i, lng: i, tags: [tagId] }));
		taggedIds = await addLocs(locs);

		const counts = await withApi((api) => api.cmd.storeTagCounts());
		expect(counts[tagId]).toBe(50);
	});

	it("remove 10 tagged -> tagCount=40", async () => {
		const toRemove = taggedIds.slice(0, 10);
		await withApi((api, ids) => api.removeLocations(new Set(ids)), toRemove);

		const counts = await withApi((api) => api.cmd.storeTagCounts());
		expect(counts[tagId]).toBe(40);
	});

	it("undo remove -> tagCount=50", async () => {
		await withApi((api) => api.undo());

		const counts = await withApi((api) => api.cmd.storeTagCounts());
		expect(counts[tagId]).toBe(50);
	});

	it("bulkAddTag to untagged locs -> tagCount=70", async () => {
		// Add 20 untagged locs
		const untaggedLocs = [];
		for (let i = 0; i < 20; i++) untaggedLocs.push(createLocation({ lat: 100 + i, lng: 100 + i }));
		await addLocs(untaggedLocs);

		await withApi(async (api, tId) => {
			await api.selectEverything();
			await api.addTagToLocations(tId, [...api.getSelectedLocationIds()]);
		}, tagId);

		const counts = await withApi((api) => api.cmd.storeTagCounts());
		expect(counts[tagId]).toBe(70);
	});

	it("tagCount=70 survives close/reopen", async () => {
		await closeMap();
		await openMap(mapId);

		const counts = await withApi((api) => api.cmd.storeTagCounts());
		expect(counts[tagId]).toBe(70);
	});
});

// =============================================================================
// 7. Float precision round-trip
// =============================================================================

describe("Float precision round-trip", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress FloatPrecision");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("high-precision floats survive close/reopen to 10 decimal places", async () => {
		const lat = 48.856789012345;
		const lng = 2.352345678901;
		const heading = 123.456789;
		const pitch = -12.345678;
		const zoom = 2.56789;

		const ids = await addLocs([createLocation({ lat, lng, heading, pitch, zoom })]);
		const locId = ids[0];

		await closeMap();
		await openMap(mapId);

		const loc = await getLoc(locId);

		// f64 gives ~15-16 significant digits; check at least 10
		expect(loc.lat).toBeCloseTo(lat, 10);
		expect(loc.lng).toBeCloseTo(lng, 10);
		expect(loc.heading).toBeCloseTo(heading, 6);
		expect(loc.pitch).toBeCloseTo(pitch, 6);
		expect(loc.zoom).toBeCloseTo(zoom, 5);
	});
});

// =============================================================================
// 8. Null vs absent field round-trip
// =============================================================================

describe("Null vs absent field round-trip", () => {
	let mapId: string;
	let id1: number;
	let id2: number;
	let id3: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress NullFields");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("null panoId and null/absent extra survive round-trip", async () => {
		const result = await withApi(async (api) => {
			const loc1 = api.createLocation({ lat: 10, lng: 20, zoom: 1 });
			const loc2 = api.createLocation({
				lat: 30,
				lng: 40,
				zoom: 1,
				panoId: "ABC",
				extra: { foo: "bar" },
			});
			const loc3 = api.createLocation({
				lat: 50,
				lng: 60,
				zoom: 1,
				extra: {},
			});
			const batch = [loc1, loc2, loc3];
			await api.addLocations(batch);
			return { ids: batch.map((l) => l.id) };
		});
		id1 = result.ids[0];
		id2 = result.ids[1];
		id3 = result.ids[2];

		await closeMap();
		await openMap(mapId);

		const l1 = await getLoc(id1);
		expect(l1.panoId).toBeNull();
		// extra is null/undefined or empty -- both OK
		expect(
			l1.extra == null || (typeof l1.extra === "object" && Object.keys(l1.extra).length === 0),
		).toBe(true);

		const l2 = await getLoc(id2);
		expect(l2.panoId).toBe("ABC");
		expect(l2.extra.foo).toBe("bar");

		const l3 = await getLoc(id3);
		expect(l3.panoId).toBeNull();
		if (l3.extra && typeof l3.extra === "object") {
			expect(Object.keys(l3.extra).length).toBe(0);
		}
	});
});

// =============================================================================
// 9. Unicode in all fields
// =============================================================================

describe("Unicode in all fields", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress Unicode");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("Unicode panoId, extra keys/values, and tag names survive round-trip", async () => {
		const result = await withApi(async (api) => {
			const resolved = await api.createTags([
				"東京タワー", // CJK
				"café crème", // diacritics
				"Москва", // Cyrillic
			]);

			const loc = api.createLocation({
				lat: 35.6762,
				lng: 139.6503,
				heading: 90,
				zoom: 1,
				panoId: "CAoSK0FG_東京_éè",
				tags: [resolved[0].id, resolved[1].id, resolved[2].id],
				extra: {
					地名: "東京タワー",
					straße: "café",
					nested: { Адрес: "Москва" },
				},
			});
			const batch = [loc];
			await api.addLocations(batch);
			return {
				locId: batch[0].id,
				tagIds: resolved.map((t) => t.id),
				tagNames: resolved.map((t) => t.name),
			};
		});

		await closeMap();
		await openMap(mapId);

		const loc = await getLoc(result.locId);
		expect(loc.panoId).toBe("CAoSK0FG_東京_éè");
		expect(loc.extra["地名"]).toBe("東京タワー");
		expect(loc.extra["straße"]).toBe("café");
		expect(loc.extra.nested["Адрес"]).toBe("Москва");

		// Verify tags survived
		expect(loc.tags).toContain(result.tagIds[0]);
		expect(loc.tags).toContain(result.tagIds[1]);
		expect(loc.tags).toContain(result.tagIds[2]);

		// Verify tag names in meta
		const tags = await withApi((api) => api.getCurrentMap()!.meta.tags);
		expect(tags[result.tagIds[0]].name).toBe("東京タワー");
		expect(tags[result.tagIds[1]].name).toBe("café crème");
		expect(tags[result.tagIds[2]].name).toBe("Москва");
	});
});

// =============================================================================
// 10. Import into non-empty map (simulated via addLocs)
// =============================================================================

describe("Import into non-empty map", () => {
	let mapId: string;
	let batch1Ids: number[];
	let tagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress ImportNonEmpty");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("adding locations to a pre-populated, already-saved map", async () => {
		const tag = await createTag("ImportTag");
		tagId = tag.id;

		// First batch: 50 locs with tag
		const locs1 = [];
		for (let i = 0; i < 50; i++) locs1.push(createLocation({ lat: i, lng: i, tags: [tagId] }));
		batch1Ids = await addLocs(locs1);

		await flushAndWait();

		// Second batch: 30 more (simulates import path)
		const locs2 = [];
		for (let i = 0; i < 30; i++) locs2.push(createLocation({ lat: 100 + i, lng: 100 + i }));
		await addLocs(locs2);

		const count = await getLocCount();
		expect(count).toBe(80);

		await closeMap();
		await openMap(mapId);

		const afterReopen = await getLocCount();
		expect(afterReopen).toBe(80);

		// First batch data is intact
		const b1 = await getLoc(batch1Ids[25]);
		expect(b1).toBeTruthy();
		expect(b1.tags).toContain(tagId);
	});
});

// =============================================================================
// 11. Export with scope (selected IDs only)
// =============================================================================

describe("Export with scope", () => {
	let mapId: string;
	let tagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress ExportScope");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("export with selected IDs only exports those locations", async () => {
		const tag = await createTag("ScopeTag");
		tagId = tag.id;

		const locs = [];
		for (let i = 0; i < 10; i++) {
			locs.push(
				createLocation({
					lat: i * 10,
					lng: i * 10,
					tags: i < 5 ? [tagId] : [],
				}),
			);
		}
		await addLocs(locs);

		// Select by tag (first 5 have the tag)
		await withApi((api, tId) => api.selectTag(tId), tagId);

		const selectedIds: number[] = await withApi((api) => [...api.getSelectedLocationIds()]);
		expect(selectedIds.length).toBe(5);

		// Export with scope = selectedIds
		const result = await withApi(async (api, scope) => {
			const map = api.getCurrentMap()!;
			const path = await api.cmd.storeExportJson({
				exportZoom: true,
				exportUnpanned: true,
				exportExtras: true,
				scope,
				mapName: map.meta.name,
				tagsJson: JSON.stringify(map.meta.tags),
				extraFieldsJson: null,
			});
			const res = await fetch("http://mma-buf.localhost/" + path.replace(/\\/g, "/"));
			const json = await res.text();
			const parsed = JSON.parse(json);
			return { count: parsed.customCoordinates.length };
		}, selectedIds);

		expect(result.count).toBe(5);
	});
});

// =============================================================================
// 12. VCS: checkout then edit then re-commit
// =============================================================================

describe("VCS: checkout, edit, re-commit", () => {
	let mapId: string;
	let v1CommitId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress VCS");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("commit v1 with 5 locs", async () => {
		const locs = [];
		for (let i = 0; i < 5; i++) locs.push(createLocation({ lat: i, lng: i }));
		await addLocs(locs);

		v1CommitId = await withApi((api) => api.commitMap("v1"));
		expect(String(v1CommitId)).not.toContain("ERROR");
	});

	it("commit v2 with 5 more locs (total 10)", async () => {
		const locs = [];
		for (let i = 0; i < 5; i++) locs.push(createLocation({ lat: 100 + i, lng: 100 + i }));
		await addLocs(locs);

		const v2CommitId = await withApi((api) => api.commitMap("v2"));
		expect(String(v2CommitId)).not.toContain("ERROR");

		const count = await getLocCount();
		expect(count).toBe(10);
	});

	it("checkout v1 -> count=5", async () => {
		await withApi((api, commitId) => api.checkoutCommit(commitId), v1CommitId);

		const count = await getLocCount();
		expect(count).toBe(5);
	});

	it("add 3 new locs and commit v3 -> count=8", async () => {
		const locs = [];
		for (let i = 0; i < 3; i++) locs.push(createLocation({ lat: 200 + i, lng: 200 + i }));
		await addLocs(locs);

		await withApi((api) => api.commitMap("v3 from v1 fork"));

		const count = await getLocCount();
		expect(count).toBe(8);
	});

	it("3 commits exist in history", async () => {
		const commits = await withApi((api, id) => api.cmd.storeListCommits(id), mapId);
		// v1 + v2 + revert(checkout) + v3 = 4 commits total
		// (checkout creates a revert commit, so we actually have 4)
		expect(commits.length).toBeGreaterThanOrEqual(3);

		// Most recent should be v3
		expect(commits[0].message).toContain("v3");
	});
});

// =============================================================================
// 13. Commit with pending overlay
// =============================================================================

describe("Commit with pending overlay", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress CommitOverlay");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("commit bakes pending overlay data", async () => {
		// Add 10 locs -- they sit in overlay, no save/close
		const locs = [];
		for (let i = 0; i < 10; i++) locs.push(createLocation({ lat: i, lng: i, panoId: `ov_${i}` }));
		const ids = await addLocs(locs);

		// Commit immediately (overlay not flushed separately)
		const commitId = await withApi((api) => api.commitMap("overlay commit"));
		expect(String(commitId)).not.toContain("ERROR");

		// Close and reopen
		await closeMap();
		await openMap(mapId);

		const count = await getLocCount();
		expect(count).toBe(10);

		// Verify data fidelity
		const loc5 = await getLoc(ids[5]);
		expect(loc5).toBeTruthy();
		expect(loc5.panoId).toBe("ov_5");
	});
});

// =============================================================================
// 14. Large batch undo correctness
// =============================================================================

describe("Large batch undo correctness", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Stress LargeBatchUndo");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("add 10000 -> undo -> redo -> close -> reopen", async () => {
		// Add 10000 in a single batch (built in-browser to avoid serialization overhead)
		await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 10000; i++) {
				locs.push(api.createLocation({
					lat: (i % 180) - 90,
					lng: (i % 360) - 180,
					heading: i % 360,
					zoom: 1,
				}));
			}
			await api.addLocations(locs);
		});

		let count = await getLocCount();
		expect(count).toBe(10000);

		// Undo the entire batch
		await withApi((api) => api.undo());

		count = await getLocCount();
		expect(count).toBe(0);

		// Redo
		await withApi((api) => api.redo());

		count = await getLocCount();
		expect(count).toBe(10000);

		// Close and reopen
		await closeMap();
		await openMap(mapId);

		count = await getLocCount();
		expect(count).toBe(10000);
	});
});

// =============================================================================
// 15. Rapid fire-and-forget mutations (no await between calls)
// =============================================================================

describe("Rapid fire-and-forget mutations", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});
	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("20 rapid addLocations calls without awaiting all land", async () => {
		mapId = await createAndOpenMap("Stress RapidAdd");
		const result = await withApi(async (api) => {
			const promises = [];
			for (let i = 0; i < 20; i++) {
				promises.push(
					api.addLocations([
						api.createLocation({
							lat: i,
							lng: i,
							heading: i * 18,
							zoom: 1,
						}),
					]),
				);
			}
			await Promise.all(promises);
			const count = await api.cmd.storeLocationCount();
			return { count };
		});
		expect(result.count).toBe(20);
	});

	it("rapid add + remove interleaved", async () => {
		const result = await withApi(async (api) => {
			// Add 10 locations
			const locs: Location[] = [];
			for (let i = 0; i < 10; i++) {
				locs.push(api.createLocation({
					lat: 50 + i,
					lng: 50 + i,
					zoom: 1,
				}));
			}
			await api.addLocations(locs);
			const ids = locs.map((l) => l.id);

			// Fire remove + add simultaneously (no await between)
			const removePromise = Promise.resolve().then(() => api.removeLocations(new Set(ids.slice(0, 5))));
			const addPromise = api.addLocations([
				api.createLocation({ lat: 99, lng: 99, zoom: 1 }),
			]);
			await Promise.all([removePromise, addPromise]);

			const count = await api.cmd.storeLocationCount();
			// 10 - 5 + 1 = 6, plus the 20 from previous test
			return { count };
		});
		expect(result.count).toBe(26); // 20 + 10 - 5 + 1
	});

	it("data survives close/reopen after rapid mutations", async () => {
		await closeMap();
		await openMap(mapId);
		const count = await getLocCount();
		expect(count).toBe(26);
	});
});

// =============================================================================
// 16. Autosave racing with mutations
// =============================================================================

describe("Autosave racing with mutations", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});
	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("flush during active editing doesn't lose data", async () => {
		mapId = await createAndOpenMap("Stress AutosaveRace");

		const result = await withApi(async (api) => {
			// Add 50 locations
			const locs: Location[] = [];
			for (let i = 0; i < 50; i++) {
				locs.push(api.createLocation({
					lat: i,
					lng: i,
					heading: i * 7.2,
					zoom: 1,
				}));
			}
			await api.addLocations(locs);

			// Now fire a save AND more mutations simultaneously
			const savePromise = api.flushSave();
			// These mutations happen while save might be serializing the overlay
			const addPromise = api.addLocations([
				api.createLocation({
					lat: 100,
					lng: 100,
					zoom: 1,
					panoId: "post-save",
					flags: 1,
				}),
			]);
			await Promise.all([savePromise, addPromise]);

			// One more save to capture the post-save location
			await api.flushSave();

			const count = await api.cmd.storeLocationCount();
			return { count };
		});
		expect(result.count).toBe(51);

		// Close and reopen to verify persistence
		await closeMap();
		await openMap(mapId);
		const count = await getLocCount();
		expect(count).toBe(51);

		// Verify the post-save location survived
		const locs = await getAllLocs();
		const postSave = locs.find((l) => l.panoId === "post-save");
		expect(postSave).toBeTruthy();
		expect(postSave!.flags).toBe(1);
	});
});

// =============================================================================
// 17. Undo while save is in-flight
// =============================================================================

describe("Undo while save in-flight", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});
	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("undo during save doesn't corrupt state", async () => {
		mapId = await createAndOpenMap("Stress UndoSave");

		const result = await withApi(async (api) => {
			// Add batch 1
			const batch1: Location[] = [];
			for (let i = 0; i < 20; i++) {
				batch1.push(api.createLocation({ lat: i, lng: i, zoom: 1 }));
			}
			await api.addLocations(batch1);

			// Add batch 2
			const batch2: Location[] = [];
			for (let i = 0; i < 10; i++) {
				batch2.push(api.createLocation({ lat: 100 + i, lng: 100 + i, zoom: 1 }));
			}
			await api.addLocations(batch2);

			// Fire save and undo simultaneously
			const savePromise = api.flushSave();
			const undoPromise = api.undo();
			await Promise.all([savePromise, undoPromise]);

			const count = await api.cmd.storeLocationCount();
			return { count };
		});
		// After undo of batch 2, should have 20
		expect(result.count).toBe(20);

		// Save current state, close, reopen
		await flushAndWait();
		await closeMap();
		await openMap(mapId);
		const count = await getLocCount();
		expect(count).toBe(20);
	});
});

// =============================================================================
// 18. Rapid open/close cycles
// =============================================================================

describe("Rapid open/close cycles", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});
	after(async () => {
		await deleteMap(mapId);
	});

	it("data survives rapid open/close without corruption", async () => {
		mapId = await createAndOpenMap("Stress RapidOpenClose");
		const ids = await addLocs([
			createLocation({ lat: 11.11, lng: 22.22, heading: 33.33, panoId: "survives", flags: 1 }),
			createLocation({ lat: 44.44, lng: 55.55, heading: 66.66 }),
		]);
		await flushAndWait();
		await closeMap();

		// Rapid open/close 5 times
		for (let i = 0; i < 5; i++) {
			await openMap(mapId);
			await closeMap();
		}

		// Final open -- verify data is intact
		await openMap(mapId);
		const count = await getLocCount();
		expect(count).toBe(2);

		const loc = await getLoc(ids[0]);
		expect(loc.lat).toBeCloseTo(11.11, 2);
		expect(loc.lng).toBeCloseTo(22.22, 2);
		expect(loc.heading).toBeCloseTo(33.33, 2);
		expect(loc.panoId).toBe("survives");
		expect(loc.flags).toBe(1);
		await closeMap();
	});
});

// =============================================================================
// 19. Rapid updates to many locations simultaneously
// =============================================================================

describe("Rapid batch updates", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});
	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("100 concurrent updateLocation calls all persist", async () => {
		mapId = await createAndOpenMap("Stress RapidUpdate");
		const locs: Location[] = [];
		for (let i = 0; i < 100; i++) locs.push(createLocation({ lat: i, lng: i }));
		const ids = await addLocs(locs);

		// Fire 100 updates simultaneously -- each sets heading to its index
		await withApi(async (api, idList) => {
			const promises = idList.map((id: number, i: number) =>
				api.batchUpdateLocations([{ id, patch: { heading: (i + 1) * 3.6 } }]),
			);
			await Promise.all(promises);
		}, ids);

		// Close and reopen
		await closeMap();
		await openMap(mapId);

		// Verify each location has its correct heading
		const allLocs = await getAllLocs();
		expect(allLocs.length).toBe(100);

		let correctCount = 0;
		for (const loc of allLocs) {
			const idx = ids.indexOf(loc.id);
			if (idx >= 0) {
				const expected = (idx + 1) * 3.6;
				if (Math.abs(loc.heading - expected) < 0.001) correctCount++;
			}
		}
		expect(correctCount).toBe(100);
	});
});

// =============================================================================
// 20. Selection sync during mutation
// =============================================================================

describe("Selection during mutation", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});
	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("selection count updates correctly after add during active selection", async () => {
		mapId = await createAndOpenMap("Stress SelMutation");
		const tag = await createTag("sel-mut-tag");

		// Add 30 tagged locations
		const locs: Location[] = [];
		for (let i = 0; i < 30; i++) locs.push(createLocation({ ...randomLatLng(), ...randomHeading(), tags: [tag.id] }));
		await addLocs(locs);

		// Select by tag -- should get 30
		const count1 = await withApi(async (api, tid) => {
			await api.selectTag(tid);
			return api.getSelectedLocationIds().size;
		}, tag.id);
		expect(count1).toBe(30);

		// Add 10 more tagged locations while selection is active
		const moreLocs: Location[] = [];
		for (let i = 0; i < 10; i++) moreLocs.push(createLocation({ ...randomLatLng(), ...randomHeading(), tags: [tag.id] }));
		await addLocs(moreLocs);

		// Re-select -- should now get 40
		const count2 = await withApi(async (api, tid) => {
			api.resetSelections();
			await api.selectTag(tid);
			return api.getSelectedLocationIds().size;
		}, tag.id);
		expect(count2).toBe(40);
	});

	it("removing selected locations updates selection", async () => {
		const result = await withApi(async (api) => {
			api.resetSelections();
			await api.selectEverything();
			const beforeCount = api.getSelectedLocationIds().size;
			const ids = [...api.getSelectedLocationIds()].slice(0, 5);
			api.removeLocations(new Set(ids));
			// Give Rust a moment to refresh selections
			await new Promise((r) => setTimeout(r, 100));
			await api.selectEverything();
			return { before: beforeCount, after: api.getSelectedLocationIds().size };
		});
		expect(result.after).toBe(result.before - 5);
	});
});

// =============================================================================
// 21. Edit, close without explicit save, reopen (autosave path)
// =============================================================================

describe("Implicit save on close", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});
	after(async () => {
		await deleteMap(mapId);
	});

	it("edits persist even without explicit flushSave", async () => {
		mapId = await createAndOpenMap("Stress ImplicitSave");

		const ids = await addLocs([
			createLocation({ lat: 77.77, lng: 88.88, heading: 99.99, panoId: "nosave", flags: 1 }),
		]);

		// Update without flushing
		await withApi((api, id) => api.updateLocation(id, { heading: 222.22 }), ids[0]);

		// Close immediately (bake happens in close)
		await closeMap();
		await openMap(mapId);

		const loc = await getLoc(ids[0]);
		expect(loc.lat).toBeCloseTo(77.77, 2);
		expect(loc.lng).toBeCloseTo(88.88, 2);
		expect(loc.heading).toBeCloseTo(222.22, 2);
		expect(loc.panoId).toBe("nosave");
		expect(loc.flags).toBe(1);
		await closeMap();
	});
});

// =============================================================================
// 22. Delete all locations then undo
// =============================================================================

describe("Delete all then undo", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});
	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("empty map after delete-all, undo restores everything", async () => {
		mapId = await createAndOpenMap("Stress DeleteAll");

		const locs: Location[] = [];
		for (let i = 0; i < 25; i++) locs.push(createLocation({ lat: i, lng: i, heading: i * 14.4 }));
		const ids = await addLocs(locs);

		// Delete all
		await withApi((api, idList) => api.removeLocations(new Set(idList)), ids);

		let count = await getLocCount();
		expect(count).toBe(0);

		// Undo
		await withApi((api) => api.undo());

		count = await getLocCount();
		expect(count).toBe(25);

		// Verify a specific location's data
		const loc = await getLoc(ids[12]);
		expect(loc).toBeTruthy();
		expect(loc.lat).toBeCloseTo(12, 0);
		expect(loc.heading).toBeCloseTo(12 * 14.4, 1);

		// Close/reopen
		await closeMap();
		await openMap(mapId);
		count = await getLocCount();
		expect(count).toBe(25);
	});
});

// =============================================================================
// 23. Duplicate then delete original
// =============================================================================

describe("Duplicate then delete original", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});
	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("duplicate survives when original is deleted", async () => {
		mapId = await createAndOpenMap("Stress DupDelete");

		const ids = await addLocs([
			createLocation({ lat: 42.42, lng: 13.13, heading: 270, panoId: "original", flags: 1 }),
		]);
		const origId = ids[0];

		// Duplicate
		const dupId = await withApi((api, id) => api.duplicateLocation(id), origId);
		expect(typeof dupId).toBe("number");

		// Delete original
		await withApi((api, id) => api.removeLocations(new Set([id])), origId);

		const count = await getLocCount();
		expect(count).toBe(1);

		// Verify duplicate has original's data
		const dup = await getLoc(dupId as number);
		expect(dup).toBeTruthy();
		expect(dup.lat).toBeCloseTo(42.42, 2);
		expect(dup.lng).toBeCloseTo(13.13, 2);
		expect(dup.heading).toBeCloseTo(270, 0);

		// Close/reopen
		await closeMap();
		await openMap(mapId);
		const count2 = await getLocCount();
		expect(count2).toBe(1);
		const dup2 = await getLoc(dupId as number);
		expect(dup2.lat).toBeCloseTo(42.42, 2);
	});
});
