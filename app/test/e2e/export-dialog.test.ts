import { closeMap, openMap, withApi, useMap } from "./helpers";

async function openExportDialog() {
	await browser.$("button=Export").click();
	await browser.$(".export-modal").waitForExist({ timeout: 5000 });
}

async function closeExportDialog() {
	await browser.keys("Escape");
	await browser.waitUntil(async () => !(await browser.$(".export-modal").isExisting()), {
		timeout: 5000,
		timeoutMsg: "export dialog never closed",
	});
}

async function checkboxStates() {
	return {
		zoom: await browser.$('.export-modal input[name="zoom"]').isSelected(),
		extras: await browser.$('.export-modal input[name="extras"]').isSelected(),
		unpanned: await browser.$('.export-modal input[name="unpanned"]').isSelected(),
	};
}

describe("Export dialog settings persistence", () => {
	const map = useMap("E2E Export Dialog");

	it("shows defaults on first open", async () => {
		await openExportDialog();
		expect(await checkboxStates()).toEqual({ zoom: false, extras: true, unpanned: true });
		await closeExportDialog();
	});

	it("remembers toggles across dialog reopen without exporting", async () => {
		await openExportDialog();
		await browser.$('.export-modal input[name="zoom"]').click();
		await browser.$('.export-modal input[name="extras"]').click();
		await browser.$('.export-modal input[name="unpanned"]').click();
		await closeExportDialog();

		await openExportDialog();
		expect(await checkboxStates()).toEqual({ zoom: true, extras: false, unpanned: false });
		await closeExportDialog();

		const settings = await withApi(async (api) => api.getMapState().map!.settings);
		expect(settings.exportZoom).toBe(true);
		expect(settings.exportExtras).toBe(false);
		expect(settings.exportUnpanned).toBe(false);
	});

	it("remembers toggles across map close and reopen", async () => {
		await closeMap();
		await openMap(map.id);
		await openExportDialog();
		expect(await checkboxStates()).toEqual({ zoom: true, extras: false, unpanned: false });
		await closeExportDialog();
	});
});
