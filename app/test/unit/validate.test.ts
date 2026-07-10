// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LocationFlag } from "@/types";
import type { Location } from "@/types";
import { ValidationState } from "@/store/selections";

vi.mock("@/lib/sv/svMeta", () => ({ fetchSvMetadata: vi.fn() }));
vi.mock("@/lib/sv/lookup", async () => {
	const actual = await vi.importActual<typeof import("@/lib/sv/lookup")>("@/lib/sv/lookup");
	return { ...actual, getPanoAtCoords: vi.fn() };
});

import { validateOne } from "@/lib/sv/validate";
import { fetchSvMetadata } from "@/lib/sv/svMeta";
import { getPanoAtCoords } from "@/lib/sv/lookup";

const mockFetch = vi.mocked(fetchSvMetadata);
const mockCoords = vi.mocked(getPanoAtCoords);

// 22-char official ids per OFFICIAL_PANO_RE: 21 of [-_A-Za-z0-9] then [AQgw].
const OFFICIAL_OLD = "AAAAAAAAAAAAAAAAAAAAAA"; // ends 'A'
const OFFICIAL_NEW = "BBBBBBBBBBBBBBBBBBBBBQ"; // ends 'Q'
const UNOFFICIAL = "U".repeat(30); // length > 22 -> isUnofficial heuristic
const BADCAM = "C".repeat(21) + "Q"; // official-shaped id, low-quality camera
const GOODCAM = "D".repeat(21) + "A"; // official-shaped id, gen4

type Pano = google.maps.StreetViewResolvedPanoramaData;

function pano(opts: {
	pano: string;
	cameraType?: string | null;
	time?: { pano: string; date?: Date }[];
}): Pano {
	const { pano: id, cameraType = "gen4", time = [] } = opts;
	return {
		location: { latLng: { lat: () => 0, lng: () => 0 }, pano: id },
		imageDate: "2022-01",
		time: time.map((t) => ({ pano: t.pano, date: t.date ?? new Date(0) })),
		tiles: { worldSize: { width: 0, height: 8192 } },
		extra: { cameraType, countryCode: null, _levelId: null },
	} as unknown as Pano;
}

function pinned(panoId: string): Location {
	return { id: 1, lat: 0, lng: 0, flags: LocationFlag.LoadAsPanoId, panoId } as Location;
}

// Coord-based (not Load-as-pano-ID). May still record the pano it resolved to.
function coord(panoId: string | null = null): Location {
	return { id: 1, lat: 0, lng: 0, flags: LocationFlag.None, panoId } as Location;
}

// Resolve fetchSvMetadata from a fixture map; unknown ids resolve to null (broken pano).
function byId(map: Record<string, Pano>) {
	mockFetch.mockImplementation(async (ids: string[]) => ids.map((id) => map[id] ?? null));
}

beforeEach(() => {
	mockFetch.mockReset();
	mockCoords.mockReset();
});

describe("timeline check scans official coverage (fix #1)", () => {
	it("pinned official pano with newer OFFICIAL coverage in timeline -> UpdateAvailable", async () => {
		mockFetch.mockResolvedValue([
			pano({
				pano: OFFICIAL_OLD,
				time: [
					{ pano: OFFICIAL_OLD, date: new Date(2020, 0) },
					{ pano: OFFICIAL_NEW, date: new Date(2023, 0) },
				],
			}),
		]);
		expect(await validateOne(pinned(OFFICIAL_OLD))).toBe(ValidationState.UpdateAvailable);
	});

	it("pinned official pano that IS the newest in its timeline -> Ok", async () => {
		mockFetch.mockResolvedValue([
			pano({
				pano: OFFICIAL_NEW,
				time: [
					{ pano: OFFICIAL_OLD, date: new Date(2020, 0) },
					{ pano: OFFICIAL_NEW, date: new Date(2023, 0) },
				],
			}),
		]);
		expect(await validateOne(pinned(OFFICIAL_NEW))).toBe(ValidationState.Ok);
	});
});

describe("Unofficial reuses the app-wide isUnofficial heuristic (fix #2)", () => {
	it("a long-id (user-uploaded) pano -> Unofficial", async () => {
		mockFetch.mockResolvedValue([pano({ pano: UNOFFICIAL })]);
		expect(await validateOne(pinned(UNOFFICIAL))).toBe(ValidationState.Unofficial);
	});

	it("a 22-char official pano is not Unofficial", async () => {
		mockFetch.mockResolvedValue([pano({ pano: OFFICIAL_OLD, time: [{ pano: OFFICIAL_OLD }] })]);
		const result = await validateOne(pinned(OFFICIAL_OLD));
		expect(result).not.toBe(ValidationState.Unofficial);
		expect(result).toBe(ValidationState.Ok);
	});
});

describe("coord-based locations (not pinned): UpdateApplied vs Ok", () => {
	it("coverage at the coordinate changed since the stored pano -> UpdateApplied", async () => {
		// Records OLD, but the coordinate now resolves to a different pano (NEW).
		mockCoords.mockResolvedValue(OFFICIAL_NEW);
		byId({
			[OFFICIAL_OLD]: pano({ pano: OFFICIAL_OLD, time: [{ pano: OFFICIAL_OLD }] }),
			[OFFICIAL_NEW]: pano({ pano: OFFICIAL_NEW, time: [{ pano: OFFICIAL_NEW }] }),
		});
		expect(await validateOne(coord(OFFICIAL_OLD))).toBe(ValidationState.UpdateApplied);
	});

	it("stored pano not newest in its own timeline -> UpdateApplied", async () => {
		// Coordinate still resolves to OLD, but OLD's timeline has a newer official pano.
		mockCoords.mockResolvedValue(OFFICIAL_OLD);
		byId({
			[OFFICIAL_OLD]: pano({
				pano: OFFICIAL_OLD,
				time: [
					{ pano: OFFICIAL_OLD, date: new Date(2020, 0) },
					{ pano: OFFICIAL_NEW, date: new Date(2023, 0) },
				],
			}),
		});
		expect(await validateOne(coord(OFFICIAL_OLD))).toBe(ValidationState.UpdateApplied);
	});

	it("current and newest at the coordinate -> Ok", async () => {
		mockCoords.mockResolvedValue(OFFICIAL_OLD);
		byId({ [OFFICIAL_OLD]: pano({ pano: OFFICIAL_OLD, time: [{ pano: OFFICIAL_OLD }] }) });
		expect(await validateOne(coord(OFFICIAL_OLD))).toBe(ValidationState.Ok);
	});
});

describe("pinned pano resolution failures", () => {
	it("pinned pano fails to resolve but the coordinate still has coverage -> PanoIdBroke", async () => {
		mockCoords.mockResolvedValue(OFFICIAL_NEW);
		// OFFICIAL_OLD absent from the fixture, so its fetch resolves null (broken).
		byId({ [OFFICIAL_NEW]: pano({ pano: OFFICIAL_NEW, time: [{ pano: OFFICIAL_NEW }] }) });
		expect(await validateOne(pinned(OFFICIAL_OLD))).toBe(ValidationState.PanoIdBroke);
	});

	it("pinned pano fails and the coordinate has no coverage -> NotFound (beats PanoIdBroke)", async () => {
		mockCoords.mockResolvedValue(null);
		byId({});
		expect(await validateOne(pinned(OFFICIAL_OLD))).toBe(ValidationState.NotFound);
	});
});

describe("NotFound and GoodcamAvailable", () => {
	it("bare coord location with no coverage -> NotFound", async () => {
		mockCoords.mockResolvedValue(null);
		byId({});
		expect(await validateOne(coord())).toBe(ValidationState.NotFound);
	});

	it("coord resolves to badcam with a better camera in the timeline -> GoodcamAvailable", async () => {
		mockCoords.mockResolvedValue(BADCAM);
		byId({
			[BADCAM]: pano({
				pano: BADCAM,
				cameraType: "badcam",
				time: [{ pano: BADCAM }, { pano: GOODCAM }],
			}),
			[GOODCAM]: pano({ pano: GOODCAM, cameraType: "gen4" }),
		});
		expect(await validateOne(coord())).toBe(ValidationState.GoodcamAvailable);
	});
});
