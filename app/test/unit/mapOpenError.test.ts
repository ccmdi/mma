import { Maps } from "@/store/maps";
import { Store } from "@/store/store";
import { describe, it, expect, vi } from "vitest";

const open = vi.hoisted(() => ({ fails: true }));

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		onmessage: (e: unknown) => void = () => {};
	},
}));
vi.mock("@/lib/commands", async () => {
	const { cmdProxy, testMap, openMapResult } = await import("./fixtures/mocks");
	return cmdProxy({
		storeGetMap: async () => (open.fails ? null : testMap()),
		storeOpenMap: async () => {
			if (open.fails) throw "map-missing";
			return openMapResult({});
		},
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

describe("a map that fails to open", () => {
	it("records why, and the next open that succeeds clears it", async () => {
		await Maps.open("gone");
		expect(Store.get()).toMatchObject({
			mapId: null,
			map: null,
			openError: "This map no longer exists.",
		});

		open.fails = false;
		await Maps.open("m1");
		expect(Store.get().openError).toBeNull();
		expect(Store.get().map).not.toBeNull();
	});
});
