import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureBenchmarkFixture, summarizeDurations, runBenchmark } from "../perf/benchmarkHarness";

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "mma-benchmark-audit-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
const file = (name = "fixture.json") => path.join(directory, name);
const contents = (target: string) => readFile(target, "utf8");
type Point = {
	lat: number;
	lng: number;
	heading: number;
	panoId?: string;
	flags?: number;
	extra: { countryCode: string; tags?: string[] };
};
const points = async (target: string) =>
	(JSON.parse(await contents(target)) as { customCoordinates: Point[] }).customCoordinates;

describe("benchmark fixtures preserve reproducible workloads", () => {
	it("produces identical bytes for the same seed and different bytes for a different seed", async () => {
		const first = await ensureBenchmarkFixture(file("first.json"), { count: 256, seed: 42 });
		const second = await ensureBenchmarkFixture(file("second.json"), { count: 256, seed: 42 });
		const third = await ensureBenchmarkFixture(file("third.json"), { count: 256, seed: 43 });
		expect(await contents(first)).toBe(await contents(second));
		expect(await contents(third)).not.toBe(await contents(first));
	});
	it("retains a matching cached fixture without rewriting it", async () => {
		const target = await ensureBenchmarkFixture(file(), { count: 10, seed: 42 });
		const before = await stat(target);
		expect(await ensureBenchmarkFixture(target, { count: 10, seed: 42 })).toBe(target);
		const after = await stat(target);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(after.ino).toBe(before.ino);
	});
	it("rebuilds when count, seed or cluster changes", async () => {
		const target = file();
		await ensureBenchmarkFixture(target, { count: 10, seed: 42 });
		await ensureBenchmarkFixture(target, { count: 25, seed: 42 });
		expect(await points(target)).toHaveLength(25);
		const before = await contents(target);
		await ensureBenchmarkFixture(target, { count: 25, seed: 43 });
		expect(await contents(target)).not.toBe(before);
		await ensureBenchmarkFixture(target, {
			count: 25,
			seed: 43,
			cluster: { lat: 20, lng: 30, latSpan: 0.1, lngSpan: 0.2 },
		});
		expect(
			(await points(target)).every(
				(p) => p.lat >= 20 && p.lat <= 20.1 && p.lng >= 30 && p.lng <= 30.2,
			),
		).toBe(true);
	});
	it("recovers from missing or malformed cache metadata", async () => {
		const target = await ensureBenchmarkFixture(file(), { count: 10, seed: 42 });
		const expected = await contents(target);
		await rm(target + ".meta.json");
		await ensureBenchmarkFixture(target, { count: 10, seed: 42 });
		expect(await contents(target)).toBe(expected);
		await writeFile(target + ".meta.json", "{");
		await ensureBenchmarkFixture(target, { count: 10, seed: 42 });
		expect(await contents(target)).toBe(expected);
		expect(JSON.parse(await contents(target + ".meta.json"))).toMatchObject({
			count: 10,
			seed: 42,
		});
	});
	it("preserves geographic ranges and workload proportions at scale", async () => {
		const values = await points(await ensureBenchmarkFixture(file(), { count: 1000, seed: 42 }));
		expect(values).toHaveLength(1000);
		expect(
			values.every(
				(p) =>
					p.lat >= -85 &&
					p.lat <= 85 &&
					p.lng >= -180 &&
					p.lng <= 180 &&
					p.heading >= 0 &&
					p.heading < 360,
			),
		).toBe(true);
		expect(values.filter((p) => p.heading === 0)).toHaveLength(100);
		expect(values.filter((p) => p.extra.tags?.includes("benchmark-tag"))).toHaveLength(100);
		expect(values.filter((p) => p.panoId !== undefined)).toHaveLength(200);
		expect(values.filter((p) => p.flags === 1)).toHaveLength(250);
		expect(new Set(values.filter((p) => p.panoId).map((p) => p.panoId)).size).toBe(200);
		expect(new Set(values.map((p) => p.extra.countryCode)).size).toBe(10);
	});
	it("writes a valid empty workload", async () => {
		expect(await points(await ensureBenchmarkFixture(file(), { count: 0, seed: 0 }))).toEqual([]);
	});
	it.each([-1, 1.5, NaN, Infinity])("rejects invalid row count %s", async (count) => {
		await expect(ensureBenchmarkFixture(file(), { count, seed: 42 })).rejects.toThrow(
			"non-negative integer",
		);
	});
	it.each([1.5, NaN, Infinity])("rejects invalid seed %s", async (seed) => {
		await expect(ensureBenchmarkFixture(file(), { count: 1, seed })).rejects.toThrow("integer");
	});
});

describe("benchmark sampling and summaries", () => {
	it("uses numeric ordering, even medians and population standard deviation", () => {
		const values = [100, 1, 10, 2];
		const before = [...values];
		const summary = summarizeDurations(values);
		expect(summary).toMatchObject({ mean: 28.25, median: 6, p95: 100, mad: 4.5, min: 1, max: 100 });
		expect(summary.sd).toBeCloseTo(
			Math.sqrt(((100 - 28.25) ** 2 + (1 - 28.25) ** 2 + (10 - 28.25) ** 2 + (2 - 28.25) ** 2) / 4),
		);
		expect(values).toEqual(before);
	});
	it("summarizes one zero-duration sample without introducing NaN", () => {
		expect(summarizeDurations([0])).toEqual({
			mean: 0,
			median: 0,
			p95: 0,
			mad: 0,
			sd: 0,
			min: 0,
			max: 0,
		});
	});
	it("discards warmups and runs setup for every sample", async () => {
		const setup = vi.fn();
		const run = vi
			.fn()
			.mockReturnValueOnce(1000)
			.mockReturnValueOnce(2000)
			.mockReturnValueOnce(10)
			.mockReturnValueOnce(20);
		const result = await runBenchmark({
			category: "fixture",
			route: "read",
			scale: 100,
			iterations: 2,
			warmupIterations: 2,
			setup,
			run,
		});
		expect(setup).toHaveBeenCalledTimes(4);
		expect(run).toHaveBeenCalledTimes(4);
		expect(result.id).toBe("fixture/read/100");
		expect(result.sampleCount).toBe(2);
		expect(result.duration).toMatchObject({ median: 15, min: 10, max: 20 });
		expect(result.rawSamples.map((s) => [s.iteration, s.durationMs])).toEqual([
			[1, 10],
			[2, 20],
		]);
	});
	it.each([-1, NaN, Infinity])("rejects invalid measured duration %s", async (value) => {
		await expect(
			runBenchmark({
				category: "fixture",
				route: "read",
				scale: 1,
				iterations: 1,
				warmupIterations: 0,
				run: () => value,
			}),
		).rejects.toThrow("Invalid benchmark duration");
	});
	it("does not emit a partial report after a sample fails", async () => {
		const run = vi.fn().mockReturnValueOnce(10).mockRejectedValueOnce(new Error("sample failed"));
		await expect(
			runBenchmark({
				category: "fixture",
				route: "read",
				scale: 1,
				iterations: 3,
				warmupIterations: 0,
				run,
			}),
		).rejects.toThrow("sample failed");
		expect(run).toHaveBeenCalledTimes(2);
	});
});
