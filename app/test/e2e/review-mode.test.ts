import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	getLocCount,
	createLocation,
	withApi,
} from "./helpers";

const SETTLE = 50; // ms for React state to settle after async review ops

describe("Review mode", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Review");
		const locs = [];
		for (let i = 0; i < 10; i++) {
			locs.push(createLocation({ lat: i * 10, lng: i * 10, heading: i * 36 }));
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("beginReview sets active location to first in list", async () => {
		const reviewIds = [locIds[3], locIds[5], locIds[7]];
		const result = await withApi(
			async (api, ids, settle) => {
				await api.beginReview(ids);
				await new Promise((r) => setTimeout(r, settle));
				return {
					activeId: api.getActiveLocation()?.id ?? null,
					workArea: api.getWorkArea(),
				};
			},
			reviewIds,
			SETTLE,
		);
		expect(result.activeId).toBe(locIds[3]);
		expect(result.workArea).toBe("location");
	});

	it("reviewNext advances to next location", async () => {
		const result = await withApi(async (api, settle) => {
			await api.reviewNext();
			await new Promise((r) => setTimeout(r, settle));
			return { activeId: api.getActiveLocation()?.id ?? null };
		}, SETTLE);
		expect(result.activeId).toBe(locIds[5]);
	});

	it("reviewNext again advances to third location", async () => {
		const result = await withApi(async (api, settle) => {
			await api.reviewNext();
			await new Promise((r) => setTimeout(r, settle));
			return { activeId: api.getActiveLocation()?.id ?? null };
		}, SETTLE);
		expect(result.activeId).toBe(locIds[7]);
	});

	it("reviewNext at end exits review mode", async () => {
		const result = await withApi(async (api, settle) => {
			await api.reviewNext();
			await new Promise((r) => setTimeout(r, settle));
			return {
				activeId: api.getActiveLocation()?.id ?? null,
				workArea: api.getWorkArea(),
			};
		}, SETTLE);
		expect(result.activeId).toBeNull();
		expect(result.workArea).toBe("overview");
	});

	it("reviewPrev navigates backward", async () => {
		const reviewIds = [locIds[0], locIds[1], locIds[2]];
		const result = await withApi(
			async (api, ids, settle) => {
				await api.beginReview(ids);
				await api.reviewNext(); // -> locIds[1]
				await api.reviewNext(); // -> locIds[2]
				await api.reviewPrev(); // -> locIds[1]
				await new Promise((r) => setTimeout(r, settle));
				return { activeId: api.getActiveLocation()?.id ?? null };
			},
			reviewIds,
			SETTLE,
		);
		expect(result.activeId).toBe(locIds[1]);
	});

	it("reviewPrev at start is a no-op (stays on first, still in review)", async () => {
		const result = await withApi(async (api, settle) => {
			await api.reviewPrev(); // -> locIds[0]
			await api.reviewPrev(); // at start -> no-op, stays put
			await new Promise((r) => setTimeout(r, settle));
			return {
				activeId: api.getActiveLocation()?.id ?? null,
				workArea: api.getWorkArea(),
				inReview: api.getReviewSession() !== null,
			};
		}, SETTLE);
		expect(result.activeId).toBe(locIds[0]);
		expect(result.workArea).toBe("location");
		expect(result.inReview).toBe(true);
		await withApi(async (api, settle) => {
			api.cancelReview();
			await new Promise((r) => setTimeout(r, settle));
			return { ok: true };
		}, SETTLE);
	});

	it("cancelReview exits review and returns to overview", async () => {
		const reviewIds = [locIds[0], locIds[1], locIds[2]];
		const result = await withApi(
			async (api, ids, settle) => {
				await api.beginReview(ids);
				api.cancelReview();
				await new Promise((r) => setTimeout(r, settle));
				return {
					activeId: api.getActiveLocation()?.id ?? null,
					workArea: api.getWorkArea(),
				};
			},
			reviewIds,
			SETTLE,
		);
		expect(result.activeId).toBeNull();
		expect(result.workArea).toBe("overview");
	});

	it("beginReview with empty array is a no-op", async () => {
		const result = await withApi(async (api, settle) => {
			await api.beginReview([]);
			await new Promise((r) => setTimeout(r, settle));
			return { workArea: api.getWorkArea() };
		}, SETTLE);
		expect(result.workArea).toBe("overview");
	});

	it("beginReview filters out invalid IDs", async () => {
		const validId = locIds[4];
		const result = await withApi(
			async (api, id, settle) => {
				await api.beginReview([999999, id, 999998]);
				await new Promise((r) => setTimeout(r, settle));
				return { activeId: api.getActiveLocation()?.id ?? null };
			},
			validId,
			SETTLE,
		);
		expect(result.activeId).toBe(validId);
		await withApi(async (api, settle) => {
			api.cancelReview();
			await new Promise((r) => setTimeout(r, settle));
			return { ok: true };
		}, SETTLE);
	});

	it("beginReview with all invalid IDs is a no-op", async () => {
		const result = await withApi(async (api, settle) => {
			await api.beginReview([999999, 999998, 999997]);
			await new Promise((r) => setTimeout(r, settle));
			return { workArea: api.getWorkArea() };
		}, SETTLE);
		expect(result.workArea).toBe("overview");
	});
});

describe("Review mode - delete", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Review Delete");
		const locs = [];
		for (let i = 0; i < 5; i++) {
			locs.push(createLocation({ lat: i, lng: i }));
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("reviewDelete removes location and advances", async () => {
		const reviewIds = [locIds[0], locIds[1], locIds[2]];
		await withApi(
			async (api, ids, settle) => {
				await api.beginReview(ids);
				await new Promise((r) => setTimeout(r, settle));
				return { ok: true };
			},
			reviewIds,
			SETTLE,
		);

		const deletedId = locIds[0];
		const nextId = locIds[1];
		const result = await withApi(
			async (api, did, _nid, settle) => {
				await api.reviewDelete();
				await new Promise((r) => setTimeout(r, settle));
				const count = await api.cmd.storeLocationCount();
				const deleted = await api.fetchLocation(did).catch(() => null);
				return {
					activeId: api.getActiveLocation()?.id ?? null,
					count,
					deleted,
				};
			},
			deletedId,
			nextId,
			SETTLE,
		);
		expect(result.activeId).toBe(nextId);
		expect(result.count).toBe(4);
		expect(result.deleted).toBeNull();
	});

	it("reviewDelete on last location exits review", async () => {
		const result = await withApi(async (api, settle) => {
			await api.reviewNext(); // -> locIds[2]
			await api.reviewDelete(); // deletes locIds[2], no more -> exits
			await new Promise((r) => setTimeout(r, settle));
			return {
				activeId: api.getActiveLocation()?.id ?? null,
				workArea: api.getWorkArea(),
			};
		}, SETTLE);
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
		const loc = await withApi(async (api, id) => {
			return await api.fetchLocation(id);
		}, restoredId);
		expect(loc).not.toBeNull();
	});
});

describe("Review mode - skips deleted locations", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Review Skip");
		const locs = [
			createLocation({ lat: 0, lng: 0 }),
			createLocation({ lat: 1, lng: 1 }),
			createLocation({ lat: 2, lng: 2 }),
		];
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("reviewNext skips location deleted outside review", async () => {
		const allIds = [locIds[0], locIds[1], locIds[2]];
		const deleteId = locIds[1];
		const result = await withApi(
			async (api, ids, delId, settle) => {
				await api.beginReview(ids);
				await api.removeLocations(new Set([delId]));
				await api.reviewNext(); // should skip locIds[1], land on locIds[2]
				await new Promise((r) => setTimeout(r, settle));
				return { activeId: api.getActiveLocation()?.id ?? null };
			},
			allIds,
			deleteId,
			SETTLE,
		);
		expect(result.activeId).toBe(locIds[2]);
		await withApi(async (api, settle) => {
			api.cancelReview();
			await new Promise((r) => setTimeout(r, settle));
			return { ok: true };
		}, SETTLE);
	});
});

describe("Review mode - reviewed tracking & peek", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Review Peek");
		const locs = [];
		for (let i = 0; i < 4; i++) locs.push(createLocation({ lat: i, lng: i }));
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("advancing marks the departed location reviewed", async () => {
		const qids = [locIds[0], locIds[1], locIds[2]];
		const r = await withApi(
			async (api, ids, settle) => {
				await api.beginReview(ids);
				await api.reviewNext(); // marks ids[0] reviewed, cursor -> ids[1]
				await new Promise((res) => setTimeout(res, settle));
				const s = api.getReviewSession();
				const out = { reviewed: s?.reviewed ?? [], cursorId: s?.cursorId ?? null };
				api.cancelReview();
				await new Promise((res) => setTimeout(res, settle));
				return out;
			},
			qids,
			SETTLE,
		);
		expect(r.reviewed).toContain(locIds[0]);
		expect(r.cursorId).toBe(locIds[1]);
	});

	it("clicking an in-queue location jumps the cursor", async () => {
		const qids = [locIds[0], locIds[1], locIds[2]];
		const r = await withApi(
			async (api, ids, settle) => {
				await api.beginReview(ids);
				await api.setActiveLocation(ids[2], false); // in-queue
				await new Promise((res) => setTimeout(res, settle));
				const s = api.getReviewSession();
				const out = {
					cursorId: s?.cursorId ?? null,
					activeId: api.getActiveLocation()?.id ?? null,
				};
				api.cancelReview();
				await new Promise((res) => setTimeout(res, settle));
				return out;
			},
			qids,
			SETTLE,
		);
		expect(r.cursorId).toBe(locIds[2]);
		expect(r.activeId).toBe(locIds[2]);
	});

	it("clicking an off-queue location is a peek (cursor parked, still in review)", async () => {
		const qids = [locIds[0], locIds[1]];
		const off = locIds[3];
		const r = await withApi(
			async (api, ids, offId, settle) => {
				await api.beginReview(ids);
				await api.setActiveLocation(offId, false); // off-queue
				await new Promise((res) => setTimeout(res, settle));
				const s = api.getReviewSession();
				const out = {
					inReview: s !== null,
					cursorId: s?.cursorId ?? null,
					activeId: api.getActiveLocation()?.id ?? null,
				};
				api.cancelReview();
				await new Promise((res) => setTimeout(res, settle));
				return out;
			},
			qids,
			off,
			SETTLE,
		);
		expect(r.inReview).toBe(true);
		expect(r.cursorId).toBe(locIds[0]); // parked
		expect(r.activeId).toBe(locIds[3]); // viewing off-queue
	});

	it("deleting a non-cursor queue member keeps the cursor", async () => {
		const qids = [locIds[0], locIds[1], locIds[2]];
		const r = await withApi(
			async (api, ids, settle) => {
				await api.beginReview(ids);
				await api.reviewNext(); // cursor -> ids[1]
				await api.removeLocations(new Set([ids[0]])); // delete a non-cursor member
				await new Promise((res) => setTimeout(res, settle));
				const s = api.getReviewSession();
				const out = {
					cursorId: s?.cursorId ?? null,
					activeId: api.getActiveLocation()?.id ?? null,
					order: s?.order ?? [],
				};
				api.cancelReview();
				await new Promise((res) => setTimeout(res, settle));
				return out;
			},
			qids,
			SETTLE,
		);
		expect(r.cursorId).toBe(locIds[1]);
		expect(r.activeId).toBe(locIds[1]);
		expect(r.order).not.toContain(locIds[0]);
		expect(r.order).toContain(locIds[1]);
	});
});

describe("Review mode - resume", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Review Resume");
		const locs = [];
		for (let i = 0; i < 3; i++) locs.push(createLocation({ lat: i, lng: i }));
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("cancel persists the session; resume restores the cursor + reviewed set", async () => {
		const qids = [locIds[0], locIds[1], locIds[2]];
		const r = await withApi(
			async (api, ids, settle) => {
				await api.beginReview(ids);
				await api.reviewNext(); // cursor -> ids[1], ids[0] reviewed
				await new Promise((res) => setTimeout(res, settle));
				api.cancelReview(); // flushes to disk, exits the UI
				await new Promise((res) => setTimeout(res, settle));
				const afterCancel = api.getReviewSession();
				const sessions = await api.listSessions("active");
				if (sessions[0]) await api.resumeReview(sessions[0]);
				await new Promise((res) => setTimeout(res, settle));
				const resumed = api.getReviewSession();
				const out = {
					afterCancel,
					count: sessions.length,
					savedCursor: sessions[0]?.cursorId ?? null,
					savedReviewed: sessions[0]?.reviewed ?? [],
					resumedCursor: resumed?.cursorId ?? null,
					activeId: api.getActiveLocation()?.id ?? null,
				};
				if (resumed) await api.deleteSession(resumed.id);
				return out;
			},
			qids,
			SETTLE,
		);
		expect(r.afterCancel).toBeNull(); // cancel exits the live session
		expect(r.count).toBe(1); // but it's persisted, resumable
		expect(r.savedCursor).toBe(locIds[1]);
		expect(r.savedReviewed).toContain(locIds[0]);
		expect(r.resumedCursor).toBe(locIds[1]);
		expect(r.activeId).toBe(locIds[1]);
	});
});

describe("Review mode - empty queue cleanup", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Review Empty");
		const locs = [createLocation({ lat: 0, lng: 0 }), createLocation({ lat: 1, lng: 1 })];
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("deleting the whole queue exits review and removes the session", async () => {
		const qids = [locIds[0], locIds[1]];
		const r = await withApi(
			async (api, ids, settle) => {
				await api.beginReview(ids);
				await api.reviewDelete(); // deletes ids[0], advances to ids[1]
				await api.reviewDelete(); // deletes ids[1], queue empties
				await new Promise((res) => setTimeout(res, settle));
				const active = api.getReviewSession();
				const sessions = await api.listSessions("active");
				return { active, count: sessions.length };
			},
			qids,
			SETTLE,
		);
		expect(r.active).toBeNull();
		expect(r.count).toBe(0);
	});
});
