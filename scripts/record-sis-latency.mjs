#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "app/test/e2e/fixtures/sisLatency.json");

const URL_SIS =
	"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch";

const HELP = `record-sis-latency -- sample real SingleImageSearch latency into a replay fixture.

  node scripts/record-sis-latency.mjs [options]

  --levels 1,2,4,8,16,32,64   concurrency levels to sweep
  --per 40                    requests per level
  --sustain 60                seconds of sustained load after the sweep
  --sustain-level 16          concurrency during the sustained phase
  --out <path>                fixture path (default app/test/e2e/fixtures/sisLatency.json)
  --compact [path]            re-emit an existing fixture with sampled buckets, no network
  --keep 400                  latencies kept per inflight depth when compacting
  --dry                       print the plan and exit, no network

Writes every sample (level, latency, status, verdict) plus per-level percentiles. The
run takes a few minutes and issues real requests to Google; do it once and commit the
fixture. Existing fixtures are merged, so repeated runs on different days accumulate.`;

const POINTS = [
	[40.758, -73.9855],
	[48.8584, 2.2945],
	[51.5007, -0.1246],
	[35.6595, 139.7005],
	[-33.8568, 151.2153],
	[37.8199, -122.4783],
	[41.8902, 12.4922],
	[55.7558, 37.6176],
	[-22.9519, -43.2105],
	[1.2834, 103.8607],
	[19.4326, -99.1332],
	[52.5163, 13.3777],
	[59.9139, 10.7522],
	[-34.6037, -58.3816],
	[25.1972, 55.2744],
	[43.6426, -79.3871],
];

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function body(lat, lng, start, end) {
	return JSON.stringify([
		["apiv3"],
		[[null, null, lat, lng], 50],
		[
			[null, null, null, null, null, null, null, null, null, null, [start, end]],
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			[1],
			null,
			[[[2, true, 2]]],
		],
		[[2, 6]],
	]);
}

/** A probe shaped like the bisection's: a window inside a plausible capture month. */
function probe(seed) {
	const [lat, lng] = POINTS[seed % POINTS.length];
	const year = 2015 + (seed % 9);
	const month = seed % 12;
	const first = Date.UTC(year, month, 1) / 1000;
	const span = [86400, 7 * 86400, 32 * 86400][seed % 3];
	return { lat, lng, start: first, end: first + span };
}

async function one(seed, inflight) {
	const p = probe(seed);
	const t0 = performance.now();
	try {
		const res = await fetch(URL_SIS, {
			method: "POST",
			headers: { "content-type": "application/json+protobuf" },
			body: body(p.lat, p.lng, p.start, p.end),
		});
		const text = await res.text();
		return {
			inflight,
			ms: Math.round(performance.now() - t0),
			status: res.status,
			found: !text.includes("Search returned no images."),
			bytes: text.length,
		};
	} catch (e) {
		return {
			inflight,
			ms: Math.round(performance.now() - t0),
			status: 0,
			found: false,
			bytes: 0,
			error: String(e?.message ?? e),
		};
	}
}

/** Runs `count` requests keeping `level` in flight, recording the true inflight depth
 *  at issue time so replay can model degradation under load. */
async function atLevel(level, count, seed0, samples) {
	let issued = 0;
	let live = 0;
	let seed = seed0;
	await new Promise((done) => {
		const pump = () => {
			while (live < level && issued < count) {
				issued++;
				live++;
				const depth = live;
				void one(seed++, depth).then((s) => {
					samples.push({ level, ...s });
					live--;
					if (issued >= count && live === 0) done();
					else pump();
				});
			}
		};
		pump();
	});
	return seed;
}

async function sustain(level, seconds, seed0, samples) {
	const until = Date.now() + seconds * 1000;
	let seed = seed0;
	let live = 0;
	await new Promise((done) => {
		const pump = () => {
			while (live < level && Date.now() < until) {
				live++;
				const depth = live;
				void one(seed++, depth).then((s) => {
					samples.push({ level, phase: "sustain", ...s });
					live--;
					if (Date.now() >= until && live === 0) done();
					else pump();
				});
			}
			if (live === 0 && Date.now() >= until) done();
		};
		pump();
	});
	return seed;
}

function pct(sorted, p) {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(samples) {
	const byLevel = new Map();
	for (const s of samples) {
		if (!byLevel.has(s.level)) byLevel.set(s.level, []);
		byLevel.get(s.level).push(s);
	}
	return [...byLevel.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([level, rows]) => {
			const ok = rows.filter((r) => r.status === 200).map((r) => r.ms).sort((a, b) => a - b);
			return {
				level,
				n: rows.length,
				ok: ok.length,
				nonOk: rows.filter((r) => r.status !== 200).length,
				p50: pct(ok, 50),
				p90: pct(ok, 90),
				p99: pct(ok, 99),
				min: ok[0] ?? 0,
				max: ok[ok.length - 1] ?? 0,
			};
		});
}

/** Latencies grouped by the true inflight depth at issue time, thinned evenly to `keep`
 *  per depth: the distribution survives, the file stays committable. */
function compact(samples, keep) {
	const byDepth = new Map();
	for (const s of samples) {
		if (s.status !== 200) continue;
		if (!byDepth.has(s.inflight)) byDepth.set(s.inflight, []);
		byDepth.get(s.inflight).push(s.ms);
	}
	return [...byDepth.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([inflight, all]) => {
			all.sort((a, b) => a - b);
			if (all.length <= keep) return { inflight, n: all.length, ms: all };
			const step = all.length / keep;
			const ms = [];
			for (let i = 0; i < keep; i++) ms.push(all[Math.floor(i * step)]);
			return { inflight, n: all.length, ms };
		});
}

/** Merges new depth buckets into whatever the fixture already holds, so successive
 *  recordings (different days, different depths) accumulate instead of replacing. */
function mergeDepths(prior, fresh, keep) {
	const byDepth = new Map();
	for (const d of [...(prior ?? []), ...fresh]) {
		if (!byDepth.has(d.inflight)) byDepth.set(d.inflight, { n: 0, ms: [] });
		const slot = byDepth.get(d.inflight);
		slot.n += d.n;
		slot.ms.push(...d.ms);
	}
	return [...byDepth.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([inflight, slot]) => {
			slot.ms.sort((a, b) => a - b);
			if (slot.ms.length <= keep) return { inflight, n: slot.n, ms: slot.ms };
			const step = slot.ms.length / keep;
			const ms = [];
			for (let i = 0; i < keep; i++) ms.push(slot.ms[Math.floor(i * step)]);
			return { inflight, n: slot.n, ms };
		});
}

function writeFixture(out, runs, samples, keep, priorDepths) {
	fs.mkdirSync(path.dirname(out), { recursive: true });
	const doc = {
		runs,
		byLevel: summarize(samples),
		depths: mergeDepths(priorDepths, compact(samples, keep), keep),
	};
	fs.writeFileSync(out, JSON.stringify(doc, null, "\t") + "\n");
}

async function main() {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(HELP);
		return;
	}
	const levels = arg("levels", "1,2,4,8,16,32,64").split(",").map(Number);
	const per = Number(arg("per", "40"));
	const sustainSecs = Number(arg("sustain", "60"));
	const sustainLevel = Number(arg("sustain-level", "16"));
	const out = path.resolve(ROOT, arg("out", OUT));
	const keep = Number(arg("keep", "400"));

	if (process.argv.includes("--compact")) {
		const src = path.resolve(ROOT, arg("compact", out));
		const prior = JSON.parse(fs.readFileSync(src, "utf8"));
		const samples = prior.samples ?? [];
		if (!samples.length) throw new Error(`${src} carries no raw samples to compact`);
		writeFixture(src, prior.runs ?? [], samples, keep, null);
		console.log(`compacted ${samples.length} samples -> ${path.relative(ROOT, src)}`);
		return;
	}

	if (process.argv.includes("--dry")) {
		console.log(
			`plan: levels ${levels.join(",")} x ${per} = ${levels.length * per} requests, ` +
				`then ${sustainSecs}s sustained at ${sustainLevel} -> ${out}`,
		);
		return;
	}

	const samples = [];
	let seed = Math.floor(Math.random() * 1000);
	for (const level of levels) {
		const t0 = Date.now();
		seed = await atLevel(level, per, seed, samples);
		const rows = samples.filter((s) => s.level === level);
		const ok = rows.filter((r) => r.status === 200).length;
		console.log(
			`level ${String(level).padStart(3)}: ${rows.length} reqs in ${Date.now() - t0}ms, ${ok} ok`,
		);
		await new Promise((r) => setTimeout(r, 2000));
	}
	if (sustainSecs > 0) {
		console.log(`sustaining ${sustainSecs}s at level ${sustainLevel}...`);
		await sustain(sustainLevel, sustainSecs, seed, samples);
	}

	const prior = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
	const runs = [
		...(prior?.runs ?? []),
		{ recordedAt: new Date().toISOString(), levels, per, sustainSecs, sustainLevel },
	];
	writeFixture(out, runs, samples, keep, prior?.depths ?? null);
	console.table(summarize(samples));
	console.log(`wrote ${samples.length} samples -> ${path.relative(ROOT, out)}`);
}

void main();
