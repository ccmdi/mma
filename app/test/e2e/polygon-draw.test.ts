/**
 * The click-vertex polygon tool under real pointer input: presses the map takes as a pan, the
 * browser's double-click counting, and double-clicks that land before a shape has three corners.
 * Every gesture goes through WebDriver actions, so the map engine decides what is a click.
 */
import { useMap, withApi } from "./helpers";

const TOOL = 'button[aria-label="Draw a polygon selection"]';
// Longer than any platform's double-click interval, so separate clicks stay separate.
const APART = 700;

type Px = [number, number];

async function mapCenter(): Promise<Px> {
	return withApi((api) => {
		const r = api.getMapHost()!.container.getBoundingClientRect();
		return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] as Px;
	});
}

type LL = { lat: number; lng: number };

/** The map position under a viewport pixel. */
const latLngAt = ([x, y]: Px) =>
	withApi(
		(api, px, py) => {
			const host = api.getMapHost()!;
			const r = host.container.getBoundingClientRect();
			return host.containerPxToLatLng(px - r.left, py - r.top)!;
		},
		x,
		y,
	);

/** The viewport pixel a map position sits at now, after any pan. Linear in the small, near-equator
 *  view `armTool` sets up. */
const pixelOf = (ll: LL) =>
	withApi(
		(api, lat, lng) => {
			const host = api.getMapHost()!;
			const r = host.container.getBoundingClientRect();
			const a = host.containerPxToLatLng(0, 0)!;
			const b = host.containerPxToLatLng(r.width, r.height)!;
			return [
				Math.round(r.left + ((lng - a.lng) / (b.lng - a.lng)) * r.width),
				Math.round(r.top + ((lat - a.lat) / (b.lat - a.lat)) * r.height),
			] as Px;
		},
		ll.lat,
		ll.lng,
	);

const move = ([x, y]: Px, duration = 0) => ({
	type: "pointerMove",
	origin: "viewport",
	x,
	y,
	duration,
});
const down = { type: "pointerDown", button: 0 };
const up = { type: "pointerUp", button: 0 };
const pause = (duration: number) => ({ type: "pause", duration });

async function pointer(...actions: object[]) {
	await browser.performActions([
		{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions },
	]);
	await browser.releaseActions();
}

const click = (p: Px) => [move(p), down, up, pause(APART)];
const doubleClick = (p: Px) => [move(p), down, up, pause(60), down, up, pause(APART)];
// A press that travels far enough for the map to take it as a pan and drop its click.
const nudge = (p: Px) => [move(p), down, move([p[0] + 12, p[1] + 6], 80), up];

const polygonVertexCounts = () =>
	withApi((api) =>
		api.Store.get().selectionList.flatMap(({ selection: { selector } }) =>
			selector.type === "Polygon" ? [selector.polygon.coordinates[0].length] : [],
		),
	);

const toolArmed = () =>
	browser
		.$(TOOL)
		.getAttribute("class")
		.then((c) => c?.includes("is-active") === true);

async function armTool() {
	await withApi((api) => {
		api.getMapHost()!.moveCamera({ center: { lat: 0.5, lng: 10 }, zoom: 13 });
		return api.SelectionList.update({ kind: "set", selections: [] });
	});
	if (await toolArmed()) await browser.$(TOOL).click();
	await browser.$(TOOL).click();
	await browser.waitUntil(toolArmed, { timeoutMsg: "polygon tool never armed" });
}

describe("Polygon tool", () => {
	useMap("E2E Polygon Draw");

	it("stays open when a dropped press and the next click make a browser double-click", async () => {
		await armTool();
		const [cx, cy] = await mapCenter();
		const first = await latLngAt([cx - 120, cy - 80]);
		await pointer(
			...click([cx - 120, cy - 80]),
			...click([cx + 120, cy - 80]),
			...click([cx + 120, cy + 80]),
			...nudge([cx - 120, cy + 80]),
			...click([cx - 120, cy + 80]),
		);
		expect(await toolArmed()).toBe(true);
		expect(await polygonVertexCounts()).toEqual([]);

		await pointer(...click(await pixelOf(first)));
		await browser.waitUntil(async () => (await polygonVertexCounts()).length === 1, {
			timeoutMsg: "closing on the first vertex never added the polygon",
		});
		expect(await polygonVertexCounts()).toEqual([5]);
		expect(await toolArmed()).toBe(false);
	});

	it("closes on a double-click, keeping the vertex it placed", async () => {
		await armTool();
		const [cx, cy] = await mapCenter();
		await pointer(
			...click([cx - 100, cy - 60]),
			...click([cx + 100, cy - 60]),
			...click([cx + 100, cy + 60]),
			...doubleClick([cx - 100, cy + 60]),
		);
		await browser.waitUntil(async () => (await polygonVertexCounts()).length === 1, {
			timeoutMsg: "double-click never closed the polygon",
		});
		expect(await polygonVertexCounts()).toEqual([5]);
		expect(await toolArmed()).toBe(false);
	});

	it("keeps drawing through a double-click before there are three vertices", async () => {
		await armTool();
		const [cx, cy] = await mapCenter();
		await pointer(...click([cx - 100, cy - 60]), ...doubleClick([cx + 100, cy - 60]));
		expect(await toolArmed()).toBe(true);
		expect(await polygonVertexCounts()).toEqual([]);

		await pointer(...click([cx, cy + 80]), ...click([cx - 100, cy - 60]));
		await browser.waitUntil(async () => (await polygonVertexCounts()).length === 1, {
			timeoutMsg: "the triangle never closed",
		});
		expect(await polygonVertexCounts()).toEqual([4]);
	});

	it("survives a burst of nudges, clicks and double-clicks and still closes cleanly", async () => {
		await armTool();
		const [cx, cy] = await mapCenter();
		await pointer(
			...click([cx - 150, cy - 100]),
			...nudge([cx - 50, cy - 100]),
			...nudge([cx - 50, cy - 100]),
			...click([cx + 150, cy - 100]),
			...nudge([cx + 150, cy + 100]),
			...click([cx + 150, cy + 100]),
			...nudge([cx, cy + 120]),
			...doubleClick([cx - 150, cy + 100]),
		);
		await browser.waitUntil(async () => (await polygonVertexCounts()).length === 1, {
			timeoutMsg: "the shape never closed",
		});
		expect(await polygonVertexCounts()).toEqual([5]);
		expect(await toolArmed()).toBe(false);
	});
});
