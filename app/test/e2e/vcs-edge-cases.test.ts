/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	getLocCount,
	flushAndWait,
	withApi,
} from "./helpers";

describe("Version control — commit and restore", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E VCS Edge");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("commit with no changes succeeds", async () => {
		await withApi(async (api) => {
			return api.commitMap("Empty commit");
		});
		// Should not throw
	});

	it("commit captures location state", async () => {
		await addLocs([
			createLocation({ lat: 10, lng: 10, heading: 90 }),
			createLocation({ lat: 20, lng: 20, heading: 180 }),
		]);
		await flushAndWait();

		await withApi(async (api) => api.commitMap("Two locations"));

		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), mapId);
		expect(commits.length).toBeGreaterThanOrEqual(2);
	});

	it("adding more locations after commit", async () => {
		await addLocs([createLocation({ lat: 30, lng: 30 }), createLocation({ lat: 40, lng: 40 })]);
		await flushAndWait();

		const count = await getLocCount();
		expect(count).toBe(4);
	});

	it("checkout restores to committed state", async () => {
		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), mapId);
		// Find the "Two locations" commit
		const twoLocCommit = commits.find((c: any) => c.message === "Two locations");
		expect(twoLocCommit).toBeTruthy();

		await withApi(async (api, commitId) => {
			await api.checkoutCommit(commitId);
		}, twoLocCommit!.id);

		const count = await getLocCount();
		expect(count).toBe(2);
	});

	it("checkout resets undo history", async () => {
		const state = await withApi(async (api) => api.getUndoRedoState());
		expect(state.canUndo).toBe(false);
		expect(state.canRedo).toBe(false);
	});

	it("can add locations after checkout", async () => {
		await addLocs([createLocation({ lat: 50, lng: 50 })]);
		const count = await getLocCount();
		expect(count).toBe(3);
	});
});

describe("Version control — multiple commits", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E VCS Multi");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("creates a sequence of commits", async () => {
		// Commit 1: empty
		await withApi(async (api) => api.commitMap("Initial"));

		// Commit 2: 5 locations
		await addLocs(Array.from({ length: 5 }, (_, i) => createLocation({ lat: i, lng: i })));
		await flushAndWait();
		await withApi(async (api) => api.commitMap("Five locations"));

		// Commit 3: 10 total
		await addLocs(
			Array.from({ length: 5 }, (_, i) => createLocation({ lat: 10 + i, lng: 10 + i })),
		);
		await flushAndWait();
		await withApi(async (api) => api.commitMap("Ten locations"));

		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), mapId);
		expect(commits.length).toBeGreaterThanOrEqual(3);
	});

	it("commit messages are preserved", async () => {
		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), mapId);
		const messages = commits.map((c: any) => c.message);
		expect(messages).toContain("Initial");
		expect(messages).toContain("Five locations");
		expect(messages).toContain("Ten locations");
	});

	it("can checkout any prior commit", async () => {
		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), mapId);
		const fiveCommit = commits.find((c: any) => c.message === "Five locations");

		await withApi(async (api, commitId) => {
			await api.checkoutCommit(commitId);
		}, fiveCommit!.id);

		const count = await getLocCount();
		expect(count).toBe(5);
	});
});
