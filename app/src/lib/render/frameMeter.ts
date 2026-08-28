// Rolling frame-timing sampler shared by Stats for Nerds (live view) and the
// perf harness (window.__mmaPerf recorder) - one measurement source, two readers.
// rAF deltas approximate main-thread frame pacing; longtasks catch jank bursts.

const CAP = 600; // rolling window, ~10s at 60fps

export interface FrameStats {
	/** Frames sampled since the last reset (not capped by the window). */
	frames: number;
	fps: number;
	p50: number;
	p95: number;
	worst: number;
	longTasks: number;
	longTaskMs: number;
	elapsedMs: number;
}

/** Nearest-rank percentile over an ascending-sorted array. */
export function percentile(sorted: ArrayLike<number>, q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1);
	return sorted[Math.max(0, idx)];
}

export class FrameMeterCore {
	private samples = new Float64Array(CAP);
	private pushed = 0;
	private longTasks = 0;
	private longTaskMs = 0;
	private startedAt: number;
	private now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
		this.startedAt = this.now();
	}

	push(deltaMs: number) {
		this.samples[this.pushed % CAP] = deltaMs;
		this.pushed++;
	}

	pushLongTask(durationMs: number) {
		this.longTasks++;
		this.longTaskMs += durationMs;
	}

	reset() {
		this.pushed = 0;
		this.longTasks = 0;
		this.longTaskMs = 0;
		this.startedAt = this.now();
	}

	stats(): FrameStats {
		const count = Math.min(this.pushed, CAP);
		// TypedArray#toSorted is numeric by default, unlike Array#sort.
		const arr = this.samples.subarray(0, count).toSorted();
		const sum = arr.reduce((a, b) => a + b, 0);
		return {
			frames: this.pushed,
			fps: sum > 0 ? Math.round((count / sum) * 1000) : 0,
			p50: percentile(arr, 0.5),
			p95: percentile(arr, 0.95),
			worst: arr.at(-1) ?? 0,
			longTasks: this.longTasks,
			longTaskMs: this.longTaskMs,
			elapsedMs: this.now() - this.startedAt,
		};
	}
}

const core = new FrameMeterCore();
let refs = 0;
let raf = 0;
let last = 0;
let observer: PerformanceObserver | null = null;
let probe: (() => void) | null = null;

/** Per-frame sync probe (e.g. gl.finish()). rAF deltas only measure the main
 *  thread; a saturated GPU queues frames while rAF keeps near-vsync pace. The
 *  probe blocks until the GPU drains, making deltas reflect true frame cost.
 *  Harness-only - never enable during normal use. */
export function setFrameProbe(fn: (() => void) | null) {
	probe = fn;
}

function tick(ts: number) {
	if (last > 0) core.push(ts - last);
	last = ts;
	probe?.();
	raf = requestAnimationFrame(tick);
}

/** Refcounted: the dialog and the harness can overlap without fighting. */
export function startFrameMeter() {
	if (refs++ > 0) return;
	last = 0;
	core.reset();
	raf = requestAnimationFrame(tick);
	try {
		observer = new PerformanceObserver((list) => {
			for (const e of list.getEntries()) core.pushLongTask(e.duration);
		});
		observer.observe({ type: "longtask", buffered: false });
	} catch {
		observer = null; // longtask entry type unsupported
	}
}

export function stopFrameMeter() {
	if (refs === 0 || --refs > 0) return;
	cancelAnimationFrame(raf);
	raf = 0;
	observer?.disconnect();
	observer = null;
}

export function resetFrameMeter() {
	core.reset();
	last = 0;
}

export function frameStats(): FrameStats {
	return core.stats();
}
