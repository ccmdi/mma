import { waitForReady, createAndOpenMap, closeMap, deleteMap } from "./helpers";

const CONTROL = ".map-type-control";
const TRIGGER = `${CONTROL} .map-control__menu-button`;
const PANEL = `${CONTROL} .settings-popup`;

async function panelOpen(): Promise<boolean> {
	return browser.$(PANEL).isExisting();
}

async function waitForPanel(open: boolean, msg: string) {
	await browser.waitUntil(async () => (await panelOpen()) === open, {
		timeout: 3000,
		timeoutMsg: msg,
	});
}

async function setPanel(open: boolean) {
	if ((await panelOpen()) === open) return;
	await browser.$(TRIGGER).click();
	await waitForPanel(open, `panel never became ${open ? "open" : "closed"}`);
}

describe("Map type control", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Map Type Control");
	});

	after(async () => {
		await setPanel(false);
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await setPanel(false);
	});

	it("does not open on hover", async () => {
		await browser.$(TRIGGER).moveTo();
		// eslint-disable-next-line no-restricted-syntax -- settle: asserting the panel never opens
		await browser.pause(500);
		expect(await panelOpen()).toBe(false);
	});

	it("opens and closes from the trigger", async () => {
		await browser.$(TRIGGER).click();
		await waitForPanel(true, "panel did not open");

		await browser.$(TRIGGER).click();
		await waitForPanel(false, "panel did not close");
	});

	it("the basemap quartet lives inside the panel", async () => {
		await setPanel(true);
		const buttons = await browser.$$(`${PANEL} ${CONTROL}__button`);
		expect(buttons).toHaveLength(4);
		expect(await browser.$$(`${PANEL} ${CONTROL}__button[data-state="on"]`)).toHaveLength(1);
	});

	it("selecting a basemap keeps the panel open", async () => {
		await setPanel(true);
		await browser.$(`${PANEL} ${CONTROL}__button[data-state="off"]`).click();
		// eslint-disable-next-line no-restricted-syntax -- settle: asserting the panel stays open
		await browser.pause(300);
		expect(await panelOpen()).toBe(true);
	});

	it("closes on Escape", async () => {
		await setPanel(true);
		await browser.keys("Escape");
		await waitForPanel(false, "Escape did not close the panel");
	});

	it("closes on an outside press", async () => {
		await setPanel(true);
		// Dismissal keys off mousedown; a synthetic one avoids picking a click target in
		// the sidebar that would fire its own handler.
		await browser.execute(() =>
			document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
		);
		await waitForPanel(false, "outside press did not close the panel");
	});
});
