import { describe, it, expect } from "vitest";
import { storedBsonSize } from "@/plugins/geoguessr/provider";
import type { GgCoordinate } from "@/plugins/geoguessr/remote-types";

// Each flip pair is a live measurement: the last accepted and first rejected count for that
// payload shape, bisected to single-pin precision against a real draft.

const pin = (over: Partial<GgCoordinate> = {}): GgCoordinate => ({
	lat: 1.5,
	lng: 2.5,
	heading: 3.5,
	pitch: 4.5,
	zoom: 5.5,
	panoId: null,
	...over,
});

const many = (n: number, over: Partial<GgCoordinate> = {}): GgCoordinate[] =>
	Array.from({ length: n }, () => pin(over));

const PANO_22 = "OhCEnVaJyDMAAAQZLBEJPQ";
const CODES = { countryCode: "fr", stateCode: "fr-idf", cityCode: "paris" };
const LIMIT = 16_777_216;

describe("storedBsonSize", () => {
	it("sizes the empty array as a bare BSON document", () => {
		expect(storedBsonSize([])).toBe(5);
	});

	it("prices null geocode fields at zero and null panoId at its stored element", () => {
		expect(storedBsonSize([pin({ countryCode: null, stateCode: null, cityCode: null })])).toBe(
			storedBsonSize([pin()]),
		);
		expect(storedBsonSize([pin({ panoId: "" })])).toBe(storedBsonSize([pin()]) + 5);
	});

	it("reproduces the measured acceptance flip for bare pins (181,591 -> 181,592)", () => {
		expect(storedBsonSize(many(181_591))).toBe(16_776_858);
		expect(storedBsonSize(many(181_592))).toBe(16_776_951);
	});

	it("reproduces the measured flip for panoId pins (140,733 -> 140,734)", () => {
		expect(storedBsonSize(many(140_733, { panoId: PANO_22 }))).toBe(16_776_855);
		expect(storedBsonSize(many(140_734, { panoId: PANO_22 }))).toBe(16_776_975);
	});

	it("reproduces the measured flip bracket for geocoded pins (108,954 passes, 108,956 fails)", () => {
		expect(storedBsonSize(many(108_954, CODES))).toBe(16_776_765);
		expect(storedBsonSize(many(108_956, CODES))).toBe(16_777_075);
	});

	it("keeps every measured accept under the limit and every reject over it, given the overhead", () => {
		// the per-draft metadata overhead interval the flips bracket; both ends must separate them
		for (const overhead of [266, 358]) {
			expect(storedBsonSize(many(181_591)) + overhead).toBeLessThanOrEqual(LIMIT);
			expect(storedBsonSize(many(181_592)) + overhead).toBeGreaterThan(LIMIT);
			expect(storedBsonSize(many(140_733, { panoId: PANO_22 })) + overhead).toBeLessThanOrEqual(
				LIMIT,
			);
			expect(storedBsonSize(many(140_734, { panoId: PANO_22 })) + overhead).toBeGreaterThan(LIMIT);
		}
	});
});
