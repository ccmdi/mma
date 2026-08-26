/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Delta-chain VCS data-fidelity invariants.
 *
 * The existing VCS specs assert commit/checkout by location *count*. These assert
 * the harder invariant the delta chain exists to guarantee: that materializing a
 * commit reproduces the EXACT location data committed -- every field, including
 * modifications, tags, and extra fields -- across the overlay->commit->checkout
 * ->reopen round trip, and that the post-checkout revert commit keeps the chain
 * materializable.
 */
import {
	closeMap,
	addLocs,
	createLocation,
	createTag,
	getAllLocs,
	getLoc,
	getLocCount,
	flushAndWait,
	withApi,
	useMap,
} from "./helpers";
import type { Location } from "@/bindings.gen";

/** Stable, comparable projection of a location's persisted data. */
function snap(l: Location) {
	return {
		id: l.id,
		lat: l.lat,
		lng: l.lng,
		heading: l.heading,
		panoId: l.panoId ?? null,
		flags: l.flags,
		tags: [...(l.tags ?? [])].sort((a, b) => a - b),
		extra: l.extra ?? null,
	};
}

async function snapshotAll() {
	const locs = await getAllLocs();
	return locs.map(snap).sort((a, b) => a.id - b.id);
}

async function listCommits(mapId: string): Promise<any[]> {
	return withApi(async (api, id) => api.cmd.storeListCommits(id), mapId);
}

async function commitDiff(): Promise<[number, number, number]> {
	return withApi(async (api) => api.cmd.storeCommitDiff());
}

describe("VCS data fidelity — exact restoration through checkout", () => {
	const map = useMap("E2E VCS Fidelity");
	let ids: number[];
	let v1Snapshot: ReturnType<typeof snap>[];
	let tagId: number;

	before(async () => {
		// Distinct data per location so a mix-up is detectable.
		ids = await addLocs([
			createLocation({ lat: 11.1, lng: 22.2, heading: 33, panoId: "PANO_A", flags: 1 }),
			createLocation({ lat: -44.4, lng: 55.5, heading: 66, panoId: null, flags: 0 }),
			createLocation({ lat: 77.7, lng: -88.8, heading: 99, panoId: "PANO_C", flags: 2 }),
			createLocation({ lat: 12.34, lng: -56.78, heading: 180, panoId: null, flags: 0 }),
		]);

		const tag = await createTag("fidelity-tag");
		tagId = tag.id;
		await withApi(async (api, t, a, b) => api.addTagToLocations(t, [a, b]), tagId, ids[0], ids[1]);

		// Extra fields: a string and a number, to prove JSON typing survives.
		const loc2 = await getLoc(ids[2]);
		await withApi(
			async (api, l) =>
				api.updateLocations([{ id: l.id, patch: { extra: { note: "hello", score: 42 } } }], {
					undoable: false,
				}),
			loc2,
		);

		await flushAndWait();
		await withApi(async (api) => api.commitMap("v1"));
		v1Snapshot = await snapshotAll();
	});
	it("v1 snapshot captured the seeded data", () => {
		expect(v1Snapshot.length).toBe(4);
		const byId = Object.fromEntries(v1Snapshot.map((s) => [s.id, s]));
		expect(byId[ids[0]].tags).toContain(tagId);
		expect(byId[ids[1]].tags).toContain(tagId);
		expect(byId[ids[2]].extra).toEqual({ note: "hello", score: 42 });
		expect(byId[ids[0]].panoId).toBe("PANO_A");
		expect(byId[ids[0]].heading).toBe(33);
	});

	it("checkout v1 restores every field exactly after a heavy v2 mutation", async () => {
		// v2: modify loc0 (move + reheading), retag loc2, change loc2 extra,
		// delete loc3, add a brand-new loc.
		const loc0 = await getLoc(ids[0]);
		await withApi(
			async (api, l) =>
				api.updateLocations([{ id: l.id, patch: { heading: 270, lat: 1.111, panoId: "PANO_A2" } }]),
			loc0,
		);
		await withApi(async (api, t, c) => api.addTagToLocations(t, [c]), tagId, ids[2]);
		const loc2 = await getLoc(ids[2]);
		await withApi(
			async (api, l) =>
				api.updateLocations([{ id: l.id, patch: { extra: { note: "changed" } } }], {
					undoable: false,
				}),
			loc2,
		);
		await withApi(async (api, d) => api.removeLocations(new Set([d])), ids[3]);
		await addLocs([createLocation({ lat: 5, lng: 6, heading: 7, panoId: "NEW" })]);

		await flushAndWait();
		await withApi(async (api) => api.commitMap("v2"));

		const commits = await listCommits(map.id);
		const v1 = commits.find((c) => c.message === "v1");
		expect(v1).toBeTruthy();

		await withApi(async (api, cid) => api.checkoutCommit(cid), v1.id);

		const restored = await snapshotAll();
		expect(restored).toEqual(v1Snapshot);
	});

	it("checkout v2 restores the modified state exactly", async () => {
		const commits = await listCommits(map.id);
		const v2 = commits.find((c) => c.message === "v2");
		expect(v2).toBeTruthy();

		await withApi(async (api, cid) => api.checkoutCommit(cid), v2.id);

		const byId = Object.fromEntries((await getAllLocs()).map((l) => [l.id, l]));
		// loc0 modifications
		expect(byId[ids[0]].heading).toBe(270);
		expect(byId[ids[0]].lat).toBe(1.111);
		expect(byId[ids[0]].panoId).toBe("PANO_A2");
		// loc2 retagged + extra changed
		expect([...byId[ids[2]].tags].sort()).toContain(tagId);
		expect(byId[ids[2]].extra.note).toBe("changed");
		// loc3 deleted, plus the new loc present
		expect(byId[ids[3]]).toBeUndefined();
		const newLoc = Object.values(byId).find((l: any) => l.panoId === "NEW");
		expect(newLoc).toBeTruthy();
	});

	it("checkout survives a save/load reopen with data intact", async () => {
		await flushAndWait();
		await closeMap();
		await withApi(async (api, id) => api._test.openMap(id), map.id);

		const byId = Object.fromEntries((await getAllLocs()).map((l) => [l.id, l]));
		expect(byId[ids[0]].heading).toBe(270);
		expect(byId[ids[0]].panoId).toBe("PANO_A2");
	});
});

describe("VCS commit-diff badge accuracy", () => {
	useMap("E2E VCS Diff Badge");
	let ids: number[];

	before(async () => {
		ids = await addLocs([
			createLocation({ lat: 1, lng: 1, heading: 0 }),
			createLocation({ lat: 2, lng: 2, heading: 0 }),
			createLocation({ lat: 3, lng: 3, heading: 0 }),
		]);
		await flushAndWait();
		await withApi(async (api) => api.commitMap("base"));
	});
	it("clean tree shows no diff right after commit", async () => {
		expect(await commitDiff()).toEqual([0, 0, 0]);
		expect(await withApi(async (api) => api.hasCommitDiff())).toBe(false);
	});

	it("a pure modification counts as ~1, not an add/remove", async () => {
		const loc0 = await getLoc(ids[0]);
		await withApi(
			async (api, l) => api.updateLocations([{ id: l.id, patch: { heading: 123 } }]),
			loc0,
		);
		const [added, removed, modified] = await commitDiff();
		expect([added, removed]).toEqual([0, 0]);
		expect(modified).toBe(1);
		expect(await withApi(async (api) => api.hasCommitDiff())).toBe(true);
	});

	it("add + remove + modify accumulate independently", async () => {
		await addLocs([createLocation({ lat: 9, lng: 9 })]);
		await withApi(async (api, d) => api.removeLocations(new Set([d])), ids[1]);
		const [added, removed, modified] = await commitDiff();
		expect(added).toBe(1);
		expect(removed).toBe(1);
		expect(modified).toBe(1); // still the loc0 heading change
	});

	it("committing resets the badge to zero", async () => {
		await withApi(async (api) => api.commitMap("changes"));
		expect(await commitDiff()).toEqual([0, 0, 0]);
		expect(await withApi(async (api) => api.hasCommitDiff())).toBe(false);
	});
});

describe("VCS revert-commit chain integrity", () => {
	const map = useMap("E2E VCS Revert Chain");

	it("the auto revert commit stays materializable and tip-correct", async () => {
		// c1 = 2 locs, c2 = +2 locs (4 total)
		await addLocs([createLocation({ lat: 1, lng: 1 }), createLocation({ lat: 2, lng: 2 })]);
		await flushAndWait();
		const c1 = await withApi(async (api) => api.commitMap("c1"));

		await addLocs([createLocation({ lat: 3, lng: 3 }), createLocation({ lat: 4, lng: 4 })]);
		await flushAndWait();
		await withApi(async (api) => api.commitMap("c2"));
		expect(await getLocCount()).toBe(4);

		// Checkout c1 -> writes a "Revert to ..." commit as the new tip.
		await withApi(async (api, cid) => api.checkoutCommit(cid), c1);
		expect(await getLocCount()).toBe(2);

		const commits = await listCommits(map.id);
		expect(commits[0].message).toContain("Revert");
		// Tip materializes to the c1 state (2 locs) -- proven by reopening.
		await flushAndWait();
		await closeMap();
		await withApi(async (api, id) => api._test.openMap(id), map.id);
		expect(await getLocCount()).toBe(2);

		// And we can still keep working + committing on top of the revert.
		await addLocs([createLocation({ lat: 5, lng: 5 })]);
		await flushAndWait();
		await withApi(async (api) => api.commitMap("after revert"));
		expect(await getLocCount()).toBe(3);
	});

	it("checking out the revert tip after more work restores 3 locs", async () => {
		const commits = await listCommits(map.id);
		const afterRevert = commits.find((c) => c.message === "after revert");
		await addLocs([createLocation({ lat: 6, lng: 6 })]);
		await flushAndWait();
		expect(await getLocCount()).toBe(4);

		await withApi(async (api, cid) => api.checkoutCommit(cid), afterRevert.id);
		expect(await getLocCount()).toBe(3);
	});
});
