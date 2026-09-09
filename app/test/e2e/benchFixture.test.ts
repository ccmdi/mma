/**
 * Builds the provider-benchmark fixture: real rows on real Street View coverage, each
 * carrying a panoId, the metadata svMeta derives, and a synthetic capture datetime.
 * Written once on master and consumed unchanged by both sides of the A/B, so every
 * provider does identical work on identical input.
 *
 * Official coverage only. A photosphere has no baked Google copyright and no driving
 * direction, so a fixture full of them lets the tile-reading providers exit early and
 * reports a throughput no real map would see.
 *
 * Not part of the suite. Run explicitly:
 *   MMA_E2E_BINARY=... npx wdio run wdio.conf.ts --spec test/e2e/benchFixture.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createAndOpenMap, closeMap, deleteMap, waitForReady, withApi } from "./helpers";

const OUT = process.env.MMA_BENCH_FIXTURE ?? "E:/tmp/mma-bench/fixture.json";
const WANT = Number(process.env.MMA_BENCH_FIXTURE_ROWS ?? 50000);
const OVERSAMPLE = Number(process.env.MMA_BENCH_OVERSAMPLE ?? 6);
/** Suburban boxes across many countries: dense enough road coverage for a 50m search to
 *  land often, official enough to look like a real map rather than a city-centre
 *  photosphere field. */
const BOXES: [number, number, number, number][] = [
	[59.2, 59.45, 17.8, 18.25],
	[55.6, 55.8, 12.4, 12.7],
	[48.7, 49.0, 2.1, 2.6],
	[52.35, 52.65, 13.1, 13.7],
	[51.35, 51.65, -0.35, 0.15],
	[53.3, 53.6, -2.4, -2.1],
	[40.6, 40.9, -74.15, -73.85],
	[41.75, 42.05, -87.9, -87.6],
	[34.0, 34.25, -118.5, -118.1],
	[47.5, 47.75, -122.4, -122.15],
	[45.4, 45.6, -73.75, -73.5],
	[-33.95, -33.75, 151.0, 151.3],
	[-37.9, -37.7, 144.85, 145.15],
	[35.6, 35.8, 139.5, 139.85],
	[37.45, 37.65, 126.85, 127.1],
	[-23.65, -23.45, -46.75, -46.5],
	[-34.7, -34.5, -58.55, -58.35],
	[52.3, 52.45, 4.8, 5.05],
	[41.3, 41.5, 2.0, 2.25],
	[45.4, 45.6, 9.1, 9.3],
];
const SVMETA_KEYS = [
	"panoType",
	"countryCode",
	"cameraType",
	"drivingDirection",
	"uploaderName",
	"imageDate",
	"coverageDates",
];

describe("bench fixture", () => {
	let mapId = "";

	before(async () => {
		await waitForReady();
		// Resolving hundreds of thousands of seeds is one executeAsync; the default
		// script timeout would abort it partway.
		await browser.setTimeout({ script: 4 * 60 * 60_000 });
		mapId = await createAndOpenMap("Bench Fixture");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it(`writes ${WANT} official rows to ${OUT}`, async function () {
		this.timeout(4 * 60 * 60_000);
		// Seeds are generated inside the page: 300k points do not fit in a WebDriver
		// request body.
		const resolved = await withApi(
			async (api, boxes, seedCount, metaKeys) => {
				let s = 987654321;
				const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
				for (let done = 0; done < seedCount;) {
					const batch = Math.min(50000, seedCount - done);
					const locs = [];
					for (let i = 0; i < batch; i++) {
						const b = boxes[Math.floor(rnd() * boxes.length)];
						locs.push(
							api.createLocation({
								lat: b[0] + rnd() * (b[1] - b[0]),
								lng: b[2] + rnd() * (b[3] - b[2]),
							}),
						);
					}
					await api.addLocations(locs);
					done += batch;
				}
				const everything = { type: "Everything" } as const;
				const run = async (id: string, fields: string[]) => {
					const provider = api.getProviders().find((p) => p.id === id);
					if (!provider) throw new Error(`no provider '${id}'`);
					await api.runProviders([{ provider, fields }], everything, { force: true });
				};
				await run("panoResolve", []);
				await run("svMeta", metaKeys);
				const all = await api.fetchLocations(everything);
				const withPano = all.filter((l) => l.panoId).length;
				const withDate = all.filter((l) => l.extra?.imageDate).length;
				const keep = all.filter(
					(l) => l.panoId && l.extra?.imageDate && String(l.extra?.panoType) === "2",
				);
				return {
					total: all.length,
					withPano,
					withDate,
					official: keep.length,
					sample: all.slice(0, 2).map((l) => ({ panoId: l.panoId, extra: l.extra })),
				};
			},
			BOXES,
			WANT * OVERSAMPLE,
			SVMETA_KEYS,
		);
		// eslint-disable-next-line no-console -- this spec is a tool, its output is the point
		console.log(`[bench] ${JSON.stringify(resolved)}`);

		// Read back in slices: 50k rows do not fit in one WebDriver response either.
		const rows: { extra: Record<string, unknown> }[] = [];
		const take = Math.min(WANT, resolved.official);
		for (let at = 0; at < take; at += 5000) {
			const slice = (await withApi(
				async (api, from, count) => {
					const all = await api.fetchLocations({ type: "Everything" });
					return all
						.filter((l) => l.panoId && l.extra?.imageDate && String(l.extra?.panoType) === "2")
						.slice(from, from + count)
						.map((l) => ({
							lat: l.lat,
							lng: l.lng,
							heading: l.heading,
							panoId: l.panoId,
							extra: l.extra ?? {},
						}));
				},
				at,
				Math.min(5000, take - at),
			)) as { extra: Record<string, unknown> }[];
			rows.push(...slice);
		}

		// A synthetic capture instant inside the real capture month: enough for every
		// datetime-driven provider, and it costs no exactDate bisection to produce.
		for (const r of rows) {
			const ym = String(r.extra.imageDate);
			r.extra.datetime = Math.floor(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 15, 12) / 1000);
		}

		mkdirSync(dirname(OUT), { recursive: true });
		writeFileSync(OUT, JSON.stringify(rows));
		// eslint-disable-next-line no-console -- this spec is a tool, its output is the point
		console.log(`[bench] wrote ${rows.length} official rows to ${OUT}`);
		if (rows.length < WANT / 2) throw new Error(`fixture came up short: ${rows.length}`);
	});
});
