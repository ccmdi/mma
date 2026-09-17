import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// API.md is what a plugin author reads first: stable surfaces before the unstable part, and
// each member's "since" read from the release tags, never guessed.
const apiMd = readFileSync(join(__dirname, "../../../plugins/types/API.md"), "utf8");

describe("the generated API reference", () => {
	it("dates a member by the first release that shipped it", () => {
		expect(apiMd).toMatch(/^### addLocations\n\n`stable` · since v0\.3\.1\n/m);
	});

	it("lists every stable surface before the unstable part", () => {
		const unstableAt = apiMd.indexOf("\n# Unstable surfaces\n");
		expect(unstableAt).toBeGreaterThan(0);
		const before = apiMd.slice(0, unstableAt);
		const after = apiMd.slice(unstableAt);
		expect(after).not.toMatch(/^`stable`/m);
		expect(before).toMatch(/^## Store$/m);
		expect(after).toMatch(/^## Review$/m);
	});

	it("shows signatures as highlighted code, not headings", () => {
		expect(apiMd).toMatch(
			/^### fetchLocations\n\n.*\n\n```ts\nfetchLocations\(selector: Selector\): Promise<Location\[\]>\n```$/m,
		);
	});
});
