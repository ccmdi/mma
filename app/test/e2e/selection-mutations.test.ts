import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	openMap,
	addLocs,
	createLocation,
	createTag,
	refreshSelections,
	withApi,
} from "./helpers";
import type { Location } from "@/types";

// ============================================================================
// 1. Live selection correctness after add/remove
// ============================================================================

describe("Live selection correctness after add/remove", () => {
	let mapId: string;
	let locIds: number[];
	let tagRedId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E SelMut AddRemove");
		await browser.pause(500);

		const tagRed = await createTag("t-red");
		tagRedId = tagRed.id;

		const locs: Location[] = [];
		for (let i = 0; i < 20; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					tags: i < 10 ? [tagRedId] : [],
				}),
			);
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("tag selection updates when matching locations are added (no reset)", async () => {
		const before = await withApi(async (api, tagId: number) => {
			await api.selectTag(tagId);
			const before = api.getSelectedLocationIds().size;

			const newLocs = [];
			for (let i = 0; i < 10; i++) {
				newLocs.push(
					api.createLocation({
						lat: 50 + i,
						lng: 50 + i,
						tags: i < 5 ? [tagId] : [],
					}),
				);
			}
			await api.addLocations(newLocs);
			return before;
		}, tagRedId);
		const ids = await refreshSelections();
		expect(before).toBe(10);
		expect(ids.length).toBe(15);
	});

	it("Everything selection count increases on add (no reset)", async () => {
		const before = await withApi(async (api) => {
			await api.selectEverything();
			const before = api.getSelectedLocationIds().size;
			await api.addLocations([
				api.createLocation({ lat: 99, lng: 99 }),
			]);
			return before;
		});
		const ids = await refreshSelections();
		expect(ids.length).toBe(before + 1);
	});

	it("removing locations IN active selection decreases count (no reset)", async () => {
		const id0 = locIds[0];
		const id1 = locIds[1];
		const result = await withApi(
			async (api, tagId: number, removeId0: number, removeId1: number) => {
				await api.selectTag(tagId);
				const before = api.getSelectedLocationIds().size;
				await api.removeLocations(new Set([removeId0, removeId1]));
				const result = await api.syncSelections();
				const after = result.ids;
				return { before, after: after.length };
			},
			tagRedId,
			id0,
			id1,
		);
		expect(result.after).toBe(result.before - 2);
	});

	it("removing locations NOT in active selection keeps count same (no reset)", async () => {
		const id10 = locIds[10];
		const id11 = locIds[11];
		const before = await withApi(
			async (api, tagId: number, removeId0: number, removeId1: number) => {
				await api.selectTag(tagId);
				const before = api.getSelectedLocationIds().size;
				api.removeLocations(new Set([removeId0, removeId1]));
				return before;
			},
			tagRedId,
			id10,
			id11,
		);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before);
	});

	it("add then remove in sequence, final count correct (no reset between)", async () => {
		const initial = await withApi(async (api, tagId: number) => {
			await api.selectTag(tagId);
			return api.getSelectedLocationIds().size;
		}, tagRedId);

		const afterAddIds = await withApi(async (api, tagId: number) => {
			const newLocs = [
				api.createLocation({ lat: 70, lng: 70, tags: [tagId] }),
				api.createLocation({ lat: 71, lng: 71, tags: [tagId] }),
				api.createLocation({ lat: 72, lng: 72, tags: [tagId] }),
			];
			await api.addLocations(newLocs);
			const result = await api.syncSelections();
			const ids: number[] = result.ids;
			// Store second loc id for removal
			return { ids, removeId: newLocs[1].id };
		}, tagRedId);
		expect(afterAddIds.ids.length).toBe(initial + 3);

		await withApi(async (api, removeId: number) => {
			api.removeLocations(new Set([removeId]));
		}, afterAddIds.removeId);
		const ids = await refreshSelections();
		expect(ids.length).toBe(initial + 2);
	});
});

// ============================================================================
// 2. Live selection correctness after update
// ============================================================================

describe("Live selection correctness after update", () => {
	let mapId: string;
	let locIds: number[];
	let tagAlphaId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E SelMut Update");
		await browser.pause(500);

		const tagAlpha = await createTag("t-alpha");
		tagAlphaId = tagAlpha.id;

		const locs: Location[] = [];
		for (let i = 0; i < 20; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					heading: i < 10 ? 0 : 90,
					panoId: i < 15 ? `pano-${i}` : null,
					flags: i < 5 ? 1 : 0,
					tags: i < 10 ? [tagAlphaId] : [],
				}),
			);
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("updating location to ADD matching tag joins active tag selection", async () => {
		const id15 = locIds[15];
		const result = await withApi(
			async (api, tagId: number, locId: number) => {
				await api.selectTag(tagId);
				const before = api.getSelectedLocationIds().size;
				await api.updateLocation(locId, { tags: [tagId] });
				const result = await api.syncSelections();
				const after = result.ids;
				return { before, after: after.length, has: after.includes(locId) };
			},
			tagAlphaId,
			id15,
		);
		expect(result.before).toBe(10);
		expect(result.after).toBe(11);
		expect(result.has).toBe(true);
	});

	it("updating location to REMOVE matching tag leaves active tag selection", async () => {
		const id0 = locIds[0];
		const before = await withApi(
			async (api, tagId: number, locId: number) => {
				await api.selectTag(tagId);
				const before = api.getSelectedLocationIds().size;
				await api.updateLocation(locId, { tags: [] });
				return before;
			},
			tagAlphaId,
			id0,
		);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before - 1);
		expect(ids).not.toContain(id0);
	});

	it("PanoIds selection updates when flag toggled on (no reset)", async () => {
		const id10 = locIds[10];
		const before = await withApi(async (api, locId: number) => {
			await api.selectPanoIds();
			const before = api.getSelectedLocationIds().size;
			await api.updateLocation(locId, { flags: 1 });
			return before;
		}, id10);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before + 1);
	});

	it("PanoIds selection updates when flag toggled off (no reset)", async () => {
		const id0 = locIds[0];
		const before = await withApi(async (api, locId: number) => {
			await api.selectPanoIds();
			const before = api.getSelectedLocationIds().size;
			await api.updateLocation(locId, { flags: 0 });
			return before;
		}, id0);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before - 1);
	});

	it("Unpanned selection updates when heading changed from 0 (no reset)", async () => {
		const id0 = locIds[0];
		const before = await withApi(async (api, locId: number) => {
			await api.selectUnpanned();
			const before = api.getSelectedLocationIds().size;
			await api.updateLocation(locId, { heading: 45 });
			return before;
		}, id0);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before - 1);
	});

	it("Unpanned selection updates when heading changed to 0 (no reset)", async () => {
		const id10 = locIds[10];
		const before = await withApi(async (api, locId: number) => {
			await api.selectUnpanned();
			const before = api.getSelectedLocationIds().size;
			await api.updateLocation(locId, { heading: 0 });
			return before;
		}, id10);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before + 1);
	});
});

// ============================================================================
// 3. Review mode delete with active selections
// ============================================================================

describe("Review mode delete with active selections", () => {
	let mapId: string;
	let locIds: number[];
	let tagRvId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E SelMut Review");
		await browser.pause(500);

		const tagRv = await createTag("t-rv");
		tagRvId = tagRv.id;

		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					tags: i < 5 ? [tagRvId] : [],
				}),
			);
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => {
			api.resetSelections();
			api.cancelReview();
		});
	});

	it("reviewDelete decreases active tag selection count", async () => {
		const taggedIds = locIds.slice(0, 5);
		const result = await withApi(
			async (api, tagId: number, reviewIds: number[]) => {
				await api.selectTag(tagId);
				const before = api.getSelectedLocationIds().size;
				await api.beginReview(reviewIds);
				await api.reviewDelete();
				const result = await api.syncSelections();
				const after = result.ids;
				api.cancelReview();
				return { before, after: after.length };
			},
			tagRvId,
			taggedIds,
		);
		expect(result.before).toBe(5);
		expect(result.after).toBe(4);
	});

	it("after review-delete, new untagged location does NOT appear in tag selection (phantom bug)", async () => {
		const reviewIds = [locIds[1], locIds[2]];
		const result = await withApi(
			async (api, tagId: number, rvIds: number[]) => {
				await api.selectTag(tagId);
				const before = api.getSelectedLocationIds().size;
				await api.beginReview(rvIds);
				await api.reviewDelete();
				api.cancelReview();
				const result = await api.syncSelections();
				const after = result.ids;
				return { before, after: after.length };
			},
			tagRvId,
			reviewIds,
		);
		const afterDeleteCount = result.after;
		expect(afterDeleteCount).toBe(result.before - 1);

		await withApi(async (api) => {
			await api.addLocations([
				api.createLocation({ lat: 99, lng: 99 }),
			]);
		});
		const afterAddIds = await refreshSelections();
		expect(afterAddIds.length).toBe(afterDeleteCount);
	});

	it("review-delete with Everything selection decreases count", async () => {
		const result = await withApi(async (api) => {
			await api.selectEverything();
			const before = api.getSelectedLocationIds().size;
			const allLocs = await api.fetchAllLocations();
			const ids = allLocs.slice(0, 3).map(l => l.id);
			await api.beginReview(ids);
			await api.reviewDelete();
			const result = await api.syncSelections();
			const after = result.ids;
			api.cancelReview();
			return { before, after: after.length };
		});
		expect(result.after).toBe(result.before - 1);
	});
});

// ============================================================================
// 4. Selection correctness after undo/redo
// ============================================================================

describe("Selection correctness after undo/redo", () => {
	let mapId: string;
	let locIds: number[];
	let tagUndoId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E SelMut Undo");
		await browser.pause(500);

		const tagUndo = await createTag("t-undo");
		tagUndoId = tagUndo.id;

		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					tags: i < 5 ? [tagUndoId] : [],
				}),
			);
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("undo of add shrinks active selection", async () => {
		const before = await withApi(async (api, tagId: number) => {
			await api.selectTag(tagId);
			const before = api.getSelectedLocationIds().size;

			await api.addLocations([
				api.createLocation({ lat: 50, lng: 50, tags: [tagId] }),
			]);
			return before;
		}, tagUndoId);
		const afterAddIds = await refreshSelections();
		expect(afterAddIds.length).toBe(before + 1);

		await withApi(async (api) => api.undo());
		const afterUndoIds = await refreshSelections();
		expect(afterUndoIds.length).toBe(before);
	});

	it("undo of remove restores location into active tag selection", async () => {
		const id0 = locIds[0];
		await withApi(
			async (api, tagId: number, locId: number) => {
				await api.resetSelections();
				await api.selectTag(tagId);
				api.removeLocations(new Set([locId]));
				await new Promise((r) => setTimeout(r, 300));
			},
			tagUndoId,
			id0,
		);
		const afterRemoveIds = await refreshSelections();
		const before = afterRemoveIds.length;

		await withApi(async (api) => {
			api.undo();
			await new Promise((r) => setTimeout(r, 300));
		});
		const afterUndoIds = await refreshSelections();
		expect(afterUndoIds.length).toBe(before + 1);
		expect(afterUndoIds).toContain(id0);
	});

	it("undo of tag-add update removes location from tag selection", async () => {
		const id5 = locIds[5];
		await withApi(
			async (api, tagId: number, locId: number) => {
				await api.resetSelections();
				await api.selectTag(tagId);
				api.updateLocation(locId, { tags: [tagId] });
				await new Promise((r) => setTimeout(r, 300));
			},
			tagUndoId,
			id5,
		);
		const afterUpdateIds = await refreshSelections();
		const before = afterUpdateIds.length;

		await withApi(async (api) => {
			api.undo();
			await new Promise((r) => setTimeout(r, 300));
		});
		const afterUndoIds = await refreshSelections();
		expect(afterUndoIds.length).toBe(before - 1);
	});

	it("multiple undo/redo cycles keep selection consistent", async () => {
		const baseline = await withApi(async (api) => {
			await api.selectEverything();
			const baseline = api.getSelectedLocationIds().size;

			await api.addLocations([
				api.createLocation({ lat: 60, lng: 60 }),
				api.createLocation({ lat: 61, lng: 61 }),
				api.createLocation({ lat: 62, lng: 62 }),
			]);
			return baseline;
		});
		const afterAddIds = await refreshSelections();
		expect(afterAddIds.length).toBe(baseline + 3);

		await withApi(async (api) => api.undo());
		const afterUndo1 = await refreshSelections();
		expect(afterUndo1.length).toBe(baseline);

		await withApi(async (api) => api.redo());
		const afterRedo1 = await refreshSelections();
		expect(afterRedo1.length).toBe(baseline + 3);

		await withApi(async (api) => api.undo());
		const afterUndo2 = await refreshSelections();
		expect(afterUndo2.length).toBe(baseline);

		await withApi(async (api) => api.redo());
		const afterRedo2 = await refreshSelections();
		expect(afterRedo2.length).toBe(baseline + 3);
	});

	it("redo of add grows selection back", async () => {
		await withApi(async (api, tagId: number) => {
			await api.resetSelections();
			await api.selectTag(tagId);
			await api.addLocations([api.createLocation({ lat: 80, lng: 80, tags: [tagId] })]);
		}, tagUndoId);
		const afterAdd = await refreshSelections();

		await withApi(async (api) => {
			api.undo();
			await new Promise((r) => setTimeout(r, 300));
		});
		const afterUndoIds = await refreshSelections();
		expect(afterUndoIds.length).toBe(afterAdd.length - 1);

		await withApi(async (api) => {
			api.redo();
			await new Promise((r) => setTimeout(r, 300));
		});
		const afterRedoIds = await refreshSelections();
		expect(afterRedoIds.length).toBe(afterAdd.length);
	});
});

// ============================================================================
// 5. Composite selection correctness after mutations
// ============================================================================

describe("Composite selection correctness after mutations", () => {
	let mapId: string;
	let locIds: number[];
	let tagCompAId: number;
	let tagCompBId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E SelMut Composite");
		await browser.pause(500);

		const tagCompA = await createTag("t-comp-a");
		tagCompAId = tagCompA.id;
		const tagCompB = await createTag("t-comp-b");
		tagCompBId = tagCompB.id;

		const locs: Location[] = [];
		for (let i = 0; i < 20; i++) {
			const tags: number[] = [];
			if (i < 10) tags.push(tagCompAId);
			if (i >= 5 && i < 15) tags.push(tagCompBId);
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					tags,
				}),
			);
		}
		// cp-0..4:  [t-comp-a]
		// cp-5..9:  [t-comp-a, t-comp-b]
		// cp-10..14: [t-comp-b]
		// cp-15..19: []
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("intersection updates when location gains a tag to enter both children", async () => {
		const id0 = locIds[0];
		const before = await withApi(
			async (api, tagAId: number, tagBId: number, locId: number) => {
				await api.selectTag(tagAId);
				await api.selectTag(tagBId);
				await api.selectIntersection();
				const before = api.getSelectedLocationIds().size;

				await api.updateLocation(locId, { tags: [tagAId, tagBId] });
				return before;
			},
			tagCompAId,
			tagCompBId,
			id0,
		);
		const ids = await refreshSelections();
		expect(before).toBe(5);
		expect(ids.length).toBe(6);
		expect(ids).toContain(id0);
	});

	it("intersection updates when location loses a tag to leave one child", async () => {
		const id5 = locIds[5];
		const before = await withApi(
			async (api, tagAId: number, tagBId: number, locId: number) => {
				await api.selectTag(tagAId);
				await api.selectTag(tagBId);
				await api.selectIntersection();
				const before = api.getSelectedLocationIds().size;

				await api.updateLocation(locId, { tags: [tagAId] });
				return before;
			},
			tagCompAId,
			tagCompBId,
			id5,
		);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before - 1);
		expect(ids).not.toContain(id5);
	});

	it("union updates when location added matching only one child", async () => {
		const before = await withApi(
			async (api, tagAId: number, tagBId: number) => {
				await api.selectTag(tagAId);
				await api.selectTag(tagBId);
				await api.selectUnion();
				const before = api.getSelectedLocationIds().size;

				await api.addLocations([
					api.createLocation({ lat: 99, lng: 99, tags: [tagAId] }),
				]);
				return before;
			},
			tagCompAId,
			tagCompBId,
		);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before + 1);
	});

	it("union does NOT gain location matching neither child", async () => {
		const before = await withApi(
			async (api, tagAId: number, tagBId: number) => {
				await api.selectTag(tagAId);
				await api.selectTag(tagBId);
				await api.selectUnion();
				const before = api.getSelectedLocationIds().size;

				await api.addLocations([
					api.createLocation({ lat: 98, lng: 98 }),
				]);
				return before;
			},
			tagCompAId,
			tagCompBId,
		);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before);
	});
});

// ============================================================================
// 6. Bulk operations with active selections
// ============================================================================

describe("Bulk operations with active selections", () => {
	let mapId: string;
	let locIds: number[];
	let tagBulkId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E SelMut Bulk");
		await browser.pause(500);

		const tagBulk = await createTag("t-bulk");
		tagBulkId = tagBulk.id;

		const locs = [];
		for (let i = 0; i < 100; i++) {
			locs.push(
				createLocation({
					lat: i * 0.1,
					lng: i * 0.1,
				}),
			);
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("batchUpdateLocations adds tag to 50 locs, all join active tag selection", async () => {
		const first50 = locIds.slice(0, 50);
		const result = await withApi(
			async (api, tagId: number, ids: number[]) => {
				await api.selectTag(tagId);
				const before = api.getSelectedLocationIds().size;
				const updates = ids.map((id: number) => ({ id, patch: { tags: [tagId] } }));
				await api.batchUpdateLocations(updates);
				const result = await api.syncSelections();
				const after = result.ids;
				return { before, after: after.length };
			},
			tagBulkId,
			first50,
		);
		expect(result.before).toBe(0);
		expect(result.after).toBe(50);
	});

	it("adding 100 locations at once, correct delta for active tag selection", async () => {
		const before = await withApi(async (api, tagId: number) => {
			await api.selectTag(tagId);
			const before = api.getSelectedLocationIds().size;

			const newLocs: Location[] = [];
			for (let i = 0; i < 100; i++) {
				newLocs.push(
					api.createLocation({
						lat: 50 + i * 0.01,
						lng: 50 + i * 0.01,
						tags: i < 30 ? [tagId] : [],
					}),
				);
			}
			await api.addLocations(newLocs);
			return before;
		}, tagBulkId);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before + 30);
	});

	it("bulk add followed by bulk remove, selection tracks correctly", async () => {
		const result = await withApi(async (api) => {
			await api.selectEverything();
			const baseline = api.getSelectedLocationIds().size;

			const newLocs: Location[] = [];
			for (let i = 0; i < 20; i++) {
				newLocs.push(
					api.createLocation({
						lat: 80 + i * 0.01,
						lng: 80 + i * 0.01,
					}),
				);
			}
			await api.addLocations(newLocs);
			const afterAddResult = await api.syncSelections();
			const afterAdd = afterAddResult.ids.length;

			// Remove first 10 of the newly added
			const toRemove = newLocs.slice(0, 10).map((l) => l.id);
			api.removeLocations(new Set(toRemove));
			const afterRemoveResult = await api.syncSelections();
			const afterRemove = afterRemoveResult.ids.length;

			return { baseline, afterAdd, afterRemove };
		});
		expect(result.afterAdd).toBe(result.baseline + 20);
		expect(result.afterRemove).toBe(result.baseline + 10);
	});
});

// ============================================================================
// 7. Selection survives save/load cycle
// ============================================================================

describe("Selection survives save/load cycle", () => {
	let mapId: string;
	let tagPersistId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E SelMut Persist");
		await browser.pause(500);

		const tagPersist = await createTag("t-persist");
		tagPersistId = tagPersist.id;

		const locs: Location[] = [];
		for (let i = 0; i < 30; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					heading: i < 15 ? 0 : 90,
					panoId: i < 20 ? `pano-${i}` : null,
					flags: i < 10 ? 1 : 0,
					tags: i < 12 ? [tagPersistId] : [],
				}),
			);
		}
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("tag selection produces same results after save/close/reopen", async () => {
		const beforeCount = await withApi(async (api, tagId: number) => {
			await api.selectTag(tagId);
			return api.getSelectedLocationIds().size;
		}, tagPersistId);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const afterCount = await withApi(async (api, tagId: number) => {
			await api.selectTag(tagId);
			return api.getSelectedLocationIds().size;
		}, tagPersistId);

		expect(afterCount).toBe(beforeCount);
	});

	it("PanoIds selection produces same results after reload", async () => {
		const beforeCount = await withApi(async (api) => {
			api.resetSelections();
			await api.selectPanoIds();
			return api.getSelectedLocationIds().size;
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const afterCount = await withApi(async (api) => {
			await api.selectPanoIds();
			return api.getSelectedLocationIds().size;
		});

		expect(afterCount).toBe(beforeCount);
	});

	it("Everything selection produces same results after reload", async () => {
		const beforeCount = await withApi(async (api) => {
			api.resetSelections();
			await api.selectEverything();
			return api.getSelectedLocationIds().size;
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const afterCount = await withApi(async (api) => {
			await api.selectEverything();
			return api.getSelectedLocationIds().size;
		});

		expect(afterCount).toBe(beforeCount);
	});

	it("Unpanned selection produces same results after reload", async () => {
		const beforeCount = await withApi(async (api) => {
			api.resetSelections();
			await api.selectUnpanned();
			return api.getSelectedLocationIds().size;
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const afterCount = await withApi(async (api) => {
			await api.selectUnpanned();
			return api.getSelectedLocationIds().size;
		});

		expect(afterCount).toBe(beforeCount);
	});
});

// ============================================================================
// 8. Slot reuse correctness
// ============================================================================

describe("Slot reuse correctness", () => {
	let mapId: string;
	let tagSlotId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E SelMut Slots");
		await browser.pause(500);

		const tagSlot = await createTag("t-slot");
		tagSlotId = tagSlot.id;
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("add, remove (freeing slots), add new (reusing slots) -- tag selection stays correct", async () => {
		const result = await withApi(async (api, tagId: number) => {
			// Add 20 locations, first 10 tagged
			const initial: Location[] = [];
			for (let i = 0; i < 20; i++) {
				initial.push(
					api.createLocation({
						lat: i,
						lng: i,
						tags: i < 10 ? [tagId] : [],
					}),
				);
			}
			await api.addLocations(initial);

			await api.selectTag(tagId);
			const afterInitial = api.getSelectedLocationIds().size;

			// Remove first 10 (the tagged ones)
			const toRemove = initial.slice(0, 10).map((l) => l.id);
			await api.removeLocations(new Set(toRemove));
			const afterRemoveResult = await api.syncSelections();
			const afterRemoveIds: number[] = afterRemoveResult.ids;
			const afterRemove = afterRemoveIds.length;

			// Add 10 new UNtagged locations -- they may reuse the freed slots
			const reuse: Location[] = [];
			for (let i = 0; i < 10; i++) {
				reuse.push(
					api.createLocation({ lat: 50 + i, lng: 50 + i }),
				);
			}
			await api.addLocations(reuse);
			const afterReuseResult = await api.syncSelections();
			const afterReuseIds: number[] = afterReuseResult.ids;
			const afterReuse = afterReuseIds.length;

			// None of the reuse locations should be in tag selection
			const reuseIdSet = new Set(reuse.map((l) => l.id));
			const hasAnyReuse = afterReuseIds.some((id: number) => reuseIdSet.has(id));
			// None of the removed locations should be in tag selection
			const removedSet = new Set(toRemove);
			const hasAnyRemoved = afterReuseIds.some((id: number) => removedSet.has(id));

			return { afterInitial, afterRemove, afterReuse, hasAnyReuse, hasAnyRemoved };
		}, tagSlotId);
		expect(result.afterInitial).toBe(10);
		expect(result.afterRemove).toBe(0);
		expect(result.afterReuse).toBe(0);
		expect(result.hasAnyReuse).toBe(false);
		expect(result.hasAnyRemoved).toBe(false);
	});

	it("slot reuse with tagged new locations -- only new tagged appear", async () => {
		const result = await withApi(async (api, tagId: number) => {
			// Add 10 tagged locations
			const batch1: Location[] = [];
			for (let i = 0; i < 10; i++) {
				batch1.push(
					api.createLocation({ lat: i, lng: i, tags: [tagId] }),
				);
			}
			await api.addLocations(batch1);

			await api.selectTag(tagId);

			// Remove all 10 — tag count drops to 0, selection is cleared
			api.removeLocations(new Set(batch1.map((l) => l.id)));
			const afterRemoveResult = await api.syncSelections();
			const afterRemoveIds: number[] = afterRemoveResult.ids;
			const afterRemoveAll = afterRemoveIds.length;

			// Add 5 tagged and 5 untagged into freed slots
			const batch2: Location[] = [];
			for (let i = 0; i < 10; i++) {
				batch2.push(
					api.createLocation({
						lat: 40 + i,
						lng: 40 + i,
						tags: i < 5 ? [tagId] : [],
					}),
				);
			}
			await api.addLocations(batch2);
			// Re-select tag (selection was cleared when count hit 0)
			await api.selectTag(tagId);
			const afterRefillResult = await api.syncSelections();
			const afterRefillIds: number[] = afterRefillResult.ids;
			const afterRefill = afterRefillIds.length;

			// Collect the IDs of tagged vs untagged batch2 entries
			const taggedNewIds = batch2.slice(0, 5).map((l) => l.id);
			const untaggedNewIds = batch2.slice(5).map((l) => l.id);

			return {
				afterRemoveAll,
				afterRefill,
				taggedNewIds,
				untaggedNewIds,
				ids: afterRefillIds,
			};
		}, tagSlotId);
		expect(result.afterRemoveAll).toBe(0);
		expect(result.afterRefill).toBe(5);
		for (const id of result.taggedNewIds) {
			expect(result.ids).toContain(id);
		}
		for (const id of result.untaggedNewIds) {
			expect(result.ids).not.toContain(id);
		}
	});

	it("multiple selection types active during slot reuse", async () => {
		const tagSlot3 = await createTag("t-slot3");
		const result = await withApi(async (api, tagId: number) => {
			// Add 20 locs: first 10 tagged, first 8 have flags=1
			const locs: Location[] = [];
			for (let i = 0; i < 20; i++) {
				locs.push(
					api.createLocation({
						lat: i,
						lng: i,
						flags: i < 8 ? 1 : 0,
						tags: i < 10 ? [tagId] : [],
					}),
				);
			}
			await api.addLocations(locs);

			await api.selectTag(tagId);
			await api.selectPanoIds();
			const tagBefore = api.getSelections().find((s) => s.props.type === "Tag")?.count;
			const panoBefore = api
				.getSelections()
				.find((s) => s.props.type === "PanoIds")?.count;

			// Remove indices 0-4 (tagged AND flagged)
			const toRemove = locs.slice(0, 5).map((l) => l.id);
			api.removeLocations(new Set(toRemove));
			await api.syncSelections();

			const tagAfterRemove = api
				.getSelections()
				.find((s) => s.props.type === "Tag")?.count;
			const panoAfterRemove = api
				.getSelections()
				.find((s) => s.props.type === "PanoIds")?.count;

			// Add new locs: 3 tagged+flagged, 2 untagged+unflagged
			const refill: Location[] = [];
			for (let i = 0; i < 5; i++) {
				refill.push(
					api.createLocation({
						lat: 60 + i,
						lng: 60 + i,
						flags: i < 3 ? 1 : 0,
						tags: i < 3 ? [tagId] : [],
					}),
				);
			}
			await api.addLocations(refill);
			await api.syncSelections();

			const tagAfterRefill = api
				.getSelections()
				.find((s) => s.props.type === "Tag")?.count;
			const panoAfterRefill = api
				.getSelections()
				.find((s) => s.props.type === "PanoIds")?.count;

			return {
				tagBefore,
				panoBefore,
				tagAfterRemove,
				panoAfterRemove,
				tagAfterRefill,
				panoAfterRefill,
			};
		}, tagSlot3.id);

		expect(result.tagBefore).toBe(10);
		expect(result.tagAfterRemove).toBe(5);
		expect(result.tagAfterRefill).toBe(8);

		expect(result.panoBefore).toBe(8);
		expect(result.panoAfterRemove).toBe(3);
		expect(result.panoAfterRefill).toBe(6);
	});

	it("rapid add/remove cycles with active selection", async () => {
		const totalLocs = await withApi(async (api) => {
			await api.selectEverything();

			// Do 10 cycles of: add 5, remove 3
			for (let cycle = 0; cycle < 10; cycle++) {
				const batch: Location[] = [];
				for (let i = 0; i < 5; i++) {
					batch.push(
						api.createLocation({
							lat: cycle * 10 + i,
							lng: cycle * 10 + i,
						}),
					);
				}
				await api.addLocations(batch);
				api.removeLocations(new Set(batch.slice(0, 3).map((l) => l.id)));
			}

			const totalLocs = await api.cmd.storeLocationCount();
			return totalLocs;
		});
		const ids = await refreshSelections();
		expect(ids.length).toBe(totalLocs);
	});
});
