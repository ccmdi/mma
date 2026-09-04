import {
	addLocs,
	createLocation,
	createTag,
	getLoc,
	refreshSelections,
	withApi,
	useMap,
	seedLocs,
	selectCount,
} from "./helpers";
import type { Location } from "@/bindings.gen";

// ============================================================================
// 1. Live selection correctness after add/remove
// ============================================================================

describe("Live selection correctness after add/remove", () => {
	useMap("E2E SelMut AddRemove");
	let locIds: number[];
	let tagRedId: number;

	before(async () => {
		const tagRed = await createTag("t-red");
		tagRedId = tagRed.id;

		locIds = await seedLocs(20, (i) => ({
			lat: i,
			lng: i,
			tags: i < 10 ? [tagRedId] : [],
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("tag selection updates when matching locations are added (no reset)", async () => {
		const before = await withApi(async (api, tagId: number) => {
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			const before = api.getMapState().selectedLocationIds.size;

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
			await api.addSelections([{ type: "Everything" }]);
			const before = api.getMapState().selectedLocationIds.size;
			await api.addLocations([api.createLocation({ lat: 99, lng: 99 })]);
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
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
				const before = api.getMapState().selectedLocationIds.size;
				await api.removeLocations(new Set([removeId0, removeId1]));
				const result = await api._test.syncSelections();
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
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
				const before = api.getMapState().selectedLocationIds.size;
				await api.removeLocations(new Set([removeId0, removeId1]));
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
		const initial = await selectCount({ type: "Tag", tagId: tagRedId });

		const afterAddIds = await withApi(async (api, tagId: number) => {
			const newLocs = [
				api.createLocation({ lat: 70, lng: 70, tags: [tagId] }),
				api.createLocation({ lat: 71, lng: 71, tags: [tagId] }),
				api.createLocation({ lat: 72, lng: 72, tags: [tagId] }),
			];
			await api.addLocations(newLocs);
			const result = await api._test.syncSelections();
			const ids: number[] = result.ids;
			// Store second loc id for removal
			return { ids, removeId: newLocs[1].id };
		}, tagRedId);
		expect(afterAddIds.ids.length).toBe(initial + 3);

		await withApi(async (api, removeId: number) => {
			await api.removeLocations(new Set([removeId]));
		}, afterAddIds.removeId);
		const ids = await refreshSelections();
		expect(ids.length).toBe(initial + 2);
	});
});

// ============================================================================
// 2. Live selection correctness after update
// ============================================================================

describe("Live selection correctness after update", () => {
	useMap("E2E SelMut Update");
	let locIds: number[];
	let tagAlphaId: number;

	before(async () => {
		const tagAlpha = await createTag("t-alpha");
		tagAlphaId = tagAlpha.id;

		locIds = await seedLocs(20, (i) => ({
			lat: i,
			lng: i,
			heading: i < 10 ? 0 : 90,
			panoId: i < 15 ? `pano-${i}` : null,
			flags: i < 5 ? 1 : 0,
			tags: i < 10 ? [tagAlphaId] : [],
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("updating location to ADD matching tag joins active tag selection", async () => {
		const id15 = locIds[15];
		const loc15 = await getLoc(id15);
		const result = await withApi(
			async (api, tagId: number, loc) => {
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
				const before = api.getMapState().selectedLocationIds.size;
				await api.updateLocations([{ id: loc.id, patch: { tags: [tagId] } }]);
				const result = await api._test.syncSelections();
				const after = result.ids;
				return { before, after: after.length, has: after.includes(loc.id) };
			},
			tagAlphaId,
			loc15,
		);
		expect(result.before).toBe(10);
		expect(result.after).toBe(11);
		expect(result.has).toBe(true);
	});

	it("updating location to REMOVE matching tag leaves active tag selection", async () => {
		const id0 = locIds[0];
		const loc0 = await getLoc(id0);
		const before = await withApi(
			async (api, tagId: number, loc) => {
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
				const before = api.getMapState().selectedLocationIds.size;
				await api.updateLocations([{ id: loc.id, patch: { tags: [] } }]);
				return before;
			},
			tagAlphaId,
			loc0,
		);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before - 1);
		expect(ids).not.toContain(id0);
	});

	it("PanoIds selection updates when flag toggled on (no reset)", async () => {
		const id10 = locIds[10];
		const loc10 = await getLoc(id10);
		const before = await withApi(async (api, loc) => {
			await api.addSelections([{ type: "PanoIds" }]);
			const before = api.getMapState().selectedLocationIds.size;
			await api.updateLocations([{ id: loc.id, patch: { flags: 1 } }]);
			return before;
		}, loc10);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before + 1);
	});

	it("PanoIds selection updates when flag toggled off (no reset)", async () => {
		const id0 = locIds[0];
		const loc0 = await getLoc(id0);
		const before = await withApi(async (api, loc) => {
			await api.addSelections([{ type: "PanoIds" }]);
			const before = api.getMapState().selectedLocationIds.size;
			await api.updateLocations([{ id: loc.id, patch: { flags: 0 } }]);
			return before;
		}, loc0);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before - 1);
	});

	it("Unpanned selection updates when heading changed from 0 (no reset)", async () => {
		const id0 = locIds[0];
		const loc0 = await getLoc(id0);
		const before = await withApi(async (api, loc) => {
			await api.addSelections([{ type: "Unpanned" }]);
			const before = api.getMapState().selectedLocationIds.size;
			await api.updateLocations([{ id: loc.id, patch: { heading: 45 } }]);
			return before;
		}, loc0);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before - 1);
	});

	it("Unpanned selection updates when heading changed to 0 (no reset)", async () => {
		const id10 = locIds[10];
		const loc10 = await getLoc(id10);
		const before = await withApi(async (api, loc) => {
			await api.addSelections([{ type: "Unpanned" }]);
			const before = api.getMapState().selectedLocationIds.size;
			await api.updateLocations([{ id: loc.id, patch: { heading: 0 } }]);
			return before;
		}, loc10);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before + 1);
	});
});

// ============================================================================
// 3. Review mode delete with active selections
// ============================================================================

describe("Review mode delete with active selections", () => {
	useMap("E2E SelMut Review");
	let locIds: number[];
	let tagRvId: number;

	before(async () => {
		const tagRv = await createTag("t-rv");
		tagRvId = tagRv.id;

		locIds = await seedLocs(10, (i) => ({
			lat: i,
			lng: i,
			tags: i < 5 ? [tagRvId] : [],
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => {
			await api.resetSelections();
			api.cancelReview();
		});
	});

	it("reviewDelete decreases active tag selection count", async () => {
		const taggedIds = locIds.slice(0, 5);
		const result = await withApi(
			async (api, tagId: number, reviewIds: number[]) => {
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
				const before = api.getMapState().selectedLocationIds.size;
				await api.beginReview(reviewIds);
				await api.reviewDelete();
				const result = await api._test.syncSelections();
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
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
				const before = api.getMapState().selectedLocationIds.size;
				await api.beginReview(rvIds);
				await api.reviewDelete();
				api.cancelReview();
				const result = await api._test.syncSelections();
				const after = result.ids;
				return { before, after: after.length };
			},
			tagRvId,
			reviewIds,
		);
		const afterDeleteCount = result.after;
		expect(afterDeleteCount).toBe(result.before - 1);

		await withApi(async (api) => {
			await api.addLocations([api.createLocation({ lat: 99, lng: 99 })]);
		});
		const afterAddIds = await refreshSelections();
		expect(afterAddIds.length).toBe(afterDeleteCount);
	});

	it("review-delete with Everything selection decreases count", async () => {
		const result = await withApi(async (api) => {
			await api.addSelections([{ type: "Everything" }]);
			const before = api.getMapState().selectedLocationIds.size;
			const allLocs = await api.fetchAllLocations();
			const ids = allLocs.slice(0, 3).map((l) => l.id);
			await api.beginReview(ids);
			await api.reviewDelete();
			const result = await api._test.syncSelections();
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
	useMap("E2E SelMut Undo");
	let locIds: number[];
	let tagUndoId: number;

	before(async () => {
		const tagUndo = await createTag("t-undo");
		tagUndoId = tagUndo.id;

		locIds = await seedLocs(10, (i) => ({
			lat: i,
			lng: i,
			tags: i < 5 ? [tagUndoId] : [],
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("undo of add shrinks active selection", async () => {
		const before = await withApi(async (api, tagId: number) => {
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			const before = api.getMapState().selectedLocationIds.size;

			await api.addLocations([api.createLocation({ lat: 50, lng: 50, tags: [tagId] })]);
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
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
				await api.removeLocations(new Set([locId]));
				await new Promise((r) => setTimeout(r, 300));
			},
			tagUndoId,
			id0,
		);
		const afterRemoveIds = await refreshSelections();
		const before = afterRemoveIds.length;

		await withApi(async (api) => {
			await api.undo();
			await new Promise((r) => setTimeout(r, 300));
		});
		const afterUndoIds = await refreshSelections();
		expect(afterUndoIds.length).toBe(before + 1);
		expect(afterUndoIds).toContain(id0);
	});

	it("undo of tag-add update removes location from tag selection", async () => {
		const id5 = locIds[5];
		const loc5 = await getLoc(id5);
		await withApi(
			async (api, tagId: number, loc) => {
				await api.resetSelections();
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
				await api.updateLocations([{ id: loc.id, patch: { tags: [tagId] } }]);
				await new Promise((r) => setTimeout(r, 300));
			},
			tagUndoId,
			loc5,
		);
		const afterUpdateIds = await refreshSelections();
		const before = afterUpdateIds.length;

		await withApi(async (api) => {
			await api.undo();
			await new Promise((r) => setTimeout(r, 300));
		});
		const afterUndoIds = await refreshSelections();
		expect(afterUndoIds.length).toBe(before - 1);
	});

	it("multiple undo/redo cycles keep selection consistent", async () => {
		const baseline = await withApi(async (api) => {
			await api.addSelections([{ type: "Everything" }]);
			const baseline = api.getMapState().selectedLocationIds.size;

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
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			await api.addLocations([api.createLocation({ lat: 80, lng: 80, tags: [tagId] })]);
		}, tagUndoId);
		const afterAdd = await refreshSelections();

		await withApi(async (api) => {
			await api.undo();
			await new Promise((r) => setTimeout(r, 300));
		});
		const afterUndoIds = await refreshSelections();
		expect(afterUndoIds.length).toBe(afterAdd.length - 1);

		await withApi(async (api) => {
			await api.redo();
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
	useMap("E2E SelMut Composite");
	let locIds: number[];
	let tagCompAId: number;
	let tagCompBId: number;

	before(async () => {
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
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("intersection updates when location gains a tag to enter both children", async () => {
		const id0 = locIds[0];
		const loc0 = await getLoc(id0);
		const before = await withApi(
			async (api, tagAId: number, tagBId: number, loc) => {
				await api.addSelections([{ type: "Tag", tagId: tagAId }]);
				await api.addSelections([{ type: "Tag", tagId: tagBId }]);
				await api.applySelectionUpdate(api.intersectSelections);
				const before = api.getMapState().selectedLocationIds.size;

				await api.updateLocations([{ id: loc.id, patch: { tags: [tagAId, tagBId] } }]);
				return before;
			},
			tagCompAId,
			tagCompBId,
			loc0,
		);
		const ids = await refreshSelections();
		expect(before).toBe(5);
		expect(ids.length).toBe(6);
		expect(ids).toContain(id0);
	});

	it("intersection updates when location loses a tag to leave one child", async () => {
		const id5 = locIds[5];
		const loc5 = await getLoc(id5);
		const before = await withApi(
			async (api, tagAId: number, tagBId: number, loc) => {
				await api.addSelections([{ type: "Tag", tagId: tagAId }]);
				await api.addSelections([{ type: "Tag", tagId: tagBId }]);
				await api.applySelectionUpdate(api.intersectSelections);
				const before = api.getMapState().selectedLocationIds.size;

				await api.updateLocations([{ id: loc.id, patch: { tags: [tagAId] } }]);
				return before;
			},
			tagCompAId,
			tagCompBId,
			loc5,
		);
		const ids = await refreshSelections();
		expect(ids.length).toBe(before - 1);
		expect(ids).not.toContain(id5);
	});

	it("union updates when location added matching only one child", async () => {
		const before = await withApi(
			async (api, tagAId: number, tagBId: number) => {
				await api.addSelections([{ type: "Tag", tagId: tagAId }]);
				await api.addSelections([{ type: "Tag", tagId: tagBId }]);
				await api.applySelectionUpdate(api.unionSelections);
				const before = api.getMapState().selectedLocationIds.size;

				await api.addLocations([api.createLocation({ lat: 99, lng: 99, tags: [tagAId] })]);
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
				await api.addSelections([{ type: "Tag", tagId: tagAId }]);
				await api.addSelections([{ type: "Tag", tagId: tagBId }]);
				await api.applySelectionUpdate(api.unionSelections);
				const before = api.getMapState().selectedLocationIds.size;

				await api.addLocations([api.createLocation({ lat: 98, lng: 98 })]);
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
	useMap("E2E SelMut Bulk");
	let locIds: number[];
	let tagBulkId: number;

	before(async () => {
		const tagBulk = await createTag("t-bulk");
		tagBulkId = tagBulk.id;

		locIds = await seedLocs(100, (i) => ({
			lat: i * 0.1,
			lng: i * 0.1,
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("batchUpdateLocations adds tag to 50 locs, all join active tag selection", async () => {
		const first50 = locIds.slice(0, 50);
		const result = await withApi(
			async (api, tagId: number, ids: number[]) => {
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
				const before = api.getMapState().selectedLocationIds.size;
				const updates = ids.map((id: number) => ({ id, patch: { tags: [tagId] } }));
				await api.updateLocations(updates);
				const result = await api._test.syncSelections();
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
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			const before = api.getMapState().selectedLocationIds.size;

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
			await api.addSelections([{ type: "Everything" }]);
			const baseline = api.getMapState().selectedLocationIds.size;

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
			const afterAddResult = await api._test.syncSelections();
			const afterAdd = afterAddResult.ids.length;

			// Remove first 10 of the newly added
			const toRemove = newLocs.slice(0, 10).map((l) => l.id);
			await api.removeLocations(new Set(toRemove));
			const afterRemoveResult = await api._test.syncSelections();
			const afterRemove = afterRemoveResult.ids.length;

			return { baseline, afterAdd, afterRemove };
		});
		expect(result.afterAdd).toBe(result.baseline + 20);
		expect(result.afterRemove).toBe(result.baseline + 10);
	});
});

// ============================================================================
// 8. Slot reuse correctness
// ============================================================================

describe("Slot reuse correctness", () => {
	useMap("E2E SelMut Slots");
	let tagSlotId: number;

	before(async () => {
		const tagSlot = await createTag("t-slot");
		tagSlotId = tagSlot.id;
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

			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			const afterInitial = api.getMapState().selectedLocationIds.size;

			// Remove first 10 (the tagged ones)
			const toRemove = initial.slice(0, 10).map((l) => l.id);
			await api.removeLocations(new Set(toRemove));
			const afterRemoveResult = await api._test.syncSelections();
			const afterRemoveIds: number[] = afterRemoveResult.ids;
			const afterRemove = afterRemoveIds.length;

			// Add 10 new UNtagged locations -- they may reuse the freed slots
			const reuse: Location[] = [];
			for (let i = 0; i < 10; i++) {
				reuse.push(api.createLocation({ lat: 50 + i, lng: 50 + i }));
			}
			await api.addLocations(reuse);
			const afterReuseResult = await api._test.syncSelections();
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
				batch1.push(api.createLocation({ lat: i, lng: i, tags: [tagId] }));
			}
			await api.addLocations(batch1);

			await api.addSelections([{ type: "Tag", tagId: tagId }]);

			// Remove all 10 — tag count drops to 0, selection is cleared
			await api.removeLocations(new Set(batch1.map((l) => l.id)));
			const afterRemoveResult = await api._test.syncSelections();
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
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			const afterRefillResult = await api._test.syncSelections();
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

			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			await api.addSelections([{ type: "PanoIds" }]);
			const tagKey = api.getActiveSelections().find((s) => s.selector.type === "Tag")?.key;
			const panoKey = api.getActiveSelections().find((s) => s.selector.type === "PanoIds")?.key;
			const tagBefore = tagKey ? api.getMapState().selectionCounts[tagKey] : undefined;
			const panoBefore = panoKey ? api.getMapState().selectionCounts[panoKey] : undefined;

			// Remove indices 0-4 (tagged AND flagged)
			const toRemove = locs.slice(0, 5).map((l) => l.id);
			await api.removeLocations(new Set(toRemove));
			await api._test.syncSelections();

			const tagAfterRemove = tagKey ? api.getMapState().selectionCounts[tagKey] : undefined;
			const panoAfterRemove = panoKey ? api.getMapState().selectionCounts[panoKey] : undefined;

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
			await api._test.syncSelections();

			const tagAfterRefill = tagKey ? api.getMapState().selectionCounts[tagKey] : undefined;
			const panoAfterRefill = panoKey ? api.getMapState().selectionCounts[panoKey] : undefined;

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
			await api.addSelections([{ type: "Everything" }]);

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
				await api.removeLocations(new Set(batch.slice(0, 3).map((l) => l.id)));
			}

			const totalLocs = (await api.cmd.storeGetSummary()).locationCount;
			return totalLocs;
		});
		const ids = await refreshSelections();
		expect(ids.length).toBe(totalLocs);
	});
});
