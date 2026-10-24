import { describe, it, expect } from "vitest";
import {
	parseMapQuery,
	mapMatchesQuery,
	labelToken,
	toggleLabelInQuery,
	buildMapTree,
} from "@/components/map-list/mapQuery";
import type { MapMeta } from "@/bindings.gen";

describe("parseMapQuery", () => {
	it("splits plain terms and label: terms", () => {
		expect(parseMapQuery("japan label:comp")).toEqual({ text: ["japan"], labels: ["comp"] });
	});

	it("parses quoted labels with spaces", () => {
		expect(parseMapQuery('label:"west europe" rural')).toEqual({
			text: ["rural"],
			labels: ["west europe"],
		});
	});

	it("lowercases everything and drops empty label terms", () => {
		expect(parseMapQuery('JAPAN label:COMP label:""')).toEqual({
			text: ["japan"],
			labels: ["comp"],
		});
	});

	it("returns empty query for blank input", () => {
		expect(parseMapQuery("  ")).toEqual({ text: [], labels: [] });
	});
});

describe("mapMatchesQuery", () => {
	const match = (q: string, name: string, labels: string[] = []) =>
		mapMatchesQuery(name, labels, parseMapQuery(q));

	it("plain terms match name or labels by substring", () => {
		expect(match("pan", "Japan")).toBe(true);
		expect(match("comp", "Japan", ["competition"])).toBe(true);
		expect(match("xyz", "Japan", ["competition"])).toBe(false);
	});

	it("label terms match labels only, by prefix", () => {
		expect(match("label:comp", "Japan", ["competition"])).toBe(true);
		expect(match("label:comp", "competition")).toBe(false); // name does not count
		expect(match("label:etition", "Japan", ["competition"])).toBe(false); // no mid-label match
	});

	it("terms AND together", () => {
		expect(match("japan label:comp", "Japan", ["competition"])).toBe(true);
		expect(match("japan label:comp", "Japan", ["rural"])).toBe(false);
		expect(match("label:a label:b", "x", ["a", "b"])).toBe(true);
		expect(match("label:a label:b", "x", ["a"])).toBe(false);
	});
});

describe("labelToken / toggleLabelInQuery", () => {
	it("quotes labels containing spaces", () => {
		expect(labelToken("comp")).toBe("label:comp");
		expect(labelToken("west europe")).toBe('label:"west europe"');
	});

	it("toggle adds the token, preserving existing terms", () => {
		expect(toggleLabelInQuery("japan", "comp")).toBe("japan label:comp");
	});

	it("toggle removes the token when present, case-insensitively", () => {
		expect(toggleLabelInQuery("japan label:Comp", "comp")).toBe("japan");
	});

	it("round-trips quoted labels", () => {
		const once = toggleLabelInQuery("", "west europe");
		expect(once).toBe('label:"west europe"');
		expect(toggleLabelInQuery(once, "west europe")).toBe("");
	});
});

describe("buildMapTree", () => {
	const map = (name: string, folder: string | null, locationCount = 10): MapMeta =>
		({
			id: name,
			name,
			folder,
			locationCount,
			createdAt: "2026-01-01",
		}) as MapMeta;

	it("nests `/`-delimited folder paths and rolls up map and location counts", () => {
		const tree = buildMapTree(
			[
				map("Root Map", null, 5),
				map("Austria", "Europe/DACH", 10),
				map("Bavaria", "Europe/DACH/Germany", 20),
				map("France", "Europe", 15),
			],
			["Europe/Nordics"],
			"name",
		);

		expect(tree.rootMaps.map((m) => m.name)).toEqual(["Root Map"]);
		expect(tree.folders).toHaveLength(1);
		const europe = tree.folders[0];
		expect(europe.segment).toBe("Europe");
		expect(europe.fullPath).toBe("Europe");
		expect(europe.mapCount).toBe(3);
		expect(europe.locationCount).toBe(45);
		expect(europe.maps.map((m) => m.name)).toEqual(["France"]);
		expect(europe.children.map((c) => c.fullPath)).toEqual(["Europe/DACH", "Europe/Nordics"]);

		const dach = europe.children[0];
		expect(dach.segment).toBe("DACH");
		expect(dach.mapCount).toBe(2);
		expect(dach.locationCount).toBe(30);
		expect(dach.children[0].fullPath).toBe("Europe/DACH/Germany");
		expect(dach.children[0].mapCount).toBe(1);
		expect(dach.children[0].locationCount).toBe(20);
	});
});
