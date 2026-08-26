import { describe, it, expect } from "vitest";
import { fillTemplate } from "@/lib/util/format";

describe("fillTemplate", () => {
	it("substitutes known placeholders and leaves unknown ones as written", () => {
		expect(fillTemplate("{value}", { value: "2019", field: "Year" })).toBe("2019");
		expect(fillTemplate("Camera/{value}", { value: "gen4", field: "Camera" })).toBe("Camera/gen4");
		expect(fillTemplate("{field}: {value}", { value: "US", field: "Country" })).toBe("Country: US");
		expect(fillTemplate("{nope}/{value}", { value: "x", field: "f" })).toBe("{nope}/x");
	});
});
