import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	openMap,
	addLocs,
	getAllLocs,
	getLocCount,
	createLocation,
	randomLatLng,
	randomHeading,
} from "./helpers";

describe("Storage round-trip", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Storage Test");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("should open the map and add locations", async () => {
		const locs = [];
		for (let i = 0; i < 200; i++) {
			locs.push(
				createLocation({
					...randomLatLng(),
					...randomHeading(),
					panoId: i % 5 === 0 ? `pano_${i}` : null,
					flags: i % 3 === 0 ? 1 : 0,
				}),
			);
		}
		await addLocs(locs);

		const count = await getLocCount();
		expect(count).toBe(200);
	});

	it("should persist after save", async () => {
		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const count = await getLocCount();
		expect(count).toBe(200);
	});

	it("should preserve location flags across save/load", async () => {
		const locs = await getAllLocs();
		const total = locs.length;
		const withFlag = locs.filter((l: any) => (l.flags & 1) !== 0).length;
		const withPano = locs.filter((l: any) => l.panoId != null).length;

		expect(total).toBe(200);
		expect(withFlag).toBeGreaterThan(50);
		expect(withFlag).toBeLessThan(80);
		expect(withPano).toBe(40);
	});

	it("should handle add + save correctly", async () => {
		const locs = [];
		for (let i = 0; i < 50; i++) {
			locs.push(createLocation({ ...randomLatLng(), ...randomHeading() }));
		}
		await addLocs(locs);

		const afterAdd = await getLocCount();
		expect(afterAdd).toBe(250);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const afterReopen = await getLocCount();
		expect(afterReopen).toBe(250);
	});
});
