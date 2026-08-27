/* eslint-disable @typescript-eslint/no-explicit-any */
import { addLocs, createLocation, useMap, withApi } from "./helpers";
import type { Location } from "@/bindings.gen";
import { ValidationState } from "@/types";
import { LocationFlag } from "@/bindings.consts";

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };
/// Not decodable as an image key, so it reaches the mock as itself: too long to be official.
const USER_PANO = "USER_UPLOADED_PANO_ID_!!!!!!";

function loc(overrides: Partial<Location> = {}): Location {
	return createLocation({ lat: 0, lng: 0, ...overrides });
}

/** `validateLocations` over a scope, as [state, ids] pairs (a Map cannot cross the bridge). */
async function validate(ids: number[]): Promise<Map<number, number[]>> {
	const pairs = (await withApi(async (api, locIds) => {
		const grouped = await api.validateLocations({
			type: "Locations",
			locations: locIds,
			name: null,
		});
		return [...grouped.entries()];
	}, ids)) as [number, number[]][];
	return new Map(pairs);
}

describe("Validation - coverage states come back from the procedure", () => {
	useMap("validation");

	it("groups every location by the state the procedure answered with", async () => {
		const ids = await addLocs([
			// Its pano resolves and the coordinate still finds the same one.
			loc({ ...OFFICIAL_COORDS, panoId: OFFICIAL_PANO }),
			// Open ocean: no pano stored, none at the coordinate.
			loc({ lat: 0, lng: 0 }),
			// Pinned to a pano that no longer resolves, but the coordinate has coverage.
			loc({ ...OFFICIAL_COORDS, panoId: "DEAD_PANO", flags: LocationFlag.LoadAsPanoId }),
			// A user-uploaded panorama.
			loc({ ...OFFICIAL_COORDS, panoId: USER_PANO, flags: LocationFlag.LoadAsPanoId }),
		]);

		const byState = await validate(ids);
		expect(byState.get(ValidationState.Ok)).toEqual([ids[0]]);
		expect(byState.get(ValidationState.NotFound)).toEqual([ids[1]]);
		expect(byState.get(ValidationState.PanoIdBroke)).toEqual([ids[2]]);
		expect(byState.get(ValidationState.Unofficial)).toEqual([ids[3]]);
	});

	it("writes nothing to the locations it validates", async () => {
		const ids = await addLocs([loc({ ...OFFICIAL_COORDS, panoId: OFFICIAL_PANO })]);
		const before = await withApi(async (api, id) => {
			const l = await api.fetchLocation(id);
			return JSON.stringify({ panoId: l?.panoId, extra: l?.extra ?? null, mod: l?.modifiedAt });
		}, ids[0]);

		const byState = await validate(ids);
		expect(byState.get(ValidationState.Ok)).toEqual([ids[0]]);

		const after = await withApi(async (api, id) => {
			const l = await api.fetchLocation(id);
			return JSON.stringify({ panoId: l?.panoId, extra: l?.extra ?? null, mod: l?.modifiedAt });
		}, ids[0]);
		expect(after).toEqual(before);
	});

	it("reports progress and answers every location in the scope", async () => {
		const ids = await addLocs([
			loc({ ...OFFICIAL_COORDS, panoId: OFFICIAL_PANO }),
			loc({ ...OFFICIAL_COORDS, panoId: OFFICIAL_PANO }),
			loc({ lat: 0, lng: 0 }),
		]);

		const seen = (await withApi(async (api, locIds) => {
			const ticks: number[][] = [];
			const grouped = await api.validateLocations(
				{ type: "Locations", locations: locIds, name: null },
				{ onProgress: (done: number, total: number) => ticks.push([done, total]) },
			);
			const answered = [...grouped.values()].reduce((n: number, l: number[]) => n + l.length, 0);
			return { answered, last: ticks.at(-1) ?? null };
		}, ids)) as any;

		expect(seen.answered).toBe(3);
		expect(seen.last).toEqual([3, 3]);
	});
});
