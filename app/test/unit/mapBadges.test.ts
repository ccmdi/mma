import { describe, it, expect } from "vitest";
import { emit } from "@/lib/events";
import { getMapBadges, registerMapBadges, type MapBadge } from "@/store/mapList";
import { setSetting } from "@/store/settings";

const badge = (key: string): MapBadge => ({ key, icon: "M0 0", title: key });
const keysOn = (mapId: string) =>
	getMapBadges()
		.get(mapId)
		?.map((b) => b.key);

describe("map badges", () => {
	it("merges every source per map, re-collects on a source's event, and drops a hidden source", () => {
		let linked = ["map-a"];
		registerMapBadges({
			id: "first",
			label: "First",
			events: ["sync-links:changed"],
			collect: () => linked.map((id) => [id, badge("first")]),
		});
		registerMapBadges({
			id: "second",
			label: "Second",
			events: [],
			collect: () => [["map-a", badge("second")]],
		});
		expect(keysOn("map-a")).toEqual(["first", "second"]);

		linked = ["map-b"];
		emit("sync-links:changed");
		expect(keysOn("map-a")).toEqual(["second"]);
		expect(keysOn("map-b")).toEqual(["first"]);

		setSetting("hiddenMapBadges", ["first"]);
		expect(keysOn("map-b")).toBeUndefined();
		expect(keysOn("map-a")).toEqual(["second"]);

		setSetting("hiddenMapBadges", []);
		expect(keysOn("map-b")).toEqual(["first"]);
	});
});
