// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { distanceUnit, fillTemplate, formatDistance, unitSystem } from "@/lib/util/format";
import { setSetting } from "@/store/settings";

describe("fillTemplate", () => {
	it("substitutes known placeholders and leaves unknown ones as written", () => {
		expect(fillTemplate("{value}", { value: "2019", field: "Year" })).toBe("2019");
		expect(fillTemplate("Camera/{value}", { value: "gen4", field: "Camera" })).toBe("Camera/gen4");
		expect(fillTemplate("{field}: {value}", { value: "US", field: "Country" })).toBe("Country: US");
		expect(fillTemplate("{nope}/{value}", { value: "x", field: "f" })).toBe("{nope}/x");
	});
});

describe("formatDistance", () => {
	it("reads metres below a kilometre and kilometres above it", () => {
		setSetting("units", "metric");
		expect(formatDistance(0)).toBe("0 m");
		expect(formatDistance(500)).toBe("500 m");
		expect(formatDistance(999)).toBe("999 m");
		expect(formatDistance(1000)).toBe("1 km");
		expect(formatDistance(1500)).toBe("1.5 km");
		expect(formatDistance(50_000)).toBe("50 km");
		expect(formatDistance(123_456)).toBe("123.46 km");
	});

	it("reads feet below a thousand and miles above them", () => {
		setSetting("units", "imperial");
		expect(formatDistance(0)).toBe("0 ft");
		expect(formatDistance(100)).toBe("328 ft");
		expect(formatDistance(304)).toBe("997 ft");
		expect(formatDistance(305)).toBe("0.19 mi");
		expect(formatDistance(1609.344)).toBe("1 mi");
		expect(formatDistance(123_456)).toBe("76.71 mi");
	});

	it("honours a fraction-digit cap on the large unit only", () => {
		setSetting("units", "metric");
		expect(formatDistance(12_340, 0)).toBe("12 km");
		expect(formatDistance(12_600, 0)).toBe("13 km");
		expect(formatDistance(12.4, 0)).toBe("12 m");
		expect(formatDistance(12.34, 2)).toBe("12.34 m");
		setSetting("units", "imperial");
		expect(formatDistance(12_340, 0)).toBe("8 mi");
	});

	it("auto follows the system locale's region", () => {
		setSetting("units", "auto");
		// jsdom reports en-US.
		expect(unitSystem()).toBe("imperial");
	});
});

describe("distanceUnit", () => {
	it("is identity under metric", () => {
		setSetting("units", "metric");
		expect(distanceUnit("m").label).toBe("m");
		expect(distanceUnit("km").toDisplay(2.5)).toBe(2.5);
		expect(distanceUnit("km").fromDisplay(2.5)).toBe(2.5);
	});

	it("converts a fixed unit per base under imperial", () => {
		setSetting("units", "imperial");
		const m = distanceUnit("m");
		const km = distanceUnit("km");
		expect(m.label).toBe("ft");
		expect(km.label).toBe("mi");
		expect(m.toDisplay(100)).toBe(328);
		expect(km.toDisplay(10)).toBe(6.21);
	});

	it("round-trips a displayed value back to a stored metric one", () => {
		setSetting("units", "imperial");
		const m = distanceUnit("m");
		expect(m.toDisplay(m.fromDisplay(3280))).toBe(3280);
		const km = distanceUnit("km");
		expect(km.toDisplay(km.fromDisplay(6.21))).toBe(6.21);
	});
});
