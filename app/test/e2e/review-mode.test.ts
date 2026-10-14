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
	it("Review.begin sets open location to first in list", async () => {
		const reviewIds = [locIds[3], locIds[5], locIds[7]];
		const result = await withApi(async (api, ids) => {
			await api.Review.begin(ids);
			return {
				activeId: api.Editor.get().open?.location?.id ?? null,
				workArea: api.Editor.get().workArea,
			};
		}, reviewIds);
		expect(result.activeId).toBe(locIds[3]);
		expect(result.workArea).toBe("location");
	});

	it("Review.next advances to next location", async () => {
		const result = await withApi(async (api) => {
			await api.Review.next();
			return { activeId: api.Editor.get().open?.location?.id ?? null };
		});
		expect(result.activeId).toBe(locIds[5]);
	});

	it("Review.next again advances to third location", async () => {
		const result = await withApi(async (api) => {
			await api.Review.next();
			return { activeId: api.Editor.get().open?.location?.id ?? null };
		});
		expect(result.activeId).toBe(locIds[7]);
	});

	it("Review.next at end exits review mode", async () => {
		const result = await withApi(async (api) => {
			await api.Review.next();
			return {
				activeId: api.Editor.get().open?.location?.id ?? null,
				workArea: api.Editor.get().workArea,
			};
		});
		expect(result.activeId).toBeNull();
		expect(result.workArea).toBe("overview");
	});

	it("Review.prev navigates backward", async () => {
		const reviewIds = [locIds[0], locIds[1], locIds[2]];
		const result = await withApi(async (api, ids) => {
			await api.Review.begin(ids);
			await api.Review.next(); // -> locIds[1]
			await api.Review.next(); // -> locIds[2]
			await api.Review.prev(); // -> locIds[1]
			return { activeId: api.Editor.get().open?.location?.id ?? null };
		}, reviewIds);
		expect(result.activeId).toBe(locIds[1]);
	});

	it("Review.prev at start is a no-op (stays on first, still in review)", async () => {
		const result = await withApi(async (api) => {
			await api.Review.prev(); // -> locIds[0]
			await api.Review.prev(); // at start -> no-op, stays put
			return {
				activeId: api.Editor.get().open?.location?.id ?? null,
				workArea: api.Editor.get().workArea,
				inReview: api.Review.session() !== null,
			};
		});
		expect(result.activeId).toBe(locIds[0]);
		expect(result.workArea).toBe("location");
		expect(result.inReview).toBe(true);
		await withApi((api) => api.Review.cancel());
	});

	it("Review.cancel exits review and returns to overview", async () => {
		const reviewIds = [locIds[0], locIds[1], locIds[2]];
		const result = await withApi(async (api, ids) => {
			await api.Review.begin(ids);
			api.Review.cancel();
			return {
				activeId: api.Editor.get().open?.location?.id ?? null,
				workArea: api.Editor.get().workArea,
			};
		}, reviewIds);
		expect(result.activeId).toBeNull();
		expect(result.workArea).toBe("overview");
	});

	it("Review.begin with empty array is a no-op", async () => {
		const result = await withApi(async (api) => {
			await api.Review.begin([]);
			return { workArea: api.Editor.get().workArea };
		});
		expect(result.workArea).toBe("overview");
	});

	it("Review.begin filters out invalid IDs", async () => {
		const validId = locIds[4];
		const result = await withApi(async (api, id) => {
			await api.Review.begin([999999, id, 999998]);
			return { activeId: api.Editor.get().open?.location?.id ?? null };
		}, validId);
		expect(result.activeId).toBe(validId);
		await withApi((api) => api.Review.cancel());
	});

	it("Review.begin with all invalid IDs is a no-op", async () => {
		const result = await withApi(async (api) => {
			await api.Review.begin([999999, 999998, 999997]);
			return { workArea: api.Editor.get().workArea };
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
	it("Review.deleteCurrent removes location and advances", async () => {
		const reviewIds = [locIds[0], locIds[1], locIds[2]];
		await withApi(async (api, ids) => api.Review.begin(ids), reviewIds);

		const deletedId = locIds[0];
		const nextId = locIds[1];
		const result = await withApi(async (api, did) => {
			await api.Review.deleteCurrent();
			const count = api.Store.get().locationCount;
			const deleted = await api.fetchLocation(did).catch(() => null);
			return {
				activeId: api.Editor.get().open?.location?.id ?? null,
				count,
				deleted,
			};
		}, deletedId);
		expect(result.activeId).toBe(nextId);
		expect(result.count).toBe(4);
		expect(result.deleted).toBeNull();
	});

	it("Review.deleteCurrent on last location exits review", async () => {
		const result = await withApi(async (api) => {
			await api.Review.next(); // -> locIds[2]
			await api.Review.deleteCurrent(); // deletes locIds[2], no more -> exits
			return {
				activeId: api.Editor.get().open?.location?.id ?? null,
				workArea: api.Editor.get().workArea,
			};
		});
		const count = await getLocCount();
		expect(result.activeId).toBeNull();
		expect(result.workArea).toBe("overview");
		expect(count).toBe(3); // locIds[0] and locIds[2] deleted
	});

	it("undo after Review.deleteCurrent restores location", async () => {
		await withApi(async (api) => {
			await api.History.step("undo", "edits");
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
	it("Review.next skips location deleted outside review", async () => {
		const allIds = [locIds[0], locIds[1], locIds[2]];
		const deleteId = locIds[1];
		const result = await withApi(
			async (api, ids, delId) => {
				await api.Review.begin(ids);
				await api.Location.remove(new Set([delId]));
				await api.Review.next(); // should skip locIds[1], land on locIds[2]
				return { activeId: api.Editor.get().open?.location?.id ?? null };
			},
			allIds,
			deleteId,
		);
		expect(result.activeId).toBe(locIds[2]);
		await withApi((api) => api.Review.cancel());
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
			await api.Review.begin(ids);
			await api.Review.next(); // marks ids[0] reviewed, cursor -> ids[1]
			const s = api.Review.session();
			const out = { reviewed: s?.reviewed ?? [], cursorId: s?.cursorId ?? null };
			api.Review.cancel();
			return out;
		}, qids);
		expect(r.reviewed).toContain(locIds[0]);
		expect(r.cursorId).toBe(locIds[1]);
	});

	it("clicking an in-queue location jumps the cursor", async () => {
		const qids = [locIds[0], locIds[1], locIds[2]];
		const r = await withApi(async (api, ids) => {
			await api.Review.begin(ids);
			await api.Editor.open(ids[2], false); // in-queue
			const s = api.Review.session();
			const out = {
				cursorId: s?.cursorId ?? null,
				activeId: api.Editor.get().open?.location?.id ?? null,
			};
			api.Review.cancel();
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
				await api.Review.begin(ids);
				await api.Editor.open(offId, false); // off-queue
				const s = api.Review.session();
				const out = {
					inReview: s !== null,
					cursorId: s?.cursorId ?? null,
					activeId: api.Editor.get().open?.location?.id ?? null,
				};
				api.Review.cancel();
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
			await api.Review.begin(ids);
			await api.Review.next(); // cursor -> ids[1]
			await api.Location.remove(new Set([ids[0]])); // delete a non-cursor member
			const s = api.Review.session();
			const out = {
				cursorId: s?.cursorId ?? null,
				activeId: api.Editor.get().open?.location?.id ?? null,
				order: s?.order ?? [],
			};
			api.Review.cancel();
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
			await api.Review.begin(ids);
			await api.Review.next(); // cursor -> ids[1], ids[0] reviewed
			api.Review.cancel(); // flushes to disk, exits the UI
			return api.Review.session();
		}, qids);
		expect(afterCancel).toBeNull(); // cancel exits the live session

		// The flush is written in the background.
		await browser.waitUntil(
			() =>
				withApi(async (api, cursorId) => {
					const sessions = await api.Review.sessions("active");
					return sessions.length === 1 && sessions[0].cursorId === cursorId;
				}, locIds[1]),
			{ timeoutMsg: "the cancelled session never persisted its cursor" },
		);

		const r = await withApi(async (api) => {
			const [saved] = await api.Review.sessions("active");
			await api.Review.resume(saved);
			const resumed = api.Review.session();
			const out = {
				savedReviewed: saved.reviewed,
				resumedCursor: resumed?.cursorId ?? null,
				activeId: api.Editor.get().open?.location?.id ?? null,
			};
			if (resumed) await api.Review.removeSession(resumed.id);
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
			await api.Review.begin(ids);
			await api.Review.deleteCurrent(); // deletes ids[0], advances to ids[1]
			await api.Review.deleteCurrent(); // deletes ids[1], queue empties
			return api.Review.session();
		}, qids);
		expect(active).toBeNull();

		// The session delete is written in the background.
		await browser.waitUntil(
			() => withApi(async (api) => (await api.Review.sessions("active")).length === 0),
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
				await api.Review.begin(ids);
				const first = api.Editor.get().open?.location?.id ?? null;
				await api.Review.next();
				return { first, second: api.Editor.get().open?.location?.id ?? null };
			},
			[locIds[0], locIds[1], locIds[2]],
		);
		expect(r.first).toBe(locIds[1]);
		expect(r.second).toBe(locIds[2]);
		await withApi((api) => api.Review.cancel());
	});

	it("blank order keeps the order the selection resolved in", async () => {
		await updateMapSettings({ reviewOrder: null });
		const r = await withApi(
			async (api, ids) => {
				await api.Review.begin(ids);
				return { first: api.Editor.get().open?.location?.id ?? null };
			},
			[locIds[0], locIds[1], locIds[2]],
		);
		expect(r.first).toBe(locIds[0]);
		await withApi((api) => api.Review.cancel());
	});
});
