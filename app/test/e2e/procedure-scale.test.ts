import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { waitForReady } from "./helpers";
import {
	addFixture,
	createMap,
	dropMap,
	dumpRows,
	runEnrich,
	runPin,
	runValidate,
	setEnrich,
} from "./parityDriver";
import { MOCK_GENERIC_IMAGE_DATE } from "./parityFixture";

/**
 * The procedures at the scale people actually run them: 10k-100k rows, mixed with the
 * same hostile shapes the small fixture uses, so the paging and wave machinery is
 * exercised rather than a single batch.
 *
 *   MMA_SCALE_ROWS=10000 MMA_E2E_SV_HIDDEN_CAPTURE=1 bash scripts/e2e.sh --mock \
 *     test/e2e/procedure-scale.test.ts
 *   MMA_SCALE_FIELDS=metadata   # skip datetime: ~40x fewer requests, for the 100k runs
 *
 * A per-row dump would be tens of megabytes, so parity at this size is a digest: the
 * same rows in the same order hashed to one line. Equal digests mean every row matched;
 * unequal digests send you back to the small fixture, which prints actual diffs.
 */

const ROWS = Number(process.env.MMA_SCALE_ROWS ?? 10000);
const METADATA_ONLY = process.env.MMA_SCALE_FIELDS === "metadata";
const FIELDS = METADATA_ONLY
	? ["countryCode", "altitude", "cameraType", "panoType", "imageDate"]
	: ["countryCode", "altitude", "cameraType", "panoType", "imageDate", "datetime"];

const DAY = 86400;
const CHUNK = 5000;
const RESULT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "../perf/results");

/** One in every N rows is a hostile shape, so paging never sees a uniform batch. */
function scaleRows(n: number): { kind: string; lat: number; lng: number; panoId?: string; extra?: Record<string, unknown> }[] {
	const rows = [];
	let h = 12345 >>> 0;
	const next = () => {
		h = (h * 1664525 + 1013904223) >>> 0;
		return h / 0x100000000;
	};
	for (let i = 0; i < n; i++) {
		const lat = Number((-55 + next() * 110).toFixed(5));
		const lng = Number((-170 + next() * 340).toFixed(5));
		if (i % 50 === 7) {
			rows.push({ kind: "dead", lat, lng, panoId: `DEAD_${i}` });
		} else if (i % 50 === 13) {
			rows.push({ kind: "undated", lat, lng, extra: { imageDate: "" } });
		} else if (i % 50 === 21) {
			rows.push({ kind: "no-coverage", lat: 0.0001 + i * 1e-9, lng: 0.0001 });
		} else {
			rows.push({ kind: "plain", lat, lng, extra: { imageDate: MOCK_GENERIC_IMAGE_DATE } });
		}
	}
	return rows;
}

function windowFor(imageDate: string): [number, number] | null {
	const m = /^(\d{4})-(\d{2})$/.exec(imageDate);
	if (!m) return null;
	const first = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) / 1000;
	return [first - DAY, first + 32 * DAY];
}

describe(`procedure scale: ${ROWS} rows`, () => {
	let mapId = "";
	let rows: Record<string, unknown>[] = [];
	let enrichMs = 0;
	let pinMs = 0;
	let validateMs = 0;
	let enrichOutcomes: unknown = null;
	let pinOutcomes: unknown = null;
	let validateStates: unknown = null;

	before(async () => {
		await waitForReady();
		await browser.setTimeout({ script: 3_600_000 });
		mapId = await createMap(`Scale ${ROWS} ${Date.now()}`);
		await setEnrich(FIELDS);
		const all = scaleRows(ROWS);
		for (let i = 0; i < all.length; i += CHUNK) {
			await addFixture(all.slice(i, i + CHUNK));
		}
		const enrich = await runEnrich(false);
		enrichMs = enrich.durationMs;
		enrichOutcomes = enrich.outcomes;
		const pin = await runPin(true);
		pinMs = pin.durationMs;
		pinOutcomes = pin.outcomes;
		const validate = await runValidate();
		validateMs = validate.durationMs;
		validateStates = validate.states;
		rows = await dumpRows();
	});

	after(async () => {
		if (mapId) await dropMap(mapId);
	});

	it("keeps every row", () => {
		expect(rows.length).toBe(ROWS);
	});

	it("never writes a timestamp outside the month it searched", () => {
		if (METADATA_ONLY) return;
		const bad: string[] = [];
		for (const r of rows) {
			const extra = r.extra as Record<string, unknown>;
			const ts = extra.datetime;
			if (typeof ts !== "number") continue;
			const w = typeof extra.imageDate === "string" ? windowFor(extra.imageDate) : null;
			if (!w || ts < w[0] || ts > w[1]) {
				bad.push(`${r.lat},${r.lng}: ${ts} vs ${String(extra.imageDate)}`);
			}
			if (bad.length > 5) break;
		}
		expect(bad).toEqual([]);
	});

	it("writes a digest of the whole map", () => {
		const lines = rows
			.map((r) => {
				const extra = r.extra as Record<string, unknown>;
				const sorted = Object.keys(extra)
					.sort()
					.map((k) => `${k}=${JSON.stringify(extra[k])}`)
					.join(",");
				return `${r.lat},${r.lng}|${String(r.panoId ?? "")}|${String(r.flags ?? 0)}|${sorted}`;
			})
			.sort();
		const digest = crypto.createHash("sha256").update(lines.join("\n")).digest("hex");

		const withDate = rows.filter(
			(r) => typeof (r.extra as Record<string, unknown>).datetime === "number",
		).length;
		const withCountry = rows.filter(
			(r) => typeof (r.extra as Record<string, unknown>).countryCode === "string",
		).length;
		const report = {
			rows: ROWS,
			fields: FIELDS,
			enrichMs,
			pinMs,
			validateMs,
			rowsPerSecond: Number((ROWS / (enrichMs / 1000)).toFixed(2)),
			pinRowsPerSecond: Number((ROWS / (pinMs / 1000)).toFixed(2)),
			validateRowsPerSecond: Number((ROWS / (validateMs / 1000)).toFixed(2)),
			enrichOutcomes,
			pinOutcomes,
			validateStates,
			withDate,
			withCountry,
			digest,
		};
		fs.mkdirSync(RESULT_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(RESULT_DIR, `scale-${ROWS}.json`),
			JSON.stringify(report, null, "\t") + "\n",
		);
		console.log("[scale] " + JSON.stringify(report));
	});
});
