// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PickingInfo } from "@deck.gl/core";
import type { CellManager } from "@/lib/render/CellManager";

const storeFindNearby = vi.fn();
const parseMapsUrl = vi.fn();
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeRead: (...a: unknown[]) =>
			(storeFindNearby(...a.slice(1)) as Promise<unknown[]>).then((locations) => ({
				kind: "locations",
				locations: { kind: "inline", locations },
			})),
		parseMapsUrl: (...a: unknown[]) => parseMapsUrl(...a),
	},
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@/store/location", async (orig) => ({
	Location: {
		...(await orig<typeof import("@/store/location")>()).Location,
		add: vi.fn(async () => [7]),
	},
}));
vi.mock("@/store/editor", async (orig) => ({
	Editor: {
		...(await orig<typeof import("@/store/editor")>()).Editor,
		open: vi.fn(),
	},
}));

vi.mock("@/store/settings", async (orig) => ({
	...(await orig()),
	getSettings: () => ({ panToImported: false }),
}));
import { resolvePickedId, openHref, handleMapClick } from "@/lib/map/mapClick";
import { MapHost } from "@/lib/map/host";

const pick = (id: string | undefined, index: number): PickingInfo =>
	({ index, layer: id == null ? null : { id } }) as unknown as PickingInfo;

const fakeCm = (over: Partial<CellManager>): CellManager =>
	({
		overlay: { ids: new Uint32Array(0) },
		resolvePickFromCell: () => null,
		...over,
	}) as unknown as CellManager;

describe("resolvePickedId (shared pick resolution)", () => {
	it("returns null for a non-pick (negative index)", () => {
		expect(resolvePickedId(fakeCm({}), pick("cell:abc", -1))).toBeNull();
	});

	it("reads a selection-overlay pick from the overlay ids", () => {
		const cm = fakeCm({
			overlay: { ids: new Uint32Array([10, 20, 30]) } as CellManager["overlay"],
		});
		expect(resolvePickedId(cm, pick("sel-overlay", 1))).toBe(20);
	});

	it("resolves a cell pick from the cell it was drawn from", () => {
		const cm = fakeCm({ resolvePickFromCell: (key, i) => (key === "abc" && i === 2 ? 99 : null) });
		expect(resolvePickedId(cm, pick("cell:abc", 2))).toBe(99);
	});

	it("a pick past the end of a cell that has since shrunk resolves to nothing", () => {
		const cm = fakeCm({ resolvePickFromCell: () => null });
		expect(resolvePickedId(cm, pick("cell:abc", 5))).toBeNull();
	});

	it("returns null for an unrelated layer", () => {
		expect(resolvePickedId(fakeCm({}), pick("import-preview", 0))).toBeNull();
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
	let open: ReturnType<typeof vi.fn>;
	let addLocs: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		openExternal = vi.mocked((await import("@tauri-apps/plugin-shell")).open);
		open = vi.mocked((await import("@/store/editor")).Editor.open);
		addLocs = vi.mocked((await import("@/store/location")).Location.add);
		parseMapsUrl.mockResolvedValue(parsed);
		storeFindNearby.mockReset();
	});

	it("opens non-location hrefs externally", async () => {
		parseMapsUrl.mockResolvedValue(null);
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
		expect(open).toHaveBeenCalledWith(samePano);
		expect(addLocs).not.toHaveBeenCalled();
	});

	it("falls back to the nearest location when no pano matches", async () => {
		const nearest = loc(1, "OTHER");
		storeFindNearby.mockResolvedValue([nearest, loc(2, "ALSO_OTHER")]);
		await openHref(HREF);
		expect(open).toHaveBeenCalledWith(nearest);
		expect(addLocs).not.toHaveBeenCalled();
	});

	it("adds the location when nothing is within the duplicate radius", async () => {
		storeFindNearby.mockResolvedValue([]);
		await openHref(HREF);
		expect(storeFindNearby).toHaveBeenCalledWith(
			{ type: "Nearby", selection: null, lat: parsed.lat, lng: parsed.lng, radiusM: 2.0 },
			{ kind: "locations" },
		);
		expect(openExternal).not.toHaveBeenCalled();
		expect(addLocs).toHaveBeenCalledWith([
			expect.objectContaining({ lat: 10, lng: 20, panoId: "PANO_A" }),
		]);
		expect(open).toHaveBeenCalledWith(7);
	});
});

describe("handleMapClick", () => {
	const at = { coordinate: [2, 1] } as unknown as PickingInfo;
	const ctx = {
		cm: fakeCm({}),
		host: null,
		clickMode: "add",
		measuring: false,
	} as unknown as Parameters<typeof handleMapClick>[2];
	const intercepted = async (domEvent: Event) => {
		const seen: [number, number][] = [];
		const off = MapHost.addClickInterceptor((lat, lng) => seen.push([lat, lng]) > 0);
		await handleMapClick(at, domEvent, ctx);
		off();
		return seen;
	};

	it("hands a click to the armed tool", async () => {
		expect(await intercepted(new MouseEvent("click", { button: 0 }))).toEqual([[1, 2]]);
	});

	it("does not count the overlay's replay of a double-click as another click", async () => {
		expect(await intercepted(new MouseEvent("dblclick", { button: 0 }))).toEqual([]);
	});
});
