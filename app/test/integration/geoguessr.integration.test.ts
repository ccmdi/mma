/**
 * REAL contract test against geoguessr.com. Mutating: it overwrites a dedicated sacrificial
 * draft's coordinate list repeatedly. Gated on credentials, excluded from the normal suite.
 *
 *   GG_NCFA=<cookie> GG_SYNC_TEST_MAP=<draft slug> npm run test:integration
 *
 * or put both in a gitignored `.env`. The draft at GG_SYNC_TEST_MAP is WIPED. Use a throwaway.
 *
 * These run in node, so they hit geoguessr.com directly rather than through the `ggapi` Rust
 * proxy -- they pin the wire contract the provider is written against, not the proxy itself.
 *
 * The session token is never asserted on, logged, or included in a failure message.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { LocationFlag } from "@/types";
import { geoguessrProvider } from "@/plugins/geoguessr/provider";
import type { GgCoordinate, GgDraft } from "@/plugins/geoguessr/remote-types";
import { syncKey, type NormalizedSyncLocation } from "@/lib/sync/normalized";

const NCFA = process.env.GG_NCFA;
const MAP = process.env.GG_SYNC_TEST_MAP;
const enabled = !!NCFA && !!MAP;

const ORIGIN = "https://www.geoguessr.com";

async function gg<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${ORIGIN}${path}`, {
		...init,
		headers: {
			...init.headers,
			accept: "application/json",
			"X-Client": "web",
			cookie: `_ncfa=${NCFA}`,
		},
	});
	// Deliberately does not echo headers: a failure message must never carry the token.
	if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
	return (await res.json()) as T;
}

const getDraft = () => gg<GgDraft>(`/api/v4/user-maps/drafts/${MAP}`);

async function putCoordinates(coordinates: GgCoordinate[], version: number) {
	return await gg<{ message: string }>(`/api/v4/user-maps/drafts/${MAP}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mode: "coordinates", version, customCoordinates: coordinates }),
	});
}

/** Write `coords` and hand back the resulting draft. */
async function write(coords: GgCoordinate[]): Promise<GgDraft> {
	const { version } = await getDraft();
	await putCoordinates(coords, version + 1);
	return await getDraft();
}

const PIN: GgCoordinate = {
	lat: 51.5007,
	lng: -0.1246,
	heading: 137.5,
	pitch: -3,
	zoom: 1.25,
	panoId: null,
};

describe.runIf(enabled)("geoguessr wire contract", () => {
	beforeAll(async () => {
		// Fail loudly and early rather than midway through a mutation.
		await getDraft();
	});

	it("exposes a signed-in profile in the shape geoguessr_me parses", async () => {
		const body = await gg<Record<string, unknown>>("/api/v3/profiles");
		const container = (body.user ?? body) as Record<string, unknown>;
		// Report the real shape when this fails; the Rust parser navigates the same way.
		expect(
			Object.keys(container),
			`/api/v3/profiles keys: ${Object.keys(body).join(", ")}`,
		).toEqual(expect.arrayContaining(["id", "nick"]));
		expect(typeof container.id).toBe("string");
		expect(typeof container.nick).toBe("string");
	});

	it("lists maps in the shape listMaps expects", async () => {
		const maps = await gg<Record<string, unknown>[]>("/api/v3/profiles/maps");
		expect(Array.isArray(maps)).toBe(true);
		if (!maps.length) return; // nothing to assert against on a fresh account
		const sample = maps[0]!;
		// The provider reads id/name, and treats mode === "regions" as unlinkable. If this fails,
		// the key list in the message is exactly what listMaps needs to be rewritten against.
		expect(Object.keys(sample).join(",")).toMatch(/(^|,)(id|slug)(,|$)/);
		expect(sample).toHaveProperty("name");
		expect(maps.some((m) => m.id === MAP || m.slug === MAP)).toBe(true);
	});

	it("reads locations under `coordinates` but writes them under `customCoordinates`", async () => {
		const draft = await write([PIN]);
		expect(draft.coordinates).toHaveLength(1);
		expect(draft).not.toHaveProperty("customCoordinates");
	});

	it("round-trips the synced contract without drift", async () => {
		const draft = await write([PIN]);
		const got = draft.coordinates![0]!;
		expect(got.lat).toBeCloseTo(PIN.lat, 6);
		expect(got.lng).toBeCloseTo(PIN.lng, 6);
		expect(got.heading).toBeCloseTo(PIN.heading, 4);
		expect(got.pitch).toBeCloseTo(PIN.pitch, 4);
		expect(got.zoom).toBeCloseTo(PIN.zoom, 4);
	});

	it("normalizes a written pin back to what we materialized from", async () => {
		// The property the whole diff rests on: materialize -> write -> read -> normalize is
		// the identity. If this drifts, every sync reports phantom changes forever.
		const source: NormalizedSyncLocation = {
			lat: 48.8584,
			lng: 2.2945,
			heading: 0, // exercises the 1e-4 north nudge in both directions
			pitch: 0,
			zoom: 0,
			panoId: null,
			flags: LocationFlag.None,
			tags: [],
		};
		const draft = await write([geoguessrProvider.materialize(source, () => undefined)]);
		expect(syncKey(geoguessrProvider.normalize(draft.coordinates![0]!))).toBe(syncKey(source));
	});

	it("keeps a panoId when the location loads by pano", async () => {
		const source: NormalizedSyncLocation = {
			lat: 51.5007,
			lng: -0.1246,
			heading: 90,
			pitch: 0,
			zoom: 0,
			panoId: "OhCEnVaJyDMAAAQZLBEJPQ",
			flags: LocationFlag.LoadAsPanoId,
			tags: [],
		};
		const draft = await write([geoguessrProvider.materialize(source, () => undefined)]);
		expect(draft.coordinates![0]!.panoId).toBe(source.panoId);
		expect(syncKey(geoguessrProvider.normalize(draft.coordinates![0]!))).toBe(syncKey(source));
	});

	it("strips unknown per-coordinate fields, so no local id can ride along", async () => {
		// This is why identity is positional rather than an embedded id. If it ever starts
		// round-tripping, the provider can be simplified considerably.
		const draft = await write([{ ...PIN, extra: { mmaId: 12345 } } as GgCoordinate]);
		expect(draft.coordinates![0]).not.toHaveProperty("extra");
	});

	it("preserves name and avatar across a coordinates-only write", async () => {
		const before = await getDraft();
		const after = await write([PIN, { ...PIN, lat: 52 }]);
		expect(after.name).toBe(before.name);
		expect(after.avatar).toEqual(before.avatar);
		expect(after.coordinates).toHaveLength(2);
	});

	it("increments version by exactly one per write", async () => {
		const before = await getDraft();
		const after = await write([PIN]);
		expect(after.version).toBe(before.version + 1);
	});

	it("rejects a stale version instead of clobbering a concurrent edit", async () => {
		// The entire concurrency story. If this ever passes silently, `push` is racing every
		// other editor of the map and the provider needs a different guard.
		const { version } = await getDraft();
		await putCoordinates([PIN], version + 1); // consumes the version
		await expect(putCoordinates([{ ...PIN, lat: 40 }], version + 1)).rejects.toThrow();
	});

	it("survives a batch large enough to exercise the payload path", async () => {
		const many = Array.from({ length: 500 }, (_, i) => ({
			...PIN,
			lat: 40 + i * 0.001,
			lng: -70 + i * 0.001,
		}));
		const draft = await write(many);
		expect(draft.coordinates).toHaveLength(500);
	});
});
