// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";
import { act, useRef } from "react";
import { mount as mountRoot } from "./fixtures/harness";
import { useHoverExpand } from "@/lib/hooks/useHoverExpand";

const DELAY = 250;
const BOX = { left: 0, top: 0, right: 100, bottom: 100 } as DOMRect;

let api: ReturnType<typeof useHoverExpand>;

function Probe() {
	const ref = useRef<HTMLDivElement>(null);
	api = useHoverExpand(ref, DELAY);
	return <div ref={ref} data-testid="box" />;
}

let unmount: () => void;

beforeEach(() => {
	vi.useFakeTimers();
	const mounted = mountRoot(<Probe />);
	const box = mounted.container.querySelector("div")!;
	box.getBoundingClientRect = () => BOX;
	unmount = mounted.unmount;
});

afterEach(() => {
	unmount();
	vi.useRealTimers();
});

const enter = (buttons = 0) =>
	act(() => api.hoverProps.onPointerEnter({ buttons } as React.PointerEvent));
const leave = () => act(() => api.hoverProps.onPointerLeave());
const pointerDown = () => act(() => api.hoverProps.onPointerDown());
const pointerUpAt = (clientX: number, clientY: number) =>
	act(() => {
		document.dispatchEvent(new MouseEvent("pointerup", { clientX, clientY }));
	});

describe("useHoverExpand", () => {
	it("expands on enter and collapses after the delay on leave", async () => {
		enter();
		expect(api.expanded).toBe(true);

		leave();
		expect(api.expanded).toBe(true);
		await act(() => vi.advanceTimersByTime(DELAY));
		expect(api.expanded).toBe(false);
	});

	it("ignores an enter while a mouse button is held, so panning across it does not open it", () => {
		enter(1);
		expect(api.expanded).toBe(false);
		enter();
		expect(api.expanded).toBe(true);
	});

	it("re-entering cancels a pending close", async () => {
		enter();
		leave();
		enter();
		await act(() => vi.advanceTimersByTime(DELAY));
		expect(api.expanded).toBe(true);
	});

	it("collapses when a drag releases outside, with no leave event", async () => {
		enter();
		pointerDown();
		pointerUpAt(500, 500);
		await act(() => vi.advanceTimersByTime(DELAY));
		expect(api.expanded).toBe(false);
	});

	it("stays open for the whole drag, however far it wanders", async () => {
		enter();
		pointerDown();
		leave();
		await act(() => vi.advanceTimersByTime(DELAY * 4));
		expect(api.expanded).toBe(true);

		pointerUpAt(500, 500);
		await act(() => vi.advanceTimersByTime(DELAY));
		expect(api.expanded).toBe(false);
	});

	it("stays open when a drag releases inside", async () => {
		enter();
		pointerDown();
		pointerUpAt(50, 50);
		await act(() => vi.advanceTimersByTime(DELAY));
		expect(api.expanded).toBe(true);
	});
});
