import { describe, it, expect } from "vitest";
import { RateWindow } from "@/plugins/generator/engine/rateWindow";

const at = (sec: number) => sec * 1000 + 500;

describe("RateWindow", () => {
	it("answers zero before anything happened", () => {
		const w = new RateWindow();
		expect(w.perSecond(at(5))).toBe(0);
		expect(w.inWindow(at(5))).toBe(0);
	});

	it("excludes the second still filling", () => {
		const w = new RateWindow();
		w.add(100, at(0));
		w.add(100, at(1));
		expect(w.inWindow(at(1))).toBe(100);
	});

	it("averages over the window", () => {
		const w = new RateWindow();
		for (let s = 0; s < 5; s++) w.add(200, at(s));
		expect(w.perSecond(at(5))).toBe(200);
	});

	it("counts a quiet second as zero instead of freezing the rate", () => {
		const w = new RateWindow();
		w.add(300, at(0));
		w.add(300, at(1));
		expect(w.perSecond(at(2))).toBe(300);
		expect(w.perSecond(at(4))).toBe(150);
	});

	it("expires counts older than the window", () => {
		const w = new RateWindow();
		w.add(500, at(0));
		w.add(10, at(12));
		expect(w.inWindow(at(13))).toBe(10);
	});

	it("reuses a ring slot without carrying its old count", () => {
		const w = new RateWindow();
		w.add(500, at(0));
		w.add(7, at(11));
		expect(w.inWindow(at(12))).toBe(7);
	});
});
