import { describe, it, expect } from "vitest";
import { emit } from "@/lib/events";
import { getMapBadges, registerMapBadges, type MapBadge } from "@/store/mapList";

const badge = (key: string): MapBadge => ({ key, icon: "M0 0", title: key });

describe("map badges", () => {
	it("merges every source per map and re-collects when a source's event fires", () => {
		let linked = ["map-a"];
		registerMapBadges(() => linked.map((id) => [id, badge("first")]), ["sync-links:changed"]);
		registerMapBadges(() => [["map-a", badge("second")]], []);

		expect(
			getMapBadges()
				.get("map-a")
				?.map((b) => b.key),
		).toEqual(["first", "second"]);

		linked = ["map-b"];
		emit("sync-links:changed");
		expect(
			getMapBadges()
				.get("map-a")
				?.map((b) => b.key),
		).toEqual(["second"]);
		expect(
			getMapBadges()
				.get("map-b")
				?.map((b) => b.key),
		).toEqual(["first"]);
	});
});
