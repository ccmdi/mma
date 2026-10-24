import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "@/store/store";
import { Edit } from "@/store/edit";
import { Autosave } from "@/store/autosave";
import { Feed } from "@/store/feed";
import type { ChangeEvent, MapMeta } from "@/bindings.gen";
import type { MapDetails } from "@/store/store";
import { cmd } from "@/lib/commands";
import { mapStorage, pluginSetting } from "@/plugins/pluginStorage";
import { metadataWritten } from "./fixtures/mocks";

vi.mock("@/store/maps", () => ({
	Maps: { setList: vi.fn(), invalidate: vi.fn(async () => {}), reload: vi.fn(async () => {}) },
}));

const feed = vi.hoisted(() => ({ deliver: (_e: unknown) => {} }));
vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		onmessage: (e: unknown) => void = () => {};
	},
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeUpdateMapMeta: vi.fn(async (patch: unknown) =>
			(await import("./fixtures/mocks")).metadataWritten(patch),
		),
		storeSaveDirty: vi.fn(async () => null),
	},
}));

function openMap(id: string, settings: MapMeta["settings"] = {}) {
	const s = Store.get() as Record<string, unknown>;
	s.mapId = id;
	s.map = { id, settings };
}

/** Each write waits on a promise the test settles, and lands in the map state only then. */
function holdWrites() {
	const pending: (() => void)[] = [];
	vi.mocked(cmd.storeUpdateMapMeta).mockImplementation(
		(patch) =>
			new Promise((resolve) => pending.push(() => void metadataWritten(patch).then(resolve))),
	);
	return async () => {
		await vi.waitUntil(() => pending.length > 0);
		pending.shift()?.();
		await new Promise((r) => setTimeout(r));
	};
}

const sentSettings = () =>
	vi.mocked(cmd.storeUpdateMapMeta).mock.calls.map(([patch]) => patch.settings);

beforeEach(() => openMap("a"));

afterEach(async () => {
	vi.mocked(cmd.storeUpdateMapMeta).mockImplementation(async (patch) =>
		(await import("./fixtures/mocks")).metadataWritten(patch),
	);
	await Autosave.flush();
	const s = Store.get() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
	vi.clearAllMocks();
});

describe("map metadata writes", () => {
	it("go out whole and at once, in call order", async () => {
		const settle = holdWrites();
		const sentIds = () => vi.mocked(cmd.storeUpdateMapMeta).mock.calls.map(([patch]) => patch.id);
		const writes = [Edit.meta({ id: "a", name: "first" }), Edit.meta({ id: "b", name: "second" })];
		await new Promise((r) => setTimeout(r));
		expect(sentIds()).toEqual(["a", "b"]);
		await settle();
		await settle();
		await Promise.all(writes);
	});

	it("carry only the settings keys they change, so writes made back to back both land", async () => {
		const settle = holdWrites();
		const writes = [
			Edit.meta({ settings: { searchRadius: 50 } }),
			Edit.meta({ settings: { exportZoom: true } }),
		];
		for (const _ of writes) await settle();
		await Promise.all(writes);
		expect(sentSettings()).toEqual([{ searchRadius: 50 }, { exportZoom: true }]);
		expect(Store.get().map?.settings).toMatchObject({ searchRadius: 50, exportZoom: true });
	});

	it("replaces settings from a complete metadata row on the change feed", () => {
		openMap("a", { searchRadius: 50 });
		const before = Store.get().map!;
		const next = { ...before, settings: { exportZoom: true } } as MapDetails;
		Store.apply([{ op: "replace", path: "/map", value: next }], 1);
		expect(Store.get().map).toBe(next);
		expect(Store.get().map?.settings).toEqual({ exportZoom: true });
	});

	it("on the open map settle as a mutation, scheduling the save that persists them", async () => {
		const channel = Feed.channel();
		feed.deliver = (e) => channel.onmessage(e as ChangeEvent);
		Feed.seed(0);
		vi.mocked(cmd.storeUpdateMapMeta).mockImplementationOnce(async (patch) => {
			await metadataWritten(patch);
			feed.deliver({ version: 1, added: [], removed: [], updated: [], patch: [] });
			return { version: 1, keys: [] };
		});
		vi.useFakeTimers();
		await Edit.meta({ id: "a", name: "first" });
		expect(cmd.storeSaveDirty).not.toHaveBeenCalled();
		await vi.runAllTimersAsync();
		expect(cmd.storeSaveDirty).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});

describe("mapStorage", () => {
	it("keeps each plugin's values in the open map's settings", async () => {
		openMap("a", { pointAlongRoad: false });
		await mapStorage("gen").set("tag", "Europe");
		await mapStorage("heat").set("layers", [1]);

		expect(mapStorage("gen").get("tag")).toBe("Europe");
		expect(mapStorage("gen").keys()).toEqual(["tag"]);
		expect(sentSettings()).toEqual([
			{ pluginData: { gen: { put: { tag: { set: "Europe" } } } } },
			{ pluginData: { heat: { put: { layers: { set: [1] } } } } },
		]);
		expect(Store.get().map?.settings.pointAlongRoad).toBe(false);
	});

	it("preserves JSON null and sends overlapping writes as independent key patches", async () => {
		const settle = holdWrites();
		const writes = [mapStorage("gen").set("nullable", null), mapStorage("gen").set("count", 2)];
		await settle();
		await settle();
		await Promise.all(writes);

		expect(mapStorage("gen").get("nullable", "fallback")).toBeNull();
		expect(sentSettings()).toEqual([
			{ pluginData: { gen: { put: { nullable: { set: null } } } } },
			{ pluginData: { gen: { put: { count: { set: 2 } } } } },
		]);
	});

	it("gives every map its own values", async () => {
		await mapStorage("gen").set("tag", "Europe");
		openMap("b");
		expect(mapStorage("gen").get("tag", "none")).toBe("none");
	});

	it("removes only the named key", async () => {
		await mapStorage("gen").set("tag", "Europe");
		await mapStorage("gen").remove("tag");
		expect(sentSettings().at(-1)).toEqual({
			pluginData: { gen: { put: { tag: { remove: null } } } },
		});
	});

	it("reads a write back at once, before the map saves it", async () => {
		const settle = holdWrites();
		const setting = pluginSetting("gen", "tag", "none").perMap();
		const seen: string[] = [];
		const off = setting.on((v) => seen.push(v));
		const write = mapStorage("gen").set("tag", "Europe");
		expect(mapStorage("gen").get("tag")).toBe("Europe");
		expect(seen).toEqual(["Europe"]);
		await settle();
		await write;
		off();
		expect(setting.get()).toBe("Europe");
		expect(seen).toEqual(["Europe"]);
	});

	it("keeps the newest write while an older one lands", async () => {
		const settle = holdWrites();
		const writes = [mapStorage("gen").set("count", 1), mapStorage("gen").set("count", 2)];
		await settle();
		expect(mapStorage("gen").get("count")).toBe(2);
		await settle();
		await Promise.all(writes);
		expect(mapStorage("gen").get("count")).toBe(2);
	});

	it("reads the saved value again when a write fails", async () => {
		openMap("a", { pluginData: { gen: { tag: "Europe" } } });
		vi.mocked(cmd.storeUpdateMapMeta).mockRejectedValueOnce(new Error("disk full"));
		const write = mapStorage("gen").set("tag", "Asia");
		expect(mapStorage("gen").get("tag")).toBe("Asia");
		await expect(write).rejects.toThrow("disk full");
		expect(mapStorage("gen").get("tag")).toBe("Europe");
	});

	it("throws with no map open", () => {
		const s = Store.get() as Record<string, unknown>;
		s.mapId = null;
		s.map = null;
		expect(() => mapStorage("gen").get("tag")).toThrow("No map is open");
		expect(() => mapStorage("gen").set("tag", 1)).toThrow("No map is open");
	});
});
