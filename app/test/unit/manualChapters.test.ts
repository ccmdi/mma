import { describe, it, expect } from "vitest";
import { globSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { MANUAL_INDEX } from "@/components/manual/manual-index.gen";

const chaptersDir = path.resolve(import.meta.dirname, "../../src/components/manual/chapters");
const imgDir = path.resolve(import.meta.dirname, "../../../img/manual");
const sources = globSync("*/*.mdx", { cwd: chaptersDir }).map((file) =>
	readFileSync(path.join(chaptersDir, file), "utf8"),
);
const attrs = (pattern: RegExp) =>
	sources.flatMap((s) => [...s.matchAll(pattern)].map((m) => m[1]));

describe("manual chapters", () => {
	it("are each indexed once", () => {
		const ids = MANUAL_INDEX.map((c) => c.id);
		expect(ids.length).toBe(sources.length);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("link only to chapters that exist", () => {
		const ids = new Set(MANUAL_INDEX.map((c) => c.id));
		expect(attrs(/<ChapterLink id="([^"]+)"/g).filter((id) => !ids.has(id))).toEqual([]);
	});

	it("show only screenshots that exist", () => {
		const names = attrs(/<Img name="([^"]+)"/g);
		expect(names.filter((name) => !existsSync(path.join(imgDir, name)))).toEqual([]);
	});
});
