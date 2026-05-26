import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	getLocCount,
	withApi,
} from "./helpers";

describe("UI: Keyboard shortcuts", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("UI Keyboard Test");
		await browser.$(".page-map-editor").waitForDisplayed({ timeout: 5000 });

		await addLocs([createLocation({ lat: 10, lng: 20, heading: 0, pitch: 0, zoom: 1 })]);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("Ctrl+Z triggers undo", async () => {
		const before = await getLocCount();
		expect(before).toBe(1);

		await browser.keys(["Control", "z"]);
		await browser.pause(300);

		const after = await getLocCount();
		expect(after).toBe(0);
	});

	it("Ctrl+Shift+Z triggers redo", async () => {
		await browser.keys(["Control", "Shift", "z"]);
		await browser.waitUntil(async () => (await getLocCount()) === 1, {
			timeout: 2000,
			timeoutMsg: "Redo did not restore location",
		});
	});

	it("Ctrl+Y also triggers redo", async () => {
		// Undo first
		await browser.keys(["Control", "z"]);
		await browser.pause(200);

		// Redo with Ctrl+Y
		await browser.keys(["Control", "y"]);
		await browser.pause(300);

		const after = await getLocCount();
		expect(after).toBe(1);
	});
});

describe("UI: Review keyboard navigation", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("UI Review KB");
		await browser.$(".page-map-editor").waitForDisplayed({ timeout: 5000 });

		const locs = [];
		for (let i = 0; i < 5; i++) {
			locs.push(createLocation({ lat: i * 10, lng: i * 10 }));
		}
		locIds = await addLocs(locs);

		await withApi(async (api) => api.selectEverything());
	});

	after(async () => {
		await withApi(async (api) => {
			try {
				api.cancelReview();
			} catch {}
		});
		await closeMap();
		await deleteMap(mapId);
	});

	it("start review then navigate with Ctrl+Arrow keys", async () => {
		await withApi(async (api, ids) => api.beginReview(ids), locIds);

		const firstId = await withApi(async (api) => api.getActiveLocation()?.id);
		expect(firstId).toBe(locIds[0]);

		// Ctrl+Right = next
		await browser.keys(["Control", "ArrowRight"]);
		await browser.pause(200);

		const secondId = await withApi(async (api) => api.getActiveLocation()?.id);
		expect(secondId).toBe(locIds[1]);

		// Ctrl+Left = prev
		await browser.keys(["Control", "ArrowLeft"]);
		await browser.pause(200);

		const backId = await withApi(async (api) => api.getActiveLocation()?.id);
		expect(backId).toBe(locIds[0]);
	});
});
