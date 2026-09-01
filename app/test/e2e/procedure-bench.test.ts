import fs from "node:fs";
import path from "node:path";
import { waitForReady } from "./helpers";
import {
	addRows,
	collectNet,
	createMap,
	dropMap,
	dumpRows,
	resetTimelines,
	runEnrich,
	seedRows,
	setEnrich,
} from "./parityDriver";

/**
 * exactDate throughput, measured against the recorded network rather than a guess.
 *
 *   MMA_E2E_SV_REPLAY=1 MMA_E2E_SV_HIDDEN_CAPTURE=1 MMA_E2E_SV_MAX_INFLIGHT=100 \
 *     bash scripts/e2e.sh --mock test/e2e/procedure-bench.test.ts
 *
 * Nothing is asserted beyond "the run actually enriched": the point is the report, and
 * a comparison is always between two of them (scripts/compare-bench.mjs).
 */

const ROWS = Number(process.env.MMA_PBENCH_ROWS ?? 200);
const LABEL = process.env.MMA_PBENCH_LABEL ?? "";
const RESULT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "../perf/results");

/** The exactDate search's own shape: BRANCH interior probes per round over a 33-day
 *  window. Kept here so the projection below is arithmetic on measured rounds, not a
 *  second implementation of the search. */
const BRANCH = 4;
const WINDOW_S = 33 * 86400;
const roundsFor = (accuracy: number) =>
	Math.max(1, Math.ceil(Math.log(WINDOW_S / accuracy) / Math.log(BRANCH + 1)));

interface Report {
	label: string;
	rows: number;
	enrichedRows: number;
	durationMs: number;
	rowsPerSecond: number;
	outcomes: { id: string; success: number; failed: number }[];
	surface: string;
	net: Record<string, number>;
	requestsPerRow: number;
	/** Resolved timestamp per row, so two runs can be compared for the value and not
	 *  only the speed. */
	rowDates: Record<string, number>;
	projection: {
		roundsSecond: number;
		roundsDay: number;
		projectedRowsPerSecondAtDay: number;
	};
}

function writeReport(r: Report): void {
	fs.mkdirSync(RESULT_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = `procedure-bench${r.label ? `-${r.label}` : ""}-${stamp}.json`;
	fs.writeFileSync(path.join(RESULT_DIR, name), JSON.stringify(r, null, "\t") + "\n");
	console.log(`[pbench] wrote test/perf/results/${name}`);
}

describe("procedure bench: exactDate throughput", () => {
	let mapId = "";

	before(async () => {
		await waitForReady();
		await browser.setTimeout({ script: 900_000 });
		mapId = await createMap(`PBench ${Date.now()}`);
		await setEnrich(["datetime"]);
		await addRows(seedRows(ROWS));
	});

	after(async () => {
		if (mapId) await dropMap(mapId);
	});

	it(`resolves ${ROWS} exact dates and reports the load it made`, async () => {
		await resetTimelines();
		const run = await runEnrich(false);
		const net = await collectNet();
		const rows = await dumpRows();
		const enriched = rows.filter((r) => {
			const extra = r.extra as Record<string, unknown>;
			return typeof extra.datetime === "number";
		}).length;

		const rowDates: Record<string, number> = {};
		for (const r of rows) {
			const ts = (r.extra as Record<string, unknown>).datetime;
			if (typeof ts === "number") rowDates[`${r.lat},${r.lng}`] = ts;
		}

		const perRow = enriched > 0 ? net.stats.requests / enriched : 0;
		const roundsSecond = roundsFor(1);
		const roundsDay = roundsFor(86400);
		const report: Report = {
			label: LABEL,
			rows: ROWS,
			enrichedRows: enriched,
			durationMs: run.durationMs,
			rowsPerSecond: Number((enriched / (run.durationMs / 1000)).toFixed(2)),
			outcomes: run.outcomes,
			surface: net.surface,
			net: { ...net.stats } as unknown as Record<string, number>,
			requestsPerRow: Number(perRow.toFixed(2)),
			rowDates,
			projection: {
				roundsSecond,
				roundsDay,
				projectedRowsPerSecondAtDay: Number(
					((enriched / (run.durationMs / 1000)) * (roundsSecond / roundsDay)).toFixed(2),
				),
			},
		};
		console.log("[pbench] " + JSON.stringify({ ...report, rowDates: undefined }, null, 1));
		writeReport(report);

		if (enriched === 0) throw new Error("no row resolved a datetime: the bench measured nothing");
	});
});
