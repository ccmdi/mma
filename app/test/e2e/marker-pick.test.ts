/**
 * Picking a drawn marker under real pointer input: hovering it shows the pointer cursor, and a
 * click opens the location that marker draws. Every gesture goes through WebDriver actions, so
 * deck.gl's own picking decides what is under the pointer.
 */
import { useMap, withApi, addLocs, makeLocs, waitForActive } from "./helpers";

type Px = [number, number];

const mapCenter = () =>
	withApi((api) => {
		const r = api.MapHost.get()!.container.getBoundingClientRect();
		return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] as Px;
	});

const latLngAt = ([x, y]: Px) =>
	withApi(
		(api, px, py) => {
			const host = api.MapHost.get()!;
			const r = host.container.getBoundingClientRect();
			return host.containerPxToLatLng(px - r.left, py - r.top)!;
		},
		x,
		y,
	);

async function pointer(...actions: object[]) {
	await browser.performActions([
		{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions },
	]);
	await browser.releaseActions();
}

const move = ([x, y]: Px) => ({ type: "pointerMove", origin: "viewport", x, y, duration: 0 });

const cursorAt = ([x, y]: Px) =>
	browser.execute(
		(px, py) => (document.elementFromPoint(px, py) as HTMLElement | null)?.style.cursor ?? "",
		x,
		y,
	);

describe("Marker pick", () => {
	useMap("E2E MarkerPick", { closeLocation: true });

	it("hovering a marker shows the pointer and a click opens that location promptly", async () => {
		const center = await mapCenter();
		const at = await latLngAt(center);
		const [id] = await addLocs(makeLocs(1, () => at));

		await browser.waitUntil(
			async () => {
				await pointer(move([center[0] + 40, center[1] + 40]), move(center));
				return (await cursorAt(center)) === "pointer";
			},
			{ interval: 500, timeoutMsg: "hovering the marker never showed the pointer cursor" },
		);

		const clicked = Date.now();
		await pointer(
			move(center),
			{ type: "pointerDown", button: 0 },
			{ type: "pointerUp", button: 0 },
		);
		await waitForActive(id);
		expect(Date.now() - clicked).toBeLessThan(2000);
	});
});
