import { describe, it, expect } from "vitest";
import { cameraTypeFromHeight, detectCameraType } from "@/lib/sv/getMetadata";
import type { Pano } from "@/types";

const meta = (over: Partial<Pano>): Pano => ({
	pano: "p",
	panoFrontend: 2,
	worldSize: { width: 13312, height: 6656 },
	tileSize: { width: 512, height: 512 },
	copyright: "",
	description: "",
	shortDescription: "",
	uploaderName: null,
	lat: 0,
	lng: 0,
	altitude: 0,
	pov: null,
	countryCode: null,
	levelId: null,
	links: [],
	time: [],
	date: { year: 2022, month: 6, day: 1 },
	source: "launch",
	...over,
});

describe("cameraTypeFromHeight", () => {
	it("maps tile world heights to generations", () => {
		expect(cameraTypeFromHeight(1664)).toBe("gen1");
		expect(cameraTypeFromHeight(6656)).toBe("gen2");
		expect(cameraTypeFromHeight(8192)).toBe("gen4");
		expect(cameraTypeFromHeight(999)).toBe(null);
	});
});

describe("detectCameraType", () => {
	it("only refines gen2 and scout gen4", () => {
		expect(detectCameraType(meta({ worldSize: { width: 0, height: 1664 } }))).toBe("gen1");
		expect(detectCameraType(meta({ worldSize: { width: 0, height: 8192 } }))).toBe("gen4");
		expect(detectCameraType(meta({ worldSize: { width: 0, height: 8192 }, source: "scout" }))).toBe(
			"trekker",
		);
		expect(detectCameraType(meta({ worldSize: { width: 0, height: 999 } }))).toBe(null);
		expect(detectCameraType(meta({}))).toBe("gen2");
		expect(detectCameraType(meta({ source: "scout" }))).toBe("trekker");
	});

	it("reads the badcam thresholds per country", () => {
		const at = (countryCode: string, ym: string, lat = 0) =>
			detectCameraType(
				meta({
					countryCode,
					lat,
					date: { year: Number(ym.slice(0, 4)), month: Number(ym.slice(5)), day: 1 },
				}),
			);
		expect(at("FI", "2020-10")).toBe("badcam");
		expect(at("FI", "2020-09")).toBe("gen2");
		expect(at("FR", "2021-02")).toBe("badcam");
		expect(at("FR", "2021-01")).toBe("gen2");
		expect(at("CY", "1999-06")).toBe("gen2"); // pre-2001 dates never reach the table
		expect(at("CY", "2001-06")).toBe("badcam");
		// The US threshold is latitude-gated.
		expect(at("US", "2020-06", 60)).toBe("badcam");
		expect(at("US", "2020-06", 40)).toBe("gen2");
		expect(at("DE", "2024-06")).toBe("gen2");
	});

	it("prefers badcam over tripod, and tripod over scout", () => {
		expect(
			detectCameraType(
				meta({ countryCode: "FR", levelId: 0, date: { year: 2024, month: 1, day: 1 } }),
			),
		).toBe("badcam");
		expect(detectCameraType(meta({ levelId: 0, source: "scout" }))).toBe("tripod");
	});

	it("ignores a malformed or absent capture month", () => {
		expect(detectCameraType(meta({ countryCode: "FR", date: null }))).toBe("gen2");
		expect(
			detectCameraType(meta({ countryCode: "FR", date: { year: 2024, month: 13, day: 1 } })),
		).toBe("gen2");
	});
});
