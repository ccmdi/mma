// @vitest-environment jsdom
import { describe, it, expect } from "vitest";

vi.mock("@/store/useMapStore", () => ({
	openMap: vi.fn(),
	closeMap: vi.fn(),
	getMapState: () => ({ mapId: null, map: null }),
}));

import { parse, build } from "@/store/router";

const list = { type: "list" } as const;
const editor = (mapId: string) => ({ type: "editor" as const, mapId });

describe("parse", () => {
	it("empty hash", () => {
		expect(parse("")).toEqual({ window: list, manual: null });
		expect(parse("#")).toEqual({ window: list, manual: null });
	});

	it("map only", () => {
		expect(parse("#map/abc-123")).toEqual({ window: editor("abc-123"), manual: null });
	});

	it("manual only", () => {
		expect(parse("#manual")).toEqual({ window: list, manual: "" });
		expect(parse("#manual/getting-started")).toEqual({ window: list, manual: "getting-started" });
	});

	it("map + manual", () => {
		expect(parse("#map/m1/manual")).toEqual({ window: editor("m1"), manual: "" });
		expect(parse("#map/m1/manual/ch2")).toEqual({ window: editor("m1"), manual: "ch2" });
	});

	it("ignores trailing slashes", () => {
		expect(parse("#map/m1/")).toEqual({ window: editor("m1"), manual: null });
	});

	it("bare #map with no id is the list", () => {
		expect(parse("#map")).toEqual({ window: list, manual: null });
	});
});

describe("build", () => {
	it("no map, no manual", () => {
		expect(build({ window: list, manual: null })).toBe("#");
	});

	it("map only", () => {
		expect(build({ window: editor("m1"), manual: null })).toBe("#map/m1");
	});

	it("manual only", () => {
		expect(build({ window: list, manual: "" })).toBe("#manual");
		expect(build({ window: list, manual: "ch" })).toBe("#manual/ch");
	});

	it("map + manual", () => {
		expect(build({ window: editor("m1"), manual: "" })).toBe("#map/m1/manual");
		expect(build({ window: editor("m1"), manual: "ch" })).toBe("#map/m1/manual/ch");
	});
});

describe("parse + build round-trip", () => {
	const cases = [
		{ window: list, manual: null },
		{ window: editor("abc"), manual: null },
		{ window: list, manual: "" },
		{ window: list, manual: "getting-started" },
		{ window: editor("m1"), manual: "" },
		{ window: editor("m1"), manual: "ch2" },
	];
	for (const route of cases) {
		it(`round-trips ${JSON.stringify(route)}`, () => {
			expect(parse(build(route))).toEqual(route);
		});
	}
});
