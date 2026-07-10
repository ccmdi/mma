import { describe, it, expect, vi } from "vitest";

// enrich.add pulls in Tauri/store/SV modules at import; stub the ones buildPatch
// doesn't use so the pure patch logic is testable in a node environment. The real
// filterEnrichPatch (from fieldDefs.add) is kept -- the bug lives in its interaction.
vi.mock("@/store/useMapStore", () => ({
	getCurrentMap: () => null,
	fetchLocationsByIds: async () => [],
	batchUpdateLocations: async () => {},
	patchLocationExtra: async () => {},
}));
vi.mock("@/lib/sv/svMeta", () => ({ fetchSvMetadata: async () => [] }));
const resolveExactTimestampMock = vi.hoisted(() => vi.fn(async (): Promise<number | null> => null));
vi.mock("@/lib/sv/exactDate", () => ({ resolveExactTimestamp: resolveExactTimestampMock }));
vi.mock("@/lib/util/timezone", () => ({ resolveTimezone: () => null }));
vi.mock("@/lib/sv/lookup", () => ({ resolvePanoIds: async () => [] }));
vi.mock("@/lib/util/log", () => ({
	log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
}));

import { buildPatch, exactDateProvider } from "@/lib/sv/enrich";
import { getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { createLocation } from "@/types";
import type { Location } from "@/types";

// Minimal StreetViewPanoramaData stub: only the fields buildPatch reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function svData(imageDate: string, extra: Record<string, unknown> = {}): any {
	return {
		imageDate,
		extra: { altitude: 10, countryCode: "US", cameraType: "gen4", panoType: "car", ...extra },
	};
}

function loc(extra: Record<string, unknown>): Location {
	return { ...createLocation({ lat: 1, lng: 2 }), extra };
}

describe("buildPatch — stale datetime/timezone clearing", () => {
	it("clears stale datetime/timezone when imageDate changes, even with datetime enrichment OFF", () => {
		// Default enrich set excludes datetime/timezone (opt-in). The clear must still apply.
		const defaults = getDefaultEnrichKeys();
		expect(defaults).not.toContain("datetime");

		const patch = buildPatch(
			svData("2023-03"),
			loc({ imageDate: "2099-01", datetime: 9999999999, timezone: "Fake/Zone" }),
			defaults,
		)!;

		expect(patch.imageDate).toBe("2023-03");
		expect(patch.datetime).toBeNull();
		expect(patch.timezone).toBeNull();
	});

	it("does NOT add datetime/timezone keys when imageDate is unchanged", () => {
		const patch = buildPatch(
			svData("2099-01"),
			loc({ imageDate: "2099-01", datetime: 9999999999, timezone: "Fake/Zone" }),
			getDefaultEnrichKeys(),
		)!;
		expect("datetime" in patch).toBe(false);
		expect("timezone" in patch).toBe(false);
	});

	it("does NOT clear when there was no stale datetime to begin with", () => {
		const patch = buildPatch(
			svData("2023-03"),
			loc({ imageDate: "2099-01" }), // no datetime
			getDefaultEnrichKeys(),
		)!;
		expect("datetime" in patch).toBe(false);
	});

	it("still respects the filter for normal enrich keys", () => {
		// altitude is in the default set; cameraType too -- both should pass through.
		const patch = buildPatch(svData("2023-03"), loc({ imageDate: "2023-03" }), ["altitude"])!;
		expect(patch.altitude).toBe(10);
		expect("countryCode" in patch).toBe(false); // filtered out
	});
});

describe("exactDateProvider", () => {
	it("requires imageDate, so bulk waves run it after the core metadata pass", () => {
		expect(exactDateProvider.requires).toContain("imageDate");
	});

	it("is inert when the datetime field is not enabled", async () => {
		const l = loc({ imageDate: "2023-03" });
		expect(exactDateProvider.units!([l], ["altitude"], false)).toBe(0);
		expect((await exactDateProvider.enrich([l], ["altitude"])).size).toBe(0);
	});

	it("resolves only locations with imageDate and no datetime; force re-resolves", async () => {
		resolveExactTimestampMock.mockResolvedValue(1700000000);
		const target = loc({ imageDate: "2023-03" });
		const already = loc({ imageDate: "2023-03", datetime: 1 });
		const noDate = loc({});
		const fields = ["datetime", "timezone"];

		expect(exactDateProvider.units!([target, already, noDate], fields, false)).toBe(1);
		expect(exactDateProvider.units!([target, already, noDate], fields, true)).toBe(2);

		const out = await exactDateProvider.enrich([target, already, noDate], fields);
		expect(out.size).toBe(1);
		expect(out.get(target.id)).toMatchObject({ datetime: 1700000000 });
	});

	it("reports failures through ctx.onFail and keeps going", async () => {
		resolveExactTimestampMock.mockRejectedValueOnce(new Error("boom"));
		const target = loc({ imageDate: "2023-03" });
		const failed: number[] = [];
		const out = await exactDateProvider.enrich([target], ["datetime"], {
			onFail: (id) => failed.push(id),
		});
		expect(out.size).toBe(0);
		expect(failed).toEqual([target.id]);
	});
});
