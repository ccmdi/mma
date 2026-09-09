/**
 * Throughput per provider, in locations per second, measured against the real release
 * binary and the real network. One case per provider: a fresh map seeded with exactly
 * the columns that provider needs, then a single-provider run timed end to end.
 *
 * Two rates are recorded. `wallPerSec` is rows over total elapsed, which includes the
 * engine's startup and the store write. `ratePerSec` reproduces what the bulk-operation
 * dialog shows: `phaseRate` in `lib/util/util.ts` starts its window at the first progress
 * sample and restarts it whenever a phase resets, so it reads steady-state throughput.
 * The second is the number to compare against what the app displays.
 *
 * Not part of the suite. Run explicitly:
 *   MMA_E2E_BINARY=... npx wdio run wdio.conf.ts --spec test/e2e/providerBench.test.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { closeMap, createAndOpenMap, deleteMap, waitForReady, withApi } from "./helpers";

const FIXTURE = process.env.MMA_BENCH_FIXTURE ?? "E:/tmp/mma-bench/fixture.json";
const OUT = process.env.MMA_BENCH_OUT ?? "E:/tmp/mma-bench/master.json";
const ONLY = (process.env.MMA_BENCH_ONLY ?? "").split(",").filter(Boolean);
const SCALE = Number(process.env.MMA_BENCH_SCALE ?? 50000);

interface FixtureRow {
	lat: number;
	lng: number;
	heading: number;
	panoId: string;
	extra: Record<string, unknown>;
}

/** `keep` is the fixture's `extra` keys a case seeds; everything else is stripped so the
 *  provider under test is the only one with work to do. `pano` seeds the pinned pano id. */
interface Case {
	id: string;
	/** Row cap. Absent means the whole fixture. */
	rows?: number;
	pano: boolean;
	keep: string[];
	/** Bulk entry points that are not registered providers. */
	op?: "pinPano" | "validate";
	/** Plugin id to enable and activate before the case. */
	plugin?: string;
	/** Why this case is capped below the fixture size. */
	why?: string;
}

const SVMETA_KEYS = [
	"panoType",
	"countryCode",
	"cameraType",
	"drivingDirection",
	"uploaderName",
	"imageDate",
	"coverageDates",
];

const CASES: Case[] = [
	{ id: "panoResolve", pano: false, keep: [] },
	{ id: "svMeta", pano: true, keep: [] },
	{
		id: "exactDate",
		rows: 5000,
		pano: true,
		keep: ["imageDate"],
		why: "~35 requests per row, so the full fixture would be 1.75M SingleImageSearch calls",
	},
	{ id: "timezone", pano: true, keep: ["datetime"] },
	{ id: "subdivision", pano: true, keep: [] },
	{ id: "sunPosition", pano: true, keep: ["datetime"], plugin: "sunPosition" },
	{
		id: "weather",
		rows: 3000,
		pano: true,
		keep: ["datetime"],
		plugin: "weather",
		why: "Open-Meteo's free tier is 600 rows/min, so the full fixture is 83 minutes of pure rate limiting",
	},
	{ id: "copyright", rows: 10000, pano: true, keep: [], plugin: "copyright" },
	{ id: "headingRoad", pano: true, keep: [] },
	{ id: "pinPano", pano: true, keep: [], op: "pinPano" },
	{ id: "validate", pano: true, keep: [], op: "validate" },
];

interface Segment {
	ms: number;
	done: number;
}
interface Result {
	id: string;
	rows: number;
	ms: number;
	wallPerSec: number;
	ratePerSec: number | null;
	segments: Segment[];
	succeeded: number;
	failed: number;
	why?: string;
	note?: string;
}

/** The rate of the longest-running phase, which is the provider under test: a run that
 *  reports more than one phase spends nearly all of it in the one being measured, and
 *  picking by row count would tie with the pass in front of it. */
function steadyRate(segments: Segment[]): number | null {
	const best = segments.filter((s) => s.ms > 250 && s.done > 0).sort((a, b) => b.ms - a.ms)[0];
	return best ? Math.round((best.done / best.ms) * 1000 * 10) / 10 : null;
}

describe("provider throughput", () => {
	const fixture: FixtureRow[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
	const results: Result[] = [];

	before(async () => {
		await waitForReady();
		// A provider run is one executeAsync; the default script timeout would abort the
		// slow cases mid-measurement.
		await browser.setTimeout({ script: 4 * 60 * 60_000 });
	});

	after(() => {
		mkdirSync(dirname(OUT), { recursive: true });
		writeFileSync(OUT, JSON.stringify(results, null, 1));
		// eslint-disable-next-line no-console -- this spec is a tool, its output is the point
		console.log(`[bench] wrote ${results.length} results to ${OUT}`);
	});

	for (const c of CASES) {
		if (ONLY.length && !ONLY.includes(c.id)) continue;
		const want = Math.min(c.rows ?? SCALE, SCALE);
		it(`${c.id} over ${want} rows`, async function () {
			this.timeout(4 * 60 * 60_000);
			const rows = fixture.slice(0, want).map((r) => ({
				lat: r.lat,
				lng: r.lng,
				heading: r.heading,
				panoId: c.pano ? r.panoId : null,
				extra: Object.fromEntries(c.keep.map((k) => [k, r.extra[k]])),
			}));
			if (c.plugin) {
				await withApi(async (api, id) => {
					api.setPluginEnabled(id, true);
					api.activatePlugin(id);
				}, c.plugin);
				// A resident sidecar costs its process start and model load on first use.
				// Pay that in a throwaway map so it is not billed to the measured rate.
				const warmId = await createAndOpenMap(`Warm ${c.id}`);
				await withApi(
					async (api, seed, caseId) => {
						await api.addLocations(
							seed.map((v) => api.createLocation({ lat: v.lat, lng: v.lng, panoId: v.panoId })),
						);
						const provider = api.getProviders().find((p) => p.id === caseId);
						if (!provider) return;
						await api.runProviders(
							[{ provider, fields: Object.keys(provider.fieldDefs ?? {}) }],
							{ type: "Everything" },
							{ force: true },
						);
					},
					fixture.slice(0, 5).map((r) => ({ lat: r.lat, lng: r.lng, panoId: r.panoId })),
					c.id,
				);
				await closeMap();
				await deleteMap(warmId);
			}
			const mapId = await createAndOpenMap(`Bench ${c.id}`);
			try {
				// Seeded in slices: the WebDriver request body cannot carry 50k rows at once.
				for (let at = 0; at < rows.length; at += 5000) {
					await withApi(
						async (api, slice) => {
							await api.addLocations(
								slice.map((s) => {
									const loc = api.createLocation({
										lat: s.lat,
										lng: s.lng,
										heading: s.heading,
										...(s.panoId ? { panoId: s.panoId } : {}),
									});
									return Object.keys(s.extra).length ? { ...loc, extra: s.extra } : loc;
								}),
							);
						},
						rows.slice(at, at + 5000),
					);
				}
				const r = await withApi(
					async (api, caseId, op, svmetaKeys) => {
						const everything = { type: "Everything" } as const;

						// phaseRate's window, recorded per phase: a new segment starts when
						// the counters go backwards or the total changes.
						const segs: { t0: number; done0: number; t: number; done: number }[] = [];
						let total = -1;
						const onProgress = (done: number, tot: number) => {
							const cur = segs[segs.length - 1];
							const now = performance.now();
							if (!cur || done < cur.done || tot !== total) {
								total = tot;
								segs.push({ t0: now, done0: done, t: now, done });
								return;
							}
							cur.t = now;
							cur.done = done;
						};

						const t0 = performance.now();
						let succeeded: number;
						let failed: number;
						if (op === "pinPano") {
							const o = await api.bulkPinToPano(everything, { force: true, onProgress });
							succeeded = o.succeeded;
							failed = o.failed.length;
						} else if (op === "validate") {
							const o = await api.validateLocations(everything, { onProgress });
							succeeded = o.succeeded;
							failed = o.failed.length;
						} else {
							const provider = api.getProviders().find((p) => p.id === caseId);
							if (!provider) throw new Error(`no provider '${caseId}' registered`);
							const fields =
								caseId === "svMeta" ? svmetaKeys : Object.keys(provider.fieldDefs ?? {});
							const run = await api.runProviders([{ provider, fields }], everything, {
								force: true,
								onProgress,
							});
							const o = run[caseId];
							succeeded = o?.succeeded ?? 0;
							failed = o?.failed.length ?? 0;
						}
						return {
							ms: performance.now() - t0,
							succeeded,
							failed,
							segments: segs.map((s) => ({
								ms: Math.round(s.t - s.t0),
								done: s.done - s.done0,
							})),
						};
					},
					c.id,
					c.op ?? "",
					SVMETA_KEYS,
				);
				results.push({
					id: c.id,
					rows: rows.length,
					ms: Math.round(r.ms),
					wallPerSec: Math.round((rows.length / r.ms) * 1000 * 10) / 10,
					ratePerSec: steadyRate(r.segments),
					segments: r.segments,
					succeeded: r.succeeded,
					failed: r.failed,
					...(c.why ? { why: c.why } : {}),
				});
			} catch (e) {
				results.push({
					id: c.id,
					rows: rows.length,
					ms: 0,
					wallPerSec: 0,
					ratePerSec: null,
					segments: [],
					succeeded: 0,
					failed: 0,
					note: (e as Error).message,
				});
			} finally {
				await closeMap();
				await deleteMap(mapId);
			}
		});
	}
});
