import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESIZE_EASING, RESIZE_MS } from "@/components/primitives/Dialog";

const STYLES = readFileSync(join(__dirname, "../../src/styles.css"), "utf8");

function token(name: string): string {
	const match = STYLES.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m"));
	if (!match) throw new Error(`--${name} is not defined in styles.css`);
	return match[1].trim();
}

describe("css tokens", () => {
	it("dialog height easing matches the slow motion tokens", () => {
		expect(`${RESIZE_MS}ms`).toBe(token("dur-slow"));
		expect(RESIZE_EASING).toBe(token("ease-standard"));
	});
});
