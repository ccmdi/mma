// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Swatch } from "@/components/primitives/Swatch";

describe("Swatch", () => {
	it("draws an RGB tuple or a CSS color on the color-block class", () => {
		expect(renderToStaticMarkup(<Swatch color={[1, 2, 3]} />)).toBe(
			'<span class="color-block" style="background-color:rgb(1, 2, 3)"></span>',
		);
		expect(renderToStaticMarkup(<Swatch color="#abcdef" size="sm" round />)).toBe(
			'<span class="color-block color-block--sm color-block--round" style="background-color:#abcdef"></span>',
		);
	});
});
