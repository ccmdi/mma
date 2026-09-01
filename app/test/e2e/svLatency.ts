import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SvNetModel } from "./svMockCore";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SIS_LATENCY_FIXTURE = path.join(HERE, "fixtures/sisLatency.json");

/** The recorded network, or null when replay is off / the fixture is absent. Replay is
 *  opt-in (MMA_E2E_SV_REPLAY) so the ordinary suite keeps its zero-latency mock. */
export function loadNetModel(force = false): SvNetModel | null {
	if (!force && !process.env.MMA_E2E_SV_REPLAY) return null;
	if (!fs.existsSync(SIS_LATENCY_FIXTURE)) return null;
	const doc = JSON.parse(fs.readFileSync(SIS_LATENCY_FIXTURE, "utf8")) as {
		depths?: { inflight: number; n?: number; ms: number[] }[];
	};
	const depths = (doc.depths ?? []).filter((d) => d.ms.length > 0);
	return depths.length ? { depths } : null;
}

export interface NetEntry {
	kind: string;
	queued: number;
	start: number;
	end: number;
	depth: number;
	ms: number;
}

export interface NetStats {
	requests: number;
	spanMs: number;
	/** Requests per second over the span: the number a throughput claim rests on. */
	rps: number;
	/** Time-weighted concurrency the network actually served. */
	meanInflight: number;
	peakInflight: number;
	/** Concurrency the engine asked for, queueing included. Offered far above served
	 *  means the width is imaginary: the requests exist, the endpoint is not running them. */
	meanOffered: number;
	peakOffered: number;
	/** Mean milliseconds a request spent waiting for a slot. */
	meanQueueMs: number;
	/** Milliseconds with nothing in flight: the engine's own stalls, not the network's. */
	idleMs: number;
	idlePct: number;
	p50Ms: number;
	p90Ms: number;
}

/** Time-weighted mean and peak of the intervals' overlap. */
function concurrency(spans: { a: number; b: number }[], t0: number, span: number) {
	const edges: { t: number; d: number }[] = [];
	for (const s of spans) edges.push({ t: s.a, d: 1 }, { t: s.b, d: -1 });
	edges.sort((x, y) => x.t - y.t || x.d - y.d);
	let live = 0;
	let peak = 0;
	let area = 0;
	let idle = 0;
	let prev = t0;
	for (const e of edges) {
		if (e.t > prev) {
			area += live * (e.t - prev);
			if (live === 0) idle += e.t - prev;
			prev = e.t;
		}
		live += e.d;
		if (live > peak) peak = live;
	}
	return { mean: area / span, peak, idle };
}

/** Reduces a request timeline to the shape of the load it made. Concurrency is derived
 *  from the intervals themselves (a +1/-1 sweep), never from what the engine claims. */
export function analyzeTimeline(entries: NetEntry[]): NetStats {
	const done = entries.filter((e) => e.end > 0);
	if (!done.length) {
		return {
			requests: 0,
			spanMs: 0,
			rps: 0,
			meanInflight: 0,
			peakInflight: 0,
			meanOffered: 0,
			peakOffered: 0,
			meanQueueMs: 0,
			idleMs: 0,
			idlePct: 0,
			p50Ms: 0,
			p90Ms: 0,
		};
	}
	const t0 = Math.min(...done.map((e) => e.queued || e.start));
	const t1 = Math.max(...done.map((e) => e.end));
	const span = Math.max(1, t1 - t0);

	const served = concurrency(
		done.map((e) => ({ a: e.start, b: e.end })),
		t0,
		span,
	);
	const offered = concurrency(
		done.map((e) => ({ a: e.queued || e.start, b: e.end })),
		t0,
		span,
	);
	const lat = done.map((e) => e.end - e.start).sort((a, b) => a - b);
	const queue = done.reduce((sum, e) => sum + Math.max(0, e.start - (e.queued || e.start)), 0);
	return {
		requests: done.length,
		spanMs: span,
		rps: Number(((done.length / span) * 1000).toFixed(2)),
		meanInflight: Number(served.mean.toFixed(2)),
		peakInflight: served.peak,
		meanOffered: Number(offered.mean.toFixed(2)),
		peakOffered: offered.peak,
		meanQueueMs: Number((queue / done.length).toFixed(1)),
		idleMs: served.idle,
		idlePct: Number(((served.idle / span) * 100).toFixed(1)),
		p50Ms: lat[lat.length >> 1] ?? 0,
		p90Ms: lat[Math.floor(lat.length * 0.9)] ?? 0,
	};
}
