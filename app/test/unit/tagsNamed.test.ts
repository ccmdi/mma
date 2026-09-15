import { describe, expect, it } from "vitest";
import { tagsNamed } from "@/lib/data/tagsNamed";
import type { Tag } from "@/bindings.gen";

const tag = (id: number, name: string): Tag => ({
	id,
	name,
	color: "#000000",
	visible: true,
	order: id,
});

const registry = [tag(1, "Old"), tag(2, "Middle"), tag(3, "New")];

describe("tagsNamed", () => {
	it("keeps the order the names were given, not the registry's", () => {
		expect(tagsNamed(["New", "Old"], registry).map((t) => t.id)).toEqual([3, 1]);
	});

	it("matches names case-insensitively and skips unknown or repeated names", () => {
		expect(tagsNamed(["new", "missing", "NEW", "middle"], registry).map((t) => t.id)).toEqual([
			3, 2,
		]);
	});
});
