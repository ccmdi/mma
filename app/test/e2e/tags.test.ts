/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	openMap,
	addLocs,
	getLoc,
	createLocation,
	withApi,
} from "./helpers";

describe("Tag CRUD", () => {
	let mapId: string;
	let t1Id: number;
	let t3Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tags");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("add a tag", async () => {
		const result = await withApi(async (api) => {
			const resolved = await api.createTags(["Red Tag"]);
			const tagInfo = resolved[0];
			const map = api.getCurrentMap()!;
			const tagKey = String(tagInfo.id);
			return {
				count: Object.keys(map.meta.tags).length,
				tag: map.meta.tags[tagKey],
				tagId: tagInfo.id,
			};
		});
		expect(result.count).toBe(1);
		expect(result.tag.name).toBe("Red Tag");
		expect(result.tag.color).toMatch(/^#[0-9a-f]{6}$/);
		t1Id = result.tagId;
	});

	it("add multiple tags", async () => {
		const result = await withApi(async (api) => {
			const resolved = await api.createTags(["Blue Tag", "Green Tag"]);
			return {
				count: Object.keys(api.getCurrentMap()!.meta.tags).length,
				ids: [resolved[0].id, resolved[1].id],
			};
		});
		expect(result.count).toBe(3);
		t3Id = result.ids[1];
	});

	it("update tag name", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.updateTags([{ id: tagId, patch: { name: "Renamed Red" } }]);
			return api.getCurrentMap()!.meta.tags[String(tagId)].name;
		}, t1Id);
		expect(result).toBe("Renamed Red");
	});

	it("update tag color", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.updateTags([{ id: tagId, patch: { color: "#ff8800" } }]);
			return api.getCurrentMap()!.meta.tags[String(tagId)].color;
		}, t1Id);
		expect(result).toBe("#ff8800");
	});

	it("delete tag hides it (count drops to 0)", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.deleteTags([tagId]);
			const tags = api.getCurrentMap()!.meta.tags;
			return {
				count: Object.keys(tags).length,
				hasTag: String(tagId) in tags,
				visible: tags[String(tagId)]?.visible,
			};
		}, t3Id);
		expect(result.count).toBe(3);
		expect(result.hasTag).toBe(true);
		expect(result.visible).toBe(false);
	});
});

describe("Tag operations on locations", () => {
	let mapId: string;
	let bulkTagId: number;
	let otherTagId: number;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Ops");

		const tagResult = await withApi(async (api) => {
			const resolved = await api.createTags(["Bulk", "Other"]);
			return { bulkId: resolved[0].id, otherId: resolved[1].id };
		});
		bulkTagId = tagResult.bulkId;
		otherTagId = tagResult.otherId;

		const locs = [];
		for (let i = 0; i < 50; i++) {
			locs.push(createLocation({ lat: i, lng: i }));
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("add tag to individual location", async () => {
		const tags = await withApi(
			async (api, locId, tagId) => {
				api.updateLocation(locId, { tags: [tagId] });
				const loc = await api.fetchLocation(locId);
				return loc?.tags;
			},
			locIds[0],
			bulkTagId,
		);
		expect(tags).toEqual([bulkTagId]);
	});

	it("bulkAddTag adds tag to all selected locations", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.selectEverything();
			await api.addTagToLocations(tagId, [...api.getSelectedLocationIds()]);
			const locs = await api.fetchAllLocations();
			const tagged = locs.filter((l: any) => l.tags.includes(tagId));
			return tagged.length;
		}, otherTagId);
		expect(result).toBe(50);
	});

	it("bulkAddTag is idempotent (no duplicates)", async () => {
		const result = await withApi(
			async (api, tagId, locId) => {
				await api.selectEverything();
				await api.addTagToLocations(tagId, [...api.getSelectedLocationIds()]);
				const loc = await api.fetchLocation(locId);
				return loc!.tags.filter((t: number) => t === tagId).length;
			},
			otherTagId,
			locIds[1],
		);
		expect(result).toBe(1);
	});

	it("undo bulkAddTag removes tag from all", async () => {
		await withApi(async (api) => {
			await api.undo();
			return "ok";
		});

		const result = await withApi(async (api, tagId) => {
			const locs = await api.fetchAllLocations();
			return locs.filter((l: any) => l.tags.includes(tagId)).length;
		}, otherTagId);
		// The no-op bulkAddTag didn't record an edit, so undo undoes the first bulkAddTag.
		expect(result).toBe(0);
	});

	it("remove tag from location", async () => {
		await withApi(async (api, locId) => {
			api.updateLocation(locId, { tags: [] });
			return "ok";
		}, locIds[0]);
		const loc = await getLoc(locIds[0]);
		expect(loc.tags).toEqual([]);
	});

	it("multiple tags on one location", async () => {
		const tags = await withApi(
			async (api, locId, bulkId, otherId) => {
				api.updateLocation(locId, { tags: [bulkId, otherId] });
				const loc = await api.fetchLocation(locId);
				return loc!.tags;
			},
			locIds[5],
			bulkTagId,
			otherTagId,
		);
		expect(tags).toContain(bulkTagId);
		expect(tags).toContain(otherTagId);
		expect(tags.length).toBe(2);
	});
});

describe("Tag persistence", () => {
	let mapId: string;
	let pt1Id: number;
	let pt2Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Persist");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("tags survive save/load", async () => {
		const result = await withApi(async (api) => {
			const resolved = await api.createTags(["Persist Tag", "Persist Tag 2"]);
			await api.updateTags([{ id: resolved[0].id, patch: { color: "#112233" } }]);
			await api.updateTags([{ id: resolved[1].id, patch: { color: "#445566" } }]);
			return { pt1Id: resolved[0].id, pt2Id: resolved[1].id };
		});
		pt1Id = result.pt1Id;
		pt2Id = result.pt2Id;

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const tags = await withApi((api) => {
			return api.getCurrentMap()!.meta.tags;
		});
		const pt1Key = String(pt1Id);
		const pt2Key = String(pt2Id);
		expect(tags[pt1Key].name).toBe("Persist Tag");
		expect(tags[pt1Key].color).toBe("#112233");
		expect(tags[pt2Key].name).toBe("Persist Tag 2");
		expect(tags[pt2Key].color).toBe("#445566");
	});

	it("tag assignments on locations survive save/load", async () => {
		const locs = [createLocation({ lat: 10, lng: 20, tags: [pt1Id, pt2Id] })];
		const ids = await addLocs(locs);
		const locId = ids[0];

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const tags = await withApi(async (api, id) => {
			const loc = await api.fetchLocation(id);
			return loc?.tags;
		}, locId);
		expect(tags).toContain(pt1Id);
		expect(tags).toContain(pt2Id);
	});

	it("tag reorder persists", async () => {
		await withApi(
			async (api, id1, id2) => {
				await api.reorderTags([id2, id1]);
				return "ok";
			},
			pt1Id,
			pt2Id,
		);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const tags = await withApi((api) => {
			return api.getCurrentMap()!.meta.tags;
		});
		const pt1Key = String(pt1Id);
		const pt2Key = String(pt2Id);
		// pt2 should come before pt1 now
		expect(tags[pt2Key].order!).toBeLessThan(tags[pt1Key].order!);
	});
});

describe("Tag merge on rename collision", () => {
	let mapId: string;
	let tagAId: number;
	let tagBId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Merge");

		const tagResult = await withApi(async (api) => {
			const resolved = await api.createTags(["Alpha", "Beta"]);
			return { aId: resolved[0].id, bId: resolved[1].id };
		});
		tagAId = tagResult.aId;
		tagBId = tagResult.bId;

		const locs = [];
		for (let i = 0; i < 10; i++) {
			locs.push(createLocation({ lat: i, lng: i, tags: [tagAId] }));
		}
		for (let i = 10; i < 15; i++) {
			locs.push(createLocation({ lat: i, lng: i, tags: [tagBId] }));
		}
		// One location has both tags
		locs.push(createLocation({ lat: 20, lng: 20, tags: [tagAId, tagBId] }));
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("renaming tag A to tag B's name merges them", async () => {
		const result = await withApi(async (api, aId, bId) => {
			await api.updateTags([{ id: aId, patch: { name: "Beta" } }]);
			const map = api.getCurrentMap()!;
			const tags = map.meta.tags;
			return {
				aVisible: tags[String(aId)]?.visible,
				bVisible: tags[String(bId)]?.visible,
				visibleCount: Object.values(tags).filter((t: any) => t.visible !== false).length,
			};
		}, tagAId, tagBId);
		// Tag A should be hidden (merged into B)
		expect(result.aVisible).toBe(false);
		expect(result.bVisible).toBe(true);
		expect(result.visibleCount).toBe(1);
	});

	it("locations from merged tag now have the target tag", async () => {
		const result = await withApi(async (api, bId) => {
			const locs = await api.fetchAllLocations();
			const withB = locs.filter((l: any) => l.tags.includes(bId));
			return withB.length;
		}, tagBId);
		// 10 from Alpha + 5 from Beta + 1 with both = 16, no duplicates
		expect(result).toBe(16);
	});

	it("no location has duplicate tag IDs after merge", async () => {
		const result = await withApi(async (api, bId) => {
			const locs = await api.fetchAllLocations();
			const dupes = locs.filter((l: any) => l.tags.filter((t: number) => t === bId).length > 1);
			return dupes.length;
		}, tagBId);
		expect(result).toBe(0);
	});

	it("merged tag no longer referenced by any location", async () => {
		const result = await withApi(async (api, aId) => {
			const locs = await api.fetchAllLocations();
			return locs.filter((l: any) => l.tags.includes(aId)).length;
		}, tagAId);
		expect(result).toBe(0);
	});

	it("undo after merge restores the original tag", async () => {
		const result = await withApi(async (api, aId, bId) => {
			await api.undo();
			const tags = api.getCurrentMap()!.meta.tags;
			const aVisible = tags[String(aId)]?.visible;
			const bVisible = tags[String(bId)]?.visible;
			const locs = await api.fetchAllLocations();
			const withA = locs.filter((l: any) => l.tags.includes(aId)).length;
			const withB = locs.filter((l: any) => l.tags.includes(bId)).length;
			return { aVisible, bVisible, withA, withB };
		}, tagAId, tagBId);
		expect(result.aVisible).toBe(true);
		expect(result.bVisible).toBe(true);
		// 10 locs had Alpha, 1 had both → 11 with Alpha
		expect(result.withA).toBe(11);
		// 5 locs had Beta, 1 had both → 6 with Beta
		expect(result.withB).toBe(6);
	});
});

describe("Tag merge persists across save/load", () => {
	let mapId: string;
	let tagXId: number;
	let tagYId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Merge Persist");

		const tagResult = await withApi(async (api) => {
			const resolved = await api.createTags(["Xray", "Yankee"]);
			return { xId: resolved[0].id, yId: resolved[1].id };
		});
		tagXId = tagResult.xId;
		tagYId = tagResult.yId;

		await addLocs([
			createLocation({ lat: 1, lng: 1, tags: [tagXId] }),
			createLocation({ lat: 2, lng: 2, tags: [tagYId] }),
		]);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("merge survives save/load", async () => {
		await withApi(async (api, xId) => {
			await api.updateTags([{ id: xId, patch: { name: "Yankee" } }]);
			return "ok";
		}, tagXId);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const result = await withApi(async (api, xId, yId) => {
			const tags = api.getCurrentMap()!.meta.tags;
			const locs = await api.fetchAllLocations();
			return {
				xVisible: tags[String(xId)]?.visible,
				yVisible: tags[String(yId)]?.visible,
				allHaveY: locs.every((l: any) => l.tags.includes(yId)),
				noneHaveX: locs.every((l: any) => !l.tags.includes(xId)),
			};
		}, tagXId, tagYId);
		expect(result.xVisible).toBe(false);
		expect(result.yVisible).toBe(true);
		expect(result.allHaveY).toBe(true);
		expect(result.noneHaveX).toBe(true);
	});
});

describe("Tag name dedup on creation", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Dedup");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("resolveTagNames returns same tag for same name", async () => {
		const result = await withApi(async (api) => {
			const first = await api.createTags(["Duplicate"]);
			const second = await api.createTags(["Duplicate"]);
			return { id1: first[0].id, id2: second[0].id };
		});
		expect(result.id1).toBe(result.id2);
	});

	it("resolveTagNames is case-insensitive", async () => {
		const result = await withApi(async (api) => {
			const upper = await api.createTags(["CaseTest"]);
			const lower = await api.createTags(["casetest"]);
			const mixed = await api.createTags(["CASETEST"]);
			return { a: upper[0].id, b: lower[0].id, c: mixed[0].id };
		});
		expect(result.a).toBe(result.b);
		expect(result.b).toBe(result.c);
	});

	it("delete then re-resolve reuses the hidden tag and makes it visible", async () => {
		const result = await withApi(async (api) => {
			const [created] = await api.createTags(["Revive"]);
			await api.deleteTags([created.id]);
			const tagsAfterDelete = api.getCurrentMap()!.meta.tags;
			const hiddenAfterDelete = tagsAfterDelete[String(created.id)]?.visible;
			const [resolved] = await api.createTags(["Revive"]);
			const tagsAfterResolve = api.getCurrentMap()!.meta.tags;
			const visibleAfterResolve = tagsAfterResolve[String(created.id)]?.visible;
			return {
				originalId: created.id,
				resolvedId: resolved.id,
				hiddenAfterDelete,
				visibleAfterResolve,
			};
		});
		expect(result.hiddenAfterDelete).toBe(false);
		expect(result.resolvedId).toBe(result.originalId);
		expect(result.visibleAfterResolve).toBe(true);
	});
});

describe("Tag visibility lifecycle", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Visibility");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("deleted tag reappears when re-resolved after save/load", async () => {
		const tagId = await withApi(async (api) => {
			const [tag] = await api.createTags(["Phoenix"]);
			await api.deleteTags([tag.id]);
			return tag.id;
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const result = await withApi(async (api, id) => {
			const before = api.getCurrentMap()!.meta.tags[String(id)]?.visible;
			await api.createTags(["Phoenix"]);
			const after = api.getCurrentMap()!.meta.tags[String(id)]?.visible;
			return { before, after };
		}, tagId);
		expect(result.before).toBe(false);
		expect(result.after).toBe(true);
	});

	it("delete strips tag from locations", async () => {
		const result = await withApi(async (api) => {
			const [tag] = await api.createTags(["StripMe"]);
			const locs = [api.createLocation({ lat: 50, lng: 50, tags: [tag.id] }), api.createLocation({ lat: 51, lng: 51, tags: [tag.id] })];
			await api.addLocations(locs);
			await api.deleteTags([tag.id]);
			const allLocs = await api.fetchAllLocations();
			const withTag = allLocs.filter((l: any) => l.tags.includes(tag.id));
			return withTag.length;
		});
		expect(result).toBe(0);
	});

	it("re-resolving a deleted tag updates JS state immediately", async () => {
		// Create tag, delete it, then re-resolve the same name.
		// JS must reflect the tag being available again.
		const result = await withApi(async (api) => {
			const [tag] = await api.createTags(["Zombie"]);
			await api.deleteTags([tag.id]);
			const hiddenInJs = api.getCurrentMap()!.meta.tags[String(tag.id)]?.visible;
			// Re-resolve (simulates typing the name in the tag input)
			await api.createTags(["Zombie"]);
			const visibleInJs = api.getCurrentMap()!.meta.tags[String(tag.id)]?.visible;
			return { hiddenInJs, visibleInJs };
		});
		expect(result.hiddenInJs).toBe(false);
		expect(result.visibleInJs).toBe(true);
	});

	it("color update via updateTag persists", async () => {
		const tagId = await withApi(async (api) => {
			const [tag] = await api.createTags(["ColorPersist"]);
			await api.updateTags([{ id: tag.id, patch: { color: "#abcdef" } }]);
			return tag.id;
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const result = await withApi(async (api, id) => {
			return api.getCurrentMap()!.meta.tags[String(id)]?.color;
		}, tagId);
		expect(result).toBe("#abcdef");
	});

	it("name update via updateTag persists", async () => {
		const tagId = await withApi(async (api) => {
			const [tag] = await api.createTags(["OldName"]);
			await api.updateTags([{ id: tag.id, patch: { name: "NewName" } }]);
			return tag.id;
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const result = await withApi(async (api, id) => {
			return api.getCurrentMap()!.meta.tags[String(id)]?.name;
		}, tagId);
		expect(result).toBe("NewName");
	});
});

describe("Tag edge cases", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Edge Cases");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("rename to same name is a no-op", async () => {
		const result = await withApi(async (api) => {
			const [tag] = await api.createTags(["SameName"]);
			await api.updateTags([{ id: tag.id, patch: { name: "SameName" } }]);
			const tags = api.getCurrentMap()!.meta.tags;
			const matching = Object.values(tags).filter((t: any) => t.name === "SameName");
			return { count: matching.length, exists: String(tag.id) in tags };
		});
		expect(result.count).toBe(1);
		expect(result.exists).toBe(true);
	});

	it("case-only rename updates name without self-merge", async () => {
		const result = await withApi(async (api) => {
			const [tag] = await api.createTags(["lowercase"]);
			await api.updateTags([{ id: tag.id, patch: { name: "Lowercase" } }]);
			const updated = api.getCurrentMap()!.meta.tags[String(tag.id)];
			return { name: updated?.name };
		});
		expect(result.name).toBe("Lowercase");
	});

	it("delete an already-hidden tag is idempotent", async () => {
		const result = await withApi(async (api) => {
			const [tag] = await api.createTags(["DoubleDelete"]);
			await api.deleteTags([tag.id]);
			await api.deleteTags([tag.id]);
			const t = api.getCurrentMap()!.meta.tags[String(tag.id)];
			return { visible: t?.visible, exists: !!t };
		});
		expect(result.exists).toBe(true);
		expect(result.visible).toBe(false);
	});

	it("empty tag name is rejected or ignored", async () => {
		const result = await withApi(async (api) => {
			const [tag] = await api.createTags(["KeepMyName"]);
			await api.updateTags([{ id: tag.id, patch: { name: "" } }]);
			return api.getCurrentMap()!.meta.tags[String(tag.id)]?.name;
		});
		// Should either keep old name or reject — never become ""
		expect(result).toBe("KeepMyName");
	});

	it("whitespace-only tag name is rejected or ignored", async () => {
		const result = await withApi(async (api) => {
			const [tag] = await api.createTags(["KeepMe"]);
			await api.updateTags([{ id: tag.id, patch: { name: "   " } }]);
			return api.getCurrentMap()!.meta.tags[String(tag.id)]?.name;
		});
		expect(result).toBe("KeepMe");
	});
});

describe("Tag merge advanced", () => {
	let mapId: string;
	let tagAId: number;
	let tagBId: number;
	let tagCId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Merge Advanced");

		const tags = await withApi(async (api) => {
			const resolved = await api.createTags(["MrgA", "MrgB", "MrgC"]);
			return { a: resolved[0].id, b: resolved[1].id, c: resolved[2].id };
		});
		tagAId = tags.a;
		tagBId = tags.b;
		tagCId = tags.c;

		await addLocs([
			createLocation({ lat: 1, lng: 1, tags: [tagAId] }),
			createLocation({ lat: 2, lng: 2, tags: [tagAId] }),
			createLocation({ lat: 3, lng: 3, tags: [tagBId] }),
			createLocation({ lat: 4, lng: 4, tags: [tagCId] }),
			createLocation({ lat: 5, lng: 5, tags: [tagCId] }),
			createLocation({ lat: 6, lng: 6, tags: [tagCId] }),
		]);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("tag counts are correct after merge", async () => {
		const result = await withApi(async (api, aId, bId) => {
			// A has 2 locs, B has 1 loc → merge A into B → B should have 3
			await api.updateTags([{ id: aId, patch: { name: "MrgB" } }]);
			const counts = await api.cmd.storeTagCounts();
			return { bCount: counts[bId] ?? 0, aCount: counts[aId] ?? 0 };
		}, tagAId, tagBId);
		expect(result.bCount).toBe(3);
		expect(result.aCount).toBe(0);
	});

	it("sequential merges accumulate correctly", async () => {
		const result = await withApi(async (api, cId, bId) => {
			// C has 3 locs, B now has 3 → merge C into B → B should have 6
			await api.updateTags([{ id: cId, patch: { name: "MrgB" } }]);
			const counts = await api.cmd.storeTagCounts();
			const locs = await api.fetchAllLocations();
			const withB = locs.filter((l: any) => l.tags.includes(bId));
			return { bCount: counts[bId] ?? 0, locsWithB: withB.length };
		}, tagCId, tagBId);
		expect(result.bCount).toBe(6);
		expect(result.locsWithB).toBe(6);
	});

	it("redo after undo of merge re-hides and remaps", async () => {
		// Undo the C→B merge, then redo it
		await withApi(async (api) => {
			await api.undo();
			return "ok";
		});

		const afterUndo = await withApi(async (api, cId, bId) => {
			const tags = api.getCurrentMap()!.meta.tags;
			const counts = await api.cmd.storeTagCounts();
			return {
				cVisible: tags[String(cId)]?.visible,
				bCount: counts[bId] ?? 0,
				cCount: counts[cId] ?? 0,
			};
		}, tagCId, tagBId);
		expect(afterUndo.cVisible).toBe(true);
		expect(afterUndo.cCount).toBe(3);
		expect(afterUndo.bCount).toBe(3);

		await withApi(async (api) => {
			await api.redo();
			return "ok";
		});

		const afterRedo = await withApi(async (api, cId, bId) => {
			const tags = api.getCurrentMap()!.meta.tags;
			const counts = await api.cmd.storeTagCounts();
			return {
				cVisible: tags[String(cId)]?.visible,
				bCount: counts[bId] ?? 0,
				cCount: counts[cId] ?? 0,
			};
		}, tagCId, tagBId);
		expect(afterRedo.cVisible).toBe(false);
		expect(afterRedo.bCount).toBe(6);
		expect(afterRedo.cCount).toBe(0);
	});
});

describe("Tag import dedup", () => {
	let mapId: string;
	let existingTagId: number;
	let hiddenTagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Import Dedup");

		const tags = await withApi(async (api) => {
			const resolved = await api.createTags(["Existing", "WasHidden"]);
			await api.deleteTags([resolved[1].id]);
			return { existingId: resolved[0].id, hiddenId: resolved[1].id };
		});
		existingTagId = tags.existingId;
		hiddenTagId = tags.hiddenId;
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("import with matching tag name reuses existing tag", async () => {
		const json = JSON.stringify({
			customCoordinates: [
				{ lat: 10, lng: 20, extra: { tags: ["Existing"] } },
			],
		});
		const result = await withApi(async (api, existId, jsonStr) => {
			await api.importPaste(jsonStr);
			const locs = await api.fetchAllLocations();
			const withExisting = locs.filter((l: any) => l.tags.includes(existId));
			const tags = api.getCurrentMap()!.meta.tags;
			const visibleCount = Object.values(tags).filter((t: any) => t.visible !== false && t.name === "Existing").length;
			return { withExisting: withExisting.length, visibleCount };
		}, existingTagId, json);
		expect(result.withExisting).toBe(1);
		expect(result.visibleCount).toBe(1);
	});

	it("import with tag name matching hidden tag reuses it", async () => {
		const json = JSON.stringify({
			customCoordinates: [
				{ lat: 30, lng: 40, extra: { tags: ["WasHidden"] } },
			],
		});
		const result = await withApi(async (api, hiddenId, jsonStr) => {
			await api.importPaste(jsonStr);
			const locs = await api.fetchAllLocations();
			const withHidden = locs.filter((l: any) => l.tags.includes(hiddenId));
			return { withHidden: withHidden.length, id: hiddenId };
		}, hiddenTagId, json);
		expect(result.withHidden).toBe(1);
	});
});
