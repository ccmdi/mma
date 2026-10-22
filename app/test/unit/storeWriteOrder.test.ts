import { Maps } from "@/store/maps";
import { Edit } from "@/store/edit";
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent = vi.hoisted(() => ({
	order: [] as string[],
	release: null as (() => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		onmessage: (e: unknown) => void = () => {};
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	emit: vi.fn(async () => {}),
	listen: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/commands", async () => {
	const { cmdProxy, openMapResult } = await import("./fixtures/mocks");
	return cmdProxy({
		storeOpenMap: async () => openMapResult({}),
		storeEdit: async (...[edits]: unknown[]) => {
			if ("values" in (edits as object)) {
				sent.order.push("values");
				return { version: 0, keys: [] };
			}
			sent.order.push("edit");
			await new Promise<void>((resolve) => (sent.release = resolve));
			return { mutation: { version: 0, keys: [] }, invalidated: [] };
		},
		storeUpdateMapMeta: async () => {
			sent.order.push("meta");
			return null;
		},
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

beforeEach(async () => {
	sent.order = [];
	await Maps.open("m1");
});

describe("store writes", () => {
	it("are sent at once in call order, none waiting for an earlier answer", async () => {
		const edit = Edit.locations({ kind: "map" }, []);
		const values = Edit.values("tags", []);
		const meta = Edit.meta({ name: "Renamed" });
		await vi.waitFor(() => expect(sent.order).toEqual(["edit", "values", "meta"]));
		sent.release!();
		await Promise.all([edit, values, meta]);
	});
});
