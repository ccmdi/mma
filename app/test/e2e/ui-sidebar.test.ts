import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	getLocCount,
	createTag,
	withApi,
} from "./helpers";

describe("UI: Tag manager", () => {
	let mapId: string;
	let uiTag1Id: number;
	let uiTag2Id: number;
	let uiTag3Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("UI Tags Test");
		await browser.$(".page-map-editor").waitForDisplayed({ timeout: 5000 });

		// Create tags via resolveTagNames + addTag
		const tag1 = await createTag("Mountains");
		uiTag1Id = tag1.id;
		const tag2 = await createTag("Coastal");
		uiTag2Id = tag2.id;
		const tag3 = await createTag("Urban");
		uiTag3Id = tag3.id;

		await withApi(
			async (api, t1, t2, t3) => {
			},
			uiTag1Id,
			uiTag2Id,
			uiTag3Id,
		);

		// Seed some locations with tags
		const locs = [];
		for (let i = 0; i < 20; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					tags: i < 8 ? [uiTag1Id] : i < 14 ? [uiTag2Id] : [uiTag3Id],
				}),
			);
		}
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("tag manager section is visible", async () => {
		const tagManager = await browser.$(".tag-manager");
		expect(await tagManager.isDisplayed()).toBe(true);
	});

	it("displays all tags", async () => {
		const tags = await browser.$$(".tag-list .tag");
		// At least our 3 tags
		expect(tags.length).toBeGreaterThanOrEqual(3);
	});

	it("tags show correct names", async () => {
		const tagTexts: string[] = [];
		const tags = await browser.$$(".tag-list .tag");
		for (const tag of tags) {
			const text = await tag.$(".tag__text");
			tagTexts.push(await text.getText());
		}
		expect(tagTexts.some((t) => t.includes("Mountains"))).toBe(true);
		expect(tagTexts.some((t) => t.includes("Coastal"))).toBe(true);
		expect(tagTexts.some((t) => t.includes("Urban"))).toBe(true);
	});

	it("clicking a tag creates a selection", async () => {
		const tags = await browser.$$(".tag-list .tag");
		for (const tag of tags) {
			const text = await tag.$(".tag__text");
			if ((await text.getText()).includes("Mountains")) {
				await tag.click();
				break;
			}
		}

		await browser.pause(300);
		const selCount = await withApi(async (api) => api.getSelections().length);
		expect(selCount).toBeGreaterThanOrEqual(1);
	});

	it("selection appears in selection manager", async () => {
		const rows = await browser.$$(".selection-row");
		expect(rows.length).toBeGreaterThanOrEqual(1);
	});

	it("filter input filters tags", async () => {
		const input = await browser.$(".tag-manager .input");
		await input.setValue("Coast");

		await browser.pause(300);
		const visibleTags = await browser.$$(".tag-list .tag");
		// Should show only Coastal
		let coastalFound = false;
		for (const tag of visibleTags) {
			if (!(await tag.isDisplayed())) continue;
			const textEl = await tag.$(".tag__text");
			const text = await textEl.getText();
			if (text.includes("Coastal")) coastalFound = true;
		}
		expect(coastalFound).toBe(true);

		// Clear filter
		await input.clearValue();
		await browser.pause(100);
	});

	it("tag edit button opens edit dialog", async () => {
		const tags = await browser.$$(".tag-list .tag");
		for (const tag of tags) {
			const text = await tag.$(".tag__text");
			if ((await text.getText()).includes("Urban")) {
				const editBtn = await tag.$(".tag__button--edit");
				await editBtn.click();
				break;
			}
		}

		const dialog = await browser.$(".edit-tag-modal");
		await dialog.waitForDisplayed({ timeout: 3000 });
		expect(await dialog.isDisplayed()).toBe(true);
	});

	it("edit dialog has tag name and color inputs", async () => {
		const nameInput = await browser.$(".edit-tag-modal .input");
		expect(await nameInput.isDisplayed()).toBe(true);
		const val = await nameInput.getValue();
		expect(val).toBe("Urban");

		// Close dialog
		const saveBtn = await browser.$('[data-qa="tag-save"]');
		await saveBtn.click();
		await browser.pause(300);
	});
});

describe("UI: Selection manager", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("UI Selections Test");
		await browser.$(".page-map-editor").waitForDisplayed({ timeout: 5000 });

		const locs = [];
		for (let i = 0; i < 50; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					panoId: i < 20 ? `p${i}` : null,
					flags: i < 10 ? 1 : 0,
				}),
			);
		}
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("selection manager shows selected count", async () => {
		await withApi(async (api) => api.selectEverything());
		await browser.pause(300);

		const selMgr = await browser.$(".selection-manager");
		const text = await selMgr.getText();
		expect(text).toContain("50");
	});

	it("selection rows appear for each selection", async () => {
		await withApi(async (api) => api.selectPanoIds());
		await browser.pause(300);

		const rows = await browser.$$(".selection-row");
		expect(rows.length).toBeGreaterThanOrEqual(2);
	});

	it("selection row shows location count", async () => {
		const rows = await browser.$$(".selection-row");
		let foundCount = false;
		for (const row of rows) {
			const sizeEl = await row.$(".selection-row__size");
			if (sizeEl) {
				const text = await sizeEl.getText().catch(() => "");
				if (text.includes("10")) {
					foundCount = true;
					break;
				}
			}
		}
		expect(foundCount).toBe(true);
	});

	it("deselect all button clears selections", async () => {
		const buttons = await browser.$$(".selection-manager .button");
		for (const btn of buttons) {
			const text = await btn.getText();
			if (text.match(/deselect all/i)) {
				await btn.click();
				break;
			}
		}

		await browser.pause(300);
		const count = await withApi(async (api) => api.getSelections().length);
		expect(count).toBe(0);
	});

	it("review button starts review mode", async () => {
		// Need a selection first
		await withApi(async (api) => api.selectEverything());
		await browser.pause(300);

		const reviewBtn = await browser.$('[data-qa="selection-review"]');
		await reviewBtn.click();

		await browser.pause(500);

		const workArea = await withApi(async (api) => api.getWorkArea());
		expect(workArea).toBe("location");
	});

	it("review header shows location count", async () => {
		const header = await browser.$(".review-header");
		await header.waitForDisplayed({ timeout: 3000 });
		const text = await header.getText();
		expect(text).toMatch(/reviewing/i);
	});

	it("review next button advances", async () => {
		const firstId = await withApi(async (api) => api.getActiveLocation()?.id);

		const nextBtn = await browser.$('[data-qa="review-next"]');
		await nextBtn.click();
		await browser.pause(200);

		const secondId = await withApi(async (api) => api.getActiveLocation()?.id);
		expect(secondId).not.toBe(firstId);
	});

	it("review prev button goes back", async () => {
		const currentId = await withApi(async (api) => api.getActiveLocation()?.id);

		const prevBtn = await browser.$('[data-qa="review-prev"]');
		await prevBtn.click();
		await browser.pause(200);

		const prevId = await withApi(async (api) => api.getActiveLocation()?.id);
		expect(prevId).not.toBe(currentId);
	});

	it("abort review returns to overview", async () => {
		const cancelBtn = await browser.$('[data-qa="review-cancel"]');
		await cancelBtn.click();
		await browser.pause(300);

		const workArea = await withApi(async (api) => api.getWorkArea());
		expect(workArea).toBe("overview");
	});
});

describe("UI: Location editor", () => {
	let mapId: string;
	let leTagId: number;
	let le1Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("UI Location Editor");
		await browser.$(".page-map-editor").waitForDisplayed({ timeout: 5000 });

		const tag = await createTag("TestTag");
		leTagId = tag.id;
		await withApi(async (api, tagId) => {
		}, leTagId);

		const ids = await addLocs([
			createLocation({ lat: 48.8566, lng: 2.3522, heading: 90, pitch: 5, zoom: 2 }),
		]);
		le1Id = ids[0];
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("setActiveLocation shows location preview panel", async () => {
		await withApi(async (api, id) => api.setActiveLocation(id), le1Id);

		const panel = await browser.$(".location-preview");
		await panel.waitForDisplayed({ timeout: 3000 });
		expect(await panel.isDisplayed()).toBe(true);
	});

	it("location preview has panorama area", async () => {
		const pano = await browser.$(".location-preview__panorama");
		expect(await pano.isDisplayed()).toBe(true);
	});

	it("location preview has meta section", async () => {
		const meta = await browser.$(".location-preview__meta");
		expect(await meta.isDisplayed()).toBe(true);
	});

	it("location preview has delete button", async () => {
		const deleteBtn = await browser.$('[data-qa="location-delete"]');
		expect(await deleteBtn.isDisplayed()).toBe(true);
	});

	it("location preview has close button", async () => {
		const closeBtn = await browser.$('[data-qa="location-close"]');
		expect(await closeBtn.isDisplayed()).toBe(true);
	});

	it("close button returns to overview", async () => {
		const closeBtn = await browser.$('[data-qa="location-close"]');
		await closeBtn.click();
		await browser.pause(300);

		const workArea = await withApi(async (api) => api.getWorkArea());
		expect(workArea).toBe("overview");
	});

	it("delete button removes location", async () => {
		// Reopen location
		await withApi(async (api, id) => api.setActiveLocation(id), le1Id);
		await browser.$(".location-preview").waitForDisplayed({ timeout: 3000 });

		const deleteBtn = await browser.$('[data-qa="location-delete"]');
		await deleteBtn.click();
		await browser.pause(300);

		const count = await getLocCount();
		expect(count).toBe(0);

		const workArea = await withApi(async (api) => api.getWorkArea());
		expect(workArea).toBe("overview");
	});

	it("undo restores deleted location", async () => {
		await withApi(async (api) => api.undo());
		const count = await getLocCount();
		expect(count).toBe(1);
	});
});
