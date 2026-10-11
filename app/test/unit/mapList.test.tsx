// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { act, useEffect } from "react";
import { mount as mountRoot } from "./fixtures/harness";
import { Maps } from "@/store/maps";
import { emit } from "@/lib/events";
import { SCRATCH_MAP_ID } from "@/bindings.consts";
import { type MapMeta } from "@/bindings.gen";

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

beforeEach(() => {
	renders = 0;
	Maps.setList([]);
});

// The map list is its own signal, not a slice of the store: every location edit fires
// `store:changed`, and the list must not re-render for any of them.
describe("useMapList subscription granularity", () => {
	it("re-renders on map-list:changed", () => {
		const unmount = mount();
		expect(renders).toBe(1);

		act(() => {
			Maps.setList([meta("a")]);
			emit("map-list:changed");
		});
		expect(renders).toBe(2);
		expect(seen).toHaveLength(1);
		unmount();
	});

	it("ignores store:changed", () => {
		const unmount = mount();
		expect(renders).toBe(1);

		act(() => {
			Maps.setList([meta("a"), meta("b")]);
			emit("store:changed");
		});
		expect(renders).toBe(1);
		unmount();
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
