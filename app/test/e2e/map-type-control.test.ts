import { waitForReady, createAndOpenMap, closeMap, deleteMap } from "./helpers";

const CONTROL = ".map-type-control";
const TRIGGER = `${CONTROL} .map-control__menu-button`;
const PANEL = `${CONTROL} .settings-popup`;

async function panelOpen(): Promise<boolean> {
	return browser.$(PANEL).isExisting();
}

async function waitForPanel(open: boolean, msg: string) {
	await browser.waitUntil(async () => (await panelOpen()) === open, {
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
		// The trigger toggles, so a panel the hover had opened would close on this click.
		await browser.$(TRIGGER).click();
		await waitForPanel(true, "the click closed a panel the hover had opened");
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
		const buttons = `${PANEL} ${CONTROL}__button`;
		const index = await browser.execute(
			(sel: string) =>
				[...document.querySelectorAll(sel)].findIndex(
					(b) => b.getAttribute("data-state") === "off",
				),
			buttons,
		);
		await (await browser.$$(buttons))[index].click();
		await browser.waitUntil(
			async () => (await (await browser.$$(buttons))[index]?.getAttribute("data-state")) === "on",
			{ timeoutMsg: "the basemap never became selected with the panel open" },
		);
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
