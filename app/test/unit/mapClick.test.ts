// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PickingInfo } from "@deck.gl/core";
import type { CellManager } from "@/lib/render/CellManager";

const storeResolvePick = vi.fn();
const storeFindNearby = vi.fn();
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeResolvePick: (...a: unknown[]) => storeResolvePick(...a),
		storeFindNearby: (...a: unknown[]) => storeFindNearby(...a),
	},
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@/lib/data/importExport", async (orig) => ({
	...(await orig()),
	parseMapsUrl: vi.fn(),
}));
vi.mock("@/store/useMapStore", async (orig) => ({
	...(await orig()),
	setActiveLocation: vi.fn(),
	addLocations: vi.fn(),
	createTags: vi.fn(async () => []),
}));
vi.mock("@/store/settings", async (orig) => ({
	...(await orig()),
	getSettings: () => ({ panToImported: false }),
}));

import { resolvePickedId, openHref } from "@/lib/map/mapClick";

const pick = (id: string | undefined, index: number): PickingInfo =>
	({ index, layer: id == null ? null : { id } }) as unknown as PickingInfo;

const fakeCm = (over: Partial<CellManager>): CellManager =>
	({
		overlay: { ids: new Uint32Array(0) },
		resolvePickFromCell: () => null,
		...over,
	}) as unknown as CellManager;

beforeEach(() => storeResolvePick.mockReset());

describe("resolvePickedId (shared pick resolution)", () => {
	it("returns null for a non-pick (negative index)", async () => {
		expect(await resolvePickedId(fakeCm({}), pick("cell:abc", -1))).toBeNull();
	});

	it("reads a selection-overlay pick from the overlay ids", async () => {
		const cm = fakeCm({
			overlay: { ids: new Uint32Array([10, 20, 30]) } as CellManager["overlay"],
		});
		expect(await resolvePickedId(cm, pick("sel-overlay", 1))).toBe(20);
	});

	it("resolves a cell pick locally without hitting Rust", async () => {
		const cm = fakeCm({ resolvePickFromCell: (key, i) => (key === "abc" && i === 2 ? 99 : null) });
		expect(await resolvePickedId(cm, pick("cell:abc", 2))).toBe(99);
		expect(storeResolvePick).not.toHaveBeenCalled();
	});

	it("falls back to Rust when the cell is not materialized in JS", async () => {
		storeResolvePick.mockResolvedValue(777);
		const cm = fakeCm({ resolvePickFromCell: () => null });
		expect(await resolvePickedId(cm, pick("cell:xyz", 5))).toBe(777);
		expect(storeResolvePick).toHaveBeenCalledWith("xyz", 5);
	});

	it("returns null for an unrelated layer", async () => {
		expect(await resolvePickedId(fakeCm({}), pick("import-preview", 0))).toBeNull();
	});
});

describe("openHref (map-aware link opening)", () => {
	const HREF = "https://www.google.com/maps/@1,2,3z";
	const parsed = {
		lat: 10,
		lng: 20,
		panoId: "PANO_A",
		heading: 0,
		pitch: 0,
		zoom: 0,
		flags: 0,
		tags: [],
	};
	const loc = (id: number, panoId: string) => ({ id, lat: 10, lng: 20, panoId });

	let openExternal: ReturnType<typeof vi.fn>;
	let setActive: ReturnType<typeof vi.fn>;
	let addLocs: ReturnType<typeof vi.fn>;
	let parseUrl: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		openExternal = vi.mocked((await import("@tauri-apps/plugin-shell")).open);
		setActive = vi.mocked((await import("@/store/useMapStore")).setActiveLocation);
		addLocs = vi.mocked((await import("@/store/useMapStore")).addLocations);
		parseUrl = vi.mocked((await import("@/lib/data/importExport")).parseMapsUrl);
		parseUrl.mockResolvedValue(parsed);
		storeFindNearby.mockReset();
	});

	it("opens non-location hrefs externally", async () => {
		parseUrl.mockResolvedValue(null);
		await openHref("https://example.com/page");
		expect(openExternal).toHaveBeenCalledWith("https://example.com/page");
		expect(storeFindNearby).not.toHaveBeenCalled();
		expect(addLocs).not.toHaveBeenCalled();
	});

	it("prefers the same-pano location over a nearer one", async () => {
		const nearest = loc(1, "OTHER");
		const samePano = loc(2, "PANO_A");
		storeFindNearby.mockResolvedValue([nearest, samePano]);
		await openHref(HREF);
		expect(setActive).toHaveBeenCalledWith(samePano);
		expect(addLocs).not.toHaveBeenCalled();
	});

	it("falls back to the nearest location when no pano matches", async () => {
		const nearest = loc(1, "OTHER");
		storeFindNearby.mockResolvedValue([nearest, loc(2, "ALSO_OTHER")]);
		await openHref(HREF);
		expect(setActive).toHaveBeenCalledWith(nearest);
		expect(addLocs).not.toHaveBeenCalled();
	});

	it("adds the location when nothing is within the duplicate radius", async () => {
		storeFindNearby.mockResolvedValue([]);
		await openHref(HREF);
		expect(storeFindNearby).toHaveBeenCalledWith(parsed.lat, parsed.lng, 2.0);
		expect(openExternal).not.toHaveBeenCalled();
		expect(addLocs).toHaveBeenCalledWith([
			expect.objectContaining({ lat: 10, lng: 20, panoId: "PANO_A" }),
		]);
	});
});
