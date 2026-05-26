import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	addLocs,
	createLocation,
	getAllLocs,
	getLocCount,
	withApi,
} from "./helpers";

describe("Version control - commits", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E VCS");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("commitMap returns a commit ID", async () => {
		locIds = await addLocs([
			createLocation({ lat: 10, lng: 20, heading: 0, panoId: null, flags: 0 }),
			createLocation({ lat: 30, lng: 40, heading: 90, panoId: "P1", flags: 1 }),
		]);

		const commitId = await withApi(async (api) => api.commitMap("initial commit"));
		expect(commitId).not.toContain("ERROR");
		expect(commitId.length).toBeGreaterThan(10);
	});

	it("commit clears undo/redo history", async () => {
		const before = await getLocCount();
		await withApi(async (api) => api.undo());
		const after = await getLocCount();
		expect(after).toBe(before);
	});

	it("listCommits returns commit history", async () => {
		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), mapId);
		expect(Array.isArray(commits)).toBe(true);
		expect(commits.length).toBeGreaterThanOrEqual(1);
		expect(commits[0].message).toBe("initial commit");
		expect(commits[0].locationCount).toBe(2);
	});

	it("second commit records diff stats", async () => {
		const newLocs = [createLocation({ lat: 50, lng: 60, heading: 0, panoId: null, flags: 0 })];
		await addLocs(newLocs);

		await withApi(async (api, removeId) => api.removeLocations(new Set([removeId])), locIds[0]);

		await withApi(async (api) => api.commitMap("add one remove one"));

		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), mapId);

		expect(commits.length).toBe(2);
		expect(commits[0].message).toBe("add one remove one");
		expect(commits[0].locationCount).toBe(2); // locIds[1] + newLoc
	});
});

describe("Version control - checkout", () => {
	let mapId: string;
	let firstCommitId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E VCS Checkout");

		locIds = await addLocs([
			createLocation({ lat: 10, lng: 20, heading: 0, panoId: null, flags: 0 }),
			createLocation({ lat: 30, lng: 40, heading: 0, panoId: null, flags: 0 }),
		]);

		firstCommitId = await withApi(async (api) => api.commitMap("v1: two locations"));
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("checkout reverts to committed state", async () => {
		// Make changes after commit
		await addLocs([createLocation({ lat: 50, lng: 60, heading: 0, panoId: null, flags: 0 })]);

		await withApi(async (api, removeId) => api.removeLocations(new Set([removeId])), locIds[0]);

		let count = await getLocCount();
		expect(count).toBe(2); // locIds[1] + new one

		// Checkout first commit
		await withApi(async (api, commitId) => api.checkoutCommit(commitId), firstCommitId);

		count = await getLocCount();
		expect(count).toBe(2); // original two restored
	});

	it("checkout restores original location data", async () => {
		const allLocs = await getAllLocs();
		const allLocIds = allLocs.map((l) => l.id);
		expect(allLocIds).toContain(locIds[0]);
		expect(allLocIds).toContain(locIds[1]);
		// The third loc added after commit should not be present
		expect(allLocs.length).toBe(2);
	});

	it("checkout clears undo/redo history", async () => {
		const before = await getLocCount();
		await withApi(async (api) => api.undo());
		const after = await getLocCount();
		expect(after).toBe(before); // undo should be no-op
	});

	it("checkout creates a revert commit", async () => {
		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), mapId);
		expect(commits.length).toBeGreaterThanOrEqual(2);
		const revertCommit = commits[0];
		expect(revertCommit.message).toContain("Revert");
	});

	it("checkout result survives save/load", async () => {
		await flushAndWait();
		await closeMap();
		await withApi(async (api, id) => api.openMap(id), mapId);

		const count = await getLocCount();
		expect(count).toBe(2);
	});
});
