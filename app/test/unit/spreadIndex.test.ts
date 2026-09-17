import { describe, it, expect } from "vitest";
import { spreadIndex } from "@/plugins/generator/engine/spread";

describe("spreadIndex", () => {
	it("answers nothing without two cells and a count", () => {
		expect(spreadIndex([])).toBeNull();
		expect(spreadIndex([5])).toBeNull();
		expect(spreadIndex([0, 0, 0])).toBeNull();
	});

	it("even counts read as fully spread", () => {
		expect(spreadIndex([4, 4, 4, 4])).toBeCloseTo(1);
	});

	it("everything in one cell reads near zero", () => {
		expect(spreadIndex([100, 0, 0, 0, 0, 0, 0, 0, 0, 0])!).toBeLessThan(0.15);
	});

	it("clustering lowers the index monotonically", () => {
		const even = spreadIndex([10, 10, 10, 10])!;
		const tilted = spreadIndex([25, 10, 3, 2])!;
		const packed = spreadIndex([37, 1, 1, 1])!;
		expect(even).toBeGreaterThan(tilted);
		expect(tilted).toBeGreaterThan(packed);
	});
});
