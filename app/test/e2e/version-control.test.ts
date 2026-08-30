import {
	closeMap,
	flushAndWait,
	addLocs,
	createLocation,
	createTag,
	getAllLocs,
	getLocCount,
	withApi,
	useMap,
} from "./helpers";

describe("Version control - commits", () => {
	const map = useMap("E2E VCS");
	let locIds: number[];

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
		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), map.id);
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

		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), map.id);

		expect(commits.length).toBe(2);
		expect(commits[0].message).toBe("add one remove one");
		expect(commits[0].locationCount).toBe(2); // locIds[1] + newLoc
	});
});

describe("Version control - checkout", () => {
	const map = useMap("E2E VCS Checkout");
	let firstCommitId: string;
	let locIds: number[];

	before(async () => {
		locIds = await addLocs([
			createLocation({ lat: 10, lng: 20, heading: 0, panoId: null, flags: 0 }),
			createLocation({ lat: 30, lng: 40, heading: 0, panoId: null, flags: 0 }),
		]);

		firstCommitId = await withApi(async (api) => api.commitMap("v1: two locations"));
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
		const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), map.id);
		expect(commits.length).toBeGreaterThanOrEqual(2);
		const revertCommit = commits[0];
		expect(revertCommit.message).toContain("Revert");
	});

	it("checkout result survives save/load", async () => {
		await flushAndWait();
		await closeMap();
		await withApi(async (api, id) => api._test.openMap(id), map.id);

		const count = await getLocCount();
		expect(count).toBe(2);
	});
});

// Issue #122: deleting a tag's last location soft-deletes the tag, and restoring
// a commit from before the delete must revive it - visible, with fresh counts.
describe("Version control - checkout revives soft-deleted tags", () => {
	useMap("E2E VCS Tag Revival");
	let tagId: number;
	let taggedCommitId: string;
	let locId: number;

	before(async () => {
		tagId = (await createTag("Revivable")).id;
		[locId] = await addLocs([createLocation({ lat: 10, lng: 20, tags: [tagId] })]);
		taggedCommitId = await withApi(async (api) => api.commitMap("v1: tagged loc"));
	});
	it("deleting the tag's only location soft-deletes it", async () => {
		await withApi(async (api, id) => api.removeLocations(new Set([id])), locId);
		await withApi(async (api) => api.commitMap("v2: loc deleted"));

		const tag = await withApi(async (api, tid) => api.getMapState().tags[tid], tagId);
		expect(tag?.visible).toBe(false);
	});

	it("restoring the tagged commit revives the tag with its count", async () => {
		await withApi(async (api, cid) => api.checkoutCommit(cid), taggedCommitId);

		const { visible, count } = await withApi(async (api, tid) => {
			const s = api.getMapState();
			return { visible: s.tags[tid]?.visible, count: s.tagCounts[tid] ?? 0 };
		}, tagId);
		expect(visible).toBe(true);
		expect(count).toBe(1);
	});
});

// Commit dialog: shift+click opens a dialog whose typed message must land on the
// commit; a plain click commits silently.
describe("Version control - commit message dialog", () => {
	const map = useMap("E2E VCS Message UI");

	/** Shift+click the Commit button. The handler reads `shiftKey` off the click event,
	 *  which a dispatched MouseEvent carries without holding a modifier across commands. */
	async function shiftClickCommit() {
		await browser.execute(() => {
			const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Commit");
			btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
		});
	}

	it("a shift+click types a message onto the commit", async () => {
		await addLocs([createLocation({ lat: 5, lng: 5, heading: 0, panoId: null, flags: 0 })]);
		await shiftClickCommit();
		const input = await browser.$(".commit-dialog__message");
		await input.waitForExist();
		await input.setValue("from the commit dialog");
		await browser.$(".commit-dialog").$("button=Commit").click();
		await browser.waitUntil(async () => {
			const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), map.id);
			return commits.length >= 1 && commits[0].message === "from the commit dialog";
		});
		await input.waitForExist({ reverse: true });
	});

	it("a plain click commits with no dialog", async () => {
		await addLocs([createLocation({ lat: 6, lng: 6, heading: 0, panoId: null, flags: 0 })]);
		const before = await withApi(async (api, id) => api.cmd.storeListCommits(id), map.id);
		await browser.$("button=Commit").click();
		await browser.waitUntil(async () => {
			const commits = await withApi(async (api, id) => api.cmd.storeListCommits(id), map.id);
			return commits.length > before.length;
		});
		expect(await browser.$(".commit-dialog").isExisting()).toBe(false);
	});
});
