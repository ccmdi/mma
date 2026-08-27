/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Cross-map / cross-window location copy (store_copy_locations_to_map).
 *
 * Two branches, decided by whether the target's store is resident:
 *  - closed target -> Rust appends to the target's delta sidecar + tags JSON and
 *    persists immediately. Fully verifiable here: copy, reopen, assert.
 *  - open target   -> Rust mutates the live target store and emits
 *    `store-external-mutation` carrying the full MutationResult; the *receiving
 *    window* owns the save via mutate(). The producer no longer persists.
 *
 * Only the closed-target branch is exercised here. The open-target branch fires
 * when the target's store is resident, which in this app means a *second window*
 * has it open — and a single webview can't host one (switching the window to the
 * source closes the prior map). Its two halves are covered elsewhere: the consumer
 * mutate(payload) is the same path import uses (store.mutate(Promise.resolve(r)),
 * covered by the import specs), and the producer's add_copied_to_store result is
 * covered by a Rust unit test in import.test.rs.
 */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	openMap,
	addLocs,
	createLocation,
	createTag,
	getLocCount,
	getAllLocs,
	flushAndWait,
	withApi,
} from "./helpers";

const copy = (targetMapId: string, ids: number[]) =>
	withApi(
		(api, t, i) =>
			api.cmd.storeCopyLocationsToMap(t, { type: "Locations", locations: i, name: null }),
		targetMapId,
		ids,
	);

// Seed + persist a map, then close it (store evicted) so copies hit the closed-target branch.
async function makeClosedMap(name: string, locs: any[] = []): Promise<string> {
	const id = await createAndOpenMap(name);
	if (locs.length) await addLocs(locs);
	await flushAndWait();
	await closeMap();
	return id;
}

describe("Copy to a closed map", () => {
	before(async () => {
		await waitForReady();
	});

	afterEach(async () => {
		// Best-effort: a test that fails mid-flight may leave a map open; close it so the
		// next test starts from the map list.
		await withApi(async (api) => {
			try {
				if (api.getMapState().map) await api._test.closeMap();
			} catch {
				// best-effort cleanup
			}
		});
	});

	it("persists copied locations into the target", async () => {
		const tgt = await makeClosedMap("CopyClosed-basic-tgt");
		const src = await createAndOpenMap("CopyClosed-basic-src");
		const ids = await addLocs([
			createLocation({ lat: 11, lng: 11 }),
			createLocation({ lat: 22, lng: 22 }),
			createLocation({ lat: 33, lng: 33 }),
		]);

		const res = await copy(tgt, ids);
		expect(res.copied).toBe(3);
		expect(res.skipped).toBe(0);

		await openMap(tgt);
		const locs = await getAllLocs();
		expect(locs.length).toBe(3);
		expect(locs.map((l) => Math.round(l.lat)).sort((a, b) => a - b)).toEqual([11, 22, 33]);

		await closeMap();
		await deleteMap(src);
		await deleteMap(tgt);
	});

	it("carries tags into the target, reconciling by name", async () => {
		// Target already has a "Shared" tag (on one baseline location).
		const tgt = await createAndOpenMap("CopyClosed-tags-tgt");
		const sharedTgt = await createTag("Shared");
		await addLocs([createLocation({ lat: 1, lng: 1, tags: [sharedTgt.id] })]);
		await flushAndWait();
		await closeMap();

		// Source tags "Shared" (same name, different map) + a "Unique" tag.
		const src = await createAndOpenMap("CopyClosed-tags-src");
		const sharedSrc = await createTag("Shared");
		const uniqueSrc = await createTag("Unique");
		const ids = await addLocs([
			createLocation({ lat: 50, lng: 50, tags: [sharedSrc.id] }),
			createLocation({ lat: 60, lng: 60, tags: [sharedSrc.id, uniqueSrc.id] }),
		]);

		expect((await copy(tgt, ids)).copied).toBe(2);

		await openMap(tgt);
		const locs = await getAllLocs();
		const tags = Object.values(await withApi((api) => api.getMapState().tags));
		const tagCounts = await withApi((api) => api.getMapState().tagCounts);

		// "Shared" reconciled to the target's existing tag (no duplicate created).
		expect(tags.filter((t) => t.name === "Shared").length).toBe(1);
		expect(tags.filter((t) => t.name === "Unique").length).toBe(1);
		const sharedId = tags.find((t) => t.name === "Shared")!.id;
		const uniqueId = tags.find((t) => t.name === "Unique")!.id;
		expect(sharedId).toBe(sharedTgt.id);

		// Membership is the ground truth: 1 baseline + 2 copied carry Shared, 1 carries Unique.
		expect(locs.filter((l) => l.tags.includes(sharedId)).length).toBe(3);
		expect(locs.filter((l) => l.tags.includes(uniqueId)).length).toBe(1);
		// Counts must reflect membership (the exact thing the cross-window fix guards).
		expect(tagCounts[sharedId]).toBe(3);
		expect(tagCounts[uniqueId]).toBe(1);

		await closeMap();
		await deleteMap(src);
		await deleteMap(tgt);
	});

	it("carries extra fields and registers their defs in the target", async () => {
		const tgt = await makeClosedMap("CopyClosed-extra-tgt");
		const src = await createAndOpenMap("CopyClosed-extra-src");
		const ids = await addLocs([
			createLocation({ lat: 5, lng: 5, extra: { altitude: 120, country: "US" } }),
		]);

		expect((await copy(tgt, ids)).copied).toBe(1);

		await openMap(tgt);
		const locs = await getAllLocs();
		expect(locs[0].extra?.altitude).toBe(120);
		expect(locs[0].extra?.country).toBe("US");
		const fields = await withApi((api) => api.getMapState().map!.extra?.fields ?? {});
		expect(Object.keys(fields).sort()).toEqual(["altitude", "country"]);

		await closeMap();
		await deleteMap(src);
		await deleteMap(tgt);
	});

	it("skips duplicates already present in the target", async () => {
		const tgt = await makeClosedMap("CopyClosed-dup-tgt");
		const src = await createAndOpenMap("CopyClosed-dup-src");
		const ids = await addLocs([
			createLocation({ lat: 12, lng: 12 }),
			createLocation({ lat: 13, lng: 13 }),
		]);

		expect((await copy(tgt, ids)).copied).toBe(2);
		const second = await copy(tgt, ids);
		expect(second.copied).toBe(0);
		expect(second.skipped).toBe(2);

		await openMap(tgt);
		expect(await getLocCount()).toBe(2); // no growth on re-copy

		await closeMap();
		await deleteMap(src);
		await deleteMap(tgt);
	});

	it("leaves the source map unchanged", async () => {
		const tgt = await makeClosedMap("CopyClosed-src-tgt");
		const src = await createAndOpenMap("CopyClosed-src-src");
		const srcTag = await createTag("SrcTag");
		const ids = await addLocs([
			createLocation({ lat: 5, lng: 5, tags: [srcTag.id] }),
			createLocation({ lat: 6, lng: 6 }),
		]);

		await copy(tgt, ids);

		// Copy does not switch the window or touch the source.
		expect(await getLocCount()).toBe(2);
		const locs = await getAllLocs();
		expect(locs.filter((l) => l.tags.includes(srcTag.id)).length).toBe(1);

		await closeMap();
		await deleteMap(src);
		await deleteMap(tgt);
	});

	it("rejects copying a map into itself", async () => {
		const src = await createAndOpenMap("CopyClosed-self");
		const ids = await addLocs([createLocation({ lat: 7, lng: 7 })]);

		const err = await withApi(async (api, i) => {
			const selfId = api.getMapState().mapId!;
			try {
				await api.cmd.storeCopyLocationsToMap(selfId, {
					type: "Locations",
					locations: i,
					name: null,
				});
				return null;
			} catch (e) {
				return (e && (e as Error).message) || String(e);
			}
		}, ids);
		expect(err).toContain("its own map");

		await closeMap();
		await deleteMap(src);
	});
});
