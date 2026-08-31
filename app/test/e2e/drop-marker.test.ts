/**
 * Drop marker (issue #76).
 *
 * `c` and a map's copy-to-map binding both save the *live* viewer -- the pano you
 * navigated to -- as a new location, leaving the open one untouched and still open.
 * The old behavior cloned the stored row, so walking around and pressing `c`
 * repeatedly stacked identical copies at the spawn point.
 *
 * panoId is the observable: `]` (next date) points the viewer at another capture
 * without writing that pano back to the location (handleDateChange only patches the
 * LoadAsPanoId flag), so source-stored and viewer-live disagree by construction.
 * The flag is NOT a usable sync point -- opening a location with a panoId sets it on
 * its own -- so the date picker's own label is what the step waits on.
 */
import {
	addLocs,
	closeLocation,
	closeMap,
	createAndOpenMap,
	createLocation,
	createTag,
	deleteMap,
	flushAndWait,
	getAllLocs,
	getLoc,
	getLocCount,
	openLocation,
	openMap,
	updateMapSettings,
	useMap,
	waitForActive,
	waitForLocCount,
	waitForPreview,
	waitForReady,
} from "./helpers";
import type { Location } from "@/bindings.gen";
import { LocationFlag } from "@/bindings.consts";

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };

const srcLoc = (over: Partial<Location> = {}) =>
	createLocation({
		lat: OFFICIAL_COORDS.lat,
		lng: OFFICIAL_COORDS.lng,
		panoId: OFFICIAL_PANO,
		flags: LocationFlag.None,
		tags: [],
		...over,
	});

const shownDate = () => browser.$(".pano-value").getText();

/** Point the viewer at a different capture of the open pano. */
async function stepToOtherPano() {
	// More than one capture must have loaded, or `]` cycles a one-element list.
	await browser.waitUntil(
		async () => {
			const badge = await browser.$(".location-preview__date .badge--number");
			return (await badge.isExisting()) && parseInt(await badge.getText()) > 1;
		},
		{ timeout: 30_000, timeoutMsg: "pano never reported multiple captures" },
	);
	const before = await shownDate();
	await browser.keys("]");
	await browser.waitUntil(async () => (await shownDate()) !== before, {
		timeout: 5000,
		timeoutMsg: "date picker never moved off the seeded capture",
	});
}

/** The location a drop just added. The map accumulates across tests in a describe, so
 *  "not the source" is not enough to name it -- only "not there a moment ago" is. */
async function dropAfter(before: number[], act: () => Promise<void>): Promise<Location> {
	const seen = new Set(before);
	await act();
	await waitForLocCount(before.length + 1);
	const added = (await getAllLocs()).filter((l) => !seen.has(l.id));
	expect(added).toHaveLength(1);
	return added[0];
}

const locIds = async () => (await getAllLocs()).map((l) => l.id);

describe("Drop marker -- 'c' in the location editor", () => {
	useMap("E2E Drop Marker", { closeLocation: true });
	let srcId: number;

	beforeEach(async () => {
		// A fresh source per test: `]` permanently sets LoadAsPanoId, which the next
		// test needs to still be unset for its sync point.
		srcId = (await addLocs([srcLoc()]))[0];
		await openLocation(srcId);
		await waitForPreview();
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("adds a location without closing the one being edited", async () => {
		const before = await getLocCount();

		await browser.keys("c");
		await waitForLocCount(before + 1);

		// The dropped location does not become active.
		await waitForActive(srcId);
	});

	it("captures the pano the viewer moved to, not the source's stored pano", async () => {
		const before = await locIds();

		const drop = await dropAfter(before, async () => {
			await stepToOtherPano();
			await browser.keys("c");
		});

		expect(drop.panoId).not.toBe(OFFICIAL_PANO);
		expect(drop.panoId).toContain(OFFICIAL_PANO); // another capture of the same pano
	});

	it("leaves the source location untouched", async () => {
		const before = await getLoc(srcId);

		await dropAfter(await locIds(), async () => {
			await stepToOtherPano();
			await browser.keys("c");
		});

		const after = await getLoc(srcId);
		expect(after.panoId).toBe(before.panoId);
		expect(after.lat).toBe(before.lat);
		expect(after.lng).toBe(before.lng);
	});
});

describe("Drop marker -- staged tags", () => {
	useMap("E2E Drop Marker Tags", { closeLocation: true });
	let srcId: number;
	let tagId: number;

	before(async () => {
		tagId = (await createTag("dropped")).id;
		srcId = (await addLocs([srcLoc()]))[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("carries tags staged in the editor that the source has not saved", async () => {
		await openLocation(srcId);
		await waitForPreview();
		const drop = await dropAfter(await locIds(), async () => {
			await browser.keys("1"); // quicktag slot 1 -> stages the first visible tag
			await browser.keys("c");
		});

		expect(drop.tags).toEqual([tagId]);
		// Staged, not saved: the source keeps the tags it had on disk.
		expect((await getLoc(srcId)).tags).toEqual([]);
	});
});

describe("Drop marker -- copy to another map", () => {
	let targetId = "";
	let sourceId = "";
	let srcId: number;

	before(async () => {
		await waitForReady();
		// Target stays closed, so the copy takes Rust's delta-sidecar branch.
		targetId = await createAndOpenMap("E2E Drop Marker Target");
		await flushAndWait();
		await closeMap();

		sourceId = await createAndOpenMap("E2E Drop Marker Source");
		srcId = (await addLocs([srcLoc()]))[0];
		await updateMapSettings({
			keyBindings: [{ key: "k", action: { type: "copyToMap", mapId: targetId } }],
		});
	});

	after(async () => {
		await closeMap();
		await deleteMap(sourceId);
		await deleteMap(targetId);
	});

	it("sends the live view to the other map", async () => {
		await openLocation(srcId);
		await waitForPreview();

		await stepToOtherPano();
		await browser.keys("k");
		await browser.waitUntil(
			async () => browser.execute(() => document.body.textContent?.includes("Copied to") === true),
			{ timeout: 15000, timeoutMsg: "copy-to-map toast never appeared" },
		);

		await closeLocation();
		await closeMap();
		await openMap(targetId);

		const copied = await getAllLocs();
		expect(copied).toHaveLength(1);
		expect(copied[0].panoId).not.toBe(OFFICIAL_PANO);
		expect(copied[0].panoId).toContain(OFFICIAL_PANO);

		await closeMap();
		await openMap(sourceId);
	});
});
