import { describe, expect, it } from "vitest";
import { analyzeTimeline, type NetEntry } from "../e2e/svLatency";
const entry = (queued: number, start: number, end: number, depth = 999): NetEntry => ({
	kind: "fixture",
	queued,
	start,
	end,
	depth,
	ms: 999,
});

describe("request timeline metrics describe actual load", () => {
	it("ignores unfinished requests and returns finite zero metrics for empty input", () => {
		const empty = analyzeTimeline([]);
		expect(Object.values(empty).every((value) => value === 0)).toBe(true);
		expect(analyzeTimeline([entry(1, 2, 0)])).toEqual(empty);
	});
	it("measures a single completed request independently of reported depth and latency", () => {
		expect(analyzeTimeline([entry(10, 10, 30)])).toEqual({
			requests: 1,
			spanMs: 20,
			rps: 50,
			meanInflight: 1,
			peakInflight: 1,
			meanOffered: 1,
			peakOffered: 1,
			meanQueueMs: 0,
			idleMs: 0,
			idlePct: 0,
			p50Ms: 20,
			p90Ms: 20,
		});
	});
	it("separates queue saturation from served concurrency", () => {
		expect(analyzeTimeline([entry(100, 110, 130), entry(105, 130, 150)])).toEqual({
			requests: 2,
			spanMs: 50,
			rps: 40,
			meanInflight: 0.8,
			peakInflight: 1,
			meanOffered: 1.5,
			peakOffered: 2,
			meanQueueMs: 17.5,
			idleMs: 10,
			idlePct: 20,
			p50Ms: 20,
			p90Ms: 20,
		});
	});
	it("computes idle gaps and treats touching requests as non-overlapping", () => {
		const result = analyzeTimeline([
			entry(100, 100, 110),
			entry(110, 110, 120),
			entry(140, 140, 150),
		]);
		expect(result).toMatchObject({
			spanMs: 50,
			meanInflight: 0.6,
			peakInflight: 1,
			idleMs: 20,
			idlePct: 40,
		});
	});
	it("weights concurrency by time rather than averaging reported request depth", () => {
		expect(analyzeTimeline([entry(100, 100, 200, 1), entry(110, 110, 120, 2)])).toMatchObject({
			meanInflight: 1.1,
			peakInflight: 2,
			meanOffered: 1.1,
			peakOffered: 2,
		});
	});
	it("handles zero-duration completed requests without NaN or infinite throughput", () => {
		const result = analyzeTimeline([entry(100, 100, 100)]);
		expect(Object.values(result).every(Number.isFinite)).toBe(true);
		expect(result).toMatchObject({ requests: 1, spanMs: 1, p50Ms: 0, p90Ms: 0, peakInflight: 0 });
	});
	it("falls back to start time when a queue timestamp is absent", () => {
		expect(analyzeTimeline([entry(0, 100, 120)])).toEqual(analyzeTimeline([entry(100, 100, 120)]));
	});
	it("calculates latency percentiles numerically", () => {
		const durations = [1, 2, 10, 20, 30, 40, 50, 60, 90, 100];
		expect(
			analyzeTimeline(durations.map((duration) => entry(100, 100, 100 + duration))),
		).toMatchObject({ p50Ms: 40, p90Ms: 100 });
	});
	it("is invariant to arrival ordering and does not mutate the input", () => {
		const values = [entry(100, 110, 130), entry(105, 130, 150), entry(106, 120, 140)];
		const before = structuredClone(values);
		expect(analyzeTimeline([...values].reverse())).toEqual(analyzeTimeline(values));
		expect(values).toEqual(before);
	});
	it.each([1, 8, 64, 512])(
		"agrees with a discrete independent load oracle for %i requests",
		(count) => {
			const values = Array.from({ length: count }, (_, i) =>
				entry(100 + (i % 13), 100 + (i % 13) + (i % 5), 100 + (i % 13) + (i % 5) + 1 + (i % 7)),
			);
			const first = Math.min(...values.map((value) => value.queued));
			const last = Math.max(...values.map((value) => value.end));
			const ticks = Array.from({ length: last - first }, (_, i) => first + i);
			const served = ticks.map(
				(t) => values.filter((value) => value.start <= t && value.end > t).length,
			);
			const offered = ticks.map(
				(t) => values.filter((value) => value.queued <= t && value.end > t).length,
			);
			const result = analyzeTimeline(values);
			expect(result.meanInflight).toBe(
				Number((served.reduce((a, b) => a + b, 0) / ticks.length).toFixed(2)),
			);
			expect(result.meanOffered).toBe(
				Number((offered.reduce((a, b) => a + b, 0) / ticks.length).toFixed(2)),
			);
			expect(result.peakInflight).toBe(Math.max(...served));
			expect(result.peakOffered).toBe(Math.max(...offered));
			expect(result.idleMs).toBe(served.filter((n) => n === 0).length);
		},
	);
});
