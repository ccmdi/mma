// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { emit } from "@/lib/events";
import { useMapList, setCachedMapList, isReservedMap } from "@/store/mapList";
import { SCRATCH_MAP_ID } from "@/bindings.consts";
import { type MapMeta } from "@/bindings.gen";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const meta = (id: string) => ({ id, name: id }) as MapMeta;

let renders = 0;
let seen: MapMeta[] = [];

function Probe() {
	seen = useMapList();
	renders++;
	return null;
}

function mount() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(<Probe />));
	return () => act(() => root.unmount());
}

beforeEach(() => {
	renders = 0;
	setCachedMapList([]);
});

// The map list is its own signal, not a slice of the store: every location edit fires
// `store:changed`, and the list must not re-render for any of them.
describe("useMapList subscription granularity", () => {
	it("re-renders on map-list:changed", () => {
		const unmount = mount();
		expect(renders).toBe(1);

		act(() => {
			setCachedMapList([meta("a")]);
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
			setCachedMapList([meta("a"), meta("b")]);
			emit("store:changed");
		});
		expect(renders).toBe(1);
		unmount();
	});
});

describe("reserved maps", () => {
	it("matches the reserved id, never a name that happens to look like one", () => {
		expect(isReservedMap(SCRATCH_MAP_ID)).toBe(true);
		// A user map merely named "scratch" is theirs, with a name and settings of its own.
		expect(isReservedMap("some-uuid")).toBe(false);
		expect(isReservedMap(null)).toBe(false);
		expect(isReservedMap(undefined)).toBe(false);
	});
});
