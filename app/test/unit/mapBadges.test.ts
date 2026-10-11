import { describe, it, expect } from "vitest";
import { Maps, type MapBadge } from "@/store/maps";
import { emit } from "@/lib/events";
import type { MapMeta } from "@/bindings.gen";
import { setSetting } from "@/store/settings";

const badge = (key: string): MapBadge => ({ key, icon: "M0 0", title: key });
const keysOn = (mapId: string) =>
	Maps.badges()
		.get(mapId)
		?.map((b) => b.key);
const map = (id: string, added: number, removed: number, updated: number) =>
	({ id, pending: { added, removed, updated } }) as MapMeta;

describe("map badges", () => {
	it("hides pending changes when the source is configured as hidden", () => {
		setSetting("hiddenMapBadges", ["pending"]);
		Maps.setList([map("edited", 3, 0, 1)]);
		emit("map-list:changed");
		expect(keysOn("edited")).toBeUndefined();
	});

	it("merges every source per map, re-collects on a source's event, and drops a hidden source", () => {
		let linked = ["map-a"];
		Maps.registerBadges({
			id: "first",
			label: "First",
			events: ["sync-links:changed"],
			collect: () => linked.map((id) => [id, badge("first")]),
		});
		Maps.registerBadges({
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
		Maps.setList([map("edited", 3, 0, 1), map("clean", 0, 0, 0)]);
		emit("map-list:changed");

		const pending = Maps.badges()
			.get("edited")
			?.find((b) => b.key === "pending");
		expect(pending && "diff" in pending && pending.diff).toEqual({
			added: 3,
			removed: 0,
			updated: 1,
		});
		expect(
			Maps.badges()
				.get("clean")
				?.some((b) => b.key === "pending") ?? false,
		).toBe(false);
	});
});
