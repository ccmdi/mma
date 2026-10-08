// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cmd } from "@/lib/commands";
import { getMapState } from "@/store/useMapStore";
import { copyName } from "@/store/mapList";
import { goTo } from "@/store/router";
import { initLocale } from "@/lib/i18n";
import { mountAsync } from "./fixtures/harness";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn() }));
vi.mock("@/store/router", () => ({ goTo: vi.fn() }));
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeDuplicateMap: vi.fn(async (_id: string, name: string) => ({ id: "copy", name })),
		storeListMaps: vi.fn(async () => []),
		storeSaveDirty: vi.fn(async () => null),
		storeCloseMap: vi.fn(async () => null),
		storeImportCancel: vi.fn(async () => null),
	},
}));

const { SaveAsDialog } = await import("@/components/editor/SaveAsDialog");

const input = () => document.querySelector(".modal input") as HTMLInputElement;

async function submit() {
	await act(async () => {
		document
			.querySelector(".modal form")!
			.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}

function type(value: string) {
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
		input().dispatchEvent(new Event("input", { bubbles: true }));
	});
}

beforeAll(async () => {
	await initLocale("en");
});

afterEach(() => {
	const s = getMapState() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
	vi.clearAllMocks();
});

describe("Save as", () => {
	it("names a copy after its map, unnamed or not", () => {
		expect(copyName("Europe")).toBe("Europe (copy)");
		expect(copyName("")).toBe("(unnamed) (copy)");
	});

	it("copies the open map under the chosen name and opens the copy", async () => {
		const s = getMapState() as Record<string, unknown>;
		s.mapId = "m1";
		s.map = { id: "m1", name: "Europe", settings: {} };
		const onOpenChange = vi.fn();
		await mountAsync(<SaveAsDialog open onOpenChange={onOpenChange} />);
		expect(input().value).toBe("Europe (copy)");

		type("  Europe 2  ");
		await submit();

		expect(cmd.storeDuplicateMap).toHaveBeenCalledWith("m1", "Europe 2");
		expect(onOpenChange).toHaveBeenCalledWith(false);
		await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith({ type: "editor", mapId: "copy" }));
		expect(cmd.storeCloseMap).toHaveBeenCalled();
	});
});
