import { describe, it, expect } from "vitest";
import { selectorForPick } from "@/store/selectorPick";

describe("selectorForPick", () => {
	it("turns each pick into a Selector -- the only language below the UI", () => {
		expect(selectorForPick({ pick: "all" })).toEqual({ type: "Everything" });
		expect(selectorForPick({ pick: "selection" })).toEqual({ type: "Selected" });
	});
});
