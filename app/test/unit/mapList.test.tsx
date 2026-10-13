// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, useEffect } from "react";
import { mount as mountRoot } from "./fixtures/harness";
import { Maps } from "@/store/maps";
import { emit } from "@/lib/events";
import { SCRATCH_MAP_ID } from "@/bindings.consts";
import { type MapMeta } from "@/bindings.gen";

const disk = vi.hoisted(() => ({ maps: [] as unknown[] }));
vi.mock("@/lib/commands", async () =>
	(await import("./fixtures/mocks")).cmdProxy({
		storeListMaps: async () => disk.maps,
		storeUpdateMapMeta: async (...args: unknown[]) => {
			const patch = args[0] as { id: string; folder: string | null };
			disk.maps = disk.maps.map((m) =>
				(m as MapMeta).id === patch.id ? { ...(m as MapMeta), folder: patch.folder } : m,
			);
			return { mutation: { version: 0, keys: [] } };
		},
	}),
);
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {}, listen: async () => () => {} }));

const meta = (id: string) => ({ id, name: id }) as MapMeta;

let renders = 0;
let seen: MapMeta[] = [];

function Probe() {
	const list = Maps.useList();
	useEffect(() => {
		seen = list;
		renders++;
	});
	return null;
}

function mount() {
	return mountRoot(<Probe />).unmount;
}

beforeEach(async () => {
	disk.maps = [];
	await Maps.reload();
	renders = 0;
});

// The map list is its own signal, not a slice of the store: every location edit fires
// `snapshot:changed`, and the list must not re-render for any of them.
describe("useMapList subscription granularity", () => {
	it("re-renders on map-list:changed", async () => {
		const unmount = mount();
		expect(renders).toBe(1);

		disk.maps = [meta("a")];
		await act(() => Maps.reload());
		expect(renders).toBe(2);
		expect(seen).toHaveLength(1);
		unmount();
	});

	it("ignores snapshot:changed", () => {
		const unmount = mount();
		expect(renders).toBe(1);

		act(() => emit("snapshot:changed"));
		expect(renders).toBe(1);
		unmount();
	});
});

describe("moving a map into a folder", () => {
	it("writes through the one metadata writer, so the list rereads what was stored", async () => {
		disk.maps = [meta("a"), meta("b")];
		await Maps.reload();
		await Maps.moveToFolder("a", "Europe");
		expect(Maps.list().find((m) => m.id === "a")?.folder).toBe("Europe");
		expect(Maps.list()).toEqual(disk.maps);
	});
});

describe("reserved maps", () => {
	it("matches the reserved id, never a name that happens to look like one", () => {
		expect(Maps.isReserved(SCRATCH_MAP_ID)).toBe(true);
		// A user map merely named "scratch" is theirs, with a name and settings of its own.
		expect(Maps.isReserved("some-uuid")).toBe(false);
		expect(Maps.isReserved(null)).toBe(false);
	});
});
