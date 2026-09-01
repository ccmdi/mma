/**
 * The hostile fixture both engines are driven over. Every row is a case that has already
 * produced a silent divergence at least once: dead panos, coordinates with no coverage,
 * rows that arrive already enriched, rows pinned to a pano that no longer resolves.
 *
 * Row identity is the coordinate pair, so a dump from either build joins on `key(row)`.
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

export function fixtureRows(): FixtureRow[] {
	return [
		{ kind: "plain", lat: 40.758, lng: -73.9855 },
		{ kind: "plain-2", lat: 48.8584, lng: 2.2945 },
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
			extra: { imageDate: "2022-06", datetime: 1, timezone: "Fake/Zone" },
		},
		{ kind: "undated", lat: 41.8902, lng: 12.4922, extra: { imageDate: "" } },
		{ kind: "custom-extra", lat: 55.7558, lng: 37.6176, extra: { userField: "keep me" } },
		{ kind: "dateless-pinned", lat: 1.2834, lng: 103.8607, flags: LOAD_AS_PANO_ID },
	];
}

export const key = (r: { lat: unknown; lng: unknown }): string => `${r.lat},${r.lng}`;

export const kindOf = (k: string): string =>
	fixtureRows().find((r) => key(r) === k)?.kind ?? "unknown";
