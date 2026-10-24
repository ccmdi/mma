import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@/store/editor";

beforeEach(() => {
	Editor.trail.clear();
});

describe("svTrail", () => {
	it("starts empty", () => {
		expect(Editor.trail.get()).toEqual([]);
	});

	it("Editor.trail.reset sets a single point", () => {
		Editor.trail.reset(10, 20, 0);
		expect(Editor.trail.get()).toEqual([[10, 20]]);
	});

	it("Editor.trail.push appends a point", () => {
		Editor.trail.reset(10, 20, 0);
		Editor.trail.push(30, 40);
		expect(Editor.trail.get()).toEqual([
			[10, 20],
			[30, 40],
		]);
	});

	it("Editor.trail.push deduplicates identical consecutive points", () => {
		Editor.trail.reset(10, 20, 0);
		Editor.trail.push(10, 20);
		expect(Editor.trail.get()).toEqual([[10, 20]]);
	});

	it("Editor.trail.push allows same point after a different one", () => {
		Editor.trail.reset(10, 20, 0);
		Editor.trail.push(30, 40);
		Editor.trail.push(10, 20);
		expect(Editor.trail.get()).toEqual([
			[10, 20],
			[30, 40],
			[10, 20],
		]);
	});

	it("Editor.trail.clear empties the trail", () => {
		Editor.trail.reset(10, 20, 0);
		Editor.trail.push(30, 40);
		Editor.trail.clear();
		expect(Editor.trail.get()).toEqual([]);
	});

	it("Editor.trail.clear on empty trail is a no-op", () => {
		Editor.trail.clear();
		expect(Editor.trail.get()).toEqual([]);
	});

	it("Editor.trail.reset replaces existing trail", () => {
		Editor.trail.reset(10, 20, 0);
		Editor.trail.push(30, 40);
		Editor.trail.reset(50, 60, 0);
		expect(Editor.trail.get()).toEqual([[50, 60]]);
	});

	it("Editor.trail.reset faces the opening heading", () => {
		Editor.trail.reset(10, 20, 90);
		expect(Editor.trail.heading()).toBe(90);
	});

	it("Editor.trail.face turns the tip without moving it", () => {
		Editor.trail.reset(10, 20, 90);
		Editor.trail.face(45);
		expect(Editor.trail.heading()).toBe(45);
		expect(Editor.trail.get()).toEqual([[10, 20]]);
	});
});
