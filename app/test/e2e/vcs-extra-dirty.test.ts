/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Invariant under scrutiny: an extra-field-only change (the path enrichment and
 * manual extra edits take, via updateLocations(undoable: false)) makes the map
 * committable.
 *
 * store_commit_diff is derived from the overlay -- the same changeset store_commit
 * records -- so non-undoable extra writes count as modified and enable the
 * "Commit map" command, and the commit captures them.
 */
import { addLocs, createLocation, getLoc, flushAndWait, withApi, useMap } from "./helpers";

describe("VCS — extra-only change commit semantics", () => {
	const map = useMap("E2E VCS Extra Dirty");
	let id: number;

	before(async () => {
		[id] = await addLocs([createLocation({ lat: 1, lng: 2, heading: 0 })]);
		await flushAndWait();
		await withApi(async (api) => api.commitMap("base"));
	});
	it("an extra-only edit registers as modified on the commit-diff badge", async () => {
		const loc = await getLoc(id);
		await withApi(
			async (api, l) =>
				api.updateLocations([{ id: l.id, patch: { extra: { score: 7 } } }], { undoable: false }),
			loc,
		);
		// Overlay-derived diff sees non-undoable extra writes.
		expect(await withApi(async (api) => api.cmd.storeCommitDiff())).toEqual([0, 0, 1]);
		expect(await withApi(async (api) => api.hasCommitDiff())).toBe(true);
	});

	it("and a commit captures the extra change", async () => {
		const newCommit = await withApi(async (api) => api.commitMap("extra commit"));
		expect(newCommit).not.toContain("ERROR");

		// Mutate extra again post-commit, then checkout the "extra commit" to prove
		// it materialized the score=7 value (not lost, not the later value).
		const loc = await getLoc(id);
		await withApi(
			async (api, l) =>
				api.updateLocations([{ id: l.id, patch: { extra: { score: 999 } } }], { undoable: false }),
			loc,
		);
		await flushAndWait();

		await withApi(async (api, cid) => api.checkoutCommit(cid), newCommit);
		const restored = await getLoc(id);
		expect(restored.extra?.score).toBe(7);
	});

	it("checkout of the base (pre-extra) commit restores a location with no score", async () => {
		const commits = await withApi(async (api, m) => api.cmd.storeListCommits(m), map.id);
		const base = commits.find((c: any) => c.message === "base");
		await withApi(async (api, cid) => api.checkoutCommit(cid), base!.id);
		const restored = await getLoc(id);
		expect(restored.extra?.score).toBeUndefined();
	});
});
