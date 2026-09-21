import { describe, it, expect } from "vitest";
import { BUILTIN_STYLE_KEYS, builtinStyle, getStyleBackgroundColor } from "@/lib/geo/mapStyles";

describe("built-in style backgrounds", () => {
	it("every styled built-in resolves its own background rather than the default's", () => {
		const fallback = getStyleBackgroundColor("default");
		for (const key of BUILTIN_STYLE_KEYS) {
			if (!builtinStyle(key)?.styles) continue;
			expect(getStyleBackgroundColor(key), key).not.toBe(fallback);
		}
	});

	it("derives the background from the style's base geometry color", () => {
		expect(getStyleBackgroundColor("noir")).toBe("#0a0a0a");
	});

	it("falls back to the default background for a custom style", () => {
		expect(getStyleBackgroundColor("my custom style")).toBe(getStyleBackgroundColor("default"));
	});
});
