// Benchmark harness for the e2e performance suite. Each case is one user-meaningful
// app operation at a stated scale, sampled `iterations` times after `warmupIterations`
// discarded runs, with process-tree telemetry captured per sample. Results are written
// as versioned JSON keyed by a stable case id so two runs can be diffed (compare.ts).
//
// Benchmarks report; they never assert an absolute time.

import { createWriteStream, promises as fs, readFileSync } from "node:fs";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { cpus, release, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measureProcessTree, telemetrySupported } from "./processTelemetry.ts";
import type { ProcessTreeTelemetry } from "./processTelemetry.ts";

export const SCHEMA_VERSION = 2 as const;
const FIXTURE_COUNTRIES = ["US", "FR", "JP", "BR", "ZA", "AU", "DE", "IN", "CA", "RU"];
const DEFAULT_RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");

export interface DurationSummary {
	mean: number;
	median: number;
	p95: number;
	mad: number;
	sd: number;
	min: number;
	max: number;
}

export interface MetricSummary {
	median: number | null;
	min: number | null;
	max: number | null;
}

export interface TelemetrySummary {
	appCpuMs: MetricSummary;
	containerCpuMs: MetricSummary;
	baselineRssBytes: MetricSummary;
	peakRssBytes: MetricSummary;
	finalRssBytes: MetricSummary;
	baselinePssBytes: MetricSummary;
	peakPssBytes: MetricSummary;
	finalPssBytes: MetricSummary;
	pssDeltaBytes: MetricSummary;
	baselineContainerMemoryBytes: MetricSummary;
	peakContainerMemoryBytes: MetricSummary;
	finalContainerMemoryBytes: MetricSummary;
	maxProcessCount: MetricSummary;
	elapsedWallMs: MetricSummary;
}

export interface BenchmarkRawSample {
	iteration: number;
	durationMs: number;
	operationMs?: number;
	metrics?: Record<string, number>;
	telemetry: ProcessTreeTelemetry;
}

export interface BenchmarkCase {
	/** Join key across runs: `${category}/${route}/${scale}`. */
	id: string;
	route: string;
	category: string;
	scale: string | number;
	sampleCount: number;
	/** Wall time of the whole measured block (operation plus paint/settle). */
	duration: DurationSummary;
	/** The operation itself, where the case can separate it from the settle. */
	operation?: DurationSummary;
	/** Case-specific extra numbers (fps, frame p95, bytes moved, ...). */
	metrics: Record<string, MetricSummary>;
	telemetry: TelemetrySummary;
	rawSamples: BenchmarkRawSample[];
}

export interface BenchmarkEnvironment {
	platform: NodeJS.Platform;
	arch: string;
	nodeVersion: string;
	cpuCount: number;
	effectiveCpuCount: number | null;
	cpuModel: string;
	memoryLimitBytes: number | null;
	appExecutable: string;
	telemetry: boolean;
	ci: boolean;
	commit: string | null;
	label: string | null;
	kernel: string;
	webkitVersion: string | null;
	buildProfile: string;
	seed: number;
	scales: Array<string | number>;
	iterations: number;
	warmupIterations: number;
}

export interface BenchmarkReport {
	schemaVersion: typeof SCHEMA_VERSION;
	generatedAt: string;
	complete: boolean;
	failures: string[];
	environment: BenchmarkEnvironment;
	cases: BenchmarkCase[];
}

export interface BenchmarkMeasurement {
	durationMs: number;
	operationMs?: number;
	metrics?: Record<string, number>;
	/** Temp artifact (e.g. an export file) deleted after the sample is recorded. */
	cleanupPath?: string;
}

export interface RunBenchmarkOptions {
	route: string;
	category: string;
	scale: string | number;
	iterations: number;
	warmupIterations: number;
	setup?: () => Promise<void> | void;
	run: () => Promise<number | BenchmarkMeasurement> | number | BenchmarkMeasurement;
}

export interface BenchmarkFixtureOptions {
	seed: number;
	count: number;
	/** Confine the points to a box, for density-sensitive render cases. */
	cluster?: { lat: number; lng: number; latSpan: number; lngSpan: number };
}

export interface BenchmarkReportPaths {
	report: string;
	latestJson: string;
	latestMarkdown: string;
}

interface FixtureMetadata {
	schemaVersion: typeof SCHEMA_VERSION;
	seed: number;
	count: number;
	cluster: BenchmarkFixtureOptions["cluster"] | null;
}

export function caseId(category: string, route: string, scale: string | number): string {
	return `${category}/${route}/${scale}`;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values: number[], quantile: number): number {
	if (values.length === 0) throw new Error("Cannot calculate a percentile without samples");
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * quantile) - 1];
}

function summarizeMetric(values: Array<number | null | undefined>): MetricSummary {
	const available = values.filter((value): value is number => value != null);
	return {
		median: median(available),
		min: available.length > 0 ? Math.min(...available) : null,
		max: available.length > 0 ? Math.max(...available) : null,
	};
}

export function summarizeDurations(values: number[]): DurationSummary {
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const p50 = median(values)!;
	const deviations = values.map((value) => Math.abs(value - p50));
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
	return {
		mean,
		median: p50,
		p95: percentile(values, 0.95),
		mad: median(deviations)!,
		sd: Math.sqrt(variance),
		min: Math.min(...values),
		max: Math.max(...values),
	};
}

function summarizeTelemetry(samples: BenchmarkRawSample[]): TelemetrySummary {
	const field = <K extends keyof ProcessTreeTelemetry>(key: K) =>
		summarizeMetric(samples.map((sample) => sample.telemetry[key]));
	return {
		appCpuMs: field("appCpuMs"),
		containerCpuMs: field("containerCpuMs"),
		baselineRssBytes: field("baselineRssBytes"),
		peakRssBytes: field("peakRssBytes"),
		finalRssBytes: field("finalRssBytes"),
		baselinePssBytes: field("baselinePssBytes"),
		peakPssBytes: field("peakPssBytes"),
		finalPssBytes: field("finalPssBytes"),
		pssDeltaBytes: summarizeMetric(
			samples.map((sample) => {
				const { baselinePssBytes, peakPssBytes } = sample.telemetry;
				return baselinePssBytes === null || peakPssBytes === null
					? null
					: peakPssBytes - baselinePssBytes;
			}),
		),
		baselineContainerMemoryBytes: field("baselineContainerMemoryBytes"),
		peakContainerMemoryBytes: field("peakContainerMemoryBytes"),
		finalContainerMemoryBytes: field("finalContainerMemoryBytes"),
		maxProcessCount: field("maxProcessCount"),
		elapsedWallMs: field("elapsedWallMs"),
	};
}

function summarizeMetrics(samples: BenchmarkRawSample[]): Record<string, MetricSummary> {
	const keys = new Set(samples.flatMap((sample) => Object.keys(sample.metrics ?? {})));
	const out: Record<string, MetricSummary> = {};
	for (const key of keys) {
		out[key] = summarizeMetric(samples.map((sample) => sample.metrics?.[key]));
	}
	return out;
}

async function sample(
	options: RunBenchmarkOptions,
	record: boolean,
	iteration: number,
): Promise<BenchmarkRawSample | null> {
	await options.setup?.();
	const measured = await measureProcessTree(options.run);
	const value = measured.result;
	const durationMs = typeof value === "number" ? value : value.durationMs;
	if (typeof value !== "number" && value.cleanupPath) {
		await fs.rm(value.cleanupPath, { force: true });
	}
	if (!Number.isFinite(durationMs) || durationMs < 0) {
		throw new Error(`Invalid benchmark duration: ${durationMs}`);
	}
	if (!record) return null;
	return {
		iteration,
		durationMs,
		operationMs: typeof value === "number" ? undefined : value.operationMs,
		metrics: typeof value === "number" ? undefined : value.metrics,
		telemetry: measured.telemetry,
	};
}

/** Run one case: warmups (discarded), then measured iterations. */
export async function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkCase> {
	if (!Number.isInteger(options.iterations) || options.iterations <= 0) {
		throw new Error("Benchmark iterations must be a positive integer");
	}
	if (!Number.isInteger(options.warmupIterations) || options.warmupIterations < 0) {
		throw new Error("Benchmark warmupIterations must be a non-negative integer");
	}

	for (let i = 0; i < options.warmupIterations; i += 1) await sample(options, false, i);
	const rawSamples: BenchmarkRawSample[] = [];
	for (let i = 0; i < options.iterations; i += 1) {
		rawSamples.push((await sample(options, true, i + 1))!);
	}

	const operationSamples = rawSamples
		.map((s) => s.operationMs)
		.filter((value): value is number => value !== undefined);
	return {
		id: caseId(options.category, options.route, options.scale),
		route: options.route,
		category: options.category,
		scale: options.scale,
		sampleCount: rawSamples.length,
		duration: summarizeDurations(rawSamples.map((s) => s.durationMs)),
		operation:
			operationSamples.length === rawSamples.length
				? summarizeDurations(operationSamples)
				: undefined,
		metrics: summarizeMetrics(rawSamples),
		telemetry: summarizeTelemetry(rawSamples),
		rawSamples,
	};
}

// --- Fixtures ---

function createPrng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

async function atomicWrite(file: string, contents: string): Promise<void> {
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temporary, contents, "utf8");
	try {
		await fs.rename(temporary, file);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

async function reusableFixture(file: string, metadata: object): Promise<boolean> {
	try {
		await fs.access(file);
		const existing = JSON.parse(await fs.readFile(`${file}.meta.json`, "utf8")) as object;
		return JSON.stringify(existing) === JSON.stringify(metadata);
	} catch {
		return false;
	}
}

/** Write (or reuse) a deterministic GeoGuessr-shaped fixture. 10% carry
 *  `benchmark-tag` and heading 0, 20% carry a panoId, 25% are informational. */
export async function ensureBenchmarkFixture(
	file: string,
	options: BenchmarkFixtureOptions,
): Promise<string> {
	if (!Number.isInteger(options.count) || options.count < 0) {
		throw new Error("Fixture count must be a non-negative integer");
	}
	if (!Number.isInteger(options.seed)) throw new Error("Fixture seed must be an integer");

	const metadata: FixtureMetadata = {
		schemaVersion: SCHEMA_VERSION,
		seed: options.seed,
		count: options.count,
		cluster: options.cluster ?? null,
	};
	if (await reusableFixture(file, metadata)) return file;

	await fs.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	const stream = createWriteStream(temporary, { encoding: "utf8" });
	const random = createPrng(options.seed);
	const write = async (contents: string): Promise<void> => {
		if (!stream.write(contents)) await once(stream, "drain");
	};
	const box = options.cluster;

	try {
		await write('{"customCoordinates":[');
		for (let index = 0; index < options.count; index += 1) {
			const unpanned = index % 10 === 0;
			const location: Record<string, unknown> = {
				lat: Number((box ? box.lat + random() * box.latSpan : -85 + random() * 170).toFixed(6)),
				lng: Number((box ? box.lng + random() * box.lngSpan : -180 + random() * 360).toFixed(6)),
				heading: unpanned ? 0 : Number((0.001 + random() * 359.998).toFixed(3)),
				extra: {
					countryCode: FIXTURE_COUNTRIES[index % FIXTURE_COUNTRIES.length],
					...(unpanned ? { tags: ["benchmark-tag"] } : {}),
				},
			};
			if (index % 5 === 0) location.panoId = `benchmark-${options.seed}-${index}`;
			if (index % 4 === 0) location.flags = 1;
			await write(`${index === 0 ? "" : ","}${JSON.stringify(location)}`);
		}
		stream.end("]}");
		await once(stream, "finish");
		await fs.rename(temporary, file);
		await atomicWrite(`${file}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`);
	} catch (error) {
		stream.destroy();
		await fs.rm(temporary, { force: true });
		throw error;
	}
	return file;
}

export function benchSeed(): number {
	return Number(process.env.MMA_BENCH_SEED ?? 1337);
}

export async function writeFixture(
	count: number,
	cluster?: BenchmarkFixtureOptions["cluster"],
): Promise<string> {
	const seed = benchSeed();
	const tag = cluster ? "cluster" : "world";
	return ensureBenchmarkFixture(path.join(tmpdir(), `mma-bench-${tag}-${count}-${seed}.json`), {
		seed,
		count,
		cluster,
	});
}

// --- Environment + report output ---

function readCgroupNumber(file: string): number | null {
	try {
		const value = readFileSync(file, "utf8").trim();
		return /^\d+$/.test(value) ? Number(value) : null;
	} catch {
		return null;
	}
}

function readCpuLimit(): number | null {
	try {
		const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
		if (quota === "max") return null;
		const value = Number(quota) / Number(period);
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function commandVersion(command: string, args: string[]): string | null {
	try {
		return execFileSync(command, args, { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

export function collectEnvironment(
	scales: Array<string | number>,
	iterations: number,
	warmupIterations: number,
): BenchmarkEnvironment {
	const cpu = cpus();
	return {
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.version,
		cpuCount: cpu.length,
		effectiveCpuCount: readCpuLimit(),
		cpuModel: cpu[0]?.model ?? "unknown",
		memoryLimitBytes: readCgroupNumber("/sys/fs/cgroup/memory.max"),
		appExecutable: path.basename(process.env.MMA_BENCH_APP_EXE ?? "map-making-app"),
		telemetry: telemetrySupported,
		ci: process.env.CI === "true",
		commit: process.env.MMA_BENCH_REVISION ?? null,
		label: process.env.MMA_BENCH_LABEL ?? null,
		kernel: release(),
		webkitVersion: commandVersion("dpkg-query", ["-W", "-f=${Version}", "libwebkit2gtk-4.1-0"]),
		buildProfile: process.env.MMA_BENCH_BUILD_PROFILE ?? "debug",
		seed: benchSeed(),
		scales,
		iterations,
		warmupIterations,
	};
}

function formatNumber(value: number | null, digits = 1): string {
	return value === null ? "n/a" : value.toFixed(digits);
}

function bytesToMib(value: number | null): number | null {
	return value === null ? null : value / (1024 * 1024);
}

function renderMarkdown(report: BenchmarkReport): string {
	const rows = report.cases.map((c) => {
		const t = c.telemetry;
		return `| ${c.id} | ${c.sampleCount} | ${formatNumber(c.operation?.median ?? null)} | ${formatNumber(c.duration.median)} | ${formatNumber(c.duration.p95)} | ${formatNumber(c.duration.mad)} | ${formatNumber(t.appCpuMs.median)} | ${formatNumber(bytesToMib(t.peakPssBytes.median))} | ${formatNumber(bytesToMib(t.pssDeltaBytes.median))} |`;
	});
	return [
		"# Benchmark results",
		"",
		`Generated: ${report.generatedAt}`,
		`Commit: ${report.environment.commit ?? "unknown"}`,
		`Status: ${report.complete ? "complete" : "incomplete"}`,
		...(report.failures.length > 0 ? ["", ...report.failures.map((f) => `- ${f}`)] : []),
		"",
		"| Case | N | Op ms | Settled ms | P95 ms | MAD ms | App CPU ms | Peak PSS MiB | PSS delta MiB |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...rows,
		"",
	].join("\n");
}

export async function writeBenchmarkReport(report: BenchmarkReport): Promise<BenchmarkReportPaths> {
	const outputDirectory = process.env.MMA_BENCH_OUTPUT_DIR ?? DEFAULT_RESULTS_DIR;
	await fs.mkdir(outputDirectory, { recursive: true });
	const timestamp = report.generatedAt.replace(/[:.]/g, "-");
	const reportFile = path.join(outputDirectory, `benchmark-${timestamp}.json`);
	const latestJson = path.join(outputDirectory, "latest.json");
	const latestMarkdown = path.join(outputDirectory, "latest.md");
	const json = `${JSON.stringify(report, null, 2)}\n`;

	await atomicWrite(reportFile, json);
	if (report.complete) {
		await atomicWrite(latestJson, json);
		await atomicWrite(latestMarkdown, renderMarkdown(report));
	}
	process.stdout.write(
		`${report.complete ? "Benchmark report" : "Incomplete benchmark report"}: ${reportFile}\n`,
	);
	return { report: reportFile, latestJson, latestMarkdown };
}
