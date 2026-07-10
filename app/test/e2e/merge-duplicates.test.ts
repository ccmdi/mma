 
/**
 * mergeDuplicates end-to-end: transitive grouping, survivor tie-break, tag union,
 * extra merge (survivor wins conflicts), group isolation, and undo. The Rust core
 * is unit-tested; this proves the full IPC + overlay + undo path.
 *
 * Spacing uses latitude only (1 deg lat ~= 111.32 km everywhere, no cos factor).
 * A=0, B=0.0001 (~11.1m), C=0.0002 (~22.3m); threshold 16m links A-B and B-C
 * transitively but NOT A-C directly.
 */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	createTag,
	getAllLocs,
	getLoc,
	getLocCount,
	flushAndWait,
	withApi,
} from "./helpers";

const DIST = 16;

describe("mergeDuplicates — transitive groups, tag/extra union, undo", () => {
	let mapId: string;
	let A: number, B: number, C: number, D: number, E: number;
	let T1: number, T2: number, T3: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Merge Dups");

		[A, B, C, D, E] = await addLocs([
			createLocation({ lat: 0.0, lng: 0, heading: 10 }),
			createLocation({ lat: 0.0001, lng: 0, heading: 20 }),
			createLocation({ lat: 0.0002, lng: 0, heading: 30 }),
			// A second, far-away cluster (within DIST of each other).
			createLocation({ lat: 50.0, lng: 0, heading: 40 }),
			createLocation({ lat: 50.00005, lng: 0, heading: 50 }),
		]);

		T1 = (await createTag("m-t1")).id;
		T2 = (await createTag("m-t2")).id;
		T3 = (await createTag("m-t3")).id;

		// B gets two tags so it wins the survivor tie-break (most tags).
		await withApi(async (api, t, a) => api.addTagToLocations(t, [a]), T1, A);
		await withApi(async (api, t, b) => api.addTagToLocations(t, [b]), T1, B);
		await withApi(async (api, t, b) => api.addTagToLocations(t, [b]), T2, B);
		await withApi(async (api, t, c) => api.addTagToLocations(t, [c]), T3, C);

		// Extra: A and C contribute keys; B (survivor) wins the shared "k" key.
		await withApi(
			async (api, l) => api.patchLocationExtra(l, { k: "fromA", x: "ax" }),
			await getLoc(A),
		);
		await withApi(async (api, l) => api.patchLocationExtra(l, { k: "fromB" }), await getLoc(B));
		await withApi(async (api, l) => api.patchLocationExtra(l, { y: "cy" }), await getLoc(C));

		await flushAndWait();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("preview groups A,B,C transitively (not A-C directly) as one group", async () => {
		const groups: number[][] = await withApi(async (api, d) => api.previewDuplicateGroups(d), DIST);
		const big = groups.find((g) => g.length === 3);
		expect(big).toBeTruthy();
		expect([...big!].sort((a, b) => a - b)).toEqual([A, B, C].sort((a, b) => a - b));
		// The far cluster is its own group of 2.
		expect(groups.some((g) => g.length === 2 && g.includes(D) && g.includes(E))).toBe(true);
	});

	it("merge collapses each group to one survivor", async () => {
		expect(await getLocCount()).toBe(5);
		await withApi(async (api, d) => api.mergeDuplicates(d), DIST);
		await flushAndWait();
		expect(await getLocCount()).toBe(2); // one survivor per group
	});

	it("survivor of A/B/C is B (most tags) with tags unioned and extra merged", async () => {
		const survivor = await getLoc(B); // B kept its id
		expect(survivor).toBeTruthy();
		expect(survivor.lat).toBe(0.0001); // B's coordinates, not A's or C's
		expect([...survivor.tags].sort((a, b) => a - b)).toEqual([T1, T2, T3].sort((a, b) => a - b));
		// Survivor wins the "k" conflict; non-survivor-only keys are merged in.
		expect(survivor.extra).toEqual({ k: "fromB", x: "ax", y: "cy" });
		// A and C were merged away.
		const ids = (await getAllLocs()).map((l) => l.id);
		expect(ids).not.toContain(A);
		expect(ids).not.toContain(C);
	});

	it("the far cluster merged independently into a single survivor", async () => {
		const ids = (await getAllLocs()).map((l) => l.id);
		const survivors = ids.filter((id) => id === D || id === E);
		expect(survivors.length).toBe(1);
	});

	it("merge is a single undoable edit that restores all 5 originals", async () => {
		await withApi(async (api) => api.undo());
		await flushAndWait();
		expect(await getLocCount()).toBe(5);

		// Originals come back with their own tags (not the unioned set).
		const a = await getLoc(A);
		const c = await getLoc(C);
		expect([...a.tags]).toEqual([T1]);
		expect([...c.tags]).toEqual([T3]);
	});
});
