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
import { fixtureRows, key, kindOf } from "./parityFixture";

/**
 * Every procedure over the hostile fixture, one phase at a time, asserted against a
 * pinned golden. Phases run in a fixed order on one map, so each dump is what the
 * previous phase left plus this phase's work, and a mismatch names the phase that
 * introduced it.
 *
 *   MMA_E2E_SV_HIDDEN_CAPTURE=1 bash scripts/e2e.sh --mock test/e2e/procedure-parity.test.ts
 *
 * `bulkPanHeading` is absent because the app does not expose it outside its bulk
 * dialog; put it on the API and it joins this list for free.
 */

const FIELDS = [
	"countryCode",
	"altitude",
	"cameraType",
	"panoType",
	"imageDate",
	"uploaderName",
	"subdivision",
	"datetime",
	"timezone",
];

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RESULT_DIR = path.join(HERE, "../perf/results");
/** The pinned answer: the oracle every run is measured against. Rewrite it with
 *  MMA_PARITY_UPDATE_GOLDEN=1, and only with a reason. */
const GOLDEN = path.join(HERE, "fixtures/parity-golden.json");

interface Phase {
	name: string;
	durationMs: number;
	outcomes: unknown;
	rows: Record<string, unknown>[];
}

describe("procedure parity: every procedure over the hostile fixture", () => {
	let mapId = "";
	const phases: Phase[] = [];

	/** Providers report in wave-completion order, which is not stable run to run; the
	 *  set and its counts are the contract, not the order. */
	const stable = (outcomes: unknown): unknown =>
		Array.isArray(outcomes)
			? [...outcomes].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
			: outcomes;

	const snapshot = async (name: string, durationMs: number, outcomes: unknown) => {
		const rows = await dumpRows();
		phases.push({
			name,
			durationMs,
			outcomes: stable(outcomes),
			rows: rows.map((r) => {
				const k = key(r as { lat: unknown; lng: unknown });
				return { key: k, kind: kindOf(k), ...r };
			}),
		});
		if (rows.length !== fixtureRows().length) {
			throw new Error(`${name} lost rows: ${rows.length}/${fixtureRows().length}`);
		}
	};

	before(async () => {
		await waitForReady();
		await browser.setTimeout({ script: 900_000 });
		mapId = await createMap(`Parity ${Date.now()}`);
		await setEnrich(FIELDS);
		await addFixture(fixtureRows());
	});

	after(async () => {
		if (mapId) await dropMap(mapId);
	});

	it("enriches", async () => {
		const run = await runEnrich(false);
		await snapshot("enrich", run.durationMs, run.outcomes);
	});

	it("pins to panoramas", async () => {
		const run = await runPin(true);
		await snapshot("pin", run.durationMs, run.outcomes);
	});

	it("validates", async () => {
		const run = await runValidate();
		await snapshot("validate", run.durationMs, run.states);
	});

	it("matches the pinned golden", () => {
		const mine = phases.map((p) => ({ name: p.name, outcomes: p.outcomes, rows: p.rows }));
		if (process.env.MMA_PARITY_UPDATE_GOLDEN) {
			fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
			fs.writeFileSync(GOLDEN, JSON.stringify({ phases: mine }, null, "\t") + "\n");
			console.log(`[parity] golden rewritten: ${GOLDEN}`);
			return;
		}
		if (!fs.existsSync(GOLDEN)) throw new Error(`no golden at ${GOLDEN}`);
		const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as { phases: unknown[] };
		expect(mine).toEqual(golden.phases);
	});

	it("writes the dump", () => {
		const dump = { fields: FIELDS, phases };
		fs.mkdirSync(RESULT_DIR, { recursive: true });
		const out = path.join(RESULT_DIR, "parity.json");
		fs.writeFileSync(out, JSON.stringify(dump, null, "\t") + "\n");
		console.log(`[parity] ${phases.length} phases -> ${out}`);
		for (const p of phases) {
			console.log(`[parity]   ${p.name} ${p.durationMs}ms ${JSON.stringify(p.outcomes)}`);
		}
	});
});
