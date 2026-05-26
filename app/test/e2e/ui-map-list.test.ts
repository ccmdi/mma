import { waitForReady, closeMap, deleteMap, withApi } from "./helpers";

describe("UI: Map list", () => {
	const createdIds: string[] = [];

	before(async () => {
		await waitForReady();
		// Ensure we're on the map list (no map open)
		await closeMap();
	});

	after(async () => {
		await closeMap();
		for (const id of createdIds) await deleteMap(id);
	});

	it("shows map list when no map is open", async () => {
		const visible = await browser.$(".page-map-list").isDisplayed();
		expect(visible).toBe(true);
	});

	it("has 'Your Maps' heading", async () => {
		const heading = await browser.$(".page-map-list h2");
		const text = await heading.getText();
		expect(text).toContain("Your Maps");
	});

	it("creates a map via the search box + New map button", async () => {
		// The map name is taken from the search/filter box; the "New map" icon creates it.
		const search = await browser.$('.page-map-list input[placeholder="Search maps..."]');
		await search.setValue("UI Test Map");

		const newMapBtn = await browser.$('.page-map-list [aria-label="New map"]');
		await newMapBtn.click();
		await browser.pause(500);

		const id = await withApi(async (api) => {
			const maps = await api.cmd.storeListMaps();
			const m = maps.find((m: any) => m.name === "UI Test Map");
			return m?.id ?? "NOT_FOUND";
		});
		expect(id).not.toBe("NOT_FOUND");
		createdIds.push(id);
	});

	it("map entry shows in the list", async () => {
		const links = await browser.$$(".map-link");
		let found = false;
		for (const link of links) {
			const text = await link.getText();
			if (text === "UI Test Map") {
				found = true;
				break;
			}
		}
		expect(found).toBe(true);
	});
});

describe("UI: Map list - rename and delete", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		await closeMap();

		// Clear any lingering search filter — the create test above types the name
		// into the search box, which also filters the list and would hide this map.
		const search = await browser.$('.page-map-list input[placeholder="Search maps..."]');
		await search.clearValue();

		mapId = await withApi(async (api) => {
			const map = await api.cmd.storeCreateMap("Rename Me", null);
			// api.createMap calls the raw command and doesn't refresh the list view.
			await api.invalidateMapList();
			return map.meta.id;
		});
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("rename button opens rename dialog", async () => {
		const entry = await browser.$('.map-list__entry*=Rename Me');
		await entry.waitForExist({ timeout: 3000 });
		// Action buttons are opacity:0 until the row is hovered.
		await entry.moveTo();
		await entry.$('[aria-label="Edit map"]').click();

		const dialog = await browser.$(".edit-map-modal");
		await dialog.waitForDisplayed({ timeout: 3000 });
	});

	it("can rename map via dialog", async () => {
		// Dialog remains open from the previous test.
		const input = await browser.$('.edit-map-modal input[name="name"]');
		await input.clearValue();
		await input.setValue("Renamed Via UI");

		await browser.$(".edit-map-modal .button--primary").click();
		await browser.pause(500);

		const link = await browser.$(".map-link=Renamed Via UI");
		expect(await link.isExisting()).toBe(true);
	});

	it("delete button removes map from list", async () => {
		const entry = await browser.$('.map-list__entry*=Renamed Via UI');
		await entry.waitForExist({ timeout: 3000 });
		await entry.moveTo();
		await entry.$('[aria-label="Delete map"]').click();

		// Confirm deletion in the dialog.
		const confirmBtn = await browser.$(".edit-map-modal .button--danger");
		await confirmBtn.waitForDisplayed({ timeout: 3000 });
		await confirmBtn.click();
		await browser.pause(500);

		const link = await browser.$(".map-link=Renamed Via UI");
		expect(await link.isExisting()).toBe(false);
	});
});
