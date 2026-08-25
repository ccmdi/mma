// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/events", () => ({
	emit: () => {},
	useEventValue: (_: string, get: () => unknown) => get(),
	subscribeMany: () => () => {},
	LOCATION_DATA_EVENTS: [],
}));
vi.mock("@/store/useMapStore", () => ({
	useMapState: (sel: (s: { map: null }) => unknown) => sel({ map: null }),
}));
vi.mock("@/lib/commands", () => ({ cmd: {} }));

import {
	startMeasure,
	endMeasure,
	getMeasurePoints,
	useMeasureInteraction,
} from "@/lib/sv/measure";
import { addClickInterceptor, tryInterceptClick } from "@/lib/map/mapState";
import type { MapHost } from "@/lib/map/host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("click interceptor priority", () => {
	it("calls the most recently registered interceptor first", () => {
		const calls: string[] = [];
		const off1 = addClickInterceptor(() => {
			calls.push("first");
			return true;
		});
		const off2 = addClickInterceptor(() => {
			calls.push("second");
			return true;
		});
		expect(tryInterceptClick(0, 0)).toBe(true);
		expect(calls).toEqual(["second"]);
		off2();
		expect(tryInterceptClick(0, 0)).toBe(true);
		expect(calls).toEqual(["second", "first"]);
		off1();
	});
});

// px <-> latlng mapping: lat = y/1000, lng = x/1000. jsdom rects are all-zero, so
// clientX/clientY are container coordinates directly.
const div = document.createElement("div");
document.body.appendChild(div);
const host = {
	container: div,
	getZoom: () => 18,
	containerPxToLatLng: (x: number, y: number) => ({ lat: y / 1000, lng: x / 1000 }),
	setDraggable: () => {},
	setCursor: () => {},
} as unknown as MapHost;

function Probe() {
	useMeasureInteraction(host);
	return null;
}

let root: Root | null = null;
function mountMeasuring(at: { lat: number; lng: number }) {
	startMeasure(at);
	root = createRoot(document.createElement("div"));
	act(() => root!.render(createElement(Probe)));
}

const down = (x: number, y: number) =>
	div.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: x, clientY: y }));
const move = (x: number, y: number) =>
	window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
const up = () => window.dispatchEvent(new MouseEvent("pointerup"));

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	endMeasure();
});

describe("measure drag then click", () => {
	it("a drag whose click never fires does not swallow the next click", () => {
		mountMeasuring({ lat: 0.01, lng: 0.01 });

		// Drag node 0 from (10,10) to (200,10); the engine drops the click after movement.
		down(10, 10);
		move(200, 10);
		up();
		expect(getMeasurePoints()).toEqual([[0.2, 0.01]]);

		// Next gesture on empty map: its click must place a point, not be eaten.
		down(300, 10);
		up();
		expect(tryInterceptClick(0.01, 0.3)).toBe(true);
		expect(getMeasurePoints()).toEqual([
			[0.2, 0.01],
			[0.3, 0.01],
		]);
	});

	it("still suppresses the click of a stationary press on a node", () => {
		mountMeasuring({ lat: 0.01, lng: 0.01 });

		down(10, 10);
		up();
		// The engine does fire a click for a stationary press; it must not add a point.
		expect(tryInterceptClick(0.01, 0.01)).toBe(true);
		expect(getMeasurePoints()).toEqual([[0.01, 0.01]]);
	});
});

describe("measure Escape layering", () => {
	const escape = () =>
		div.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);

	it("leaves the measurement alone when a capture-phase handler consumed Escape", () => {
		mountMeasuring({ lat: 0.01, lng: 0.01 });
		const consume = (e: KeyboardEvent) => e.preventDefault();
		document.addEventListener("keydown", consume, true);
		escape();
		document.removeEventListener("keydown", consume, true);
		expect(getMeasurePoints()).toEqual([[0.01, 0.01]]);
	});

	it("ends the measurement on an unconsumed Escape", () => {
		mountMeasuring({ lat: 0.01, lng: 0.01 });
		escape();
		expect(getMeasurePoints()).toEqual([]);
	});
});
