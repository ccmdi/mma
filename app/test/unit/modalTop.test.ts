import { describe, it, expect } from "vitest";
import { modalTop } from "@/components/primitives/Dialog";

describe("a modal's top edge", () => {
	it("sits slightly above centre, two fifths of the free space above the modal", () => {
		expect(modalTop(200, 1000)).toBe(320);
		expect(modalTop(500, 1000)).toBe(200);
	});

	it("moves up by two fifths of whatever the modal grows by", () => {
		expect(modalTop(300, 1000) - modalTop(400, 1000)).toBe(40);
	});

	it("scales with the window", () => {
		expect(modalTop(200, 800)).toBe(240);
		expect(modalTop(200, 1400)).toBe(480);
	});

	it("never climbs past the top margin", () => {
		expect(modalTop(950, 1000)).toBe(50);
	});
});
