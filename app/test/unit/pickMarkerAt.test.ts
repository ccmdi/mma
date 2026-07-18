// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CellManager } from "@/lib/render/CellManager";
import { LOD_BANDS, LOD_MIN_TOTAL } from "@/lib/render/CellManager";
import type { Location } from "@/bindings.gen";

vi.mock("@/lib/util/log", () => ({
	log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
}));

const storePick = vi.fn();
vi.mock("@/lib/commands", () => ({
	cmd: { storePick: (...a: unknown[]) => storePick(...a) },
}));

let activeLocation: Location | null = null;
let workArea = "editor";
let importPreviewPositions = new Float32Array(0);
vi.mock("@/store/useMapStore", () => ({
	getActiveLocation: () => activeLocation,
	getWorkArea: () => workArea,
	getImportPreviewPositions: () => importPreviewPositions,
	addLocations: vi.fn(),
	getCurrentMap: () => null,
	openStagedLocation: vi.fn(),
	resolveLocation: vi.fn(),
	setActiveLocation: vi.fn(),
	toggleManualSelection: vi.fn(),
	subscribeStore: vi.fn(),
}));

let seenActive = false;
let seenEntries: { id: number; lat: number; lng: number }[] = [];
vi.mock("@/lib/seen/seenOverlay", () => ({
	openSeenEntry: vi.fn(),
	isSeenOverlayActive: () => seenActive,
	getSeenOverlayEntries: () => seenEntries,
}));

vi.mock("@/lib/sv/lookup", () => ({
	lookupStreetView: vi.fn(),
	showToast: vi.fn(),
}));
vi.mock("@/lib/map/mapState", () => ({
	tryInterceptClick: () => false,
}));
vi.mock("@/lib/sv/measure", () => ({
	openContextMenuLatLng: vi.fn(),
	openContextMenuLocation: vi.fn(),
}));

const { pickMarkerAt } = await import("@/lib/map/mapClick");

function loc(over: Partial<Location>): Location {
	return {
		id: 1,
		lat: 0,
		lng: 0,
		heading: 0,
		pitch: 0,
		zoom: 1,
		panoId: null,
		flags: 0,
		tags: [],
		extra: null,
		createdAt: 0,
		modifiedAt: null,
		...over,
	} as Location;
}

function fakeCellManager(over: Partial<CellManager> = {}): CellManager {
	return {
		totalCount: 0,
		cells: new Map(),
		selOverlayCount: 0,
		selOverlayPositions: new Float32Array(0),
		selOverlayColors: new Uint8Array(0),
		selOverlayAngles: new Float32Array(0),
		selOverlayIds: new Uint32Array(0),
		...over,
	} as unknown as CellManager;
}

beforeEach(() => {
	storePick.mockReset();
	activeLocation = null;
	workArea = "editor";
	importPreviewPositions = new Float32Array(0);
	seenActive = false;
	seenEntries = [];
});

describe("pickMarkerAt: active marker priority", () => {
	it("hits the active location without calling storePick", async () => {
		activeLocation = loc({ id: 42, lat: 10, lng: 20 });
		const cm = fakeCellManager();
		const pick = await pickMarkerAt(10, 20, {
			cm,
			zoom: 15,
			markerStyle: "pin",
			markerSize: 1,
			markerOpacity: 1,
			lodBand: null,
		});
		expect(pick).toEqual({ kind: "location", picked: activeLocation });
		expect(storePick).not.toHaveBeenCalled();
	});
});

describe("pickMarkerAt: full-detail path", () => {
	it("resolves an unselected hit via storePick", async () => {
		storePick.mockResolvedValue([{ id: 5, selected: false }]);
		const cm = fakeCellManager();
		const pick = await pickMarkerAt(10, 20, {
			cm,
			zoom: 15,
			markerStyle: "pin",
			markerSize: 1,
			markerOpacity: 1,
			lodBand: null,
		});
		expect(pick).toEqual({ kind: "location", picked: 5 });
	});

	it("a selected hit beats a seen dot at the same spot", async () => {
		storePick.mockResolvedValue([{ id: 7, selected: true }]);
		seenActive = true;
		seenEntries = [{ id: 1, lat: 10, lng: 20 }];
		const cm = fakeCellManager();
		const pick = await pickMarkerAt(10, 20, {
			cm,
			zoom: 15,
			markerStyle: "pin",
			markerSize: 1,
			markerOpacity: 1,
			lodBand: null,
		});
		expect(pick).toEqual({ kind: "location", picked: 7 });
	});

	it("an unselected base hit loses to a seen dot at the same spot", async () => {
		storePick.mockResolvedValue([{ id: 7, selected: false }]);
		seenActive = true;
		seenEntries = [{ id: 1, lat: 10, lng: 20 }];
		const cm = fakeCellManager();
		const pick = await pickMarkerAt(10, 20, {
			cm,
			zoom: 15,
			markerStyle: "pin",
			markerSize: 1,
			markerOpacity: 1,
			lodBand: null,
		});
		expect(pick).toEqual({ kind: "seen", index: 0 });
	});

	it("markerOpacity 0 filters unselected hits, falling through to seen", async () => {
		storePick.mockResolvedValue([{ id: 7, selected: false }]);
		seenActive = true;
		seenEntries = [{ id: 1, lat: 10, lng: 20 }];
		const cm = fakeCellManager();
		const pick = await pickMarkerAt(10, 20, {
			cm,
			zoom: 15,
			markerStyle: "pin",
			markerSize: 1,
			markerOpacity: 0,
			lodBand: null,
		});
		expect(pick).toEqual({ kind: "seen", index: 0 });
	});

	it("markerOpacity 0 with no seen hit returns null", async () => {
		storePick.mockResolvedValue([{ id: 7, selected: false }]);
		const cm = fakeCellManager();
		const pick = await pickMarkerAt(10, 20, {
			cm,
			zoom: 15,
			markerStyle: "pin",
			markerSize: 1,
			markerOpacity: 0,
			lodBand: null,
		});
		expect(pick).toBeNull();
	});
});

describe("pickMarkerAt: LOD path", () => {
	it("skips storePick and hits via cell.getLod representatives", async () => {
		const fakeCell = {
			count: 1,
			getLod: (band: number) =>
				band === 0
					? {
							count: 1,
							positions: new Float32Array([20, 10]),
							colors: new Uint8Array([42, 42, 42, 255]),
							ids: new Uint32Array([99]),
						}
					: {
							count: 0,
							positions: new Float32Array(0),
							colors: new Uint8Array(0),
							ids: new Uint32Array(0),
						},
		};
		const cm = fakeCellManager({
			totalCount: LOD_MIN_TOTAL,
			cells: new Map([["s", fakeCell]]) as unknown as CellManager["cells"],
		});
		const zoom = LOD_BANDS[0].maxZoom - 1;
		const pick = await pickMarkerAt(10, 20, {
			cm,
			zoom,
			markerStyle: "pin",
			markerSize: 1,
			markerOpacity: 1,
			lodBand: 0,
		});
		expect(pick).toEqual({ kind: "location", picked: 99 });
		expect(storePick).not.toHaveBeenCalled();
	});

	it("misses a point far from any LOD representative", async () => {
		const fakeCell = {
			count: 1,
			getLod: () => ({
				count: 1,
				positions: new Float32Array([20, 10]),
				colors: new Uint8Array([42, 42, 42, 255]),
				ids: new Uint32Array([99]),
			}),
		};
		const cm = fakeCellManager({
			totalCount: LOD_MIN_TOTAL,
			cells: new Map([["s", fakeCell]]) as unknown as CellManager["cells"],
		});
		const zoom = LOD_BANDS[0].maxZoom - 1;
		const pick = await pickMarkerAt(50, 100, {
			cm,
			zoom,
			markerStyle: "pin",
			markerSize: 1,
			markerOpacity: 1,
			lodBand: 0,
		});
		expect(pick).toBeNull();
	});
});
