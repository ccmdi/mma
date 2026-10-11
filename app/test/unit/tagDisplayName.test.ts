import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tag } from "@/types";

const h = vi.hoisted(() => ({
	settings: { tagViewMode: "list", truncateTagPaths: true },
	tags: [] as Tag[],
}));

vi.mock("@/store/settings", () => ({ getSettings: () => h.settings }));
vi.mock("@/store/tag", () => ({ Tag: { visible: () => h.tags } }));

import { displayTagName } from "@/lib/data/tags";

const tag = (id: number, name: string): Tag => ({
	id,
	name,
	color: "#000",
	visible: true,
	order: null,
	doclinks: [],
});

beforeEach(() => {
	h.settings = { tagViewMode: "list", truncateTagPaths: true };
	h.tags = [];
});

describe("displayTagName", () => {
	it("leaves paths intact outside tree mode or when truncation is disabled", () => {
		h.settings.tagViewMode = "list";
		expect(displayTagName("Europe/France/Paris")).toBe("Europe/France/Paris");
		h.settings.tagViewMode = "tree";
		h.settings.truncateTagPaths = false;
		expect(displayTagName("Europe/France/Paris")).toBe("Europe/France/Paris");
	});

	it("uses the shortest suffix that separates visible tag paths", () => {
		h.settings.tagViewMode = "tree";
		h.tags = [tag(1, "Europe/France/Paris"), tag(2, "USA/Texas/Paris"), tag(3, "USA/Texas/Austin")];

		expect(displayTagName("Europe/France/Paris")).toBe("France/Paris");
		expect(displayTagName("USA/Texas/Paris")).toBe("Texas/Paris");
		expect(displayTagName("USA/Texas/Austin")).toBe("Austin");
	});

	it("falls back to the original name when it is not in the visible tag set", () => {
		h.settings.tagViewMode = "tree";
		h.tags = [tag(1, "Europe/France/Paris")];

		expect(displayTagName("Unknown/Path")).toBe("Unknown/Path");
	});

	it("rebuilds suffixes when the visible tag array changes", () => {
		h.settings.tagViewMode = "tree";
		h.tags = [tag(1, "Europe/France/Paris")];
		expect(displayTagName("Europe/France/Paris")).toBe("Paris");

		h.tags = [...h.tags, tag(2, "USA/Texas/Paris")];
		expect(displayTagName("Europe/France/Paris")).toBe("France/Paris");
	});
});
