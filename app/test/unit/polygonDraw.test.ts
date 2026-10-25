// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { createElement, act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PolygonTools } from "@/components/editor/PolygonTools";
import { MapHost } from "@/lib/map/mapHost";

// px <-> latlng mapping: lat = y/1000, lng = x/1000. jsdom rects are all-zero, so
// clientX/clientY are container coordinates directly.
const div = document.createElement("div");
// The engine's own handlers live on elements it renders inside the container.
const engineSurface = document.createElement("div");
div.appendChild(engineSurface);
document.body.appendChild(div);

let draggableCalls: boolean[] = [];
let overlayUpdates = 0;
const host = {
	container: div,
	getZoom: () => 18,
	containerPxToLatLng: (x: number, y: number) => ({ lat: y / 1000, lng: x / 1000 }),
	setDraggable: (v: boolean) => draggableCalls.push(v),
	setCursor: () => {},
	setDoubleClickZoom: () => {},
} as unknown as MapHost;

let root: Root | null = null;
let toolsEl: HTMLElement;
let freehandPathRef = createRef<number[][] | null>();
let polygonVerticesRef = createRef<number[][] | null>();

function mount(): number[][][][] {
	const drawn: number[][][][] = [];
	toolsEl = document.createElement("div");
	freehandPathRef = createRef<number[][] | null>();
	polygonVerticesRef = createRef<number[][] | null>();
	root = createRoot(toolsEl);
	act(() =>
		root!.render(
			createElement(PolygonTools, {
				host,
				onDraw: (rings: number[][][]) => drawn.push(rings),
				freehandPathRef,
				polygonVerticesRef,
				requestOverlayUpdate: () => overlayUpdates++,
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
	overlayUpdates = 0;
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

describe("polygon preview", () => {
	it("ends at the clicked vertex when the cursor event is stale", () => {
		mount();
		arm("Draw a polygon selection");
		act(() => {
			MapHost.tryInterceptClick(0, 0);
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: 1000, clientY: 1000 }));
			MapHost.tryInterceptClick(2, 2);
		});
		expect(freehandPathRef.current).toEqual([
			[0, 0],
			[2, 2],
			[2, 2],
		]);
	});

	it("keeps following window pointermove when the engine stops emitting map mousemove", () => {
		mount();
		arm("Draw a polygon selection");
		act(() => {
			MapHost.tryInterceptClick(0, 0);
		});
		// Simulate a slight nudge that the engine takes as a pan (no map mousemove or click),
		// followed by moving the cursor to (250, 500).
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: 250, clientY: 500 }));
		});
		expect(freehandPathRef.current).toEqual([
			[0, 0],
			[0.25, 0.5],
		]);
	});
});

describe("polygon vertex editing", () => {
	const pDown = (x: number, y: number) =>
		act(() => {
			div.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: x, clientY: y }));
		});
	const pMove = (x: number, y: number) =>
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
		});
	const pUp = (x = 0, y = 0) =>
		act(() => {
			window.dispatchEvent(new MouseEvent("pointerup", { clientX: x, clientY: y }));
		});
	const key = (k: string) =>
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
			);
		});

	it("removes a vertex on a stationary click and ignores the follow-up map click", () => {
		mount();
		arm("Draw a polygon selection");
		act(() => {
			MapHost.tryInterceptClick(0, 0);
			MapHost.tryInterceptClick(0, 0.125);
			MapHost.tryInterceptClick(0.125, 0.125);
		});
		expect(polygonVerticesRef.current).toEqual([
			[0, 0],
			[0.125, 0],
			[0.125, 0.125],
		]);

		// Click the second vertex at (125, 0) -> (lng 0.125, lat 0).
		pDown(125, 0);
		pMove(126, 1);
		pUp(126, 1);
		expect(MapHost.tryInterceptClick(0, 0.125)).toBe(true);
		expect(polygonVerticesRef.current).toEqual([
			[0, 0],
			[0.125, 0.125],
		]);
	});

	it("drags a vertex past the click slop to reposition it", () => {
		mount();
		arm("Draw a polygon selection");
		act(() => {
			MapHost.tryInterceptClick(0, 0);
			MapHost.tryInterceptClick(0, 0.125);
		});

		pDown(125, 0);
		pMove(250, 125);
		pUp(250, 125);
		expect(polygonVerticesRef.current).toEqual([
			[0, 0],
			[0.25, 0.125],
		]);
	});

	it("still closes on the first vertex when three or more vertices are placed", () => {
		const drawn = mount();
		arm("Draw a polygon selection");
		act(() => {
			MapHost.tryInterceptClick(0, 0);
			MapHost.tryInterceptClick(0, 0.125);
			MapHost.tryInterceptClick(0.125, 0.125);
		});

		// Clicking vertex 0 at (0, 0) must close the polygon rather than delete vertex 0.
		pDown(0, 0);
		pUp(0, 0);
		act(() => {
			MapHost.tryInterceptClick(0, 0);
		});
		expect(drawn).toHaveLength(1);
	});

	it("steps back the last vertex on Backspace", () => {
		mount();
		arm("Draw a polygon selection");
		act(() => {
			MapHost.tryInterceptClick(0, 0);
			MapHost.tryInterceptClick(0, 0.125);
			MapHost.tryInterceptClick(0.125, 0.125);
		});
		key("Backspace");
		expect(polygonVerticesRef.current).toEqual([
			[0, 0],
			[0.125, 0],
		]);
		key("Backspace");
		expect(polygonVerticesRef.current).toEqual([[0, 0]]);
		key("Backspace");
		expect(polygonVerticesRef.current).toBeNull();
		expect(freehandPathRef.current).toBeNull();
	});
});

describe("closing a polygon", () => {
	const armed = () => toolsEl.querySelector("button.is-active") !== null;
	// A press the engine clicked for: the browser's mousedown, then the engine's click.
	const press = (lat: number, lng: number) => {
		down(lng * 1000, lat * 1000);
		act(() => {
			MapHost.tryInterceptClick(lat, lng);
		});
	};
	const doubleClick = () =>
		act(() => {
			engineSurface.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});

	it("closes on a double-click whose second press follows the vertex its first placed", () => {
		const drawn = mount();
		arm("Draw a polygon selection");
		press(0, 0);
		press(0, 1);
		press(1, 1);
		press(1, 0);
		down(0, 1000);
		doubleClick();
		expect(drawn).toHaveLength(1);
		expect(drawn[0][0]).toHaveLength(5);
		expect(armed()).toBe(false);
	});

	it("keeps the vertex a double-click's first press placed when its second press lands on it", () => {
		const drawn = mount();
		arm("Draw a polygon selection");
		press(0, 0);
		press(0, 1);
		press(1, 1);
		press(1, 0);
		act(() => {
			div.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 0, clientY: 1000 }));
			div.dispatchEvent(
				new MouseEvent("mousedown", { button: 0, clientX: 0, clientY: 1000, detail: 2 }),
			);
			window.dispatchEvent(new MouseEvent("pointerup", { clientX: 0, clientY: 1000 }));
		});
		doubleClick();
		expect(drawn).toHaveLength(1);
		expect(drawn[0][0]).toHaveLength(5);
	});

	it("stays open when the double-click pairs a press the engine took as a pan", () => {
		const drawn = mount();
		arm("Draw a polygon selection");
		press(0, 0);
		press(0, 1);
		press(1, 1);
		down(500, 1000);
		press(1, 0.5);
		doubleClick();
		expect(drawn).toHaveLength(0);
		expect(armed()).toBe(true);
		expect(freehandPathRef.current?.slice(0, -1)).toEqual([
			[0, 0],
			[1, 0],
			[1, 1],
			[0.5, 1],
		]);
		press(0, 0);
		expect(drawn).toHaveLength(1);
	});

	it("keeps drawing through a double-click before there are three vertices", () => {
		const drawn = mount();
		arm("Draw a polygon selection");
		press(0, 0);
		press(0, 1);
		down(1000, 0);
		doubleClick();
		expect(drawn).toHaveLength(0);
		expect(armed()).toBe(true);
	});
});

describe("draw tool cleanup", () => {
	it.each(["Freehand polygon selection", "Draw a rectangle selection"])(
		"repaints after disarming %s",
		(label) => {
			mount();
			arm(label);
			down(10, 10);
			move(20, 20);
			expect(freehandPathRef.current).not.toBeNull();
			const updatesBeforeDisarm = overlayUpdates;
			arm(label);
			expect(freehandPathRef.current).toBeNull();
			expect(overlayUpdates).toBe(updatesBeforeDisarm + 1);
		},
	);
});

describe("a finished draw keeps the click that ends it", () => {
	// The engine raises its own click at the end of a claimed stroke, after the tool has disarmed
	// itself. It would otherwise pick a marker or drop a location on coverage.
	it("consumes the click that follows a freehand stroke", () => {
		mount();
		arm("Freehand polygon selection");
		down(10, 10);
		move(200, 10);
		move(200, 200);
		up(200, 200);
		expect(MapHost.tryInterceptClick(0.2, 0.2)).toBe(true);
	});

	it("consumes the click that follows a rectangle drag", () => {
		mount();
		arm("Draw a rectangle selection");
		down(10, 10);
		move(200, 200);
		up(200, 200);
		expect(MapHost.tryInterceptClick(0.2, 0.2)).toBe(true);
	});

	it("consumes the click that follows closing a polygon, and draws nothing more", () => {
		const drawn = mount();
		arm("Draw a polygon selection");
		act(() => {
			MapHost.tryInterceptClick(0, 0);
			MapHost.tryInterceptClick(0, 1);
			MapHost.tryInterceptClick(1, 1);
			MapHost.tryInterceptClick(0, 0);
		});
		expect(drawn).toHaveLength(1);
		expect(MapHost.tryInterceptClick(0, 0)).toBe(true);
		expect(drawn).toHaveLength(1);
	});

	it("releases the claim once a real gesture starts", () => {
		mount();
		arm("Freehand polygon selection");
		down(10, 10);
		move(200, 10);
		move(200, 200);
		up(200, 200);
		down(50, 50);
		expect(MapHost.tryInterceptClick(0.05, 0.05)).toBe(false);
	});
});
