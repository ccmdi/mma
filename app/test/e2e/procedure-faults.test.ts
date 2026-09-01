import { waitForReady } from "./helpers";
import {
	addFixture,
	createMap,
	dropMap,
	dumpRows,
	runEnrich,
	setEnrich,
	setFaults,
} from "./parityDriver";
import { faultRows, faultScript, fixtureRows, key, kindOf } from "./parityFixture";

/**
 * What the procedures do when the network misbehaves. The mock serves a deterministic
 * fault script per key (429/503 sequences, and a 200 whose body is truncated), so these
 * are assertions about intended behaviour rather than a diff against another build.
 *
 *   MMA_E2E_SV_HIDDEN_CAPTURE=1 bash scripts/e2e.sh --mock test/e2e/procedure-faults.test.ts
 *
 * The invariants below are the ones the code states out loud and the ones whose absence
 * has already cost a fix: a transport failure must never read as evidence, a failure must
 * not leak into a neighbouring row, and no row may end up with a timestamp outside the
 * window its capture month defines.
 */

const FIELDS = ["countryCode", "altitude", "cameraType", "panoType", "imageDate", "datetime"];
const DAY = 86400;

/** The window `newSearch` opens for a capture month: the month, plus a day of slack on
 *  each side for timezone offsets. Any datetime outside it is not a narrowing of that
 *  month, it is a wrong answer. */
function windowFor(imageDate: string): [number, number] | null {
	const m = /^(\d{4})-(\d{2})$/.exec(imageDate);
	if (!m) return null;
	const month = Number(m[2]);
	if (month < 1 || month > 12) return null;
	const first = Date.UTC(Number(m[1]), month - 1, 1) / 1000;
	return [first - DAY, first + 32 * DAY];
}

type Row = Record<string, unknown> & { extra: Record<string, unknown> };

describe("procedure faults: what a misbehaving network does to the data", () => {
	const maps: string[] = [];
	let rows: Row[] = [];
	let clean: Row[] = [];
	const byKind = new Map<string, Row>();

	/** One fixture, enriched under the given fault script, on a map of its own. */
	const run = async (faults: Record<string, number[]>): Promise<Row[]> => {
		const id = await createMap(`Faults ${maps.length} ${Date.now()}`);
		maps.push(id);
		await setEnrich(FIELDS);
		await addFixture([...fixtureRows(), ...faultRows()]);
		await setFaults(faults);
		await runEnrich(true);
		return (await dumpRows()) as Row[];
	};

	before(async () => {
		await waitForReady();
		await browser.setTimeout({ script: 900_000 });
		clean = await run({});
		rows = await run(faultScript());
		for (const r of rows) byKind.set(kindOf(key(r as { lat: unknown; lng: unknown })), r);
	});

	after(async () => {
		await setFaults({});
		for (const id of maps) await dropMap(id);
	});

	it("never writes a timestamp outside the month it searched", () => {
		const bad: string[] = [];
		for (const r of rows) {
			const ts = r.extra.datetime;
			if (typeof ts !== "number") continue;
			const month = r.extra.imageDate;
			if (typeof month !== "string") {
				bad.push(`${kindOf(key(r))}: datetime ${ts} with no imageDate`);
				continue;
			}
			const w = windowFor(month);
			if (!w) {
				bad.push(`${kindOf(key(r))}: datetime ${ts} for unparseable month ${month}`);
				continue;
			}
			if (ts < w[0] || ts > w[1]) {
				bad.push(`${kindOf(key(r))}: datetime ${ts} outside ${month} window ${w[0]}..${w[1]}`);
			}
		}
		expect(bad).toEqual([]);
	});

	it("does not resolve a date for a row whose probes never succeeded", () => {
		const row = byKind.get("fault-persists");
		expect(row).toBeDefined();
		// A transport failure is not evidence of anything: the search must abandon the
		// row rather than settle it. (exactDate's `verdict` returns -1, `absorb` settles null.)
		expect(row?.extra.datetime).toBeUndefined();
	});

	it("does not resolve a date for a row with no capture month", () => {
		for (const kind of ["undated", "month-not-a-month", "malformed-month"]) {
			const row = byKind.get(kind);
			if (!row) continue;
			const month = row.extra.imageDate;
			const parseable = typeof month === "string" && windowFor(month) !== null;
			if (!parseable) expect([kind, row.extra.datetime]).toEqual([kind, undefined]);
		}
	});

	it("keeps a metadata failure from inventing fields", () => {
		const row = byKind.get("known-pano");
		expect(row).toBeDefined();
		const cc = row?.extra.countryCode;
		// Either the fetch failed and nothing was written, or it succeeded and the value
		// is the fixture's. A third answer means a failed response was parsed anyway.
		expect(cc === undefined || cc === "RU").toBe(true);
	});

	it("does not let one row's faults change another row", () => {
		const faulted = new Set(Object.keys(faultScript()));
		const isFaulted = (k: string) =>
			faulted.has(
				k
					.split(",")
					.map((n) => Number(n).toFixed(4))
					.join(","),
			);
		const mine = new Map(rows.map((r) => [key(r), r]));
		const drift: string[] = [];
		for (const before of clean) {
			const k = key(before);
			if (isFaulted(k)) continue;
			const after = mine.get(k);
			if (!after) continue;
			const a = JSON.stringify(before.extra ?? {});
			const b = JSON.stringify(after.extra ?? {});
			if (a !== b) drift.push(`${kindOf(k)}: ${a} -> ${b}`);
		}
		expect(drift).toEqual([]);
	});
});
