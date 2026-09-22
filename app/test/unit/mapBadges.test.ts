import { describe, it, expect } from "vitest";
import { emit } from "@/lib/events";
import type { MapMeta } from "@/bindings.gen";
import { getMapBadges, registerMapBadges, setCachedMapList, type MapBadge } from "@/store/mapList";
import { setSetting } from "@/store/settings";

const badge = (key: string): MapBadge => ({ key, icon: "M0 0", title: key });
const keysOn = (mapId: string) =>
	getMapBadges()
		.get(mapId)
		?.map((b) => b.key);
const map = (id: string, added: number, removed: number, modified: number) =>
	({ id, pending: { added, removed, modified } }) as MapMeta;

describe("map badges", () => {
	it("hides uncommitted changes by default", () => {
		setCachedMapList([map("edited", 3, 0, 1)]);
		emit("map-list:changed");
		expect(keysOn("edited")).toBeUndefined();
	});

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

	it("a map with uncommitted changes carries them as a diff badge, a clean map carries none", () => {
		setSetting("hiddenMapBadges", []);
		setCachedMapList([map("edited", 3, 0, 1), map("clean", 0, 0, 0)]);
		emit("map-list:changed");

		const pending = getMapBadges()
			.get("edited")
			?.find((b) => b.key === "pending");
		expect(pending && "diff" in pending && pending.diff).toEqual({
			added: 3,
			removed: 0,
			modified: 1,
		});
		expect(
			getMapBadges()
				.get("clean")
				?.some((b) => b.key === "pending") ?? false,
		).toBe(false);
	});
});
