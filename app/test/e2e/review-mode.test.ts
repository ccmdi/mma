import {
	addLocs,
	createLocation,
	getLocCount,
	getLocOrNull,
	seedLocs,
	updateMapSettings,
	useMap,
	withApi,
} from "./helpers";

describe("Review mode", () => {
	useMap("E2E Review");
	let locIds: number[];

	before(async () => {
		locIds = await seedLocs(10, (i) => ({ lat: i * 10, lng: i * 10, heading: i * 36 }));
	});
	it("beginReview sets active location to first in list", async () => {
		const reviewIds = [locIds[3], locIds[5], locIds[7]];
		const result = await withApi(async (api, ids) => {
			await api.beginReview(ids);
			return {
				activeId: api.getMapState().activeLocation?.id ?? null,
				workArea: api.getMapState().workArea,
			};
		}, reviewIds);
		expect(result.activeId).toBe(locIds[3]);
		expect(result.workArea).toBe("location");
	});

	it("reviewNext advances to next location", async () => {
		const result = await withApi(async (api) => {
			await api.reviewNext();
			return { activeId: api.getMapState().activeLocation?.id ?? null };
		});
		expect(result.activeId).toBe(locIds[5]);
	});

	it("reviewNext again advances to third location", async () => {
		const result = await withApi(async (api) => {
			await api.reviewNext();
			return { activeId: api.getMapState().activeLocation?.id ?? null };
		});
		expect(result.activeId).toBe(locIds[7]);
	});

	it("reviewNext at end exits review mode", async () => {
		const result = await withApi(async (api) => {
			await api.reviewNext();
			return {
				activeId: api.getMapState().activeLocation?.id ?? null,
				workArea: api.getMapState().workArea,
			};
		});
		expect(result.activeId).toBeNull();
		expect(result.workArea).toBe("overview");
	});

	it("reviewPrev navigates backward", async () => {
		const reviewIds = [locIds[0], locIds[1], locIds[2]];
		const result = await withApi(async (api, ids) => {
			await api.beginReview(ids);
			await api.reviewNext(); // -> locIds[1]
			await api.reviewNext(); // -> locIds[2]
			await api.reviewPrev(); // -> locIds[1]
			return { activeId: api.getMapState().activeLocation?.id ?? null };
		}, reviewIds);
		expect(result.activeId).toBe(locIds[1]);
	});

	it("reviewPrev at start is a no-op (stays on first, still in review)", async () => {
		const result = await withApi(async (api) => {
			await api.reviewPrev(); // -> locIds[0]
			await api.reviewPrev(); // at start -> no-op, stays put
			return {
				activeId: api.getMapState().activeLocation?.id ?? null,
				workArea: api.getMapState().workArea,
				inReview: api.getReviewSession() !== null,
			};
		});
		expect(result.activeId).toBe(locIds[0]);
		expect(result.workArea).toBe("location");
		expect(result.inReview).toBe(true);
		await withApi((api) => api.cancelReview());
	});

	it("cancelReview exits review and returns to overview", async () => {
		const reviewIds = [locIds[0], locIds[1], locIds[2]];
		const result = await withApi(async (api, ids) => {
			await api.beginReview(ids);
			api.cancelReview();
			return {
				activeId: api.getMapState().activeLocation?.id ?? null,
				workArea: api.getMapState().workArea,
			};
		}, reviewIds);
		expect(result.activeId).toBeNull();
		expect(result.workArea).toBe("overview");
	});

	it("beginReview with empty array is a no-op", async () => {
		const result = await withApi(async (api) => {
			await api.beginReview([]);
			return { workArea: api.getMapState().workArea };
		});
		expect(result.workArea).toBe("overview");
	});

	it("beginReview filters out invalid IDs", async () => {
		const validId = locIds[4];
		const result = await withApi(async (api, id) => {
			await api.beginReview([999999, id, 999998]);
			return { activeId: api.getMapState().activeLocation?.id ?? null };
		}, validId);
		expect(result.activeId).toBe(validId);
		await withApi((api) => api.cancelReview());
	});

	it("beginReview with all invalid IDs is a no-op", async () => {
		const result = await withApi(async (api) => {
			await api.beginReview([999999, 999998, 999997]);
			return { workArea: api.getMapState().workArea };
		});
		expect(result.workArea).toBe("overview");
	});
});

describe("Review mode - delete", () => {
	useMap("E2E Review Delete");
	let locIds: number[];

	before(async () => {
		locIds = await seedLocs(5, (i) => ({ lat: i, lng: i }));
	});
	it("reviewDelete removes location and advances", async () => {
		const reviewIds = [locIds[0], locIds[1], locIds[2]];
		await withApi(async (api, ids) => api.beginReview(ids), reviewIds);

		const deletedId = locIds[0];
		const nextId = locIds[1];
		const result = await withApi(async (api, did) => {
			await api.reviewDelete();
			const count = (await api.cmd.storeGetSummary()).locationCount;
			const deleted = await api.fetchLocation(did).catch(() => null);
			return {
				activeId: api.getMapState().activeLocation?.id ?? null,
				count,
				deleted,
			};
		}, deletedId);
		expect(result.activeId).toBe(nextId);
		expect(result.count).toBe(4);
		expect(result.deleted).toBeNull();
	});

	it("reviewDelete on last location exits review", async () => {
		const result = await withApi(async (api) => {
			await api.reviewNext(); // -> locIds[2]
			await api.reviewDelete(); // deletes locIds[2], no more -> exits
			return {
				activeId: api.getMapState().activeLocation?.id ?? null,
				workArea: api.getMapState().workArea,
			};
		});
		const count = await getLocCount();
		expect(result.activeId).toBeNull();
		expect(result.workArea).toBe("overview");
		expect(count).toBe(3); // locIds[0] and locIds[2] deleted
	});

	it("undo after reviewDelete restores location", async () => {
		await withApi(async (api) => {
			await api.undo();
			return { ok: true };
		});
		const restoredId = locIds[2];
		const loc = await getLocOrNull(restoredId);
		expect(loc).not.toBeNull();
	});
});

describe("Review mode - skips deleted locations", () => {
	useMap("E2E Review Skip");
	let locIds: number[];

	before(async () => {
		const locs = [
			createLocation({ lat: 0, lng: 0 }),
			createLocation({ lat: 1, lng: 1 }),
			createLocation({ lat: 2, lng: 2 }),
		];
		locIds = await addLocs(locs);
	});
	it("reviewNext skips location deleted outside review", async () => {
		const allIds = [locIds[0], locIds[1], locIds[2]];
		const deleteId = locIds[1];
		const result = await withApi(
			async (api, ids, delId) => {
				await api.beginReview(ids);
				await api.removeLocations(new Set([delId]));
				await api.reviewNext(); // should skip locIds[1], land on locIds[2]
				return { activeId: api.getMapState().activeLocation?.id ?? null };
			},
			allIds,
			deleteId,
		);
		expect(result.activeId).toBe(locIds[2]);
		await withApi((api) => api.cancelReview());
	});
});

describe("Review mode - reviewed tracking & peek", () => {
	useMap("E2E Review Peek");
	let locIds: number[];

	before(async () => {
		locIds = await seedLocs(4, (i) => ({ lat: i, lng: i }));
	});
	it("advancing marks the departed location reviewed", async () => {
		const qids = [locIds[0], locIds[1], locIds[2]];
		const r = await withApi(async (api, ids) => {
			await api.beginReview(ids);
			await api.reviewNext(); // marks ids[0] reviewed, cursor -> ids[1]
			const s = api.getReviewSession();
			const out = { reviewed: s?.reviewed ?? [], cursorId: s?.cursorId ?? null };
			api.cancelReview();
			return out;
		}, qids);
		expect(r.reviewed).toContain(locIds[0]);
		expect(r.cursorId).toBe(locIds[1]);
	});

	it("clicking an in-queue location jumps the cursor", async () => {
		const qids = [locIds[0], locIds[1], locIds[2]];
		const r = await withApi(async (api, ids) => {
			await api.beginReview(ids);
			await api.setActiveLocation(ids[2], false); // in-queue
			const s = api.getReviewSession();
			const out = {
				cursorId: s?.cursorId ?? null,
				activeId: api.getMapState().activeLocation?.id ?? null,
			};
			api.cancelReview();
			return out;
		}, qids);
		expect(r.cursorId).toBe(locIds[2]);
		expect(r.activeId).toBe(locIds[2]);
	});

	it("clicking an off-queue location is a peek (cursor parked, still in review)", async () => {
		const qids = [locIds[0], locIds[1]];
		const off = locIds[3];
		const r = await withApi(
			async (api, ids, offId) => {
				await api.beginReview(ids);
				await api.setActiveLocation(offId, false); // off-queue
				const s = api.getReviewSession();
				const out = {
					inReview: s !== null,
					cursorId: s?.cursorId ?? null,
					activeId: api.getMapState().activeLocation?.id ?? null,
				};
				api.cancelReview();
				return out;
			},
			qids,
			off,
		);
		expect(r.inReview).toBe(true);
		expect(r.cursorId).toBe(locIds[0]); // parked
		expect(r.activeId).toBe(locIds[3]); // viewing off-queue
	});

	it("deleting a non-cursor queue member keeps the cursor", async () => {
		const qids = [locIds[0], locIds[1], locIds[2]];
		const r = await withApi(async (api, ids) => {
			await api.beginReview(ids);
			await api.reviewNext(); // cursor -> ids[1]
			await api.removeLocations(new Set([ids[0]])); // delete a non-cursor member
			const s = api.getReviewSession();
			const out = {
				cursorId: s?.cursorId ?? null,
				activeId: api.getMapState().activeLocation?.id ?? null,
				order: s?.order ?? [],
			};
			api.cancelReview();
			return out;
		}, qids);
		expect(r.cursorId).toBe(locIds[1]);
		expect(r.activeId).toBe(locIds[1]);
		expect(r.order).not.toContain(locIds[0]);
		expect(r.order).toContain(locIds[1]);
	});
});

describe("Review mode - resume", () => {
	useMap("E2E Review Resume");
	let locIds: number[];

	before(async () => {
		locIds = await seedLocs(3, (i) => ({ lat: i, lng: i }));
	});
	it("cancel persists the session; resume restores the cursor + reviewed set", async () => {
		const qids = [locIds[0], locIds[1], locIds[2]];
		const afterCancel = await withApi(async (api, ids) => {
			await api.beginReview(ids);
			await api.reviewNext(); // cursor -> ids[1], ids[0] reviewed
			api.cancelReview(); // flushes to disk, exits the UI
			return api.getReviewSession();
		}, qids);
		expect(afterCancel).toBeNull(); // cancel exits the live session

		// The flush is written in the background.
		await browser.waitUntil(
			() =>
				withApi(async (api, cursorId) => {
					const sessions = await api.listSessions("active");
					return sessions.length === 1 && sessions[0].cursorId === cursorId;
				}, locIds[1]),
			{ timeoutMsg: "the cancelled session never persisted its cursor" },
		);

		const r = await withApi(async (api) => {
			const [saved] = await api.listSessions("active");
			await api.resumeReview(saved);
			const resumed = api.getReviewSession();
			const out = {
				savedReviewed: saved.reviewed,
				resumedCursor: resumed?.cursorId ?? null,
				activeId: api.getMapState().activeLocation?.id ?? null,
			};
			if (resumed) await api.deleteSession(resumed.id);
			return out;
		});
		expect(r.savedReviewed).toContain(locIds[0]);
		expect(r.resumedCursor).toBe(locIds[1]);
		expect(r.activeId).toBe(locIds[1]);
	});
});

describe("Review mode - empty queue cleanup", () => {
	useMap("E2E Review Empty");
	let locIds: number[];

	before(async () => {
		const locs = [createLocation({ lat: 0, lng: 0 }), createLocation({ lat: 1, lng: 1 })];
		locIds = await addLocs(locs);
	});
	it("deleting the whole queue exits review and removes the session", async () => {
		const qids = [locIds[0], locIds[1]];
		const active = await withApi(async (api, ids) => {
			await api.beginReview(ids);
			await api.reviewDelete(); // deletes ids[0], advances to ids[1]
			await api.reviewDelete(); // deletes ids[1], queue empties
			return api.getReviewSession();
		}, qids);
		expect(active).toBeNull();

		// The session delete is written in the background.
		await browser.waitUntil(
			() => withApi(async (api) => (await api.listSessions("active")).length === 0),
			{ timeoutMsg: "the emptied session was never removed" },
		);
	});
});

describe("Review mode - review order", () => {
	useMap("E2E Review Order");
	let locIds: number[];

	before(async () => {
		locIds = await addLocs([
			createLocation({ lat: 0, lng: 0, zoom: 1 }),
			createLocation({ lat: 1, lng: 1, zoom: 3 }),
			createLocation({ lat: 2, lng: 2, zoom: 2 }),
		]);
	});

	it("walks the worklist highest-scored first", async () => {
		await updateMapSettings({ reviewOrder: "zoom" });
		const r = await withApi(
			async (api, ids) => {
				await api.beginReview(ids);
				const first = api.getMapState().activeLocation?.id ?? null;
				await api.reviewNext();
				return { first, second: api.getMapState().activeLocation?.id ?? null };
			},
			[locIds[0], locIds[1], locIds[2]],
		);
		expect(r.first).toBe(locIds[1]);
		expect(r.second).toBe(locIds[2]);
		await withApi((api) => api.cancelReview());
	});

	it("blank order keeps the order the selection resolved in", async () => {
		await updateMapSettings({ reviewOrder: null });
		const r = await withApi(
			async (api, ids) => {
				await api.beginReview(ids);
				return { first: api.getMapState().activeLocation?.id ?? null };
			},
			[locIds[0], locIds[1], locIds[2]],
		);
		expect(r.first).toBe(locIds[0]);
		await withApi((api) => api.cancelReview());
	});
});
