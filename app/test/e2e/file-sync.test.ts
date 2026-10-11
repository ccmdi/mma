import { readFileSync, writeFileSync } from "node:fs";
import { addLocs, createLocation, getAllLocs, useMap, waitForLocCount, withApi } from "./helpers";

const SOURCE = "/tmp/e2e-file-sync.json";

const coord = (lat: number, extra: Record<string, unknown>) => ({
	lat,
	lng: 10,
	heading: 0,
	pitch: 0,
	zoom: 0,
	panoId: null,
	extra,
});

const writeSource = (coords: ReturnType<typeof coord>[]) =>
	writeFileSync(SOURCE, JSON.stringify({ name: "Upstream", customCoordinates: coords }));

const lats = async () => (await getAllLocs()).map((l) => l.lat).sort((a, b) => a - b);

describe("File sync", () => {
	const map = useMap("E2E File Sync");

	before(async () => {
		await withApi(async (api) => {
			api.setPluginEnabled("file-sync", true);
			api.activatePlugin("file-sync");
		});
	});

	it("links a map to a file, merging it with the map's own locations", async () => {
		writeSource([
			coord(1, { tags: ["Upstream"], score: 1 }),
			coord(2, { score: 2 }),
			coord(3, { score: 3 }),
		]);
		await addLocs([createLocation({ lat: 99, lng: 10 })]);

		await browser.$('button[aria-label="File sync"]').click();
		await browser.$('input[placeholder="Path or URL of a map file"]').setValue(SOURCE);
		await browser.$("button=Link").click();
		await browser.$("button=Merge · keep everything on both sides").click();

		await waitForLocCount(4);
		expect(await lats()).toEqual([1, 2, 3, 99]);
		const first = (await getAllLocs()).find((l) => l.lat === 1)!;
		expect(first.extra).toMatchObject({ score: 1 });
		const tagNames = await withApi(async (api, ids: number[]) => {
			const tags = api.Tag.all();
			return ids.map((id) => tags[id]?.name);
		}, first.tags);
		expect(tagNames).toEqual(["Upstream"]);
	});

	it("follows a regenerated file and keeps the map's own locations", async () => {
		const regenerated = [coord(10, { score: 10 }), coord(11, { score: 11 })];
		writeSource(regenerated);

		await browser.$("button=Sync now").click();

		await waitForLocCount(3);
		expect(await lats()).toEqual([10, 11, 99]);
		const written = JSON.parse(readFileSync(SOURCE, "utf8")) as { customCoordinates: unknown[] };
		expect(written.customCoordinates).toEqual(regenerated);
	});

	it("keeps a history of its passes, newest first", async () => {
		const passes = () => withApi(async (api, id) => api.cmd.syncLogList("file", id), map.id);
		await browser.waitUntil(async () => (await passes()).length >= 2, {
			timeoutMsg: "the link and the sync were never recorded",
		});
		// Linking turns live sync on, which runs a pass of its own between these two.
		const all = await passes();
		expect(all[0].trigger).toBe("manual");
		expect(all.at(-1)!.trigger).toBe("link");
		expect(all[0].result).toMatchObject({ kind: "ok", pulled: { create: 2, delete: 3 } });
		expect(all.every((p) => p.result.kind === "ok")).toBe(true);
	});
});
