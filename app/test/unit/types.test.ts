import { describe, it, expect } from "vitest";
import { createLocation, isPinned } from "@/types";

describe("createLocation", () => {
	it("applies defaults for omitted fields", () => {
		const loc = createLocation({ lat: 10, lng: 20 });
		expect(loc.lat).toBe(10);
		expect(loc.lng).toBe(20);
		expect(loc.heading).toBe(0);
		expect(loc.pitch).toBe(0);
		expect(loc.zoom).toBe(0);
		expect(loc.panoId).toBeNull();
		expect(loc.flags).toBe(0);
		expect(loc.tags).toEqual([]);
		expect(loc.id).toBe(0);
	});

	it("overrides defaults with provided values", () => {
		const loc = createLocation({
			lat: 40.7,
			lng: -74.0,
			heading: 180,
			pitch: -10,
			zoom: 2,
			panoId: "abc123",
			flags: 1,
			tags: [5, 6],
		});
		expect(loc.heading).toBe(180);
		expect(loc.pitch).toBe(-10);
		expect(loc.zoom).toBe(2);
		expect(loc.panoId).toBe("abc123");
		expect(loc.flags).toBe(1);
		expect(loc.tags).toEqual([5, 6]);
	});

	it("generates a createdAt Unix timestamp (seconds) by default", () => {
		const before = Math.floor(Date.now() / 1000);
		const loc = createLocation({ lat: 0, lng: 0 });
		const after = Math.floor(Date.now() / 1000);
		expect(loc.createdAt).toBeGreaterThanOrEqual(before);
		expect(loc.createdAt).toBeLessThanOrEqual(after);
	});

	it("allows overriding createdAt", () => {
		const ts = Math.floor(Date.UTC(2024, 0, 1) / 1000);
		const loc = createLocation({ lat: 0, lng: 0, createdAt: ts });
		expect(loc.createdAt).toBe(ts);
	});

	it("preserves negative coordinates", () => {
		const loc = createLocation({ lat: -33.8688, lng: -151.2093 });
		expect(loc.lat).toBe(-33.8688);
		expect(loc.lng).toBe(-151.2093);
	});

	it("preserves zero values explicitly passed", () => {
		const loc = createLocation({ lat: 0, lng: 0, heading: 0, pitch: 0, zoom: 0 });
		expect(loc.heading).toBe(0);
		expect(loc.pitch).toBe(0);
		expect(loc.zoom).toBe(0);
	});
});

describe("isPinned", () => {
	it("needs the LoadAsPanoId bit and a pano id", () => {
		const at = (flags: number, panoId: string | null) =>
			isPinned(createLocation({ lat: 0, lng: 0, flags, panoId }));
		expect(at(0, "abc")).toBe(false);
		expect(at(2, "abc")).toBe(false);
		expect(at(1, null)).toBe(false);
		expect(at(1, "")).toBe(false);
		expect(at(1, "abc")).toBe(true);
		expect(at(3, "abc")).toBe(true);
	});
});
