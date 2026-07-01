/**
 * REAL end-to-end contract test against map-making.app. Mutating: it pushes to and clears
 * a dedicated sacrificial map (reset before every test). Gated on credentials, excluded from
 * the normal suite (see vitest.integration.config.ts). Run with:
 *
 *   MMA_API_KEY=<key> MMA_SYNC_TEST_MAP=<mapId> npm run test:integration
 *
 * The map at MMA_SYNC_TEST_MAP is WIPED repeatedly. Use a throwaway you own.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Location } from "@/bindings.gen";
import { LocationFlag } from "@/types";
import { MapMakingWebApi, Remote } from "@/plugins/mapMakingSync/map-making-web-api";
import {
	localToNormalized,
	remoteToNormalized,
	localToRemoteInput,
	syncKey,
	type NormalizedSyncLocation,
	type TagName,
} from "@/plugins/mapMakingSync/adapter";

const KEY = process.env.MMA_API_KEY;
const MAP = process.env.MMA_SYNC_TEST_MAP ? Number(process.env.MMA_SYNC_TEST_MAP) : undefined;
const enabled = !!KEY && !!MAP && Number.isFinite(MAP);

const TAGS = new Map<number, string>([
	[1, "alpha"],
	[2, "beta gamma"], // space in the name
	[3, "DELTA"], // case sensitivity
]);
const tagName: TagName = (id) => TAGS.get(id);

function localLoc(over: Partial<Location>): Location {
	return {
		id: 0,
		lat: 0,
		lng: 0,
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId: null,
		flags: 0,
		tags: [],
		extra: null,
		createdAt: 0,
		modifiedAt: null,
		...over,
	};
}

const keysSorted = (ns: NormalizedSyncLocation[]) => ns.map(syncKey).sort();

describe.runIf(enabled)("map-making.app real push/pull contract", () => {
	const api = new MapMakingWebApi({ apiKey: KEY! });

	async function resetMap() {
		const locs = await api.getLocationsJson(MAP!);
		if (!locs.length) return;
		await api.editLocations(MAP!, {
			edits: [
				{
					action: { type: Remote.EditActionType.RemoveAll },
					create: [],
					remove: locs.map((l) => l.id),
				},
			],
		});
		const after = await api.getLocationsJson(MAP!);
		if (after.length) throw new Error(`reset failed: ${after.length} locations remain`);
	}

	async function push(locals: Location[]) {
		const create = locals.map((l, i) => localToRemoteInput(l, -(i + 1), tagName));
		await api.editLocations(MAP!, {
			edits: [{ action: { type: Remote.EditActionType.Import }, create, remove: [] }],
		});
	}

	beforeAll(async () => {
		const user = await api.getUser();
		expect(user.id).toBeGreaterThan(0);
		const map = await api.getMap(MAP!);
		expect(map.role).toBe("owner"); // never run against a map we don't own
	});

	beforeEach(resetMap);
	afterAll(resetMap);

	// --- Field fidelity: each case pushed alone, pulled, normalized both sides, compared ---

	const cases: { name: string; loc: Partial<Location> }[] = [
		{ name: "high-precision coords", loc: { lat: 48.8583701, lng: 2.2944813 } },
		{ name: "southern/western negatives", loc: { lat: -33.856159, lng: -151.215256 } },
		{
			name: "fully panned",
			loc: { lat: 40.1, lng: -74.2, heading: 287.4, pitch: -7.2, zoom: 1.75 },
		},
		{ name: "zoom 0 (unpanned)", loc: { lat: 1, lng: 1, zoom: 0 } },
		{ name: "heading wrap edge", loc: { lat: 2, lng: 2, heading: 359.99 } },
		{ name: "pitch extremes", loc: { lat: 3, lng: 3, pitch: 90 } },
		{ name: "informational flag", loc: { lat: 4, lng: 4, flags: LocationFlag.Informational } },
		{ name: "coordinate-only (no pano)", loc: { lat: 5, lng: 5, panoId: null, flags: 0 } },
		{ name: "single tag", loc: { lat: 6, lng: 6, tags: [1] } },
		{ name: "multiple tags incl. space + case", loc: { lat: 7, lng: 7, tags: [3, 1, 2] } },
		{
			name: "virtual flags stripped before push",
			loc: { lat: 8, lng: 8, flags: LocationFlag.Informational | LocationFlag.ImportPreview },
		},
		{
			name: "pano-bearing (LoadAsPanoId), real pano, server does not snap",
			loc: {
				lat: 39.4362809319088,
				lng: 140.5081804243339,
				heading: 80.3,
				pitch: -16.33,
				zoom: 0,
				panoId: "79KtMrJ5g6v6a1_JY5YcoQ",
				flags: LocationFlag.LoadAsPanoId,
				tags: [1],
			},
		},
	];

	it.each(cases)("round-trips: $name", async ({ loc }) => {
		const L = localLoc(loc);
		await push([L]);
		const pulled = await api.getLocationsJson(MAP!);
		expect(pulled).toHaveLength(1);
		expect(remoteToNormalized(pulled[0]!)).toEqual(localToNormalized(L, tagName));
	});

	// --- Batch + order independence ---

	it("round-trips a batch by set equality", async () => {
		const batch = [
			localLoc({ lat: 10.1, lng: 20.2, heading: 12 }),
			localLoc({ lat: -5.5, lng: 33.3, tags: [1, 2] }),
			localLoc({ lat: 0.001, lng: -0.002, flags: LocationFlag.Informational }),
			localLoc({ lat: 60, lng: 60, zoom: 2.0, pitch: -3 }),
		];
		await push(batch);
		const pulled = await api.getLocationsJson(MAP!);
		expect(pulled).toHaveLength(batch.length);
		expect(keysSorted(pulled.map(remoteToNormalized))).toEqual(
			keysSorted(batch.map((l) => localToNormalized(l, tagName))),
		);
	});

	// --- JSON vs protobuf parity (validates the protobuf reader incl. panoDate field 11) ---

	it("JSON and protobuf pulls normalize identically", async () => {
		const batch = [
			localLoc({
				lat: 35.6586,
				lng: 139.7454,
				heading: 200,
				pitch: -2,
				zoom: 1.25,
				tags: [1, 2, 3],
			}),
			localLoc({ lat: -22.95, lng: -43.21, flags: LocationFlag.Informational }),
		];
		await push(batch);
		const json = await api.getLocationsJson(MAP!);
		const proto = await api.getLocationsProtobuf(MAP!);
		expect(proto).toHaveLength(json.length);
		expect(keysSorted(proto.map(remoteToNormalized))).toEqual(
			keysSorted(json.map(remoteToNormalized)),
		);
		expect(keysSorted(json.map(remoteToNormalized))).toEqual(
			keysSorted(batch.map((l) => localToNormalized(l, tagName))),
		);
	});

	// --- Tag behavior: names survive on the location; registry stays empty (web-app-managed) ---

	it("tag names survive on locations but the map tag registry stays empty", async () => {
		await push([localLoc({ lat: 9, lng: 9, tags: [1, 2, 3] })]);
		const pulled = await api.getLocationsJson(MAP!);
		expect(pulled[0]!.tags.sort()).toEqual(["DELTA", "alpha", "beta gamma"]);
		const map = await api.getMap(MAP!);
		expect(Object.keys(map.tags)).toHaveLength(0); // not API-writable
	});

	it("reset truly empties the map", async () => {
		await push([localLoc({ lat: 1, lng: 1 }), localLoc({ lat: 2, lng: 2 })]);
		expect(await api.getLocationsJson(MAP!)).toHaveLength(2);
		await resetMap();
		expect(await api.getLocationsJson(MAP!)).toHaveLength(0);
	});
});
