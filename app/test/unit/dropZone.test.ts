import { describe, expect, it } from "vitest";
import { dropZone } from "@/lib/util/dom";

describe("dropZone", () => {
	it("drops onto the middle half of a row that takes drops", () => {
		expect([0.1, 0.3, 0.5, 0.7, 0.9].map((at) => dropZone(at, true))).toEqual([
			"before",
			"on",
			"on",
			"on",
			"after",
		]);
	});

	it("splits a row that takes no drops onto it in halves", () => {
		expect([0.1, 0.3, 0.7, 0.9].map((at) => dropZone(at, false))).toEqual([
			"before",
			"before",
			"after",
			"after",
		]);
	});
});
