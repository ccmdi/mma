import { describe, it, expect } from "vitest";
import { colorForName } from "@/lib/util/color";

// Ground-truth fixtures shared with the Rust source of truth
// (app/src-tauri/src/util.test.rs :: color_for_name_parity_fixtures).
// If either side drifts, one of the two suites goes red. Keep both lists identical.
describe("colorForName parity with Rust Rgb::for_name", () => {
	const fixtures: [string, string][] = [
		["red", "#bf9940"],
		["blue", "#6c40bf"],
		["urban", "#40acbf"],
		["test", "#40bfbd"],
		["hello", "#4fbf40"],
		["Tag 1", "#bf40ae"],
		["café", "#9340bf"],
		["東京", "#bf4071"],
		["", "#407dbf"],
	];
	it.each(fixtures)("colorForName(%j) === %s", (name, expected) => {
		expect(colorForName(name)).toBe(expected);
	});
});
