/**
 * The hostile fixture both engines are driven over. Every row is a case that has already
 * produced a silent divergence, or an edge the procedures have to decide something about:
 * dead panos, coordinates with no coverage, rows that arrive already enriched, rows
 * pinned to a pano that no longer resolves, the poles and the antimeridian.
 *
 * Row identity is the coordinate pair, so a dump from either build joins on `key(row)`.
 * Coordinates are unique across the fixture; nothing here may collide with another row.
 */

export interface FixtureRow {
	kind: string;
	lat: number;
	lng: number;
	panoId?: string | null;
	flags?: number;
	extra?: Record<string, unknown>;
}

/** Ocean: the mock answers "no pano here" for anything within 0.01 of the null island. */
const NO_COVERAGE = { lat: 0.0005, lng: 0.0005 };

/** Panos the mock carries real fixtures for, with more than one capture date. */
const KNOWN_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const KNOWN_PANO_SINGLE_DATE = "5upMz1_zTGPdkIXG6_QM3g";

const LOAD_AS_PANO_ID = 1;
const INFORMATIONAL = 2;

/** The month the mock reports for a coordinate it holds no fixture for. */
export const MOCK_GENERIC_IMAGE_DATE = "2022-06";

export function fixtureRows(): FixtureRow[] {
	return [
		{ kind: "plain", lat: 40.758, lng: -73.9855 },
		{ kind: "plain-2", lat: 48.8584, lng: 2.2945 },

		// --- coverage and pano state ---
		{ kind: "no-coverage", ...NO_COVERAGE },
		{ kind: "dead-pano", lat: 51.5007, lng: -0.1246, panoId: "DEAD_PANO_1" },
		{
			kind: "dead-pano-pinned",
			lat: 35.6595,
			lng: 139.7005,
			panoId: "DOES_NOT_EXIST_2",
			flags: LOAD_AS_PANO_ID,
		},
		{ kind: "known-pano", lat: 52.10947502806108, lng: 34.90131410856584, panoId: KNOWN_PANO },
		{
			kind: "known-pano-pinned",
			lat: 55.510656,
			lng: 157.636627,
			panoId: KNOWN_PANO_SINGLE_DATE,
			flags: LOAD_AS_PANO_ID,
		},
		{ kind: "dateless-pinned", lat: 1.2834, lng: 103.8607, flags: LOAD_AS_PANO_ID },
		// A pano id that belongs to a different coordinate than the row carries.
		{ kind: "mismatched-pano", lat: 19.4326, lng: -99.1332, panoId: KNOWN_PANO },

		// --- pre-existing extras ---
		{
			kind: "already-enriched",
			lat: -33.8568,
			lng: 151.2153,
			extra: { countryCode: "ZZ", altitude: 1234, imageDate: "1999-01" },
		},
		{
			kind: "stale-datetime",
			lat: 37.8199,
			lng: -122.4783,
			extra: { imageDate: MOCK_GENERIC_IMAGE_DATE, datetime: 1, timezone: "Fake/Zone" },
		},
		{ kind: "custom-extra", lat: 55.7558, lng: 37.6176, extra: { userField: "keep me" } },
		{
			kind: "typed-extras",
			lat: 43.6426,
			lng: -79.3871,
			extra: { altitude: "not a number", panoType: null, cameraType: 7, nested: { a: [1, 2] } },
		},
		{ kind: "empty-extra-object", lat: 59.9139, lng: 10.7522, extra: {} },

		// --- capture month edges (what exactDate searches) ---
		{ kind: "undated", lat: 41.8902, lng: 12.4922, extra: { imageDate: "" } },
		{ kind: "malformed-month", lat: 52.5163, lng: 13.3777, extra: { imageDate: "2022-13" } },
		{ kind: "month-not-a-month", lat: 25.1972, lng: 55.2744, extra: { imageDate: "someday" } },
		{ kind: "leap-february", lat: -22.9519, lng: -43.2105, extra: { imageDate: "2020-02" } },
		{ kind: "december", lat: 60.1699, lng: 24.9384, extra: { imageDate: "2021-12" } },
		{ kind: "january", lat: -34.6037, lng: -58.3816, extra: { imageDate: "2019-01" } },
		{ kind: "future-month", lat: 13.7563, lng: 100.5018, extra: { imageDate: "2099-07" } },
		{ kind: "ancient-month", lat: 30.0444, lng: 31.2357, extra: { imageDate: "1970-01" } },

		// --- coordinate edges ---
		{ kind: "north-pole", lat: 89.9999, lng: 0.5 },
		{ kind: "south-pole", lat: -89.9999, lng: -0.5 },
		{ kind: "antimeridian-east", lat: 12.3456, lng: 179.9999 },
		{ kind: "antimeridian-west", lat: 12.3457, lng: -179.9999 },
		{ kind: "equator", lat: 0.0, lng: 42.1234 },
		{ kind: "high-precision", lat: 45.123456789, lng: -93.987654321 },

		// --- flags ---
		{ kind: "informational", lat: 47.6062, lng: -122.3321, flags: INFORMATIONAL },
		{ kind: "informational-pinned", lat: 49.2827, lng: -123.1207, flags: INFORMATIONAL | LOAD_AS_PANO_ID },

		// --- duplicates: same coordinate, distinct rows ---
		{ kind: "dup-a", lat: 35.0, lng: 135.0 },
		{ kind: "dup-b", lat: 35.0, lng: 135.000001 },
	];
}

/** Rows whose requests are answered with a fault script, keyed the way the mock keys
 *  them: a coordinate for SingleImageSearch, a pano id for GetMetadata. 0 = a 200 with
 *  a truncated body. */
export function faultScript(): Record<string, number[]> {
	// A row's search issues ~40 requests, and the transport retries on its own, so a
	// script that is meant to persist has to outlast both.
	const always = (status: number) => Array.from({ length: 200 }, () => status);
	return {
		// Retried and recovered: the row must come out identical to an unfaulted one.
		"46.9480,7.4474": [429, 503],
		// Never recovers: whatever the row ends up as, it must not be a wrong answer.
		"37.9838,23.7275": always(503),
		// A 200 whose body is garbage: must not read as "no coverage".
		"59.3293,18.0686": always(0),
		// Metadata itself fails for a live pano.
		[KNOWN_PANO]: always(500),
	};
}

/** Rows that only exist to be faulted; kept apart so the plain fixture stays readable. */
export function faultRows(): FixtureRow[] {
	return [
		{ kind: "fault-recovers", lat: 46.948, lng: 7.4474, extra: { imageDate: MOCK_GENERIC_IMAGE_DATE } },
		{ kind: "fault-persists", lat: 37.9838, lng: 23.7275, extra: { imageDate: MOCK_GENERIC_IMAGE_DATE } },
		{ kind: "fault-truncated", lat: 59.3293, lng: 18.0686, extra: { imageDate: MOCK_GENERIC_IMAGE_DATE } },
	];
}

export const key = (r: { lat: unknown; lng: unknown }): string => `${r.lat},${r.lng}`;

const KIND_BY_KEY = new Map(
	[...fixtureRows(), ...faultRows()].map((r) => [key(r), r.kind] as const),
);

export const kindOf = (k: string): string => KIND_BY_KEY.get(k) ?? "unknown";
