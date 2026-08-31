// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { createElement, act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PolygonTools } from "@/components/editor/PolygonTools";
import type { MapHost } from "@/lib/map/host";

// px <-> latlng mapping: lat = y/1000, lng = x/1000. jsdom rects are all-zero, so
// clientX/clientY are container coordinates directly.
const div = document.createElement("div");
// The engine's own handlers live on elements it renders inside the container.
const engineSurface = document.createElement("div");
div.appendChild(engineSurface);
document.body.appendChild(div);

let draggableCalls: boolean[] = [];
const host = {
	container: div,
	getZoom: () => 18,
	containerPxToLatLng: (x: number, y: number) => ({ lat: y / 1000, lng: x / 1000 }),
	setDraggable: (v: boolean) => draggableCalls.push(v),
	setCursor: () => {},
	setDoubleClickZoom: () => {},
	on: () => () => {},
} as unknown as MapHost;

let root: Root | null = null;
let toolsEl: HTMLElement;

function mount(): number[][][][] {
	const drawn: number[][][][] = [];
	toolsEl = document.createElement("div");
	root = createRoot(toolsEl);
	act(() =>
		root!.render(
			createElement(PolygonTools, {
				host,
				onDraw: (rings: number[][][]) => drawn.push(rings),
				freehandPathRef: createRef<number[][] | null>(),
				polygonVerticesRef: createRef<number[][] | null>(),
				requestOverlayUpdate: () => {},
			}),
		),
	);
	return drawn;
}

function arm(label: string) {
	const button = toolsEl.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
	act(() => button.click());
}

const down = (x: number, y: number) =>
	act(() => {
		engineSurface.dispatchEvent(
			new MouseEvent("mousedown", { button: 0, clientX: x, clientY: y, bubbles: true }),
		);
	});
const move = (x: number, y: number) =>
	act(() => {
		window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
	});
const up = (x: number, y: number) =>
	act(() => {
		window.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y }));
	});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	draggableCalls = [];
});

describe("draw tools leave the map interactive", () => {
	// The engine resolves `draggable: false` to gestureHandling "none", which takes wheel
	// zoom and the keyboard with it. Only the stroke's own gesture may be claimed.
	it("never disables the host's gestures while freehand is armed", () => {
		mount();
		arm("Freehand polygon selection");
		down(10, 10);
		move(200, 10);
		move(200, 200);
		up(200, 200);
		expect(draggableCalls).toEqual([]);
	});

	it("never disables the host's gestures while the rectangle tool is armed", () => {
		mount();
		arm("Draw a rectangle selection");
		down(10, 10);
		move(200, 200);
		up(200, 200);
		expect(draggableCalls).toEqual([]);
	});

	it("keeps the engine from seeing the stroke's mousedown, so no pan starts", () => {
		mount();
		let seen = 0;
		const engineHandler = () => seen++;
		engineSurface.addEventListener("mousedown", engineHandler);
		arm("Freehand polygon selection");
		down(10, 10);
		up(10, 10);
		engineSurface.removeEventListener("mousedown", engineHandler);
		expect(seen).toBe(0);
	});

	it("leaves mousedown alone when no tool is armed", () => {
		mount();
		let seen = 0;
		const engineHandler = () => seen++;
		engineSurface.addEventListener("mousedown", engineHandler);
		down(10, 10);
		engineSurface.removeEventListener("mousedown", engineHandler);
		expect(seen).toBe(1);
	});
});

describe("draw tools still produce their ring", () => {
	it("freehand commits the stroke and disarms", () => {
		const drawn = mount();
		arm("Freehand polygon selection");
		down(10, 10);
		move(200, 10);
		move(200, 200);
		up(200, 200);
		expect(drawn).toHaveLength(1);
		// Closed ring: first vertex repeated last.
		const ring = drawn[0][0];
		expect(ring[0]).toEqual(ring[ring.length - 1]);
		// Disarmed: a second stroke draws nothing.
		down(10, 10);
		move(200, 10);
		move(200, 200);
		up(200, 200);
		expect(drawn).toHaveLength(1);
	});

	it("rectangle commits the dragged box and drops a degenerate one", () => {
		const drawn = mount();
		arm("Draw a rectangle selection");
		down(10, 10);
		move(200, 200);
		up(200, 200);
		expect(drawn).toHaveLength(1);

		arm("Draw a rectangle selection");
		down(10, 10);
		move(10, 200);
		up(10, 200);
		expect(drawn).toHaveLength(1);
	});
});
