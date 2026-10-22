import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameLoop, smoothed } from "@/lib/util/motion";

describe("smoothed", () => {
	it("eases toward its target and lands on it exactly once settled", () => {
		const s = smoothed({ ease: 100, settled: ([gap]) => Math.abs(gap) < 0.01 }, [0]);
		expect(s.step([1], 100)).toBe(true);
		expect(s.value[0]).toBeCloseTo(1 - Math.exp(-1));
		while (s.step([1], 16));
		expect(s.value).toEqual([1]);
	});

	it("springs past a fast target a little and settles on it", () => {
		const s = smoothed(
			{ spring: 0.035, damping: 0.8, settled: (gap, v) => Math.hypot(...gap, ...v) < 1e-6 },
			[0, 0],
		);
		let peak = 0;
		for (let i = 0; i < 200 && s.step([1, 0], 16); i++) peak = Math.max(peak, s.value[0]);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThan(1.05);
		expect(s.value).toEqual([1, 0]);
	});

	it("glides over its time from wherever it was when the target changed", () => {
		const s = smoothed({ glide: 200 }, [0]);
		s.step([10], 0);
		s.step([10], 100);
		expect(s.value[0]).toBeCloseTo(10 * (1 - 0.5 ** 3));
		s.step([20], 16);
		const from = s.value[0];
		expect(s.step([20], 100)).toBe(true);
		expect(s.value[0]).toBeCloseTo(from + (20 - from) * (1 - 0.5 ** 3));
		expect(s.step([20], 100)).toBe(false);
		expect(s.value).toEqual([20]);
	});

	it("lands at once on an infinite step", () => {
		const s = smoothed({ glide: 200 }, [0]);
		expect(s.step([5], Infinity)).toBe(false);
		expect(s.value).toEqual([5]);
	});
});

describe("frameLoop", () => {
	let frames: FrameRequestCallback[] = [];
	const tick = (ms: number) => {
		vi.advanceTimersByTime(ms);
		const due = frames;
		frames = [];
		for (const fn of due) fn(performance.now());
	};
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
		vi.stubGlobal("cancelAnimationFrame", () => (frames = []));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("runs each frame while asked, wakes after a wait, and once per frame however often woken", () => {
		const waits = [0, 0, 500, Infinity];
		const step = vi.fn((_dt: number) => waits.shift() ?? Infinity);
		const loop = frameLoop(step);
		loop.wake();
		loop.wake();
		tick(16);
		expect(step).toHaveBeenCalledOnce();
		expect(step.mock.calls[0][0]).toBe(16);
		tick(16);
		tick(16);
		expect(step).toHaveBeenCalledTimes(3);
		tick(16);
		expect(step).toHaveBeenCalledTimes(3);
		tick(500);
		expect(step).toHaveBeenCalledTimes(4);
		tick(16);
		expect(step).toHaveBeenCalledTimes(4);
		loop.wake();
		loop.stop();
		tick(16);
		expect(step).toHaveBeenCalledTimes(4);
	});
});
