// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { mount as render } from "./fixtures/harness";

const h = vi.hoisted(() => ({
	open: null as { id: number; origin: string; location: Record<string, unknown> } | null,
	hotkeys: new Map<string, () => void>(),
	edits: vi.fn(async () => ({ mutation: { version: 0, keys: [] } })),
	addTo: vi.fn(async () => true),
	dialogs: vi.fn(),
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/editor", () => ({
	Editor: {
		get: () => ({ open: h.open }),
		use: <T,>(select: (s: unknown) => T) => select({ open: h.open }),
	},
}));
vi.mock("@/lib/hooks/useHotkey", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/hooks/useHotkey")>()),
	useHotkey: (key: string, run: () => void) => h.hotkeys.set(key, run),
}));
vi.mock("@/lib/util/hotkeys", () => ({ useBinding: (id: string) => id }));
vi.mock("@/lib/hooks/usePano", () => ({
	usePano: () => ({
		capture: () => ({ lat: 1, lng: 2, heading: 0, pitch: 0, zoom: 1, panoId: "P" }),
	}),
}));
vi.mock("@/components/editor/location/PanoViewerContext", async () => {
	const { Loading } = await import("@/types/util");
	return { usePanoViewer: () => ({ onScreen: new Loading() }) };
});
vi.mock("@/components/editor/location/PanoControls", () => ({ sendHideCar: () => {} }));
vi.mock("@/lib/review/review", () => ({ Review: { useSession: () => null } }));
vi.mock("@/store/edit", () => ({ Edit: { locations: h.edits } }));
vi.mock("@/store/location", () => ({ Location: { addTo: h.addTo, add: async () => {} } }));
vi.mock("@/store/tag", () => ({
	Tag: {
		visible: () => [
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
		],
		names: () => [],
		counts: () => ({}),
	},
}));
vi.mock("@/store/dialogBus", () => ({ openDialog: h.dialogs }));
vi.mock("@/lib/sv/panoDownload", () => ({ downloadPano: async () => {} }));
vi.mock("@/lib/sv/lookup", () => ({ followLinkedPanos: async () => [] }));
vi.mock("@/lib/sv/viewportLock", () => ({ toggleViewportLock: async () => {} }));

import { useLocationHotkeys } from "@/components/editor/location/useLocationHotkeys";
import { useMapKeyBindings } from "@/lib/map/mapKeyBindings";
import "@/store/commandDefs";
import { getCommand } from "@/store/commands";
import type { PendingTags } from "@/lib/data/tags";

const mapKeys = [
	{ key: "t", action: { type: "applyTag" as const, tagId: 1 } },
	{ key: "t", action: { type: "applyTag" as const, tagId: 2 } },
	{ key: "t", action: { type: "applyTag" as const, tagId: 99 } },
	{ key: "d", action: { type: "applyTag" as const, tagId: 99 } },
	{ key: "c", action: { type: "copyToMap" as const, mapId: "other" } },
];

function pressConsumed(key: string): boolean {
	const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
	window.dispatchEvent(e);
	return e.defaultPrevented;
}

function mount(origin: string) {
	h.open = { id: 7, origin, location: { id: 7, lat: 0, lng: 0, tags: [], panoId: "A" } };
	const setPendingTags = vi.fn();
	function Probe() {
		useLocationHotkeys({
			pendingTags: { ids: [], names: [] },
			setPendingTags,
			fullscreenContainerRef: { current: null },
			panoContainerRef: { current: null },
			handleSave: () => {},
			handleClose: () => {},
			handleDelete: () => {},
			handleReturnToSpawn: () => {},
			handleDateChange: () => {},
		});
		useMapKeyBindings(() => mapKeys);
		return null;
	}
	render(createElement(Probe), { attach: false });
	return setPendingTags;
}

afterEach(() => {
	h.hotkeys.clear();
	h.edits.mockClear();
	h.addTo.mockClear();
	h.dialogs.mockClear();
});

describe("location hotkeys on a preview", () => {
	it("toggles all live tags in a group with one pending update", () => {
		const setPendingTags = mount("map");
		expect(pressConsumed("t")).toBe(true);
		expect(setPendingTags).toHaveBeenCalledTimes(1);
		const update = setPendingTags.mock.calls[0][0] as (cur: PendingTags) => PendingTags;
		const partial = { ids: [1, 7], names: ["typed"] };
		const all = update(partial);
		expect(all).toEqual({ ids: [1, 7, 2], names: ["typed"] });
		expect(update(all)).toEqual({ ids: [7], names: ["typed"] });
		expect(update({ ids: [], names: [] })).toEqual({ ids: [1, 2], names: [] });
	});

	it("falls through when every tag in the group is deleted", () => {
		const setPendingTags = mount("map");
		expect(pressConsumed("d")).toBe(false);
		expect(setPendingTags).not.toHaveBeenCalled();
	});
	it.each(["import", "seen"])(
		"a %s preview is not duplicated, copied or tagged",
		async (origin) => {
			const setPendingTags = mount(origin);
			h.hotkeys.get("duplicateLocation")?.();
			expect(pressConsumed("t")).toBe(false);
			expect(pressConsumed("c")).toBe(false);
			void getCommand("quickCopyToMap")!.execute();
			await Promise.resolve();
			expect(getCommand("quickCopyToMap")!.enabled!()).toBe(false);
			expect(h.edits).not.toHaveBeenCalled();
			expect(h.addTo).not.toHaveBeenCalled();
			expect(setPendingTags).not.toHaveBeenCalled();
			expect(h.dialogs).not.toHaveBeenCalled();
		},
	);

	it("a map location is duplicated, copied and tagged", async () => {
		const setPendingTags = mount("map");
		h.hotkeys.get("duplicateLocation")?.();
		expect(pressConsumed("t")).toBe(true);
		expect(pressConsumed("c")).toBe(true);
		void getCommand("quickCopyToMap")!.execute();
		await vi.waitUntil(() => h.addTo.mock.calls.length > 0);
		expect(getCommand("quickCopyToMap")!.enabled!()).toBe(true);
		expect(h.edits).toHaveBeenCalledTimes(1);
		expect(setPendingTags).toHaveBeenCalledTimes(1);
		expect(h.dialogs).toHaveBeenCalledWith("quick-copy-to-map", 7);
	});
});
